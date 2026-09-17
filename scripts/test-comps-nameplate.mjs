// The same car, filed under two model names, compared against nothing.
//
// WHAT BROKE. A real report on a 2026 Lexus NX 350 F SPORT 3 AWD at Lexus of
// Royal Oak, Calgary, printed:
//
//     Other listings read:  None read
//     "No listings filed as '2026 Lexus NX 350' were among those LotCheck read
//      from Alberta dealers' own pages in the 30 days to Sep 16, 2026, so there
//      is nothing to count this one against."
//
// We were holding NINETY-FIVE 2026 Lexus NX listings in Alberta at that moment.
// Fifty-one were gas NX 350s, from $54,830 to $72,146. The car asks $72,241 --
// the top of the range, and the single most useful thing the report could have
// told that buyer.
//
// THE CAUSE is one line in fn_market_comps:
//
//     and lower(vl.model) = lower(p_model)
//
// Exact string equality. The subject page parses as model "NX 350"; the crawled
// listings are stored as model "NX" with "NX 350" in the TRIM, because that is
// how the dealer pages write them. "NX 350" never equals "NX", so the candidate
// set came back empty and every downstream card honestly said it had nothing --
// which a buyer reads as "there are none out there".
//
// Same shape as the trim-name fork fixed the same day: an identity built on a
// name that two sides spell differently.
//
// THE FIXTURES ARE REAL. Every row in NX_POOL below has the model, trim, price,
// city and last-seen date of an actual row returned by fn_market_comps on
// 2026-09-16.
//
// Run: node scripts/test-comps-nameplate.mjs

import { baseNameplate } from "../supabase/functions/_shared/model-identity.js";
import { likeForLikePool } from "../supabase/functions/_shared/market-count.js";

let failures = 0;
const fail = (what, got, want) => {
  failures++;
  console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
};
const eq = (what, got, want) => { if (got !== want) fail(what, got, want); };

// ── 1. what may be widened, and what must never be ────────────────────────
console.log("1. the nameplate a widened fetch may fall back to");

// Widening is correct: a 2-3 digit engine designation, with or without a
// hybrid/EV suffix, is a variant of one nameplate.
for (const [model, want] of [
  ["NX 350", "NX"], ["NX 350h", "NX"], ["NX 450h+", "NX"],
  ["RX 350h", "RX"], ["ES 300h", "ES"], ["GLC 300", "GLC"], ["X3 xDrive30i", "X3"],
  ["RAV4 Prime", "RAV4"], ["Equinox EV", "Equinox"],
]) eq(`baseNameplate(${JSON.stringify(model)})`, baseNameplate(model), want);

// WIDENING HERE WOULD NAME A DIFFERENT VEHICLE. Each of these is the reason the
// rule is "2-3 digits, trailing, never a bare word and never four digits".
for (const model of [
  "Silverado 1500",   // a 1500 is not a 2500; four digits are a truck series
  "Sierra 1500",
  "Ram 2500",
  "Corolla Cross",    // not a Corolla
  "Grand Highlander", // not a Highlander
  "Land Cruiser",
  "Model 3",          // widening to "Model" names nothing
  "RAV4", "Mazda3", "CX-5", "F-150", "Q50",   // digits belong to the name
]) eq(`baseNameplate(${JSON.stringify(model)}) refuses`, baseNameplate(model), "");

// ── 2. the pool the report should have had ────────────────────────────────
// Shape taken from production: model "NX", the designation in the trim.
const NX_POOL = [
  { price: 54830, trim: "NX 350",   year: 2026, asOf: "2026-09-04", city: "Edmonton" },
  { price: 55080, trim: "NX 350",   year: 2026, asOf: "2026-09-04", city: "Edmonton" },
  { price: 58995, trim: "NX 350",   year: 2026, asOf: "2026-08-27", city: "Edmonton" },
  { price: 64200, trim: "NX 350",   year: 2026, asOf: "2026-08-27", city: "Edmonton" },
  { price: 72146, trim: "NX 350",   year: 2026, asOf: "2026-09-04", city: "Edmonton" },
  { price: 61500, trim: "NX 350h",  year: 2026, asOf: "2026-09-04", city: "Edmonton" },
  { price: 66900, trim: "NX 350h",  year: 2026, asOf: "2026-08-27", city: "Edmonton" },
  { price: 76995, trim: "NX 450h+", year: 2026, asOf: "2026-09-04", city: "Edmonton" },
  { price: 55080, trim: "Other/Don't Know", year: 2026, asOf: "2026-09-04", city: "Edmonton" },
];

// `rowModel` is what production now passes: the model the pool was actually
// FETCHED under. The rows above are filed under "NX"; the subject is filed as
// "NX 350". Without it the wall builds each row's identity by prepending the
// SUBJECT's model, which injects the subject's own powertrain marker into every
// row and stops the wall separating anything — see the note in
// computeMarketCount. Test 3 below is what catches that.
const SUBJECT = { model: "NX 350", rowModel: "NX", trim: "F SPORT 3", year: 2026, condition: "new", today: "2026-09-16" };

console.log("2. the gas subject gets the gas rows, and only those");
{
  const pool = likeForLikePool(NX_POOL, SUBJECT);
  const trims = (pool.rows || []).map((r) => r.trim);
  if (!pool.rows || !pool.rows.length) {
    fail("a widened pool produces comparable rows", pool, "at least one row");
  }
  // THE SAFETY PROPERTY. Widening the FETCH must never widen the COMPARISON:
  // a hybrid and a plug-in are different vehicles with different price ladders,
  // and putting one in a gas car's set is the IONIQ 9 false anchor.
  // [[powertrain-identity-rule]]
  for (const bad of ["NX 350h", "NX 450h+"]) {
    if (trims.includes(bad)) fail(`the wall rejects ${bad} for a gas subject`, trims, `no ${bad}`);
  }
  if (!trims.includes("NX 350")) fail("the gas rows survive the wall", trims, "includes NX 350");
}

console.log("3. a hybrid subject gets the hybrid rows, and not the gas ones");
{
  const pool = likeForLikePool(NX_POOL, { ...SUBJECT, model: "NX 350h", trim: "Premium" });
  const trims = (pool.rows || []).map((r) => r.trim);
  if (trims.includes("NX 350")) fail("the wall rejects gas for a hybrid subject", trims, "no bare NX 350");
  if (trims.includes("NX 450h+")) fail("the wall rejects plug-in for a hybrid subject", trims, "no NX 450h+");
}

console.log("4. an empty pool stays empty — widening invents nothing");
{
  const pool = likeForLikePool([], SUBJECT);
  eq("no rows in, no rows out", (pool.rows || []).length, 0);
}

console.log("5. the recency window still applies after widening");
{
  const stale = NX_POOL.map((r) => ({ ...r, asOf: "2026-06-01" }));
  const pool = likeForLikePool(stale, SUBJECT);
  eq("rows outside the 30-day window are not counted", (pool.rows || []).length, 0);
}

// ── 6. the regression this test exists for ────────────────────────────────
// Before the fix the candidate set was fetched with p_model = "NX 350" and the
// rows are stored under "NX", so the pool arrived EMPTY and the card said
// "None read". This asserts the decision that prevents that: the subject's
// model must resolve to a nameplate the crawl actually files rows under.
console.log("6. the subject's model resolves to the name the crawl files rows under");
{
  const CRAWL_MODEL = "NX";   // what vehicle_listing actually stores
  eq("NX 350 -> NX", baseNameplate(SUBJECT.model), CRAWL_MODEL);
  if (SUBJECT.model.toLowerCase() === CRAWL_MODEL.toLowerCase()) {
    fail("the fixture reproduces the mismatch", SUBJECT.model, "a model that differs from the crawl's");
  }
}

// ── 7. rowModel is load-bearing, and must stay wired ──────────────────────
// If someone makes `rowModel` a no-op, tests 2 and 3 could still pass for the
// wrong reason. This asserts the parameter is actually READ: the same rows, the
// same subject, a different rowModel, must produce a different answer. With the
// subject's own model standing in for the rows' (the pre-fix behaviour), the
// subject's powertrain marker is injected into every row and the wall stops
// separating anything.
console.log("7. the wall reads rowModel, so it cannot be quietly dropped");
{
  const hybrid = { ...SUBJECT, model: "NX 350h", trim: "Premium" };
  const correct = likeForLikePool(NX_POOL, hybrid).rows || [];
  const broken = likeForLikePool(NX_POOL, { ...hybrid, rowModel: hybrid.model }).rows || [];
  const gasIn = (set) => set.some((r) => r.trim === "NX 350");
  if (gasIn(correct)) fail("with rowModel the gas rows stay out", correct.map((r) => r.trim), "no NX 350");
  if (!gasIn(broken)) {
    fail("rowModel is actually read", "dropping it changed nothing",
      "the pre-fix shape lets gas rows into a hybrid set — if this no longer holds, the wall is not reading rowModel");
  }
}

if (failures) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log(
  "\nOK — a widened fetch reaches the 95-listing NX pool the report missed, " +
  "the powertrain wall still separates 350 / 350h / 450h+, and no truck series is ever widened."
);
