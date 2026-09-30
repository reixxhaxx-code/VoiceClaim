const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Safe, zero-dependency .env loader using Node built-ins
function loadEnv() {
  const envPath = path.resolve(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    try {
      const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    } catch (err) {
      console.error('Warning: Could not read .env file:', err.message);
    }
  }
}

loadEnv();

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '');
const TAVILY_API_KEY = (process.env.TAVILY_API_KEY || '').trim().replace(/^["']|["']$/g, '');
const MODEL = (process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim().replace(/^["']|["']$/g, '');
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const TAVILY_API_URL = 'https://api.tavily.com/search';

function safeRedact(text) {
  if (!text) return '';
  let str = typeof text === 'string' ? text : JSON.stringify(text);
  if (GEMINI_API_KEY && GEMINI_API_KEY.length > 4) {
    str = str.split(GEMINI_API_KEY).join('[REDACTED_GEMINI_KEY]');
  }
  if (TAVILY_API_KEY && TAVILY_API_KEY.length > 4) {
    str = str.split(TAVILY_API_KEY).join('[REDACTED_TAVILY_KEY]');
  }
  return str;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 15_000) {
        reject(new Error('Request payload exceeds limit.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(new Error('Send a valid JSON request.')); }
    });
    req.on('error', reject);
  });
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

async function callGemini(input) {
  const response = await fetch(GEMINI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY
    },
    body: JSON.stringify({
      model: MODEL,
      input
    }),
    signal: AbortSignal.timeout(35_000)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 429) {
      throw new Error('Gemini API rate limit or quota exceeded (429). Please wait a moment and try again.');
    }
    if (response.status === 503) {
      throw new Error('Gemini 3.8 Flash is currently experiencing high demand (503). Spikes are temporary, please try again.');
    }
    const errObj = Array.isArray(data) ? data[0]?.error : data.error;
    const message = errObj?.message || `Gemini API returned HTTP ${response.status}.`;
    throw new Error(message);
  }
  return data;
}

async function searchTavily(query) {
  const response = await fetch(TAVILY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TAVILY_API_KEY}`
    },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query: query.trim(),
      search_depth: 'basic',
      max_results: 3,
      include_answer: false
    }),
    signal: AbortSignal.timeout(25_000)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('Tavily API key is invalid or unauthorized.');
    }
    if (response.status === 429) {
      throw new Error('Tavily API credit quota or rate limit exceeded (429).');
    }
    const msg = data.detail || data.error || data.message || `Tavily Search API returned HTTP ${response.status}.`;
    throw new Error(msg);
  }

  const rawResults = Array.isArray(data.results) ? data.results : [];
  return rawResults
    .filter(r => r && typeof r.url === 'string' && r.url.trim())
    .slice(0, 3)
    .map(r => ({
      title: (r.title || new URL(r.url).hostname).trim(),
      url: r.url.trim(),
      content: (r.content || '').trim()
    }));
}

function parseSingleClaim(text) {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed.claims) || parsed.claims.length === 0) return null;
    const first = parsed.claims[0];
    if (!first || typeof first.claim !== 'string' || !first.claim.trim()) return null;
    return {
      claim: first.claim.trim(),
      context: typeof first.context === 'string' ? first.context.trim() : ''
    };
  } catch {
    return null;
  }
}

async function processTranscriptChunk(transcript) {
  // Step 1: Extract at most ONE factual claim using Gemini 3.8 Flash
  const extractionPrompt = `You are a conservative factual-claim detector. Read the transcript below.
Extract at most 1 distinct, explicit factual claim that can be checked against reliable public evidence.
Include numerical, historical, scientific, market, policy, or measurable claims.
Skip opinions, personal preferences, questions, predictions, jokes, incomplete thoughts, and statements that cannot be checked.
Preserve the exact meaning and key phrasing. Do not research or evaluate the claim here.

Return ONLY valid JSON in this exact shape:
{"claims":[{"claim":"the exact factual claim","context":"short surrounding context if needed"}]}

If there is no checkable factual claim, return exactly:
{"claims":[]}

TRANSCRIPT:
${transcript}`;

  const extractionData = await callGemini(extractionPrompt);
  const parsedClaim = parseSingleClaim(extractGeminiText(extractionData));

  // Step 2: If no claim found, return without searching Tavily
  if (!parsedClaim) {
    return {
      status: 'no_claim',
      message: 'No checkable factual claim found in this speech segment.'
    };
  }

  // Step 3: Search Tavily (basic search, max 3 results)
  const sources = await searchTavily(parsedClaim.claim);

  if (sources.length === 0) {
    return {
      status: 'no_search_results',
      claim: parsedClaim.claim,
      context: parsedClaim.context,
      message: 'No search results found for this claim.',
      results: [{
        claim: parsedClaim.claim,
        context: parsedClaim.context,
        verdict: 'INSUFFICIENT EVIDENCE',
        assessment: 'INSUFFICIENT EVIDENCE. Live web search returned no results for this claim.',
        citations: [],
        disclaimer: 'AI assessment based on the sources below.'
      }]
    };
  }

  // Step 4: Evaluate claim strictly using only Tavily sources
  const formattedSources = sources.map((s, idx) =>
    `[Source ${idx + 1}]\nTitle: ${s.title}\nURL: ${s.url}\nContent: ${s.content}`
  ).join('\n\n');

  const assessmentPrompt = `You are a strict, objective fact-checker. Assess the factual claim below USING ONLY the provided search sources.

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

CLAIM: ${parsedClaim.claim}
CONTEXT: ${parsedClaim.context || 'None supplied.'}

SEARCH SOURCES:
${formattedSources}`;

  const assessmentData = await callGemini(assessmentPrompt);
  const assessmentText = extractGeminiText(assessmentData);

  const verdictMatch = assessmentText.match(/^\s*(SUPPORTED|CONTRADICTED|MIXED|INSUFFICIENT EVIDENCE)/i);
  const verdict = verdictMatch ? verdictMatch[1].toUpperCase() : 'INSUFFICIENT EVIDENCE';

  // Return only actual Tavily sources
  const citations = sources.map(s => ({
    title: s.title,
    url: s.url
  }));

  return {
    status: 'success',
    results: [{
      claim: parsedClaim.claim,
      context: parsedClaim.context,
      verdict,
      assessment: assessmentText,
      citations,
      disclaimer: 'AI assessment based on the sources below.'
    }]
  };
}

const server = http.createServer(async (req, res) => {
  // Status check endpoint
  if (req.method === 'GET' && req.url === '/api/status') {
    return send(res, 200, {
      configured: Boolean(GEMINI_API_KEY && TAVILY_API_KEY),
      geminiConfigured: Boolean(GEMINI_API_KEY),
      tavilyConfigured: Boolean(TAVILY_API_KEY),
      model: MODEL
    });
  }

  // Process transcript chunk
  if (req.method === 'POST' && req.url === '/api/process-transcript') {
    if (!GEMINI_API_KEY || !TAVILY_API_KEY) {
      const missing = [];
      if (!GEMINI_API_KEY) missing.push('GEMINI_API_KEY');
      if (!TAVILY_API_KEY) missing.push('TAVILY_API_KEY');
      return send(res, 503, {
        error: `Missing required API keys: ${missing.join(', ')}. Please configure them in your .env file.`
      });
    }

    try {
      const { transcript } = await readJson(req);
      if (typeof transcript !== 'string' || transcript.trim().length < 8 || transcript.length > 2_500) {
        return send(res, 400, { error: 'Transcript chunk must be between 8 and 2,500 characters.' });
      }

      const outcome = await processTranscriptChunk(transcript.trim());
      return send(res, 200, outcome);
    } catch (error) {
      console.error('API processing error:', safeRedact(error.message));
      const statusCode = error.message.includes('429') ? 429 : error.message.includes('503') ? 503 : 502;
      return send(res, statusCode, { error: error.message || 'Fact-checking failed. Please try again.' });
    }
  }

  // Static file serving
  let pathname;
  try {
    pathname = req.url === '/' ? '/index.html' : decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    return send(res, 400, { error: 'Invalid URL.' });
  }

  const file = path.resolve(ROOT, `.${pathname}`);
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, { error: 'Not found' });
  }

  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8'
  };

  return send(res, 200, fs.readFileSync(file), types[path.extname(file)] || 'application/octet-stream');
});

server.listen(PORT, () => {
  console.log(`VoiceClaim is available at http://localhost:${PORT}`);
  const missing = [];
  if (!GEMINI_API_KEY) missing.push('GEMINI_API_KEY');
  if (!TAVILY_API_KEY) missing.push('TAVILY_API_KEY');
  if (missing.length > 0) {
    console.log(`Notice: Missing ${missing.join(' and ')} in .env. Add them to enable claim research.`);
  } else {
    console.log(`Configured with model: ${MODEL} + Tavily Search`);
  }
});
