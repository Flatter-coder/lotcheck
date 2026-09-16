// The two false claims in the Charlesglen report, pinned.
//
// Both were shipped, both survived every existing gate, and both were found by
// Vic reading a PDF rather than by anything we run. Run with:
//   node --experimental-strip-types supabase/functions/_shared/report-truth.test.ts

import { dealerReputationPoint, pointState, pageAbsenceCopy } from "./point-state.ts";
import { stripSettledContradictions, settledTopics } from "./settled-claims.ts";
import { sanitiseSummary } from "./settled-claims.ts";
import { canadianiseTerms } from "./canada-terms.ts";
import { resolveJurisdiction, isAllInJurisdiction, resolveCity } from "./jurisdiction.ts";
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

// ---------------------------------------------------------------------------
// 4. THE CITY THAT WAS SITTING IN THE HOSTNAME. Stampede Toyota came back
// "NOT CHECKED" with 3,369 Google reviews, partly because the reputation
// lookup received dealerCity: null. A dealer domain runs the words together,
// so a word-boundary match never saw it.
// ---------------------------------------------------------------------------
const stampede = { dealerName: "Stampede Toyota", url: "https://www.stampedetoyotacalgary.com/inventory/x" };

check("city is recovered from a run-together dealer domain",
  resolveCity(stampede) === "Calgary", String(resolveCity(stampede)));

check("...and so is the province, from that same hostname",
  resolveJurisdiction(stampede).code === "AB", JSON.stringify(resolveJurisdiction(stampede)));

check("an explicit dealerCity always wins over inference",
  resolveCity({ dealerCity: "Red Deer", url: "https://somethingcalgary.com/x" }) === "Red Deer",
  "a value we were given must never be overridden by a guess");

check("no city signal returns null rather than a plausible guess",
  resolveCity({ dealerName: "Some Motors", url: "https://example.com/x" }) === null,
  "Places disambiguates better with nothing than with a wrong city");


// ── the verdict must not send a buyer to ask for what we hold ────────
// Real report, 2026 Lexus NX 350 F SPORT 3 AWD, Lexus of Edmonton, advertised
// $72,010. We hold Lexus's own published Alberta all-in for that exact
// configuration -- $71,985.18 -- and the verdict still told the buyer to go ask
// the dealer to itemise MSRP, freight and fees.
const NX_SUMMARY = "This is a new, essentially undriven (90 km) 2026 Lexus NX 350 F SPORT 3 AWD advertised at $72,010, with a disclosed $13,573 Installed Options line that appears to already be baked into that advertised price rather than added on top -- no separate base MSRP or discount was shown on the page, so ask the dealer to itemize MSRP, freight/PDI, and any fees (GST/title/tags are explicitly excluded per the page own disclaimer) before signing.";
const NX_A = { make: "Lexus", msrpBasis: "exact", msrpAllIn: 71985.18 };

{
  const r = sanitiseSummary(NX_SUMMARY, NX_A);
  check("the ask-the-dealer-to-itemise sentence is removed when we hold the figure",
    r.removed.some((x) => x.topic === "msrp_itemisation"), JSON.stringify(r.removed));
  check("...and the published all-in replaces it, to the cent",
    r.text.includes("$71,985.18"), r.text);
  check("...naming the make, so the figure has an author",
    r.text.includes("Lexus publishes this exact configuration"), r.text);
  check("US paperwork terms never reach a Canadian buyer",
    !/title\/tags/i.test(r.text) && !/\bDMV\b/.test(r.text), r.text);
  check("...and the swap is recorded rather than silent",
    r.swapped.some((x) => x.from.toLowerCase() === "title/tags"), JSON.stringify(r.swapped));
}

// FAIL-SAFE: with no exact configuration match the summary is RIGHT to send the
// buyer asking, and must be left alone.
check("no exact match -> the ask survives untouched",
  sanitiseSummary(NX_SUMMARY, { make: "Lexus" }).removed.length === 0,
  "we hold nothing, so asking the dealer is the correct advice");
check("an exact trim with no all-in figure -> still left alone",
  sanitiseSummary(NX_SUMMARY, { make: "Lexus", msrpBasis: "exact", msrpAllIn: null }).removed.length === 0,
  "an exact match without an all-in cannot answer an all-in question");

// FOUND BY MUTATION: forcing `exact = true` left every test green, because the
// only no-fire case also had no all-in. A non-exact basis must block it alone.
check("an all-in figure with a NON-exact basis -> still left alone",
  sanitiseSummary(NX_SUMMARY, { make: "Lexus", msrpBasis: "starting_at", msrpAllIn: 71985.18 }).removed.length === 0,
  "a starting-at basis cannot pin the configuration, so the ask is still right");

// ALSO FOUND BY MUTATION: emptying the terminology list left the US-terms
// assertion green, because the settled-topic pass had already deleted the
// sentence carrying them -- a deleted surface passes every negative check
// written about it. This summary has the terminology and nothing to remove.
{
  const onlyTerms = sanitiseSummary("Budget for GST/title/tags on top, and take the paperwork to the DMV.", NX_A);
  check("terminology alone is repaired, with no sentence removed",
    onlyTerms.removed.length === 0 && onlyTerms.swapped.length === 2, JSON.stringify(onlyTerms));
  check("...and the Canadian wording is what the buyer reads",
    onlyTerms.text === "Budget for GST/registration and licensing on top, and take the paperwork to the provincial registry.",
    onlyTerms.text);
}

// The terminology pass is narrow on purpose.
check("clean Canadian copy is not rewritten",
  canadianiseTerms("Confirm the AMVIC all-in advertised price and the registration cost.").swapped.length === 0,
  "a rewrite that fires on correct copy is worse than the term it chased");
check("the state of the vehicle is not treated as a US state",
  canadianiseTerms("Ask about the state of the vehicle before signing.").swapped.length === 0,
  "state has a legitimate general use and is deliberately not in the list");

console.log(`\n${pass}/${pass + fail} passed${fail ? `  — ${fail} FAILING` : "  ✓ all green"}`);
if (fail) (globalThis as any).process?.exit?.(1);
