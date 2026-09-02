// Regression suite: an MSRP is only THIS car's sticker if the car is still new.
// Run: node --experimental-strip-types scripts/test-msrp-basis-condition.mjs
//
// THE DEFECT THIS PINS. analyze-listing-url has three branches that write
// msrpBasis. Two carried a hand-copied used-vehicle guard, the third -- the one
// that runs whenever the DEALER'S OWN PAGE states an MSRP -- carried none. It
// cross-checked the stated figure against msrp_catalog and stored
// `analysis.msrpBasis = decided.basis` unguarded, so a used listing came back
// with basis "exact" and the report told the buyer a years-old vehicle was
// thousands "under MSRP" (Advantage Ford, a used GMC Acadia, 2026-08-31).
//
// That is a fabricated bargain claim, and it flatters the DEALER at the buyer's
// expense -- the exact inversion of what this product is for.
//
// WHY THIS FILE IMPORTS THE REAL MODULE. The one existing test of this rule
// (test-quote-msrp-authority.mjs, case 9) re-implements the guard as a local
// `basisFor` copy, so it asserts against its own stale duplicate: the shipped
// code could be edited to anything at all and that test would still report
// green. It did, and it was. This gate calls msrp-basis.ts itself, so changing
// the rule changes what these cases see.

import { msrpIsPresentTense, applyConditionToMsrp } from "../supabase/functions/_shared/msrp-basis.ts";

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "  -- " + detail : ""}`); }
};

// A resolved catalog hit good enough to be called "exact", carrying the
// inflation callout resolveMsrpAuthority attaches when the gap is material.
const EXACT = { msrp: 61990, basis: "exact", trim: "AT4", sourceUrl: "https://catalog/gmc/acadia" };
const INFLATION = { overBy: 4200, pct: 6.8 };

// 1. THE ADVANTAGE FORD CASE (2026-08-31). A used GMC Acadia whose dealer page
// printed a sticker. Branch 3 cross-checked it against the catalog, got back
// "exact", and stored it -- so the report subtracted an as-new sticker from a
// used asking price and published the difference as a discount.
{
  const out = applyConditionToMsrp(
    { ...EXACT, inflation: INFLATION },
    { vehicleCondition: "used", saleCondition: null, odometerKm: 61000, year: 2021 },
  );
  check("Advantage Ford: a used listing's exact catalog hit is NOT 'exact'", out.basis !== "exact", `basis=${out.basis}`);
  check("Advantage Ford: it is relabelled original_when_new", out.basis === "original_when_new", `basis=${out.basis}`);
  check("Advantage Ford: the figure survives as context, not as a claim",
    !!out.originalMsrp && out.originalMsrp.msrp === 61990 && out.originalMsrp.year === 2021,
    JSON.stringify(out.originalMsrp));
  check("Advantage Ford: no over/under claim may be narrated", out.presentTense === false);
}

// 2. Used + an exact catalog row also drops the inflated-sticker ACCUSATION. A
// used car's stated MSRP is its ORIGINAL as-optioned sticker and the catalog
// row is a base trim, so the gap is a data gap, not padding by this dealer
// (no-accusation-language).
{
  const out = applyConditionToMsrp({ ...EXACT, inflation: INFLATION }, { vehicleCondition: "used", odometerKm: 61000 });
  check("used: the inflation accusation is suppressed", out.inflation === null, JSON.stringify(out.inflation));
}

// 3. CERTIFIED is a used car with a premium (condition.ts). The catalog figure
// is what it cost new, not today's sticker.
{
  const out = applyConditionToMsrp({ ...EXACT }, { vehicleCondition: "used", saleCondition: "certified", odometerKm: 38000 });
  check("certified: exact catalog hit -> original_when_new", out.basis === "original_when_new", `basis=${out.basis}`);
  check("certified: not present tense", out.presentTense === false);
}

// 4. DEMO stays present tense on purpose. A demo is sold as new inventory at a
// discount off its OWN sticker, so "$4,000 off MSRP" is the frame that buyer
// needs. Its warranty clock is a separate question (cpo.ts / condition.ts).
{
  const out = applyConditionToMsrp({ ...EXACT, inflation: INFLATION }, { vehicleCondition: "used", saleCondition: "demo", odometerKm: 4200 });
  check("demo: a demo IS measured against its own sticker -> stays exact", out.basis === "exact", `basis=${out.basis}`);
  check("demo: no original-when-new context needed", out.originalMsrp === null);
  check("demo: the inflation callout is left intact", out.inflation === INFLATION);
  check("demo: present tense", out.presentTense === true);
}

// 5. A new car is untouched -- the fix must not disarm the comparison this
// product is built on (reference-point-model).
{
  const out = applyConditionToMsrp({ ...EXACT, inflation: INFLATION }, { vehicleCondition: "new", odometerKm: 12 });
  check("new: stays exact", out.basis === "exact", `basis=${out.basis}`);
  check("new: the real inflation callout still fires", out.inflation === INFLATION);
}

// 6. THE FAIL-OPEN CASE. The old heuristic was `odometerKm > 5000 && condition
// !== "new"`, so a 3,800 km unit with no condition flag anywhere was "not used"
// -- 3,800 is not greater than 5,000 -- and kept a present-tense sticker. That
// is a guess dressed as a fact, and it guessed in the dealer's favour.
{
  const ctx = { vehicleCondition: null, saleCondition: null, odometerKm: 3800 };
  check("3,800 km with no condition flag is NOT present tense (old rule said it was)",
    msrpIsPresentTense(ctx) === false);
  check("3,800 km with no condition flag -> original_when_new",
    applyConditionToMsrp({ ...EXACT }, ctx).basis === "original_when_new");
}

// 7. UNKNOWN FAILS CLOSED. No condition, no odometer, nothing. We do not
// publish a number that only makes sense for a new car (missing beats wrong).
//
// The null/"" cases are not hypothetical shapes. The extraction schema at
// analyze-listing-url/index.ts:2777 specifies `"odometerKm": number | null`
// with "null if not shown", and the SM360 fallback (index.ts:2132) writes null
// the same way -- so a used listing that simply does not publish its mileage
// arrives here with an explicit null, not an absent key. `Number(null)` is 0,
// which is inside the delivery-kilometre window, so it reads as a brand-new
// car. That is the shipped defect again through a different door, and the
// module header already promises the opposite: "including no odometer at all
// -- is unknown, and unknown is not new".
{
  check("unknown everything -> NOT present tense", msrpIsPresentTense({}) === false);
  check("unknown everything -> original_when_new", applyConditionToMsrp({ ...EXACT }, {}).basis === "original_when_new");
  check("an odometer the page did not show (null) is unknown, not 0 km",
    msrpIsPresentTense({ vehicleCondition: null, saleCondition: null, odometerKm: null }) === false);
  check("a blank odometer field is unknown, not 0 km",
    msrpIsPresentTense({ vehicleCondition: null, saleCondition: null, odometerKm: "" }) === false);
  check("an unparseable odometer is unknown", msrpIsPresentTense({ odometerKm: "call us" }) === false);
}

// 8. Delivery kilometres with no flag ARE positive evidence of newness -- a car
// on the lot reads 8 km, and refusing every unflagged listing would turn the
// guard into a blanket refusal of the comparison.
{
  check("odometer 0 with no flag -> present tense", msrpIsPresentTense({ odometerKm: 0 }) === true);
  check("delivery km (8) with no flag -> present tense", msrpIsPresentTense({ odometerKm: 8 }) === true);
  check("the delivery ceiling holds at 1,000 km", msrpIsPresentTense({ odometerKm: 1000 }) === true);
  check("just past the ceiling is no longer new", msrpIsPresentTense({ odometerKm: 1001 }) === false);
  check("delivery km still loses to an explicit 'used'", msrpIsPresentTense({ vehicleCondition: "used", odometerKm: 8 }) === false);
}

// 9. A DEALER-STATED figure keeps its label. msrp-claim.ts already refuses an
// over/under claim on anything that is not "exact", and relabelling it would
// lose the fact that the DEALER said it. Leave the label, drop the accusation.
{
  const out = applyConditionToMsrp(
    { msrp: 81499, basis: "dealer_stated", trim: null, sourceUrl: null, inflation: INFLATION },
    { vehicleCondition: "used", odometerKm: 61000 },
  );
  check("used + dealer_stated: the honest label is kept", out.basis === "dealer_stated", `basis=${out.basis}`);
  check("used + dealer_stated: the accusation is still dropped", out.inflation === null, JSON.stringify(out.inflation));
  check("used + dealer_stated: no original-when-new figure invented", out.originalMsrp === null);
}

// 10. A model-level floor on a used car is context twice over, and must not
// come back looking like this trim's sticker.
{
  const out = applyConditionToMsrp(
    { msrp: 44995, basis: "starting_at", trim: null, sourceUrl: null },
    { vehicleCondition: "used", odometerKm: 61000, year: 2021 },
  );
  check("used + starting_at -> original_when_new", out.basis === "original_when_new", `basis=${out.basis}`);
}

// 11. No fabrication: a used car with no usable MSRP gets no context figure.
{
  const out = applyConditionToMsrp({ msrp: 0, basis: "exact", trim: "AT4", sourceUrl: null }, { vehicleCondition: "used", odometerKm: 61000 });
  check("used with no usable MSRP -> no invented original figure", out.originalMsrp === null, JSON.stringify(out.originalMsrp));
  check("used with no usable MSRP -> still original_when_new", out.basis === "original_when_new");
}

// 12. The extractor's saleConditionHint travels the same road as saleCondition:
// dealers write "Demonstrator" and "Certified Pre-Owned" as badges, and the
// hint is how that reaches this decision (dealer-model-name-variants).
{
  check("saleConditionHint 'demo' is present tense", msrpIsPresentTense({ saleConditionHint: "demo", odometerKm: 4200 }) === true);
  check("saleConditionHint 'certified' is not", msrpIsPresentTense({ saleConditionHint: "certified", odometerKm: 4200 }) === false);
  check("an explicit saleCondition wins over the hint",
    msrpIsPresentTense({ saleCondition: "used", saleConditionHint: "new", odometerKm: 8 }) === false);
}

console.log(`\n${pass}/${pass + fail} passed${fail ? "  -- FAILING" : "  all green"}`);
process.exit(fail ? 1 : 0);
