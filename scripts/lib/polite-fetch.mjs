// THE RATE LIMITER. Every outbound request LotCheck makes to a dealer's server
// goes through here -- the inventory crawl and the permission survey both.
//
// Extracted from crawl-alberta-inventory.mjs so a second caller cannot quietly
// grow its own fetch loop with its own idea of politeness. One limiter, one
// ledger, one circuit breaker per host.
//
// UA is passed in rather than hardcoded so the caller says which job is knocking,
// but every caller must send one: a standing crawler that will not say who it is
// is harder to defend than one that does, and if a dealer chooses to block us
// that is a signal we want to receive.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 429 IS A REFUSAL, NOT A HICCUP ---------------------------------------
// Measured on run 34162561357 (2026-09-07): 2,403 requests in that pass came
// back HTTP 429 -- "you are going too fast" -- and the loop fired the next one
// `delayMs` later regardless. 36% of the run bought nothing, and it told 32
// dealers' servers that we ignore their rate limits. At province-wide coverage
// that is the same behaviour fifty times over, and it is the single most likely
// thing to turn a technical question into a complaint. The crawler already
// identifies itself honestly in UA; ignoring a refusal while doing so is worse
// than anonymity, not better.
//
// Three changes, in order of how much they matter:
//   1. A 429 or 503 is RETRIED with exponential backoff, honouring Retry-After
//      when the server sends one. That header is the server stating exactly what
//      it wants; overriding it is indefensible in a way a delay constant is not.
//   2. After MAX_REFUSAL_STREAK consecutive refusals a host's circuit BREAKS for
//      the rest of the run. Continuing to knock is not persistence, it is the
//      screenshot in someone's complaint.
//   3. Every request is COUNTED per host, so a run can state what it sent. The
//      2,403 above had to be reconstructed from failure lines after the fact --
//      before asking anyone to bless more traffic, we should be able to say how
//      much we send today.
const DEFAULT_UA = "LotCheckBot/1.0 (+https://lotcheck.ca/about; buyer-side vehicle price verification)";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_REFUSAL_RETRIES = 3;      // then hand the refusal back to the caller
const BACKOFF_BASE_MS = 2_000;      // 2s, 4s, 8s
const MAX_BACKOFF_MS = 60_000;      // a silly Retry-After must not stall the run
// DERIVED, NOT CHOSEN. One call can produce at most RETRIES + 1 refusals, so a
// streak limit above that could never be reached inside a single call and the
// circuit would only ever open across calls -- which is what a first draft did,
// caught by test:crawl-backoff. Tying them together means a host that exhausts
// its retries on one URL is left alone, and the two numbers cannot drift apart.
// Exhausting them takes ~14s of honoured backoff; a host still refusing after
// that is not having a moment, it is saying no.
const MAX_REFUSAL_STREAK = MAX_REFUSAL_RETRIES + 1;

const hostStats = new Map();        // origin -> { requests, refusals, streak, broken }
function statsFor(origin) {
  let st = hostStats.get(origin);
  if (!st) { st = { requests: 0, refusals: 0, streak: 0, broken: false }; hostStats.set(origin, st); }
  return st;
}
function originOf(u) { try { return new URL(u).origin; } catch { return String(u); } }

// Retry-After is either a count of seconds or an HTTP date. Both are the server
// telling us when to come back; neither is optional.
function retryAfterMs(h) {
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_BACKOFF_MS);
  const when = Date.parse(h);
  if (Number.isFinite(when)) return Math.min(Math.max(0, when - Date.now()), MAX_BACKOFF_MS);
  return null;
}

// Every outbound request in this crawler goes through here. A caller that
// bypasses it is a caller that cannot be rate-limited, and check:crawl-politeness
// refuses one.
export async function politeFetch(url, init = {}) {
  const origin = originOf(url);
  const st = statsFor(origin);
  if (st.broken) throw new Error(`circuit open for ${origin} (${st.refusals} refusals) — not knocking again this run`);
  let wait = BACKOFF_BASE_MS;
  for (let attempt = 0; ; attempt++) {
    st.requests++;
    const res = await fetch(url, {
      ...init,
      headers: { "User-Agent": init.ua || DEFAULT_UA, ...(init.headers || {}) },
      signal: AbortSignal.timeout(init.timeoutMs || DEFAULT_TIMEOUT_MS),
    });
    if (res.status !== 429 && res.status !== 503) { st.streak = 0; return res; }
    st.refusals++; st.streak++;
    if (st.streak >= MAX_REFUSAL_STREAK) {
      st.broken = true;
      throw new Error(`HTTP ${res.status} x${st.streak} from ${origin} — circuit opened, skipping this host for the rest of the run`);
    }
    if (attempt >= MAX_REFUSAL_RETRIES) return res;  // caller sees the refusal
    const pause = retryAfterMs(res.headers.get("retry-after")) ?? Math.min(wait, MAX_BACKOFF_MS);
    console.warn(`    HTTP ${res.status} from ${origin} — backing off ${Math.round(pause / 1000)}s (attempt ${attempt + 1}/${MAX_REFUSAL_RETRIES})`);
    await sleep(pause);
    wait *= 2;
  }
}

// What we sent, per host. Printed at the end of every run.
export function requestLedger() {
  return [...hostStats.entries()]
    .map(([origin, st]) => ({ origin, requests: st.requests, refusals: st.refusals, circuitOpen: st.broken }))
    .sort((a, b) => b.requests - a.requests);
}

// Start a fresh ledger. Used by tests and by a second job in the same process.
export function resetLedger() { hostStats.clear(); }
