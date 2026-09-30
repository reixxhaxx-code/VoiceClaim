const fs = require('node:fs');
const path = require('node:path');

// Safe .env loader using Node built-ins
function loadEnv() {
  const envPath = path.resolve(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
}

loadEnv();

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '');
const TAVILY_API_KEY = (process.env.TAVILY_API_KEY || '').trim().replace(/^["']|["']$/g, '');
const MODEL = (process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim().replace(/^["']|["']$/g, '');
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const TAVILY_API_URL = 'https://api.tavily.com/search';

function safeRedact(text) {
  if (!text) return '';
  let str = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
  if (GEMINI_API_KEY && GEMINI_API_KEY.length > 4) {
    str = str.split(GEMINI_API_KEY).join('[REDACTED_GEMINI_KEY]');
  }
  if (TAVILY_API_KEY && TAVILY_API_KEY.length > 4) {
    str = str.split(TAVILY_API_KEY).join('[REDACTED_TAVILY_KEY]');
  }
  return str;
}

function extractGeminiText(data) {
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  return (data.steps || [])
    .filter(step => step.type === 'model_output')
    .flatMap(step => step.content || [])
    .filter(part => part.type === 'text')
    .map(part => part.text || '')
    .join('\n')
    .trim();
}

async function runTest() {
  console.log('====================================================');
  console.log(' VoiceClaim: Gemini + Tavily Search Test');
  console.log('====================================================');

  const missing = [];
  if (!GEMINI_API_KEY) missing.push('GEMINI_API_KEY');
  if (!TAVILY_API_KEY) missing.push('TAVILY_API_KEY');

  if (missing.length > 0) {
    console.error(`\n[CONFIG ERROR] Missing required key(s): ${missing.join(', ')}`);
    console.error('Please add them to your .env file:');
    console.error('GEMINI_API_KEY=your_gemini_key');
    console.error('TAVILY_API_KEY=your_tavily_key\n');
    process.exit(1);
  }

  const claim = 'Water boils at 100 degrees Celsius at sea level.';
  const context = 'Standard atmospheric science.';

  console.log(`Model:      ${MODEL}`);
  console.log(`Claim:      "${claim}"`);
  console.log(`Search:     Tavily Search API (Basic depth, max 3 results)`);
  console.log(`Assessment: ${MODEL} (Sources only, no Google Search grounding tool)\n`);

  // Step 1: Tavily Search
  console.log('1. Searching Tavily for live evidence...');
  let sources = [];
  try {
    const searchRes = await fetch(TAVILY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TAVILY_API_KEY}`
      },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query: claim,
        search_depth: 'basic',
        max_results: 3,
        include_answer: false
      }),
      signal: AbortSignal.timeout(25_000)
    });

    const searchData = await searchRes.json().catch(() => ({}));
    if (!searchRes.ok) {
      console.error('----------------------------------------------------');
      console.error(`[TAVILY ERROR] HTTP Status: ${searchRes.status} ${searchRes.statusText}`);
      console.error('----------------------------------------------------');
      console.error(`Details: ${safeRedact(searchData.detail || searchData.error || searchData.message || searchData)}`);
      process.exit(1);
    }

    const rawResults = Array.isArray(searchData.results) ? searchData.results : [];
    sources = rawResults
      .filter(r => r && typeof r.url === 'string' && r.url.trim())
      .slice(0, 3)
      .map(r => ({
        title: (r.title || new URL(r.url).hostname).trim(),
        url: r.url.trim(),
        content: (r.content || '').trim()
      }));

    console.log(`   Found ${sources.length} sources from Tavily.\n`);
  } catch (err) {
    console.error('----------------------------------------------------');
    console.error('[TAVILY SEARCH FAILED]');
    console.error('----------------------------------------------------');
    console.error(safeRedact(err.message || String(err)));
    process.exit(1);
  }

  if (sources.length === 0) {
    console.log('No sources returned by Tavily for this claim. Test complete.');
    process.exit(0);
  }

  // Step 2: Gemini 3.8 Flash Assessment
  console.log('2. Sending sources to Gemini 3.8 Flash for evaluation...');
  const formattedSources = sources.map((s, idx) =>
    `[Source ${idx + 1}]\nTitle: ${s.title}\nURL: ${s.url}\nContent: ${s.content}`
  ).join('\n\n');

  const prompt = `You are a strict, objective fact-checker. Assess the factual claim below USING ONLY the provided search sources.

CRITICAL RULES:
1. Base your assessment ONLY on the facts reported in the sources below. Do NOT use outside memory or assumptions to fill gaps.
2. If the provided sources do not directly address, confirm, or challenge the claim, your verdict MUST be INSUFFICIENT EVIDENCE.
3. Start your response with EXACTLY ONE of these four labels as the first word(s):
   SUPPORTED
   CONTRADICTED
   MIXED
   INSUFFICIENT EVIDENCE
4. After the verdict label, explain your reasoning in 2 to 4 concise sentences, specifically referencing what the sources state.
5. Do not invent citations or URLs.

CLAIM: ${claim}
CONTEXT: ${context}

SEARCH SOURCES:
${formattedSources}`;

  try {
    const geminiRes = await fetch(GEMINI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY
      },
      body: JSON.stringify({
        model: MODEL,
        input: prompt
      }),
      signal: AbortSignal.timeout(35_000)
    });

    const geminiData = await geminiRes.json().catch(() => ({}));
    if (!geminiRes.ok) {
      console.error('----------------------------------------------------');
      console.error(`[GEMINI ERROR] HTTP Status: ${geminiRes.status} ${geminiRes.statusText}`);
      console.error('----------------------------------------------------');
      const errObj = Array.isArray(geminiData) ? geminiData[0]?.error : geminiData.error;
      console.error(`Error Code:    ${errObj?.code || geminiRes.status}`);
      console.error(`Error Status:  ${errObj?.status || 'N/A'}`);
      console.error(`Error Message: ${safeRedact(errObj?.message || 'Unknown error')}`);
      process.exit(1);
    }

    const outputText = extractGeminiText(geminiData);
    const verdictMatch = outputText.match(/^\s*(SUPPORTED|CONTRADICTED|MIXED|INSUFFICIENT EVIDENCE)/i);
    const verdict = verdictMatch ? verdictMatch[1].toUpperCase() : 'INSUFFICIENT EVIDENCE';

    console.log('----------------------------------------------------');
    console.log('[TEST SUCCEEDED]');
    console.log('----------------------------------------------------');
    console.log(`Verdict:    ${verdict}`);
    console.log(`\nAssessment:`);
    console.log(outputText);
    console.log(`\nNotice:     AI assessment based on the sources below.`);
    console.log(`\nSources (Tavily):`);
    sources.forEach((s, idx) => {
      console.log(`  [${idx + 1}] ${s.title}`);
      console.log(`      ${s.url}`);
    });
  } catch (err) {
    console.error('----------------------------------------------------');
    console.error('[GEMINI REQUEST FAILED]');
    console.error('----------------------------------------------------');
    console.error(safeRedact(err.message || String(err)));
    process.exit(1);
  }
}

runTest();
