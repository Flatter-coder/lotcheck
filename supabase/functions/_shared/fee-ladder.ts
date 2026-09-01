// ============================================================================
// THE DEALER'S OWN PRICE LADDER, read off the page.
//
// WHY THIS EXISTS. Vic pasted a used 2025 GMC Acadia at Advantage Ford and the
// report told him:
//
//     Add-ons & fee audit -- NONE LISTED
//     "No dealer extras were itemized."
//
// The page itemises them, in a box beside the price:
//
//     Market Price      $51,999
//     Doc Fee            +$899
//     AMVIC fee           +$10
//     Dealer Discount  -$3,009
//     Your Price        $49,899
//
// which reconciles to the cent. We told a buyer there was nothing to see on a
// page that shows an $899 documentation fee -- the single most negotiable line
// on the whole worksheet, and exactly the data [[fee-catalog]] and
// [[used-market-fee-tracking]] exist to collect. The leverage score was then
// computed from "no flagged fees", so the miss propagated into the number.
//
// The cause: that report came off the JSON-LD fallback path, and a fee box is
// rendered HTML, not schema.org markup. The fallback already reads days-on-lot
// and price-gating straight out of the HTML it holds; it simply never read this.
//
// THE SAFETY PROPERTY, and it is the whole design: A LADDER IS ONLY CLAIMED
// WHEN THE ARITHMETIC CLOSES. base + additions - deductions must equal the
// advertised total, to the dollar. That is a self-check no heuristic can fake:
// if we mislabelled a line, grabbed a monthly payment, or caught a neighbouring
// vehicle's price, the sum will not land and we return null and say nothing.
//
// A half-read ladder is worse than no ladder. Naming a fee that is not there,
// or missing one that is, both end with a buyer at a desk quoting us. Missing
// beats wrong. [[dealers-are-adversaries]] [[make-it-dispute-proof]]
// ============================================================================

import { normalizeFeeLabel } from "./fee-vocab.ts";

export type LadderKind = "base" | "add" | "deduct" | "total";

export interface LadderLine {
  /** The label exactly as the page prints it. */
  label: string;
  /** Always positive. `kind` carries the direction. */
  amount: number;
  kind: LadderKind;
  /** Controlled vocabulary from fee-vocab, so this joins the fee flywheel. */
  feeLabel: string;
  /**
   * A levy the dealer collects for someone else (AMVIC, tire levy, air-tax) is
   * NOT theirs to waive, and telling a buyer to negotiate it wastes the one
   * conversation they get. [[fee-decomposition-and-capture]]
   */
  dealerCharge: boolean;
}

export interface FeeLadder {
  base: number;
  total: number;
  lines: LadderLine[];
  /** Always true on a returned ladder -- kept explicit so callers can assert it. */
  reconciles: boolean;
}

// A base is what the ladder counts UP or DOWN from. "MSRP" is deliberately
// absent: on a used vehicle it is not the basis of anything, and on a new one
// it is handled by the msrp-claim path with its own authority rules.
const BASE_LABELS = /\b(market\s*price|retail\s*price|regular\s*price|list\s*price|was\s*price|asking\s*price|price\s*before)\b/i;
// The advertised number a buyer would actually write down.
const TOTAL_LABELS = /\b(your\s*price|our\s*price|sale\s*price|selling\s*price|today'?s\s*(best\s*)?price|final\s*price|cash\s*price|now\s*only|internet\s*price)\b/i;
// Words that mean the amount comes OFF, whatever sign the page printed.
const DEDUCT_LABELS = /\b(discount|savings?|rebate|credit|incentive|off|reduction|allowance)\b/i;
// Amounts that are not part of a cash ladder at all.
const PAYMENT_NOISE = /\b(bi[- ]?weekly|weekly|monthly|\/\s*mo\b|per\s*month|o\.?a\.?c|apr|financ|lease|payment|term|down)\b/i;

const money = (s: string): number | null => {
  const n = Number(String(s).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

/**
 * Read the price ladder out of a page's visible text.
 *
 * Returns null unless a base, a total and at least one adjustment were all
 * found AND the arithmetic closes exactly. Callers may treat a non-null result
 * as the dealer's own published breakdown.
 */
export function readFeeLadder(text: unknown): FeeLadder | null {
  const raw = typeof text === "string" ? text : "";
  if (raw.length < 40) return null;

  // Collapse markup and whitespace so a label and its amount sit adjacent
  // whatever table, list or div the dealer's platform wrapped them in.
  const flat = raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;?/gi, " ")
    .replace(/[|*•·]+/g, " ")
    // Markdown-escaped minus signs ("Discount \-$2,500") reach us from any
    // reader that produced markdown. The backslash is not part of the number
    // and would otherwise split the label from its amount.
    .replace(/\\/g, " ")
    .replace(/\s+/g, " ");

  // label ... optional sign ... $amount. The label window is bounded so a match
  // cannot reach back across half the page and adopt an unrelated heading.
  // A REAL MONEY PATTERN, not "three or more digits". The first draft required
  // 3+ digits and therefore skipped the AMVIC levy -- "+$10" -- on the very
  // page this module was written for. The ladder then missed by exactly $10,
  // failed to reconcile, and correctly published nothing: the safety check
  // caught the parser's own bug before a buyer ever saw it. Small amounts are
  // admitted now, and the reconciliation is what keeps noise out.
  const PAIR = /([A-Za-z][A-Za-z'&./ -]{2,38}?)\s*[:–—-]?\s*(\+|-|−|\-)?\s*\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d{1,6}(?:\.\d{2})?)(?!\s*\/)/g;

  let base: number | null = null;
  let total: number | null = null;
  const lines: LadderLine[] = [];
  const seen = new Set<string>();

  for (const m of flat.matchAll(PAIR)) {
    const label = m[1].trim().replace(/\s+/g, " ");
    const sign = m[2] || "";
    const amount = money(m[3]);
    if (amount == null) continue;

    // A financing figure is not a cash-ladder line.
    if (PAYMENT_NOISE.test(label)) continue;

    if (BASE_LABELS.test(label)) { if (base == null) base = amount; continue; }
    if (TOTAL_LABELS.test(label)) { if (total == null) total = amount; continue; }

    // "$341.10 / bi-weekly" puts the disqualifier AFTER the amount, so an
    // adjustment candidate is also judged on the few characters that follow it.
    //
    // This test deliberately runs AFTER the base/total checks, and the first
    // draft had it before -- which disqualified "Your Price $49,899" on a page
    // whose next line happened to be "Payment $412.00". Losing the total meant
    // losing the whole ladder, so a financing figure ELSEWHERE ON THE PAGE
    // silently suppressed a fee box that read perfectly. Narrow window, and
    // only where the ambiguity actually exists.
    const after = flat.slice(m.index + m[0].length, m.index + m[0].length + 16);
    if (PAYMENT_NOISE.test(after)) continue;

    // Everything else is an adjustment, and only if the page marked it as one.
    // An unsigned, undeducted number next to a label is just a number on a page
    // -- a trade-in estimate, a payment, another vehicle -- and guessing its
    // direction is how a ladder stops reconciling.
    const isDeduct = DEDUCT_LABELS.test(label) || /^(-|−|\\-)$/.test(sign);
    const isAdd = sign === "+";
    if (!isDeduct && !isAdd) continue;

    const key = `${label.toLowerCase()}|${amount}`;
    if (seen.has(key)) continue;      // platforms repeat the box for mobile
    seen.add(key);

    const feeLabel = normalizeFeeLabel(label);
    lines.push({
      label,
      amount,
      kind: isDeduct ? "deduct" : "add",
      feeLabel,
      // Regulator levies and government taxes pass through the dealer; the
      // rest are the dealer's own charge and are the ones worth discussing.
      dealerCharge: isDeduct ? false : feeLabel !== "regulatory" && feeLabel !== "levy_tax",
    });
  }

  if (base == null || total == null || lines.length === 0) return null;

  const sum = lines.reduce((t, l) => t + (l.kind === "add" ? l.amount : -l.amount), base);
  // Exact. Not "close enough" -- a tolerance is a licence to publish a ladder
  // we did not actually understand.
  if (sum !== total) return null;

  return { base, total, lines, reconciles: true };
}

/**
 * The dealer's own charges, as the add-ons audit consumes them.
 * Deductions and pass-through levies are excluded: a discount is not an add-on,
 * and a regulator's levy is not the dealer's money.
 */
export function ladderFees(ladder: FeeLadder | null): Array<{ name: string; amount: number; feeLabel: string }> {
  if (!ladder) return [];
  return ladder.lines
    .filter((l) => l.kind === "add" && l.dealerCharge)
    .map((l) => ({ name: l.label, amount: l.amount, feeLabel: l.feeLabel }));
}
