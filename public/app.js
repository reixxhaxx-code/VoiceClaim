const micButton = document.querySelector('#mic-button');
const micLabel = document.querySelector('#mic-label');
const micMessage = document.querySelector('#mic-message');
const language = document.querySelector('#language');
const transcriptBox = document.querySelector('#transcript');
const speechState = document.querySelector('#speech-state');
const queueState = document.querySelector('#queue-state');
const resultsBox = document.querySelector('#results');
const errorBox = document.querySelector('#error');
const apiStatus = document.querySelector('#api-status');

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let shouldListen = false;
let finalTranscript = '';
let pendingChunk = '';
let interimTranscript = '';
let flushTimer;
let restartTimer;
let workQueue = Promise.resolve();
let chunkNumber = 0;
let lastSubmittedChunk = '';
let isProcessing = false;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function paintTranscript() {
  if (!finalTranscript && !interimTranscript) {
    transcriptBox.innerHTML = '<span class="placeholder">Your speech will appear here…</span>';
    return;
  }
  transcriptBox.innerHTML = `${escapeHtml(finalTranscript)}${interimTranscript ? ` <span class="interim">${escapeHtml(interimTranscript)}</span>` : ''}`;
  transcriptBox.scrollTop = transcriptBox.scrollHeight;
}

function appendResult(result, index) {
  if (resultsBox.querySelector('.empty')) resultsBox.innerHTML = '';
  const verdictMatch = (result.verdict || result.assessment || '').match(/^\s*(SUPPORTED|CONTRADICTED|MIXED|INSUFFICIENT EVIDENCE)/i);
  const verdict = verdictMatch ? verdictMatch[1].toUpperCase() : 'INSUFFICIENT EVIDENCE';
  const citations = (Array.isArray(result.citations) ? result.citations : []).filter(source => {
    try { return ['http:', 'https:'].includes(new URL(source.url).protocol); }
    catch { return false; }
  });
  const card = document.createElement('article');
  card.className = 'claim-card';
  card.innerHTML = `<div class="card-top"><span class="claim-index">CLAIM ${index}</span><span class="verdict ${verdict.toLowerCase().replaceAll(' ', '-')}">${escapeHtml(verdict)}</span></div>
    <h3>${escapeHtml(result.claim)}</h3>
    <p class="assessment">${escapeHtml(result.assessment)}</p>
    <div class="result-notice">${escapeHtml(result.disclaimer || 'AI assessment based on the sources below.')}</div>
    ${citations.length ? `<div class="sources"><strong>Sources</strong>${citations.map(source => `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title)} ↗</a>`).join('')}</div>` : '<p class="no-sources">No source links were returned for this assessment.</p>'}`;
  resultsBox.prepend(card);
}

async function sendChunk(chunk) {
  const trimmed = chunk.trim();
  if (trimmed.length < 8) return;

  // Prevent duplicate submissions of the exact same text
  if (trimmed === lastSubmittedChunk) return;
  lastSubmittedChunk = trimmed;

  chunkNumber += 1;
  const thisChunk = chunkNumber;
  queueState.textContent = `Checking segment ${thisChunk}…`;
  errorBox.hidden = true;

  const pending = document.createElement('div');
  pending.className = 'pending';
  pending.textContent = `Batch ${thisChunk}: extracting claim and checking live web sources…`;
  resultsBox.prepend(pending);

  isProcessing = true;
  try {
    const response = await fetch('/api/process-transcript', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: trimmed })
    });
    const data = await response.json().catch(() => ({}));

    pending.remove();

    if (!response.ok) {
      throw new Error(data.error || `Fact-checking failed with status ${response.status}.`);
    }

    if (data.status === 'no_claim') {
      const skipped = document.createElement('div');
      skipped.className = 'skipped';
      skipped.textContent = data.message || 'No checkable factual claim found in this speech segment.';
      resultsBox.prepend(skipped);
      queueState.textContent = 'No claim found in latest segment';
      return;
    }

    if (data.status === 'no_search_results') {
      const notice = document.createElement('div');
      notice.className = 'skipped';
      notice.textContent = `No web search results found for: "${data.claim || ''}"`;
      resultsBox.prepend(notice);
      queueState.textContent = 'No search results found';
      return;
    }

    if (Array.isArray(data.results) && data.results.length > 0) {
      // Exactly ONE claim per transcript chunk
      appendResult(data.results[0], thisChunk);
      queueState.textContent = '1 claim researched';
    } else {
      const skipped = document.createElement('div');
      skipped.className = 'skipped';
      skipped.textContent = 'No checkable factual claim found in this speech segment.';
      resultsBox.prepend(skipped);
      queueState.textContent = 'No claim found in latest segment';
    }
  } catch (error) {
    pending.remove();
    errorBox.textContent = error.message;
    errorBox.hidden = false;
    queueState.textContent = 'Research paused';
    // Do not display a verdict card on error
  } finally {
    isProcessing = false;
    if (shouldListen && pendingChunk.trim()) scheduleChunk();
  }
}

function queueChunk(chunk) {
  workQueue = workQueue.then(() => sendChunk(chunk));
}

function scheduleChunk() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    if (!pendingChunk.trim() || isProcessing) return;
    const chunk = pendingChunk;
    pendingChunk = '';
    queueChunk(chunk);
  }, 2200);
}

function createRecognition() {
  const rec = new SpeechRecognition();
  rec.lang = language.value;
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = event => {
    interimTranscript = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const phrase = event.results[i][0].transcript.trim();
      if (event.results[i].isFinal && phrase) {
        pendingChunk += `${pendingChunk ? ' ' : ''}${phrase}`;
        finalTranscript += `${finalTranscript ? ' ' : ''}${phrase}`;
      } else if (phrase) {
        interimTranscript += `${interimTranscript ? ' ' : ''}${phrase}`;
      }
    }
    paintTranscript();
    if (pendingChunk.trim()) scheduleChunk();
    speechState.textContent = interimTranscript ? 'Hearing speech…' : 'Listening';
  };
  rec.onerror = event => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      shouldListen = false;
      setListeningUi(false);
      micMessage.textContent = 'Microphone permission is blocked. Allow microphone access in the browser, then try again.';
      return;
    }
    if (event.error !== 'no-speech' && event.error !== 'aborted') {
      micMessage.textContent = `Speech recognition issue: ${event.error}. You can stop and try again.`;
    }
  };
  rec.onend = () => {
    if (shouldListen) {
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        try {
          recognition = createRecognition();
          recognition.start();
        } catch {
          speechState.textContent = 'Reconnecting…';
        }
      }, 250);
    } else {
      speechState.textContent = 'Mic off';
    }
  };
  return rec;
}

function setListeningUi(active) {
  micButton.classList.toggle('active', active);
  micLabel.textContent = active ? 'Stop listening' : 'Start listening';
  micButton.setAttribute('aria-pressed', String(active));
  language.disabled = active;
  if (!active) speechState.textContent = 'Mic off';
}

let recognition;
micButton.addEventListener('click', () => {
  if (!SpeechRecognition) {
    micMessage.textContent = 'Speech recognition is not supported in this browser. Try Chrome on desktop.';
    return;
  }
  if (shouldListen) {
    shouldListen = false;
    clearTimeout(restartTimer);
    clearTimeout(flushTimer);
    if (pendingChunk.trim()) {
      const chunk = pendingChunk;
      pendingChunk = '';
      queueChunk(chunk);
    }
    try { recognition?.stop(); } catch {}
    setListeningUi(false);
    micMessage.textContent = 'Stopped. Any pending transcript is still being processed.';
    queueState.textContent = 'Processing queued speech…';
    return;
  }
  try {
    shouldListen = true;
    recognition = createRecognition();
    recognition.start();
    setListeningUi(true);
    speechState.textContent = 'Connecting mic…';
    micMessage.textContent = 'Listening. Pause briefly after a thought; the AI checks each transcript segment automatically.';
  } catch {
    shouldListen = false;
    setListeningUi(false);
    micMessage.textContent = 'Could not start the microphone. Check browser permission and try again.';
  }
});

fetch('/api/status').then(response => response.json()).then(data => {
  if (data.configured) {
    apiStatus.textContent = `AI READY · ${data.model} + TINYFISH SEARCH`;
    apiStatus.classList.add('ready');
  } else {
    const missing = [];
    if (!data.geminiConfigured) missing.push('Gemini');
    if (!data.tinyfishConfigured) missing.push('TinyFish');
    apiStatus.textContent = `KEYS NEEDED (${missing.join(' + ')})`;
    apiStatus.classList.remove('ready');
    micMessage.textContent = `Please configure ${missing.join(' and ')} in the server environment to enable live research.`;
  }
}).catch(() => {
  apiStatus.textContent = 'SERVER NOT READY';
  apiStatus.classList.remove('ready');
});

if (!SpeechRecognition) {
  micButton.disabled = true;
  micMessage.textContent = 'This browser does not support speech recognition. Try Chrome on desktop.';
}
