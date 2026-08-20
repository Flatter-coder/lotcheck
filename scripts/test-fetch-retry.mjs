// Regression gate for scripts/lib/fetch-retry.mjs — locks the 2026-08-19 fix
// (Mercedes 504 killed a daily refresh on a single un-retried gateway
// timeout). Pure node, no network, no real timers.
import { fetchRetry } from "./lib/fetch-retry.mjs";

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}
const R = (status) => ({ ok: status >= 200 && status < 300, status });
const seq = (results) => {
  let i = 0;
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, hasSignal: !!opts?.signal });
    const r = results[Math.min(i++, results.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = calls;
  return fn;
};
const noSleep = () => Promise.resolve();

// 1. Transient 504s heal: 504, 504, 200 -> ok response on the third try.
{
  const f = seq([R(504), R(504), R(200)]);
  const res = await fetchRetry("u", {}, { fetchImpl: f, sleep: noSleep });
  check("504,504,200 succeeds on third attempt", res.ok && f.calls.length === 3);
}
// 2. Persistent 5xx: returns the final non-ok response after exactly `attempts`
//    tries — the caller's !res.ok throw stays authoritative.
{
  const f = seq([R(504)]);
  const res = await fetchRetry("u", {}, { attempts: 3, fetchImpl: f, sleep: noSleep });
  check("all-504 returns non-ok after exactly 3 attempts", !res.ok && res.status === 504 && f.calls.length === 3);
}
// 3. Network throws retry too: throw, throw, 200 -> ok.
{
  const f = seq([new Error("ECONNRESET"), new Error("ETIMEDOUT"), R(200)]);
  const res = await fetchRetry("u", {}, { fetchImpl: f, sleep: noSleep });
  check("network errors retry then succeed", res.ok && f.calls.length === 3);
}
// 4. Persistent network failure: the last throw propagates.
{
  const f = seq([new Error("boom")]);
  let threw = false;
  try { await fetchRetry("u", {}, { attempts: 2, fetchImpl: f, sleep: noSleep }); }
  catch (e) { threw = /boom/.test(String(e)); }
  check("persistent network error throws after final attempt", threw && f.calls.length === 2);
}
// 5. A 4xx is a real answer — returned immediately, never retried.
{
  const f = seq([R(404)]);
  const res = await fetchRetry("u", {}, { fetchImpl: f, sleep: noSleep });
  check("404 returns immediately with one attempt", res.status === 404 && f.calls.length === 1);
}
// 6. 429 is retryable.
{
  const f = seq([R(429), R(200)]);
  const res = await fetchRetry("u", {}, { fetchImpl: f, sleep: noSleep });
  check("429 retries", res.ok && f.calls.length === 2);
}
// 7. Backoff grows: delays recorded between attempts are non-decreasing bases.
{
  const delays = [];
  const f = seq([R(500), R(500), R(200)]);
  await fetchRetry("u", {}, { fetchImpl: f, sleep: (ms) => { delays.push(ms); return Promise.resolve(); }, baseDelayMs: 100 });
  check("exponential backoff between attempts", delays.length === 2 && delays[0] >= 100 && delays[1] >= 200 && delays[1] > delays[0]);
}
// 8. Every attempt carries an abort signal (per-attempt timeout is wired).
{
  const f = seq([R(200)]);
  await fetchRetry("u", { headers: { a: "b" } }, { fetchImpl: f, sleep: noSleep });
  check("attempts carry an AbortController signal", f.calls[0].hasSignal === true);
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exit(1);
