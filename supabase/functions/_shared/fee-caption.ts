// A BUNDLED price line is not the dealer's money.
//
// WHAT WENT WRONG. Dealer platforms bundle everything above the vehicle price
// into ONE row with a generic caption. On the real 2026 Lexus NX 350h in report
// LC-46A4-66F the page read:
//
//     MSRP                     58,675
//     Fees & Accessories        3,330      <- one row, one caption
//     Sales Price              62,005      ("+ GST")
//
// "Fees & Accessories" is the PLATFORM's label for its addon slot. It describes
// the slot, not the contents. Decomposed against Lexus Canada's own published
// Alberta figures that $3,330 is:
//
//     Delivery and Destination (freight)   2,205   Lexus
//     Air Conditioning Charge                100   federal excise
//     AMVIC                                   10   provincial regulator
//     Tire Levy                               20   provincial levy
//     Dealer Fees                            995   the dealer -- and it is
//                                                  LEXUS's own published
//                                                  figure, at its ceiling
//                                        -------
//                                          3,330   to the cent
//
// So 70% of it is freight and government charges the dealer collects and
// remits. LotCheck was treating the whole row as dealer markup, in THREE
// independent places, and all three are buyer-facing:
//
//   1. classifyLine() (deal.ts) has no bucket for a mixture. A caption that
//      matches neither regex falls through to `return "addon"` -- "unknown line
//      item on a quote -> worth questioning". Reasonable for an unknown SINGLE
//      charge; wrong for a row that openly says it contains fees.
//   2. totalFlaggedCost is "sum of price for every addOn where verdict is
//      flagged" -- straight from the model. A $3,330 bundle with no breakdown
//      is exactly what a model flags, and the fee point then reads
//      "$3,330 worth questioning".
//   3. buildCounterScript() then hands the buyer a line to READ ALOUD to a
//      named AMVIC licensee:
//        "Please take off the $3,330 in dealer add-ons (Fees & Accessories)
//         -- I don't want them."
//      Verified end-to-end against the real functions: with verdict "flagged"
//      or with no verdict at all, that move fires.
//
// Asking a dealer to remove the manufacturer's freight and the province's tire
// levy, on the grounds that they are the dealer's add-ons, is a false statement
// about that business. [[no-accusation-language]] [[dealers-are-adversaries]]
// This repo has already made the same class of error once, at $11,173 of
// phantom markup -- see the S25 comment in analyze-listing-url/index.ts,
// "printing Toyota's own $3,078 of freight as dealer markup".
//
// THE RULE. A caption that names a PASS-THROUGH category and joins it to
// something else cannot be attributed to any single payee. We do not know the
// split, so we do not claim one: the line is carried as a cost added on top,
// never as dealer markup, and the buyer is told to ask for it itemised -- which
// is the request that actually gets them the answer. [[missing-beats-wrong]]
//
// This normalises ONCE, server-side, before any consumer runs, so
// classifyLine, totalFlaggedCost, the counter-script and every render surface
// inherit the same correction instead of each needing its own fix.

// Words that name money the dealer collects on someone else's behalf, or a
// generic "fee" bucket. Deliberately broad: a caption containing any of these
// is making a claim about pass-through costs.
const PASS_THROUGH = /\b(fees?|levy|levies|tax(es)?|dut(y|ies)|freight|pdi|destination|delivery|registration|licen[sc]e|government|governmental|environmental|tire|a\/?c|air\s?conditioning|amvic|omvic|excise|surcharge|charges?)\b/i;

// A caption joining two or more things: "&", "and", "/", "+", or a comma.
const CONJUNCTION = /(\s(?:&|and|\+|,)\s)|&|\/|\+/i;

// Captions that are a single named pass-through, not a mixture. "Freight and
// PDI" is two pass-throughs and nothing else -- bundling it changes nothing,
// but it is also not a mixture of PAYEES, so it is left to classifyLine.
const SINGLE_PAYEE_PAIR = /^\s*(freight\s*(?:&|and|\/|\+)\s*pdi|pdi\s*(?:&|and|\/|\+)\s*freight|delivery\s*(?:&|and|\/|\+)\s*destination)\s*$/i;

/**
 * Does this caption denote a MIXTURE that includes pass-through money?
 *
 * True only when the caption both (a) names a pass-through category and
 * (b) joins it to something else. One condition alone is not enough:
 *   "Dealer Fees"                  -> false (no conjunction; it IS the dealer's)
 *   "Protection & Appearance Pkg"  -> false (a conjunction, but no pass-through)
 *   "Fees & Accessories"           -> TRUE
 *   "Taxes, Fees & Levies"         -> TRUE
 */
export function isBundledFeeCaption(name: unknown): boolean {
  const n = String(name ?? "").trim();
  if (!n) return false;
  if (SINGLE_PAYEE_PAIR.test(n)) return false;
  return PASS_THROUGH.test(n) && CONJUNCTION.test(n);
}

/** What the buyer is asked to do about a line we cannot attribute. */
export function bundledItemisationAsk(name: unknown, price: unknown): string {
  const p = Number(price);
  const amount = Number.isFinite(p) && p > 0
    ? `$${Math.round(p).toLocaleString("en-CA")}`
    : "that line";
  const label = String(name ?? "").trim();
  return `Please itemise ${amount}${label ? ` ("${label}")` : ""} in writing — freight, ` +
    `the dealer's administration fee, and government levies as separate lines. ` +
    `I want to see which parts are set by the manufacturer or the province and which are yours.`;
}

export interface BundledNormalisation {
  changed: boolean;
  lines: Array<{ name: string; price: number | null }>;
  flaggedRemoved: number;
}

/**
 * Normalise an analysis IN PLACE so no consumer can attribute a bundled line to
 * the dealer.
 *
 * For every addOn whose caption is a mixture:
 *   - `bundled` is set, so renderers and classifiers can see it;
 *   - a "flagged" verdict is demoted to "standard" -- flagged means "this is
 *     worth questioning as an add-on", and we have no basis to say that of
 *     money that is mostly not the dealer's;
 *   - `kind` is set to "fee", the pass-through bucket.
 *
 * totalFlaggedCost is then RECOMPUTED from the surviving flagged lines, because
 * the model supplies that total itself and it would otherwise keep the money we
 * just declined to attribute.
 *
 * Returns what changed so the caller can log it and so a gate can assert the
 * call actually happened.
 */
export function normaliseBundledAddOns(analysis: any): BundledNormalisation {
  const out: BundledNormalisation = { changed: false, lines: [], flaggedRemoved: 0 };
  const items = Array.isArray(analysis?.addOns) ? analysis.addOns : [];
  if (!items.length) return out;

  for (const it of items) {
    if (!it || !isBundledFeeCaption(it.name)) continue;
    const price = Number(it.price);
    out.lines.push({ name: String(it.name), price: Number.isFinite(price) ? price : null });
    out.changed = true;
    it.bundled = true;
    if (it.verdict === "flagged") {
      out.flaggedRemoved += Number.isFinite(price) ? price : 0;
      it.verdict = "standard";
    }
    it.kind = "fee";
    // The model's stated reason argued the line was suspicious. Replace it with
    // what is actually true and checkable, so nothing downstream renders a
    // rationale for a claim we are no longer making.
    it.reason = "The dealer's platform bundles several charges into this one row, so it cannot be " +
      "attributed to any single party without an itemisation — it typically contains manufacturer " +
      "freight and government levies as well as the dealer's own fee.";
  }

  if (out.changed) {
    const flagged = items
      .filter((x: any) => x && x.verdict === "flagged")
      .reduce((s: number, x: any) => s + (Number(x.price) || 0), 0);
    analysis.totalFlaggedCost = Math.round(flagged * 100) / 100;
    analysis.bundledFeeLines = out.lines;
  }
  return out;
}
