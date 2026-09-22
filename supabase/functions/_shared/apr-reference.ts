// ============================================================================
// apr-reference.ts — "is this rate above one the buyer could get themselves,
// and what does the difference actually cost?"
//
// WHY THIS EXISTS. computeFinancingTrap() already compares the quoted rate to a
// manufacturer PROMO rate, but a promo rate only exists on subvented deals. On
// everything else the report said nothing about the rate at all — and the rate
// is where the money is. A dealership finance manager, asked on the record
// whether he would present 5.74% at a small flat or 6.09% at 4% reserve, said
// he would "present the 6.09 more than likely", and that the dealership "does
// make money by marking up rate". That is a structure, not an accusation: the
// person arranging the loan is paid more when the rate is higher.
//
// SO THE REFERENCE MUST BE ONE THE BUYER CAN OBTAIN WITHOUT US. A posted lender
// rate the buyer can walk in and ask for is checkable by them and revocable by
// nobody. A reference sourced from anything dealer-facing would be a kill
// switch held by the people this check exists to counter.
//
// NEVER AN INVENTED RATE ON EITHER SIDE. On 2026-08-19 a rate that existed only
// in an LLM's read of a page became "20.01% above Ford's advertised 4.99% —
// about $23,275 more over 60 months", printed against a named dealer that had
// published no rate at all. trustedDealerApr() closed that on the quote side;
// this module requires captured provenance on the reference side too. If either
// half is missing the answer is a refusal, never a number.
// ============================================================================

// ONE READER FOR A MISSING NUMBER. A local re-implementation here would be a
// second author for "did we read a number or nothing", and 0% financing is a
// real rate — "we read zero" and "we read nothing" must never collapse.
// [[read-num]]
import { readNum } from "./read-num.js";

/**
 * How old a posted rate may be before we stop comparing against it.
 *
 * A POLICY CHOICE, NOT A MEASUREMENT — said plainly rather than dressed up as
 * one. Posted retail auto rates move with the Bank of Canada's schedule, so a
 * figure from last quarter can be wrong by a point, and a stale reference
 * producing a dollar accusation is exactly the 2026-08-19 shape. 30 days stops
 * that while the daily verification job is what actually keeps the catalogue
 * current. If someone measures how often posted rates really move, re-derive
 * this from that measurement and delete this paragraph.
 */
export const BENCHMARK_STALE_DAYS = 30;

/**
 * A published rate with its provenance.
 *
 * `lender` is required and `sourceUrl` is not, because our two real sources
 * differ: a manufacturer's advertised promo rate is captured per make/model/term
 * with an effective date and no single durable URL, while a lender's posted rate
 * comes off a page the buyer can open. Both are nameable; only one is linkable.
 * A benchmark that can name neither is not a benchmark — see hasProvenance().
 */
export interface AprBenchmark {
  apr: number;
  lender: string;             // who publishes it — named in the report
  capturedOn: string;         // ISO date we read it
  termMin: number;            // the term band this rate is posted for
  termMax: number;
  sourceUrl?: string | null;  // the page the buyer can open, where one exists
  qualifier?: string | null;  // e.g. "on approved credit, new vehicles"
}

/**
 * A rate we cannot attribute is a rate we made up. The 2026-08-19 report cited
 * "Ford's advertised 4.99%" against a page that advertised nothing.
 */
export function hasProvenance(bm: AprBenchmark | null | undefined): boolean {
  if (!bm) return false;
  // ATTRIBUTION ONLY. Whether the capture date is READABLE is a freshness
  // question, answered in the staleness branch: an undated rate is one we
  // cannot show is current, which is "stale", not "we hold nothing". Checking
  // the date here too would collapse two different refusals into the wrong one
  // and tell the buyer we have no rate when we have an undated one.
  return typeof bm.lender === "string" && bm.lender.trim().length > 0;
}

export type AprRefusal =
  | "no_quoted_rate"
  | "no_benchmark"
  | "benchmark_stale"
  | "term_not_covered"
  | "no_loan_amount";

export interface AprClaim {
  checked: boolean;
  comparable: boolean;
  why: AprRefusal | null;
  quotedApr: number | null;
  benchmark: AprBenchmark | null;
  loan: number | null;
  termMonths: number | null;
  overByPts: number | null;      // percentage points above the posted rate
  extraOverTerm: number | null;  // DOLLARS across the whole loan
  extraPerMonth: number | null;  // never non-null unless extraOverTerm is too
}

/** Total interest paid on a level-payment loan. */
export function totalInterestOf(principal: number, annualPct: number, months: number): number {
  if (!(principal > 0) || !(months > 0)) return 0;
  const r = (annualPct / 100) / 12;
  if (r <= 0) return 0;
  const pmt = principal * r / (1 - Math.pow(1 + r, -months));
  return Math.max(0, pmt * months - principal);
}

const daysBetween = (isoA: string, isoB: string): number | null => {
  const a = Date.parse(isoA), b = Date.parse(isoB);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
};

/**
 * Compare a quoted rate to a posted one.
 *
 * `quotedApr` MUST already have passed the trusted-source gate. This module
 * cannot tell an evidenced rate from an invented one and does not pretend to.
 */
export function aprClaim(input: {
  quotedApr: number | null | undefined;
  benchmark: AprBenchmark | null | undefined;
  loan: number | null | undefined;
  termMonths: number | null | undefined;
  today: string;              // ISO date, injected so this stays pure
}): AprClaim {
  const quoted = readNum(input.quotedApr);
  const loan = readNum(input.loan);
  const term = readNum(input.termMonths);
  const bm = input.benchmark ?? null;
  const bmApr = bm ? readNum(bm.apr) : null;
  const base: AprClaim = {
    checked: true, comparable: false, why: null, quotedApr: quoted, benchmark: bm,
    loan, termMonths: term, overByPts: null, extraOverTerm: null, extraPerMonth: null,
  };

  if (quoted === null) return { ...base, why: "no_quoted_rate" };
  // An unattributable reference is not a reference. Checked before the rate
  // itself, because a number with nobody behind it is the whole 2026-08-19 defect.
  if (!bm || bmApr === null || !hasProvenance(bm)) return { ...base, why: "no_benchmark" };

  // An unreadable or future capture date is treated as stale. We cannot show
  // such a figure is current, and an absence is never a pass.
  const age = daysBetween(bm.capturedOn, input.today);
  if (age === null || age < 0 || age > BENCHMARK_STALE_DAYS) return { ...base, why: "benchmark_stale" };

  // A rate posted for 36–60 months says nothing about an 84-month loan, and the
  // longer term is normally the dearer one. Comparing across them would invent
  // a gap out of a term difference — the same error as measuring an all-in
  // asking price against an ex-freight MSRP.
  if (term === null) return { ...base, why: "term_not_covered" };
  if (term < bm.termMin || term > bm.termMax) return { ...base, why: "term_not_covered" };

  const overByPts = Math.round((quoted - bmApr) * 100) / 100;

  // No loan amount: the rate gap is real but its cost is not computable. State
  // the gap; never a dollar figure we did not derive.
  if (loan === null || !(loan > 0)) {
    return { ...base, comparable: true, why: "no_loan_amount", overByPts };
  }

  const extra = Math.round(totalInterestOf(loan, quoted, term) - totalInterestOf(loan, bmApr, term));
  return {
    ...base, comparable: true, overByPts,
    extraOverTerm: extra,
    // THE PER-MONTH FIGURE EXISTS ONLY ALONGSIDE THE TOTAL. It is the industry's
    // framing device. In the exchange that prompted this check a 0.30-point
    // spread was waved off as "$2 a month"; on $30,000 over 72 months it is
    // $4.24 a month and $306 over the loan, and neither man in the argument
    // could do the arithmetic live. See overTerm() in money-over-term.ts, which
    // is the only sanctioned way to render either number.
    extraPerMonth: Math.round((extra / term) * 100) / 100,
  };
}

/** Why we are not making the comparison, in the buyer's language. Ours, not theirs. */
export function aprRefusal(why: AprRefusal | null): string {
  switch (why) {
    case "no_quoted_rate":
      return "This quote does not disclose a finance rate we could verify, so we are not comparing one. Ask what APR you are being offered before you sign anything.";
    case "no_benchmark":
      return "We do not yet hold a published lender rate for a loan of this length, so we are not calling this rate high or low. That is a gap in our catalogue, not a finding about the dealer.";
    case "benchmark_stale":
      return `The published rate we hold is more than ${BENCHMARK_STALE_DAYS} days old. Rates move, so we are not comparing against it.`;
    case "term_not_covered":
      return "We hold no published rate for a loan of this length, and a rate posted for a shorter term would understate the gap. We are not comparing.";
    case "no_loan_amount":
      return "The amount being financed is not stated, so we can show the rate difference but not what it costs.";
    default:
      return "";
  }
}
