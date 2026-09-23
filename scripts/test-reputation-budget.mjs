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
//
// 2026-09-22: it used to pin that arithmetic with its OWN copy of it --
//   const budget = (elapsed) => Math.min(TIMEOUT, SKIP_AFTER - elapsed);
// under a comment reading "Mirrors the source line exactly". Nothing compared
// the two. Drop the "- elapsed" in production, or swap the min for a max, and
// the four checks below still passed, because they were asking the copy. The
// expression is now LIFTED FROM THE SOURCE and evaluated, so they ask the line
// that ships. Same defect as test:catalog-quality, same day --
// docs/FIXING-HISTORY.md.
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

// THE REAL EXPRESSION, lifted from the source and evaluated. A miss here is
// fatal, never skipped: "the line moved" must not read as "the budget is fine".
const EXPR = /const highlightsBudget = ([^;]+);/.exec(SRC);
if (!EXPR) {
  console.error("FAIL: get-dealer-sentiment no longer declares highlightsBudget as a single\n" +
    "  expression. This gate evaluates THAT line -- restating the arithmetic here\n" +
    "  is what it used to do, and it meant production could compute anything.");
  process.exit(1);
}
const budgetFn = new Function("elapsed", "HIGHLIGHTS_TIMEOUT_MS", "HIGHLIGHTS_SKIP_AFTER_MS",
  `return ${EXPR[1]};`);
const budget = (elapsed) => budgetFn(elapsed, TIMEOUT, SKIP_AFTER);

// The expression must be self-contained: the two constants and elapsed, and
// nothing else. If it grows a call into a helper, or reads something that only
// exists inside the request handler, it cannot be evaluated here -- and a
// stack trace is a worse answer than a sentence saying what to do about it.
try {
  const probe = budget(0);
  if (!Number.isFinite(probe)) throw new Error(`evaluated to ${probe}`);
} catch (e) {
  console.error(`FAIL: the highlights budget can no longer be evaluated offline -- ${e.message}`);
  console.error(`  the expression found was: ${EXPR[1].trim().slice(0, 120)}`);
  console.error("  This gate runs the REAL line rather than a copy of it, so the line has");
  console.error("  to be a plain expression over HIGHLIGHTS_TIMEOUT_MS, HIGHLIGHTS_SKIP_AFTER_MS");
  console.error("  and elapsed. If the budget now comes from a helper, export that helper and");
  console.error("  call it from here. Do NOT restate the arithmetic in this file -- that is");
  console.error("  exactly what made these checks worthless until 2026-09-22.");
  process.exit(1);
}

console.log("\nthe worst case fits inside the caller's abort");
{
  // Derived by RUNNING the lifted expression across the range of elapsed
  // times, not by restating what it ought to come to. Hop 3 only starts when
  // the budget clears 1s (the skip condition below), so the worst case is the
  // largest elapsed+budget among the starts that actually happen.
  let worst = 0, at = 0;
  for (let elapsed = 0; elapsed <= callerTimeout; elapsed += 5) {
    const b = budget(elapsed);
    if (b < 1000) continue;                 // hop 3 is skipped; nothing is spent
    if (elapsed + b > worst) { worst = elapsed + b; at = elapsed; }
  }
  check("hop 3 is reachable at all", worst > 0,
    "no elapsed value clears the 1s floor -- highlights could never run");
  check(`measured worst case ${worst}ms (at ${at}ms elapsed) is under the caller's ${callerTimeout}ms abort`,
    worst < callerTimeout,
    "if this fails the buyer gets NOT CHECKED again — the whole point of the fix");
  // "Not over" is not enough: the response, its JSON and the cache write all
  // happen AFTER hop 3 and inside the same abort. A budget that exactly equals
  // the caller's timeout fits only if all of that is free.
  check(`and leaves real headroom for the response and the cache write (${callerTimeout - worst}ms)`,
    callerTimeout - worst >= 1500,
    "an exact fit is not a fit");
  // The declared ceiling, independent of the expression's shape: even if the
  // budget stopped shrinking with elapsed altogether, the two constants must
  // still be chosen so the pair cannot outrun the caller.
  check(`the declared constants alone (${SKIP_AFTER}+${TIMEOUT}) stay inside the abort`,
    SKIP_AFTER + TIMEOUT < callerTimeout,
    "the constants must be safe on their own, not only via the subtraction");
}

console.log("\nthe budget shrinks as the earlier hops spend it");
{
  check("a fast cold start leaves the full highlight budget",
    budget(500) === TIMEOUT, String(budget(500)));
  check("a slow pair of Places calls shrinks it",
    budget(SKIP_AFTER - 3000) === 3000, String(budget(SKIP_AFTER - 3000)));
  check("past the threshold the budget goes non-positive, so hop 3 is skipped",
    budget(SKIP_AFTER + 1) <= 0, String(budget(SKIP_AFTER + 1)));
  check("the skip fires below 1s of remaining budget, not at zero",
    budget(SKIP_AFTER - 500) < 1000,
    "starting a call we cannot finish only guarantees the caller aborts");
  // The property behind all four: time already spent can never buy MORE
  // budget. A formula that ignores elapsed satisfies whichever fixed points
  // above happen to land on TIMEOUT; it cannot satisfy this.
  let monotonic = true;
  for (let e = 0; e < SKIP_AFTER + 2000; e += 25) if (budget(e + 25) > budget(e)) monotonic = false;
  check("the budget never grows as elapsed time grows", monotonic,
    "spending time must cost budget -- otherwise the abort is bounded by nothing");
  check("the budget is never more than hop 3's own ceiling",
    budget(0) <= TIMEOUT && budget(-5000) <= TIMEOUT, String(budget(-5000)));
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
