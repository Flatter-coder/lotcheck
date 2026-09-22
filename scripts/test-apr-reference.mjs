// Gate for the APR benchmark check and the total-over-term rule.
//
// Two properties have to hold for as long as these exist:
//   1. A dollar figure appears only when BOTH the quoted rate and a captured,
//      in-date, term-matched published rate are present. Everything else is a
//      refusal. The 2026-08-19 incident was a number printed against a named
//      dealer from a rate nobody had captured.
//   2. A per-month figure never renders without its total. The monthly number
//      is the framing device this check exists to defeat.
import { aprClaim, aprRefusal, totalInterestOf, hasProvenance, BENCHMARK_STALE_DAYS } from "../supabase/functions/_shared/apr-reference.ts";
import { overTerm, statesMonthlyWithoutTotal } from "../supabase/functions/_shared/money-over-term.ts";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const TODAY = "2026-09-22";
const BM = { apr: 5.79, lender: "Test Credit Union", sourceUrl: "https://example.ca/rates", capturedOn: "2026-09-20", termMin: 60, termMax: 84 };

// ---- the arithmetic itself ------------------------------------------------
// $30,000 / 72 months, 5.79% -> 6.09%. Computed independently, not copied from
// the module: this is the exact spread two industry professionals argued over
// and both got wrong ("$2 a month" and "$500").
const c = aprClaim({ quotedApr: 6.09, benchmark: BM, loan: 30000, termMonths: 72, today: TODAY });
check("the comparison is made", c.comparable === true && c.why === null, `why=${c.why}`);
eq("the rate gap is stated in points", c.overByPts, 0.3);
check("the total over the term is $306", c.extraOverTerm === 306, `got ${c.extraOverTerm}`);
check("the per-month figure is $4.25", Math.abs(c.extraPerMonth - 4.25) < 0.01, `got ${c.extraPerMonth}`);
check("neither industry number was right", c.extraOverTerm !== 500 && Math.round(c.extraPerMonth) !== 2);

// A two-point markup on a six-figure car is the number that makes someone ask.
const big = aprClaim({ quotedApr: 8, benchmark: { ...BM, apr: 6 }, loan: 112153, termMonths: 84, today: TODAY });
check("a 2-point markup on $112,153/84mo exceeds $9,000", big.extraOverTerm > 9000 && big.extraOverTerm < 9500, `got ${big.extraOverTerm}`);

// Zero-interest and degenerate inputs must not produce NaN or negatives.
eq("a 0% loan has no interest", totalInterestOf(30000, 0, 72), 0);
eq("a zero-length loan has no interest", totalInterestOf(30000, 6, 0), 0);
eq("a zero principal has no interest", totalInterestOf(0, 6, 72), 0);

// ---- refusals: a missing half is never a number ---------------------------
const refusals = [
  ["no quoted rate", { quotedApr: null, benchmark: BM, loan: 30000, termMonths: 72 }, "no_quoted_rate"],
  ["no benchmark held", { quotedApr: 6.09, benchmark: null, loan: 30000, termMonths: 72 }, "no_benchmark"],
  ["benchmark out of date", { quotedApr: 6.09, benchmark: { ...BM, capturedOn: "2026-01-01" }, loan: 30000, termMonths: 72 }, "benchmark_stale"],
  ["benchmark dated in the future", { quotedApr: 6.09, benchmark: { ...BM, capturedOn: "2027-01-01" }, loan: 30000, termMonths: 72 }, "benchmark_stale"],
  ["benchmark with an unreadable date", { quotedApr: 6.09, benchmark: { ...BM, capturedOn: "soon" }, loan: 30000, termMonths: 72 }, "benchmark_stale"],
  ["term longer than the posted band", { quotedApr: 6.09, benchmark: { ...BM, termMin: 36, termMax: 60 }, loan: 30000, termMonths: 84 }, "term_not_covered"],
  ["term shorter than the posted band", { quotedApr: 6.09, benchmark: { ...BM, termMin: 72, termMax: 84 }, loan: 30000, termMonths: 48 }, "term_not_covered"],
  ["no term stated", { quotedApr: 6.09, benchmark: BM, loan: 30000, termMonths: null }, "term_not_covered"],
];
for (const [name, input, want] of refusals) {
  const r = aprClaim({ ...input, today: TODAY });
  eq(`refuses: ${name}`, r.why, want);
  check(`  ...and prints no dollar figure (${name})`, r.extraOverTerm === null && r.extraPerMonth === null);
  check(`  ...and explains itself (${name})`, aprRefusal(r.why).length > 30);
}

// Exactly at the staleness limit is still usable; one day past is not.
const atLimit = new Date(Date.parse(TODAY) - BENCHMARK_STALE_DAYS * 86400000).toISOString().slice(0, 10);
const pastLimit = new Date(Date.parse(TODAY) - (BENCHMARK_STALE_DAYS + 1) * 86400000).toISOString().slice(0, 10);
check("a benchmark exactly at the age limit is still compared", aprClaim({ quotedApr: 6.09, benchmark: { ...BM, capturedOn: atLimit }, loan: 30000, termMonths: 72, today: TODAY }).comparable === true);
eq("one day past the limit is stale", aprClaim({ quotedApr: 6.09, benchmark: { ...BM, capturedOn: pastLimit }, loan: 30000, termMonths: 72, today: TODAY }).why, "benchmark_stale");

// The rate gap is real without a loan amount; its COST is not.
const noLoan = aprClaim({ quotedApr: 6.09, benchmark: BM, loan: null, termMonths: 72, today: TODAY });
check("without a loan amount the gap is stated but not costed",
  noLoan.overByPts === 0.3 && noLoan.extraOverTerm === null && noLoan.why === "no_loan_amount");

// A rate AT or BELOW the posted rate is a real answer, not a refusal.
const below = aprClaim({ quotedApr: 5.29, benchmark: BM, loan: 30000, termMonths: 72, today: TODAY });
check("a rate below the posted one compares and reads negative", below.comparable === true && below.overByPts === -0.5 && below.extraOverTerm < 0);

// ---- provenance: a rate with nobody behind it is a rate we made up -------
check("a benchmark naming a lender and a date has provenance", hasProvenance(BM) === true);
check("a benchmark with no lender has none", hasProvenance({ ...BM, lender: "" }) === false);
check("a benchmark with a blank lender has none", hasProvenance({ ...BM, lender: "   " }) === false);
// An undated rate IS attributed — it is just not shown to be current, which
// the staleness branch answers. Two refusals, not one.
check("an undated benchmark is still attributed", hasProvenance({ ...BM, capturedOn: "whenever" }) === true);
check("a missing benchmark has none", hasProvenance(null) === false && hasProvenance(undefined) === false);
// A sourceUrl is welcome but not required: an OEM promo rate is captured per
// make/model/term with an effective date and no durable page.
check("no sourceUrl is still usable when the lender is named", hasProvenance({ ...BM, sourceUrl: null }) === true);
for (const bad of [{ ...BM, lender: "" }, { ...BM, lender: "   " }]) {
  const r = aprClaim({ quotedApr: 6.09, benchmark: bad, loan: 30000, termMonths: 72, today: TODAY });
  eq("an unattributable benchmark is refused", r.why, "no_benchmark");
  check("  ...and costs nothing", r.extraOverTerm === null);
}

// ---- the total-over-term rule --------------------------------------------
eq("the total is the default rendering", overTerm(306, 72), "$306 over 72 months");
check("a noun names what the money IS", overTerm(306, 72, { noun: "more in interest" }) === "$306 more in interest over 72 months");
check("the monthly figure only ever follows the total",
  overTerm(306, 72, { withMonthly: true }) === "$306 over 72 months, or $4.25 a month");
check("nothing renders when it cannot be computed",
  overTerm(306, 0) === null && overTerm(null, 72) === null && overTerm(306, null) === null && overTerm("x", 72) === null);

// THE RULE ITSELF. Every string this module can emit must survive its own
// detector — a formatter that produced a violation would be the whole point.
for (const opts of [{}, { withMonthly: true }, { noun: "more in interest" }, { withMonthly: true, noun: "more in interest" }]) {
  const s = overTerm(306, 72, opts);
  check(`overTerm output passes the monthly-alone rule (${JSON.stringify(opts)})`, !statesMonthlyWithoutTotal(s), s);
}
check("a bare monthly figure is caught", statesMonthlyWithoutTotal("just $4.24 a month") === true);
check("a bare /mo figure is caught", statesMonthlyWithoutTotal("only $4.24/mo") === true);
check("a bare 'per month' figure is caught", statesMonthlyWithoutTotal("$4.24 per month more") === true);
check("a monthly figure beside its total passes", statesMonthlyWithoutTotal("$306 over 72 months, or $4.25 a month") === false);
check("a 72-month-loan phrasing also counts as a total", statesMonthlyWithoutTotal("$4.24 a month on a 72-month loan") === false);
check("text with no monthly figure at all is not a violation", statesMonthlyWithoutTotal("$306 in extra interest") === false);
check("empty and missing text are not violations", statesMonthlyWithoutTotal("") === false && statesMonthlyWithoutTotal(null) === false);

// ---- the module's own invariant ------------------------------------------
// extraPerMonth may never be non-null while extraOverTerm is null. That is the
// per-month-alone defect expressed as data rather than as rendered text.
const all = [c, big, noLoan, below, ...refusals.map(([, i]) => aprClaim({ ...i, today: TODAY }))];
check("no result ever carries a per-month figure without a total",
  all.every(r => !(r.extraPerMonth !== null && r.extraOverTerm === null)));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
