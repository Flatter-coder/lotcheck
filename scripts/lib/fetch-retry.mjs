// Bounded retry for scraper fetches — the class fix for 2026-08-19, when a
// single transient HTTP 504 from Mercedes' inventory service killed that
// make's daily refresh (the fresh-write guard correctly went red; the fetch
// just never deserved to die on one gateway timeout).
//
// Retries ONLY what a retry can fix: network-level throws, 429, and 5xx.
// A 4xx is a real answer and returns immediately — the caller's !res.ok
// handling stays authoritative. Exponential backoff with jitter; every
// attempt carries its own timeout so a hung socket can't stall the run.
// `fetchImpl`/`sleep` are injectable so the regression test drives it
// deterministically without network or real timers.
export async function fetchRetry(url, options = {}, {
  attempts = 3,
  baseDelayMs = 2000,
  timeoutMs = 45000,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  retryOn = (status) => status === 429 || (status >= 500 && status < 600),
} = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error("attempt timed out")), timeoutMs);
    try {
      const res = await fetchImpl(url, { ...options, signal: ctl.signal });
      if (res.ok || !retryOn(res.status) || i === attempts - 1) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
      if (i === attempts - 1) throw e;
    } finally {
      clearTimeout(timer);
    }
    await sleep(baseDelayMs * Math.pow(2, i) + Math.floor(Math.random() * 250));
  }
  throw lastErr;
}
