# VoiceClaim — Frozen MVP Scope

**Date:** 2026-09-29  
**Build target:** one-person, one-day hackathon demo  
**Product form:** responsive website / local web app. On a laptop, the live transcript and research cards sit side-by-side; on a narrow/mobile screen they stack vertically.

## Frozen product decision

VoiceClaim listens to one speaker, shows the speech transcript, automatically detects factual claims in each short transcript segment, and researches only those claims. Users do not select claims manually. Each detected claim gets a result card with a cautious evidence assessment and links returned by web search.

This is a demo of **speech → claim detection → sourced research**, not a real-time truth oracle. A result may arrive several seconds after a speech pause. Users must be able to see when the app is listening, processing, and waiting.

## Target user and demo

**User:** a hackathon judge or listener who wants to follow factual statements in a short spoken pitch.  
**Demo:** turn on the mic, speak 3–4 sentences containing one checkable factual claim, pause, then show the transcript and an evidence card for that claim. A sentence that is opinion or not checkable should produce no research card.

## In scope

- Browser microphone dictation through the Web Speech API.
- Language picker for English (India) and Hindi (India); test one selected language on the actual demo device.
- Live transcript visible on the page.
- After a short pause, send the transcript segment to Gemini to identify up to three distinct, checkable factual claims.
- Skip opinions, questions, predictions, jokes, incomplete thoughts, and uncheckable statements.
- Automatically research each detected claim, serially, with Gemini Google Search grounding.
- Show the extracted claim, concise assessment, one of `SUPPORTED`, `CONTRADICTED`, `MIXED`, or `INSUFFICIENT EVIDENCE`, and source links/citations when returned.
- Keep processing in memory only; do not save audio, transcript history, account data, or claim history.
- If claim extraction finds nothing, show a “No checkable factual claim found” state.

## Explicitly out of scope

- User selecting claims manually as the main workflow.
- Continuous research on every word or every partial transcript token.
- Multi-speaker diarization, uploaded recordings, video, or meetings.
- Guaranteed low latency, guaranteed recall, confidence score, or “true/false” verdict.
- Adversarial multi-agent research, source-quality ranking system, embeddings, vector DB, custom model training.
- Login, cloud history, mobile native app, deployment, paid API dependency, billing integration.
- More than three claims from one transcript chunk.

## User flow

1. User opens the website and chooses English (India) or Hindi (India).
2. User clicks **Start listening** and grants microphone access.
3. Transcript appears as speech is recognized.
4. After about 2.2 seconds without a final speech segment, that transcript chunk enters the work queue.
5. Gemini receives the chunk and returns up to three factual claims as JSON. Opinions and incomplete speech are excluded by instruction.
6. For each returned claim, in order, the backend makes a separate Gemini request with Google Search grounding enabled.
7. The page shows the claim, cautious assessment, verdict label, and source links. If no claim was found, it shows a skip message.
8. User clicks **Stop listening** to end capture. Any completed transcript waiting in the queue continues processing.

## Product acceptance criteria

- Mic permission can be granted and revoked; app visibly shows listening/off states.
- In the chosen demo browser, speech appears in the live transcript.
- A 3–4 sentence test chunk with one clear factual claim produces a research card for that claim without a manual selection click.
- An opinion-only chunk produces the no-claim state and does not start a grounded search request.
- Research cards show source links returned by Gemini, or visibly state when no source links were returned.
- API errors and missing API key produce a readable message; the UI never fabricates an evidence card.
- Mic and API limitations are disclosed in the page.

## Architecture and exact API calls

### Browser speech recognition

Use `window.SpeechRecognition || window.webkitSpeechRecognition`. Configure `continuous = true`, `interimResults = true`, and the selected language tag. Show final and interim transcript differently. Buffer final transcript and submit after an idle pause of about 2.2 seconds. Browser support is limited; some implementations send audio to an online recognition service. The demo needs a tested browser/device fallback.

### App API

`GET /api/status`

Response:

```json
{ "configured": true, "model": "gemini-3.8-flash" }
```

`POST /api/process-transcript`

Request:

```json
{ "transcript": "The company has 40 percent of the market. I like its design." }
```

Success response:

```json
{
  "results": [
    {
      "claim": "The company has 40 percent of the market.",
      "context": "The company has 40 percent of the market. I like its design.",
      "assessment": "MIXED — ...",
      "citations": [
        { "url": "https://example.com/source", "title": "Source title" }
      ]
    }
  ],
  "note": "AI-selected claims and web evidence are fallible..."
}
```

No-claim success response: `{ "results": [], "note": "..." }`  
Validation error: HTTP 400 with `{ "error": "..." }`  
Missing API key: HTTP 503 with `{ "error": "..." }`  
Upstream/API failure: HTTP 502 with `{ "error": "..." }`

### Gemini calls (server only)

Use Node's built-in `fetch`; keep `GEMINI_API_KEY` on the server. Do not put the key in browser JavaScript or commit it.

1. **Claim extraction:** POST `https://generativelanguage.googleapis.com/v1beta/interactions`, header `x-goog-api-key`, JSON body:

```json
{
  "model": "gemini-3.8-flash",
  "input": "Conservative claim extraction instructions plus the transcript. Return only {\"claims\":[{\"claim\":\"...\",\"context\":\"...\"}]}; max 3."
}
```

2. **Research each detected claim, serially:** same endpoint/header, JSON body:

```json
{
  "model": "gemini-3.8-flash",
  "input": "Search for primary or reputable evidence for and against this claim. Return cautious assessment, one of SUPPORTED / CONTRADICTED / MIXED / INSUFFICIENT EVIDENCE, in the transcript language.",
  "tools": [{ "type": "google_search" }]
}
```

Extract answer text and `url_citation` annotations from `steps[].content[].annotations` in the Interactions response. One extraction call is made per transcript chunk; a separate grounded call is made only for each extracted claim.

## Data schema

No database and no disk persistence in the frozen MVP. Ephemeral in-memory/API payload shapes:

```text
TranscriptChunk {
  transcript: string,       // 8–2,000 characters
  language: "en-IN" | "hi-IN"
}
DetectedClaim {
  claim: string,
  context: string
}
ClaimResult {
  claim: string,
  context: string,
  assessment: string,
  citations: [{ url: string, title: string }]
}
```

The selected speech language is currently held in browser state and applied to the recognition API. Add it to the server payload before production-grade multilingual use.

## Directory structure

```text
.
  index.html             # one-page microphone/transcript/results UI
  styles.css             # responsive page styling
  layout.css             # desktop two-column / mobile stacked transcript-results view
  app.js                 # speech capture, debounce, serial queue, result cards
  server.js              # static server + Gemini proxy + API validation
  package.json           # Node start script; no npm dependencies
  .gitignore             # excludes secrets and node_modules
  outputs/
    VoiceClaim-MVP-Scope.md
    Idea.txt
```

## Setup

Requirements: Node.js 18+ and a Gemini API key from Google AI Studio. Current Google documentation lists Gemini 3.8 Flash with free input/output and Google Search grounding up to 500 requests/day on the free tier; quotas, availability, and pricing can change. Free-tier content may be used to improve Google products. Do not submit sensitive speech.

PowerShell, from the project folder:

```powershell
$env:GEMINI_API_KEY = "paste-your-key-in-this-terminal-only"
npm start
```

Open `http://localhost:3000` in the browser used for the demo. Do not commit the key to GitHub. Before public deployment, add a protected secret store, rate limiting, consent language, and review provider terms.

## One-day solo plan

| Time | Deliverable |
|---|---|
| 0:00–1:00 | Add API key locally; open app; check `AI READY` state. |
| 1:00–2:00 | Test microphone permission and speech recognition in chosen browser; settle on English or Hindi for demo. |
| 2:00–4:00 | Try transcript chunks with one factual claim, multiple claims, opinion-only, and incomplete speech. Tune extraction prompt and pause delay. |
| 4:00–6:00 | Confirm grounded research citations appear; improve source cards and errors. |
| 6:00–8:00 | Exercise API quota/error path, stop/start mic, silence, and long speech. Keep no more than three claims/chunk. |
| 8:00–10:00 | Polish visual layout, privacy notice, and no-claim state. |
| 10:00–12:00 | Rehearse the 60-second three-sentence demo; freeze changes and prepare honest limitations. |

## Known risks / demo limits

- SpeechRecognition has limited browser support. Some browsers send speech to an online recognition service; test the target browser and be clear about mic use.
- ASR can mishear names, numbers, accents, and code-switching. A bad transcript causes a bad check.
- The LLM may miss, merge, or misclassify claims. Search grounding and citations reduce unsupported answers but do not prove truth.
- Google free-tier quotas and service availability can change; keep a short rehearsed fallback transcript, but label fallback results as demo/sample output and never fake live citations.
- Search quality varies by language, geography, and claim context. A result may take multiple seconds and arrives after the speech chunk/pause.
- Any public demo needs consent from people whose speech is captured.

## Frozen scope change rule

Do not add audio uploads, login, history, team features, custom models, embeddings, or always-on per-word verification until the acceptance criteria work on the chosen demo device. The core value to demonstrate is automatic claim selection from speech followed by linked research.
