// The fees an SM360 dealer states, in its own words, on every vehicle.
//
// SM360's inventory feed carries one sentence per payment option, written by
// the dealer's own pricing setup (read 2026-09-25, Taza Park Volkswagen):
//   "Cash purchase selling price ($49,990.00) includes: Doc Fee ($899.00),
//    AMVIC Levies ($10.00) Plus (GST) & Licensing."
//   "Finance selling price ($50,015.50) includes: Doc Fee ($899.00), PPSA
//    Finance ($25.50), AMVIC Levies ($10.00) (GST) are extra."
// Nothing here is inferred: a fee is a name followed by a dollar figure in
// brackets, inside a sentence that says the selling price INCLUDES it. A
// sentence of any other shape returns null, never a guess. [[missing-beats-wrong]]
import { normalizeFeeLabel } from "./fee-vocab.ts";

const money = (s) => { const n = Number(String(s).replace(/,/g, "")); return Number.isFinite(n) && n > 0 ? n : null; };

export function parseSm360FeesDisclaimer(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  const m = t.match(/^(cash purchase|finance|lease)\b[^()$]*?selling price \(\$([\d,]+(?:\.\d{1,2})?)\) includes:\s*(.*)$/i);
  if (!m) return null;
  const basis = /^cash/i.test(m[1]) ? "cash" : /^finance/i.test(m[1]) ? "finance" : "lease";
  const fees = [];
  for (const f of m[3].matchAll(/([A-Za-z][A-Za-z0-9 &'./-]*?)\s*\(\$([\d,]+(?:\.\d{1,2})?)\)/g)) {
    const name = f[1].trim().replace(/^(and|plus)\s+/i, "");
    const amount = money(f[2]);
    if (name && amount) fees.push({ name, amount, feeLabel: normalizeFeeLabel(name) });
  }
  return { basis, sellingPrice: money(m[2]), fees, insideSellingPrice: true };
}

// Both sentences off one feed vehicle (cash and finance), parsed.
export function sm360VehicleFees(v) {
  const po = v?.paymentOptions || {};
  return [po.cashPurchase?.feesDisclaimer, po.finance?.feesDisclaimer, po.lease?.feesDisclaimer]
    .map(parseSm360FeesDisclaimer).filter(Boolean);
}
