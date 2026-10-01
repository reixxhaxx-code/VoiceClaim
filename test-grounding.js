const baseUrl = (process.env.VOICECLAIM_URL || 'http://localhost:3000').replace(/\/$/, '');
const transcript = 'The Eiffel Tower was completed in 1889.';

async function runTest() {
  console.log('VoiceClaim: TinyFish Search/Fetch + Gemini end-to-end test');
  console.log(`Target: ${baseUrl}`);

  const health = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(10_000) });
  if (!health.ok) throw new Error(`Health check failed with HTTP ${health.status}.`);

  const response = await fetch(`${baseUrl}/api/process-transcript`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript }),
    signal: AbortSignal.timeout(240_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Claim check failed with HTTP ${response.status}.`);

  const result = (data.results || [])[0];
  if (!result) {
    console.log(data.status === 'no_claim' ? 'No checkable claim was extracted.' : data.message || data.status);
    return;
  }

  console.log(`Claim: ${result.claim}`);
  console.log(`Verdict: ${result.verdict}`);
  console.log(`Source links: ${(result.citations || []).length}`);
  for (const source of result.citations || []) console.log(`- ${source.title}: ${source.url}`);
}

runTest().catch(error => {
  console.error(`Test failed: ${error.message}`);
  process.exitCode = 1;
});
