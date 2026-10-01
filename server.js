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

const ROOT = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '');
const TAVILY_API_KEY = (process.env.TAVILY_API_KEY || '').trim().replace(/^["']|["']$/g, '');
const MODEL = (process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim().replace(/^["']|["']$/g, '');
const FALLBACK_MODEL = (process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.5-flash-lite').trim().replace(/^["']|["']$/g, '');
const TRUST_PROXY_HEADERS = process.env.TRUST_PROXY_HEADERS === 'true';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const TAVILY_API_URL = 'https://api.tavily.com/search';
const TRANSCRIPT_LIMIT = 4;
const TRANSCRIPT_WINDOW_MS = 60_000;
const transcriptRequestsByIp = new Map();

function hasTranscriptAllowance(req) {
  const now = Date.now();
  const forwardedFor = TRUST_PROXY_HEADERS ? req.headers['x-forwarded-for'] : '';
  const forwardedClientIp = typeof forwardedFor === 'string' ? forwardedFor.split(',')[0].trim() : '';
  const clientIp = forwardedClientIp || req.socket.remoteAddress || 'unknown';
  const recentRequests = (transcriptRequestsByIp.get(clientIp) || [])
    .filter(timestamp => now - timestamp < TRANSCRIPT_WINDOW_MS);

  if (recentRequests.length >= TRANSCRIPT_LIMIT) {
    transcriptRequestsByIp.set(clientIp, recentRequests);
    return false;
  }

  recentRequests.push(now);
  transcriptRequestsByIp.set(clientIp, recentRequests);

  if (transcriptRequestsByIp.size > 1_000) {
    for (const [ip, timestamps] of transcriptRequestsByIp) {
      if (!timestamps.some(timestamp => now - timestamp < TRANSCRIPT_WINDOW_MS)) {
        transcriptRequestsByIp.delete(ip);
      }
    }
  }

  return true;
}

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
  res.writeHead(status, {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'microphone=(self)',
    'Cache-Control': 'no-store'
  });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (req.body !== undefined) {
      const payload = req.body;
      const size = Buffer.byteLength(typeof payload === 'string' ? payload : JSON.stringify(payload));
      if (size > 15_000) {
        reject(Object.assign(new Error('Request payload exceeds limit.'), { statusCode: 413 }));
        return;
      }
      if (typeof payload !== 'string') {
        resolve(payload || {});
        return;
      }
      try { resolve(JSON.parse(payload || '{}')); }
      catch { reject(Object.assign(new Error('Send a valid JSON request.'), { statusCode: 400 })); }
      return;
    }

    let body = '';
    let tooLarge = false;
    req.on('data', chunk => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > 15_000) {
        tooLarge = true;
        body = '';
      }
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(Object.assign(new Error('Request payload exceeds limit.'), { statusCode: 413 }));
        return;
      }
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(Object.assign(new Error('Send a valid JSON request.'), { statusCode: 400 })); }
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

async function requestGemini(input, model) {
  const response = await fetch(GEMINI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY
    },
    body: JSON.stringify({
      model,
      input
    }),
    signal: AbortSignal.timeout(35_000)
  });

  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function callGemini(input) {
  let modelUsed = MODEL;
  let primaryStatus = null;
  let { response, data } = await requestGemini(input, modelUsed);

  if ([429, 503].includes(response.status) && FALLBACK_MODEL && FALLBACK_MODEL !== MODEL) {
    primaryStatus = response.status;
    console.warn(`Gemini ${MODEL} returned ${primaryStatus}; retrying once with ${FALLBACK_MODEL}.`);
    await new Promise(resolve => setTimeout(resolve, 800));
    modelUsed = FALLBACK_MODEL;
    ({ response, data } = await requestGemini(input, modelUsed));
  }

  if (!response.ok) {
    if (response.status === 429) {
      const fallbackNote = primaryStatus
        ? ` Both ${MODEL} and ${FALLBACK_MODEL} are currently rate-limited or out of quota.`
        : '';
      throw new Error(`Gemini API rate limit or quota exceeded (429).${fallbackNote} Wait before retrying and check your active limits in Google AI Studio.`);
    }
    if (response.status === 503) {
      const fallbackNote = primaryStatus
        ? ` ${MODEL} and ${FALLBACK_MODEL} both returned 503.`
        : '';
      throw new Error(`Gemini is temporarily unavailable (503).${fallbackNote} Please try again shortly.`);
    }
    const errObj = Array.isArray(data) ? data[0]?.error : data.error;
    const message = errObj?.message || `Gemini API returned HTTP ${response.status}.`;
    throw new Error(message);
  }
  data.voiceclaimModel = modelUsed;
  data.voiceclaimFallbackStatus = primaryStatus;
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
    .map(r => {
      if (!r || typeof r.url !== 'string') return null;
      try {
        const url = new URL(r.url.trim());
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        return {
          title: (r.title || url.hostname).trim(),
          url: url.href,
          content: (r.content || '').trim()
        };
      } catch { return null; }
    })
    .filter(Boolean)
    .slice(0, 3);
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
    const extractionModelNote = extractionData.voiceclaimModel !== MODEL
      ? ` Claim extraction used fallback model ${extractionData.voiceclaimModel} after ${MODEL} returned ${extractionData.voiceclaimFallbackStatus}.`
      : '';
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
        disclaimer: `AI assessment based on the sources below.${extractionModelNote}`
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
6. Match the source to the exact person, place, date, and context in the claim. If a place name is ambiguous or the sources refer to different places (for example, Delhi, Ontario versus New Delhi, India), treat the claim as INSUFFICIENT EVIDENCE unless the transcript context clearly resolves the match.

CLAIM: ${parsedClaim.claim}
CONTEXT: ${parsedClaim.context || 'None supplied.'}

SEARCH SOURCES:
${formattedSources}`;

  const assessmentData = await callGemini(assessmentPrompt);
  const assessmentText = extractGeminiText(assessmentData);
  const fallbackModels = [...new Set([extractionData.voiceclaimModel, assessmentData.voiceclaimModel]
    .filter(model => model && model !== MODEL))];
  const primaryLimitNote = fallbackModels.length
    ? ` after ${MODEL} returned a temporary 429 or 503.`
    : '';

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
      disclaimer: fallbackModels.length
        ? `AI assessment based on the sources below. Gemini used fallback model ${fallbackModels.join(' and ')}${primaryLimitNote}`
        : 'AI assessment based on the sources below.'
    }]
  };
}

async function handleRequest(req, res) {
  // Status check endpoint
  if (req.method === 'GET' && req.url === '/api/status') {
    return send(res, 200, {
      configured: Boolean(GEMINI_API_KEY && TAVILY_API_KEY),
      geminiConfigured: Boolean(GEMINI_API_KEY),
      tavilyConfigured: Boolean(TAVILY_API_KEY),
      model: MODEL
    });
  }

  if (req.method === 'GET' && req.url === '/api/health') {
    return send(res, 200, { status: 'ok' });
  }

  // Process transcript chunk
  if (req.method === 'POST' && req.url === '/api/process-transcript') {
    try {
      const payload = await readJson(req);
      const transcript = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload.transcript
        : undefined;
      if (typeof transcript !== 'string' || transcript.trim().length < 8 || transcript.length > 2_500) {
        return send(res, 400, { error: 'Transcript chunk must be between 8 and 2,500 characters.' });
      }

      if (!hasTranscriptAllowance(req)) {
        return send(res, 429, {
          error: 'Demo limit reached: this network can check up to 4 speech segments per minute. Pause briefly, then try again.'
        });
      }

      if (!GEMINI_API_KEY || !TAVILY_API_KEY) {
        const missing = [];
        if (!GEMINI_API_KEY) missing.push('GEMINI_API_KEY');
        if (!TAVILY_API_KEY) missing.push('TAVILY_API_KEY');
        return send(res, 503, {
          error: `Missing required API keys: ${missing.join(', ')}. Please configure them in your environment.`
        });
      }

      const outcome = await processTranscriptChunk(transcript.trim());
      return send(res, 200, outcome);
    } catch (error) {
      console.error('API processing error:', safeRedact(error.message));
      const statusCode = error.statusCode || (error.message.includes('429') ? 429 : error.message.includes('503') ? 503 : 502);
      return send(res, statusCode, { error: safeRedact(error.message) || 'Fact-checking failed. Please try again.' });
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
}

if (require.main === module) {
  const server = http.createServer(handleRequest);
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
}

module.exports = handleRequest;
