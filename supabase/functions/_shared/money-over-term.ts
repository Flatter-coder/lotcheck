// ============================================================================
// money-over-term.ts — a cost spread over a loan is stated as the TOTAL. The
// per-month figure may follow it. It may never appear alone.
//
// WHY THIS IS A RULE AND NOT A PREFERENCE. The monthly number is the car
// industry's framing device, and it works. Asked about the difference between
// 5.79% and 6.09%, a finance manager called it "$2 a month" and the consultant
// arguing with him called it "$500". On $30,000 over 72 months the real answer
// is $4.24 a month and $306 over the loan — both men were wrong, live, about
// their own trade, because a per-month figure is unarguable-sounding and
// nobody can check it in their head.
//
// $4.24 sounds like nothing. $306 does not. On an $112,153 vehicle over 84
// months a two-point markup is $109.65 a month and $9,210 over the loan, and
// only one of those two numbers makes a buyer ask a question.
//
// So every surface renders through overTerm(). scripts/test-over-term.mjs
// fails the build when a per-month figure is rendered without its total.
// ============================================================================

const money = (n: number): string =>
  `$${Math.abs(Math.round(n)).toLocaleString("en-CA")}`;

// Cents matter on a per-month figure and never on a total-over-term figure:
// "$4.24 a month" is checkable against a payment schedule, "$306.48" is noise.
const moneyCents = (n: number): string =>
  `$${Math.abs(n).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface OverTermOpts {
  /** Append the per-month figure after the total. Never renders it alone. */
  withMonthly?: boolean;
  /** What the money IS — "more in interest", "in extra fees". */
  noun?: string;
}

/**
 * The sanctioned rendering of a cost spread across a loan.
 *
 *   overTerm(306, 72)                                  -> "$306 over 72 months"
 *   overTerm(306, 72, { withMonthly: true })           -> "$306 over 72 months, or $4.25 a month"
 *   overTerm(306, 72, { noun: "more in interest" })    -> "$306 more in interest over 72 months"
 *
 * Returns null when it cannot be computed. A caller that gets null prints
 * nothing — it does not fall back to a monthly figure.
 */
export function overTerm(amount: unknown, months: unknown, opts: OverTermOpts = {}): string | null {
  // Number(null) is 0 and Number("") is 0, so a missing amount would render as
  // "$0 over 72 months" — a confident statement that the markup costs nothing.
  // That is the defect family read-num.js exists to close; it is reproduced
  // here because this module is loaded by surfaces that cannot import it.
  const toNum = (v: unknown): number =>
    (v === null || v === undefined || v === "") ? NaN
      : (typeof v === "number" ? v : Number(v));
  const a = toNum(amount);
  const m = toNum(months);
  if (!Number.isFinite(a) || !Number.isFinite(m) || m <= 0) return null;

  const noun = opts.noun ? ` ${opts.noun.trim()}` : "";
  const head = `${money(a)}${noun} over ${Math.round(m)} months`;
  if (!opts.withMonthly) return head;

  // The per-month figure is derived HERE from the same total, so the two can
  // never disagree. A caller computing its own monthly figure is the defect
  // this module exists to prevent.
  return `${head}, or ${moneyCents(a / m)} a month`;
}

/**
 * True when a rendered string states a per-month figure without a total beside
 * it. Exported so the gate and the runtime share one definition rather than
 * two that can drift.
 */
export function statesMonthlyWithoutTotal(text: unknown): boolean {
  const s = String(text ?? "");
  const monthly = /(a month|per month|\/mo\b|monthly payment)/i.test(s);
  if (!monthly) return false;
  // "over 72 months" / "across 84 months" / "72-month" — a stated span.
  const total = /over \d{1,3} months|across \d{1,3} months|\d{1,3}[-\s]month (loan|term)/i.test(s);
  return !total;
}
