# VoiceClaim MVP

Responsive voice-to-claim research demo. Speak naturally; after a pause, the app extracts one checkable claim, searches and fetches live web sources with TinyFish, and asks Gemini 3.8 Flash to assess the evidence.

## Requirements

- Node.js 18 or newer
- A Gemini API key for the Gemini Developer API
- A TinyFish API key (Search and Fetch are currently free within published limits)
- Chrome desktop is recommended for the browser Web Speech API microphone feature

No npm packages are needed. The server uses Node.js built-in modules and `fetch`.

## Configure keys safely (Windows PowerShell)

1. In this folder, create your local environment file:

   ```powershell
   Copy-Item .env.example .env
   ```

2. Open `.env` in your editor and replace the placeholders with your real Gemini and TinyFish keys. Keep each value after its `=` sign.
3. `.env` is excluded by `.gitignore`. Commit `.env.example`, never `.env`.

Example `.env.example` entries:

```text
GEMINI_API_KEY=put_your_gemini_key_here
GEMINI_MODEL=gemini-3.8-flash
GEMINI_FALLBACK_MODEL=gemini-3.5-flash-lite
TINYFISH_API_KEY=put_your_tinyfish_key_here
PORT=3000
```

If Gemini 3.8 Flash returns a temporary 503 or a 429 quota/rate-limit response, the server retries that request once with Gemini 3.5 Flash-Lite. The result card will say when the fallback model was used. You can change the fallback model with `GEMINI_FALLBACK_MODEL`. A fallback cannot help if both models have exhausted their project quota.

The demo limits each client IP to 4 transcript segments per minute and asks Gemini to reject evidence for ambiguous or mismatched locations. This in-memory limit is a small demo safeguard, not production access control; do not expose the app publicly without proper authentication and abuse monitoring.

## Deploy a demo on Vercel

This repo uses Vercel's **Other** preset with the `public/` directory as its static output. Vercel Node.js Functions serve `/api/status`, `/api/health`, and `/api/process-transcript`. Push the repo to GitHub and import it in Vercel; `vercel.json` supplies the framework, build, and output settings. In **Project Settings → Environment Variables**, add `GEMINI_API_KEY`, `TINYFISH_API_KEY`, `GEMINI_MODEL=gemini-3.8-flash`, `GEMINI_FALLBACK_MODEL=gemini-3.5-flash-lite`, and `TRUST_PROXY_HEADERS=true`. Keep API keys in Vercel's environment settings, never in Git. Redeploy after saving the variables, then open the generated HTTPS URL and test `/api/health` before trying a short claim.

Vercel serves the static site from its edge network and invokes the API function when a request arrives. Function duration is set to 300 seconds in `vercel.json` for the sequential Gemini/TinyFish calls; Vercel documents this maximum for Hobby when Fluid Compute is enabled. [Vercel function limits](https://vercel.com/docs/functions/limitations). TinyFish currently lists Search as free for up to 30 requests/minute and 500/hour, and Fetch as free for up to 150 URLs/minute and 1,000/day. [TinyFish pricing](https://future.tinyfish.io/pricing). The Agent and Browser products are metered, so this MVP uses Search and Fetch only. Gemini remains a separate provider with its own quota and possible charges. The demo rate limiter is held in function memory and is not reliable global abuse prevention. Anyone with the public app URL may use provider quotas, so share it selectively and monitor usage.

## Run

From this folder:

```powershell
npm start
```

Open <http://localhost:3000> in Chrome, allow microphone access, select English or Hindi, click **Start listening**, and say a short factual claim. Pause briefly. The app detects one claim, searches TinyFish, fetches up to three source pages, then asks Gemini to assess only the retrieved source text. The result card shows source links.

Click **Stop listening** to stop recording. Close the terminal to stop the local server.

## Manual checks

1. **Factual claim:** “The Eiffel Tower was completed in 1889.” Confirm the result shows source links, open them, and judge whether they support the assessment.
2. **Opinion only:** “I prefer tea to coffee.” The app should report that no checkable factual claim was found and skip the search.
3. **Missing key:** temporarily remove one key from `.env`, restart the server, and confirm the app reports the missing configuration without showing a verdict. Restore the key afterward.
4. **Provider error:** if Gemini or TinyFish returns an error, confirm the app displays an error and does not show a made-up verdict.
5. **Mobile layout:** resize the browser to phone width and confirm the transcript and result card fit the screen.

These are manual demo checks, not an accuracy benchmark. Speech recognition, search results, source quality, and AI assessments can vary. Open the sources before relying on a result.

For a one-claim end-to-end check after configuring `.env`, start the app with `npm start` in one terminal and run `node test-grounding.js` in another. To test the deployed site instead, set `$env:VOICECLAIM_URL` in PowerShell to its HTTPS URL before running the script. Each run submits one claim and uses Gemini plus TinyFish Search/Fetch.

## Privacy and limitations

Browser speech recognition may send audio to the browser vendor's online service. Transcript chunks and fetched source text are sent to Gemini; claim searches and source URLs are sent to TinyFish. The demo does not save transcripts to disk or use a database. Do not use private or sensitive conversations. A source-based AI assessment is not a guarantee that a claim is true.

## Main files

- `public/index.html`, `public/styles.css`, `public/layout.css`: responsive website
- `public/app.js`: browser speech recognition, transcript chunking, and result cards
- `server.js`: local API, Gemini claim extraction/source assessment, TinyFish Search and Fetch
- `.env.example`: safe template with placeholders only
- `test-grounding.js`: one-claim integration check for Gemini and TinyFish
- `api/`, `vercel.json`: Vercel API functions and deployment settings
