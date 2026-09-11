// THE RATE LIMITER, EXERCISED.
//
// The source gate (check:crawl-politeness) proves every request GOES THROUGH
// politeFetch. It cannot prove politeFetch actually backs off. These cases do,
// because "we stop when a server tells us to" is the promise the whole standing
// crawl rests on, and a promise nobody tested is a promise.
//
// Run: node scripts/test-crawl-backoff.mjs
import { politeFetch, requestLedger } from "./lib/polite-fetch.mjs";

let pass = 0, fail = 0; const failures = [];
const check = (label, ok, detail = "") => {
  if (ok) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; failures.push(label); console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ""}`); }
};

// A stub server. `plan` is the status sequence it hands back, per host.
let calls = [];
function stub(plan, headers = {}) {
  let i = 0;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const status = plan[Math.min(i++, plan.length - 1)];
    return {
      status, ok: status >= 200 && status < 300,
      headers: { get: (h) => (h.toLowerCase() === "retry-after" ? (headers["retry-after"] ?? null) : null) },
      text: async () => "", json: async () => ({}),
    };
  };
}
const ledgerFor = (origin) => requestLedger().find((h) => h.origin === origin) || { requests: 0, refusals: 0, circuitOpen: false };

console.log("-- politeFetch: backoff, circuit breaker, ledger --");

// 1. the happy path costs exactly one request
calls = []; stub([200]);
let r = await politeFetch("https://a.example.com/x");
check("a 200 passes straight through", r.status === 200 && calls.length === 1, `${calls.length} calls`);
check("and is counted once", ledgerFor("https://a.example.com").requests === 1);

// 2. a refusal is RETRIED, not stepped over
calls = []; stub([429, 429, 200], { "retry-after": "0" });
r = await politeFetch("https://b.example.com/x");
check("429 is retried until it succeeds", r.status === 200 && calls.length === 3, `${calls.length} calls`);
const b = ledgerFor("https://b.example.com");
check("both refusals are recorded", b.refusals === 2 && b.requests === 3, JSON.stringify(b));

// 3. Retry-After is obeyed, not overridden by our own constant
calls = []; stub([429, 200], { "retry-after": "1" });
let t0 = Date.now();
await politeFetch("https://c.example.com/x");
const waited = Date.now() - t0;
check("Retry-After is honoured (waited ~1s, not the 2s default)", waited >= 900 && waited < 1900, `${waited}ms`);

// 4. a host that keeps refusing gets left alone
calls = []; stub([429], { "retry-after": "0" });
let threw = null;
try { await politeFetch("https://d.example.com/x"); } catch (e) { threw = e; }
check("repeated refusals open the circuit", !!threw && /circuit opened/i.test(threw.message), threw?.message);
const d = ledgerFor("https://d.example.com");
// Exactly one exhausted call: MAX_REFUSAL_RETRIES (3) + the initial attempt.
// Pinned as a number because the whole point is that it is BOUNDED -- the run
// this replaced sent 2,403.
check("the circuit opens after one exhausted call, not unlimited knocking", d.requests === 4, `${d.requests} requests`);
check("the ledger reports the open circuit", d.circuitOpen === true);

// 5. once open, we do not knock again — not even once
calls = [];
threw = null;
try { await politeFetch("https://d.example.com/y"); } catch (e) { threw = e; }
check("an open circuit refuses without sending anything", !!threw && calls.length === 0, `${calls.length} calls`);

// 6. one bad host does not silence the others
calls = []; stub([200]);
r = await politeFetch("https://e.example.com/x");
check("a different host is unaffected by another's open circuit", r.status === 200);

// 7. 503 is treated as a refusal too — "come back later" either way
calls = []; stub([503, 200], { "retry-after": "0" });
r = await politeFetch("https://f.example.com/x");
check("503 backs off the same as 429", r.status === 200 && calls.length === 2, `${calls.length} calls`);

console.log(`\n${pass} passed, ${fail} failed${fail ? `\n  ${failures.join("\n  ")}` : ""}`);
process.exitCode = fail ? 1 : 0;
