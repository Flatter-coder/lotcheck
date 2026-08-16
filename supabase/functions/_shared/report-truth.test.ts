// The two false claims in the Charlesglen report, pinned.
//
// Both were shipped, both survived every existing gate, and both were found by
// Vic reading a PDF rather than by anything we run. Run with:
//   node --experimental-strip-types supabase/functions/_shared/report-truth.test.ts

import { dealerReputationPoint, pointState, pageAbsenceCopy } from "./point-state.ts";
import { stripSettledContradictions, settledTopics } from "./settled-claims.ts";
import { resolveJurisdiction, isAllInJurisdiction } from "./jurisdiction.ts";
import { qualifyMsrpClaim } from "./msrp-claim.ts";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, detail?: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "\n        " + (detail ?? "")}`);
  cond ? pass++ : fail++;
};

// ---------------------------------------------------------------------------
// 1. DEALER REPUTATION — Charlesglen Toyota, 4.7 stars, 5,930 Google reviews.
// ---------------------------------------------------------------------------
const never = dealerReputationPoint(undefined);
check("THE BUG: an unrun lookup must NOT say NOT FOUND",
  never.value === "NOT CHECKED" && never.state === "unchecked", JSON.stringify(never));

check("...and its explanation must not assert anything about the dealer",
  !/no public reviews were found/i.test(never.explain) &&
  /says nothing about the dealer/i.test(never.explain), never.explain);

const ran = dealerReputationPoint({ checked: true, rating: null, reviewCount: 0 });
check("a lookup that RAN and found nothing may say so",
  ran.value === "NONE FOUND" && ran.state === "absent" && /we searched/i.test(ran.explain),
  JSON.stringify(ran));

const found = dealerReputationPoint({ checked: true, rating: 4.7, reviewCount: 5930 });
check("Charlesglen renders its real rating",
  found.value === "4.7* / 5,930" && found.state === "confirmed" && found.tone === "pass",
  JSON.stringify(found));

check("a poor-but-real rating is still confirmed, just not a pass",
  dealerReputationPoint({ checked: true, rating: 2.1, reviewCount: 40 }).tone === "muted",
  "a low rating is a finding, not an absence");

check("presence of a value never IMPLIES the check ran",
  pointState(undefined, true) === "unchecked",
  "inferring `checked` from the value is the bug itself");

check("page-absence copy refuses to assert when the page was unreadable",
  pageAbsenceCopy("addons", false).value === "COULDN'T READ" &&
  pageAbsenceCopy("addons", true).value === "NONE LISTED",
  JSON.stringify(pageAbsenceCopy("addons", false)));

// ---------------------------------------------------------------------------
// 2. THE REBATE CONTRADICTION — verbatim from the shipped report.
// ---------------------------------------------------------------------------
const REAL_SUMMARY =
  "The vehicle overview lists 10 km on the odometer while the description text says 8 km. " +
  "Also flagging that the page's spec sheet labels fuel type simply as 'Hybrid,' but since this is the RAV4 Plug-In Hybrid model, it should be treated as a PHEV for rebate-eligibility purposes -- worth confirming the plug-in battery/charging specs with the dealer.";

const notEligible = { evapRebate: { eligible: false, ineligibleReason: "over price cap" } };
const cleaned = stripSettledContradictions(REAL_SUMMARY, notEligible);

check("THE BUG: the rebate sentence is removed once the panel has ruled",
  !/rebate-eligibility purposes/.test(cleaned.text), cleaned.text);

check("...and the settled fact replaces it",
  /not rebate-eligible/i.test(cleaned.text) && /nothing to confirm/i.test(cleaned.text), cleaned.text);

check("the removal is auditable, not silent",
  cleaned.removed.length === 1 && cleaned.removed[0].topic === "rebate",
  JSON.stringify(cleaned.removed));

check("the REAL page inconsistency survives — it is a genuine finding",
  /10 km/.test(cleaned.text) && /8 km/.test(cleaned.text), cleaned.text);

check("an ELIGIBLE verdict is equally settled and equally protected",
  /confirmed in the EV \/ PHEV rebate section/i.test(
    stripSettledContradictions("You may qualify - worth confirming eligibility with the dealer.",
      { evapRebate: { eligible: true, total: 5000 } }).text),
  "a positive verdict must not be reopened either");

check("with NO rebate verdict computed, nothing is stripped",
  stripSettledContradictions(REAL_SUMMARY, {}).removed.length === 0 &&
  settledTopics({}).length === 0,
  "the guard must not silence a topic the report never answered");

check("ordinary mentions of a rebate are NOT removed",
  /advertises a \$2,000 rebate/.test(
    stripSettledContradictions("The listing advertises a $2,000 rebate as a discount line.", notEligible).text),
  "the matcher must fire on REOPENING, not on any mention");

check("a settled recall check is protected the same way",
  stripSettledContradictions("You should confirm the recall status with the dealer.",
    { recalls: { checked: true, count: 0 } }).removed.length === 1,
  "recalls were checked against Transport Canada — that is not the dealer's to confirm");

// ---------------------------------------------------------------------------
// 3. THE $11,173 THAT WAS REALLY $8,095 — Charlesglen Toyota, Calgary AB.
//
// The trim match was CORRECT: GR SPORT, and $57,500 is its real ex-freight
// MSRP. What broke is the BASIS. The city never extracted, so allInPricing was
// null, null took the ex-freight branch, and Toyota's own $3,078 of freight and
// levies was printed as the dealer's markup.
// ---------------------------------------------------------------------------
check("phone area code alone resolves Alberta",
  resolveJurisdiction({ dealerPhone: "(403) 241-0888" }).code === "AB",
  JSON.stringify(resolveJurisdiction({ dealerPhone: "(403) 241-0888" })));

check("the Google listing line resolves it too",
  resolveJurisdiction({ dealerAddress: "Toyota dealer in Calgary, Alberta" }).code === "AB",
  JSON.stringify(resolveJurisdiction({ dealerAddress: "Toyota dealer in Calgary, Alberta" })));

check("a postal code resolves it",
  resolveJurisdiction({ dealerAddress: "11500 35 St NE, T3N 1A1" }).code === "AB", "postal T = AB");

check("Alberta is an all-in jurisdiction",
  isAllInJurisdiction({ dealerPhone: "(403) 241-0888" }).allIn === true, "AMVIC mandates all-in");

check("with NO signal at all, the answer is NULL — not false",
  isAllInJurisdiction({}).allIn === null,
  "unknown must never collapse into 'not all-in'");

const charlesglen = { msrp: 57500, msrpBasis: "exact", quotedPrice: 68673, priceVerified: true, make: "Toyota" };

const unknownBasis = qualifyMsrpClaim({ ...charlesglen, basisUnknown: true });
check("THE BUG: unknown jurisdiction REFUSES instead of inventing $3,078",
  !unknownBasis.comparable && /could not establish which province/i.test(unknownBasis.refusal || ""),
  JSON.stringify({ comparable: unknownBasis.comparable, delta: unknownBasis.delta }));

const correct = qualifyMsrpClaim({ ...charlesglen, allInPricing: { code: "AB" }, msrpAllIn: 60578 });
check("with the province known and an all-in reference, the gap is $8,095",
  correct.comparable && correct.delta === 8095 && correct.comparedAgainst === "all_in",
  JSON.stringify({ delta: correct.delta, basis: correct.comparedAgainst }));

check("...and never the $11,173 the shipped report printed",
  correct.delta !== 11173, "68,673 - 57,500 counts Toyota's own freight as dealer markup");

const noAllIn = qualifyMsrpClaim({ ...charlesglen, allInPricing: { code: "AB" }, msrpAllIn: null });
check("an all-in province with no all-in reference still refuses",
  !noAllIn.comparable && /freight and fees as markup/i.test(noAllIn.refusal || ""),
  JSON.stringify(noAllIn.refusal));

console.log(`\n${pass}/${pass + fail} passed${fail ? `  — ${fail} FAILING` : "  ✓ all green"}`);
if (fail) (globalThis as any).process?.exit?.(1);
