// The dealer's RATING must not wait on the review HIGHLIGHTS.
//
// THE DEFECT (2026-08-27, report LC-436A-B5C). get-dealer-sentiment makes three
// network hops in series — Places text search, Places details, then a Claude
// call that turns the reviews into highlights — behind a Deno cold start. The
// caller aborts the whole thing at 12s. On a cold cache the three hops
// routinely exceed that, the caller catches the abort, and the point renders
// "Dealer reputation: NOT CHECKED" — printed about Sundance Mazda, an
// established Edmonton dealer with plenty of Google reviews.
//
// The rating and the review count are both in hand after hop TWO. Only the
// highlights need Claude. An optional enrichment that can take down the
// required result is one of the four recurring defect shapes in
// docs/FIXING-HISTORY.md ("optional step, fatal failure"), and this was one.
//
// This gate has no network and no API keys. It pins the BUDGET ARITHMETIC and
// the structural guarantees in the source, which is what the fix actually is.
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const SRC = readFileSync(new URL("../supabase/functions/get-dealer-sentiment/index.ts", import.meta.url), "utf8");
const CALLER = readFileSync(new URL("../supabase/functions/analyze-listing-url/index.ts", import.meta.url), "utf8");

// The two constants the fix turns on, read from the source so the test cannot
// drift from the code it is pinning.
const constOf = (name) => {
  const m = new RegExp(`const ${name} = ([\\d_]+)`).exec(SRC);
  return m ? Number(m[1].replace(/_/g, "")) : null;
};
const SKIP_AFTER = constOf("HIGHLIGHTS_SKIP_AFTER_MS");
const TIMEOUT = constOf("HIGHLIGHTS_TIMEOUT_MS");
const callerTimeout = (() => {
  const m = /AbortSignal\.timeout\((\d+)_?(\d*)\)/.exec(
    CALLER.slice(CALLER.indexOf("async function resolveDealerReputation")));
  return m ? Number((m[1] + (m[2] || "")).replace(/_/g, "")) : null;
})();

console.log("\nthe budget is declared, not implicit");
check("the skip threshold exists", SKIP_AFTER > 0, String(SKIP_AFTER));
check("the highlights timeout exists", TIMEOUT > 0, String(TIMEOUT));
check("the caller's abort is known", callerTimeout > 0, String(callerTimeout));

console.log("\nthe worst case fits inside the caller's abort");
{
  // The function can spend at most SKIP_AFTER before hop 3 starts (past that
  // it does not start at all), and hop 3 itself is capped at TIMEOUT.
  const worst = SKIP_AFTER + TIMEOUT;
  check(`worst case ${worst}ms is under the caller's ${callerTimeout}ms abort`,
    worst < callerTimeout,
    "if this fails the buyer gets NOT CHECKED again — the whole point of the fix");
  // "Not over" is not enough: the response, its JSON and the cache write all
  // happen AFTER hop 3 and inside the same abort. A budget that exactly equals
  // the caller's timeout fits only if all of that is free.
  check(`and leaves real headroom for the response and the cache write (${callerTimeout - worst}ms)`,
    callerTimeout - worst >= 1500,
    "an exact fit is not a fit");
}

console.log("\nthe budget shrinks as the earlier hops spend it");
{
  // Mirrors the source line exactly:
  //   const highlightsBudget = Math.min(TIMEOUT, SKIP_AFTER - elapsed);
  const budget = (elapsed) => Math.min(TIMEOUT, SKIP_AFTER - elapsed);
  check("a fast cold start leaves the full highlight budget",
    budget(500) === TIMEOUT, String(budget(500)));
  check("a slow pair of Places calls shrinks it",
    budget(SKIP_AFTER - 3000) === 3000, String(budget(SKIP_AFTER - 3000)));
  check("past the threshold the budget goes non-positive, so hop 3 is skipped",
    budget(SKIP_AFTER + 1) <= 0, String(budget(SKIP_AFTER + 1)));
  check("the skip fires below 1s of remaining budget, not at zero",
    budget(SKIP_AFTER - 500) < 1000,
    "starting a call we cannot finish only guarantees the caller aborts");
}

console.log("\nthe structure: an optional hop cannot take down the required one");
check("hop 3 is skipped outright when the budget is spent",
  /if \(reviews\.length > 0 && highlightsBudget < 1_000\)/.test(SRC));
check("hop 3 carries an abort signal",
  /signal: AbortSignal\.timeout\(highlightsBudget\)/.test(SRC),
  "without a signal this fetch is unbounded — it is what blew the caller's abort");
check("a thrown or aborted hop 3 is caught",
  /catch \(e\) \{[\s\S]{0,200}claudeRes = null;[\s\S]{0,200}parseFailed = true;/.test(SRC));
check("the non-ok branch cannot dereference a null response",
  /\} else if \(claudeRes\) \{/.test(SRC),
  "claudeRes.status on the aborted path would throw into the outer catch and return a 500");
check("the rating is read BEFORE hop 3 runs",
  SRC.indexOf("details.rating") < SRC.indexOf("api.anthropic.com"),
  "if the rating came after, bounding hop 3 would not save it");

console.log("\na bounded failure is never cached as this dealer's answer");
check("parseFailed still gates the cache write", /if \(!parseFailed\) \{/.test(SRC));
check("the skip path sets parseFailed",
  /parseFailed = true;\s*\/\/ not an answer -- do not cache it for 30 days/.test(SRC),
  "an empty highlights list must not be baked in for the 30-day TTL");

console.log("\nand the caller still treats a failure as UNCHECKED, never as none-found");
check("the caller leaves it unchecked on any failure",
  /leaving UNCHECKED/.test(CALLER),
  "a lookup that did not complete must never render as an absence of reviews");

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exit(1);
