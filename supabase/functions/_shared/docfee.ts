// ============================================================================
// S12 — Doc-fee vs jurisdiction benchmark (the junk-fee wedge).
//
// FAIL-SAFE + BACKED: only flags when we have a sourced benchmark for the
// vehicle's jurisdiction; otherwise returns null (no over/under claim — never
// a false "this fee is too high"). Facing a dealer, so every claim must be
// backed + neutral (claims-must-stay-backed, defamation-proof-and-compliant).
//
// Two benchmark kinds:
//   allin  — Canadian all-in price advertising (AMVIC/OMVIC/etc.): a separate
//            doc/admin fee should ALREADY be inside the advertised price.
//   cap    — a statutory cap (e.g. TX ~$225): flag if the fee exceeds it.
//   norm   — no cap, a typical/high figure (e.g. FL ~$999): flag if at/over it.
//
// US caps NEED counsel verification + expansion before the US launch (caps
// change) — same officially-sourced discipline as the warranty catalog.
// ============================================================================

import { assessDealerFeeVsCeiling } from "./fee-schedule.ts";

const num = (x: unknown): number | null => { const v = Number(x); return Number.isFinite(v) ? v : null; };

type Benchmark =
  | { type: "allin"; body: string; source: string }
  | { type: "cap"; value: number; note: string; source: string }
  | { type: "norm"; value: number; note: string; source: string };

const BENCHMARKS: Record<string, Benchmark> = {
  // Canada — all-in advertised pricing (a separate doc/admin fee should be in the ad price).
  AB: { type: "allin", body: "AMVIC", source: "https://www.amvic.org/consumers/advertising/" },
  ON: { type: "allin", body: "OMVIC", source: "https://www.omvic.on.ca/" },
  BC: { type: "allin", body: "the VSA (BC)", source: "https://mvsabc.com/" },
  QC: { type: "allin", body: "the OPC (Quebec)", source: "https://www.opc.gouv.qc.ca/" },
  // US — SOURCED (expansion-strategy.md); VERIFY with counsel before US launch.
  TX: { type: "cap", value: 225, note: "OCCC safe-harbor", source: "https://gettruelane.com/articles/dealer-doc-fee-by-state" },
  FL: { type: "norm", value: 999, note: "no statutory cap; ~$999–1,295 is typical", source: "https://gettruelane.com/articles/dealer-doc-fee-by-state" },
};

const NAME_TO_CODE: Record<string, string> = {
  alberta: "AB", ontario: "ON", "british columbia": "BC", quebec: "QC", "québec": "QC",
  texas: "TX", florida: "FL",
};

// Pull a province/state code from a "City, XX" or "City, Province" string.
function jurisdictionOf(dealerCity: unknown): string | null {
  const s = (typeof dealerCity === "string" ? dealerCity : "").trim();
  if (!s) return null;
  const m = s.match(/,\s*([A-Za-z][A-Za-z .]+?)\s*$/);
  const tail = (m ? m[1] : s).trim();
  if (/^[A-Za-z]{2}$/.test(tail)) return tail.toUpperCase();
  const code = NAME_TO_CODE[tail.toLowerCase()];
  return code || null;
}

// Find the doc/admin fee line item in the quote's add-ons.
function findDocFee(items: any[]): { name: string; price: number } | null {
  let best: { name: string; price: number } | null = null;
  for (const it of items) {
    const n = (typeof it?.name === "string" ? it.name : "").toLowerCase();
    const p = num(it?.price);
    if (p == null || p <= 0) continue;
    if (/\b(documentation|doc(\s|-)?fee|admin(istration)?|dealer fees?)\b/.test(n) && (!best || p > best.price)) {
      best = { name: it.name, price: p };
    }
  }
  return best;
}

export interface DocFeeAssessment {
  docFee: number;
  jurisdiction: string;
  kind: "allin" | "over_cap" | "within_cap" | "over_norm";
  benchmark: number | null;   // the cap/norm value
  overBy: number | null;      // amount above the benchmark
  body?: string;              // regulator name (allin)
  note?: string;              // cap/norm note
  source: string;
  // Manufacturer's OWN published maximum dealer fee, attached only when the fee
  // exceeds it. Valid, backed leverage on a NEW vehicle of a make whose ceiling
  // we have captured (fee-schedule.ts). Absent = no sourced ceiling to cite.
  mfrCeiling?: number;        // the published maximum (e.g. Lexus $995, Toyota $999)
  mfrCeilingOverBy?: number;  // observed doc fee − ceiling
  mfrCeilingMake?: string;    // whose ceiling this is
  mfrCeilingSource?: string;  // provenance (manufacturer Build & Price)
}

// All-in advertised-pricing authority for a listing's jurisdiction (Canada).
// Returns the regulator + source when the vehicle sits in an all-in province,
// else null. Unlike assessDocFee (which needs a separate fee line to flag),
// this fires on a CLEAN listing too — so the report can always state the all-in
// safeguard: the advertised price IS the total, only tax/licensing/insurance
// are added after. Reuses the same jurisdiction map, so it stays in lockstep.
export function resolveAllInAuthority(
  dealerCity: unknown,
): { code: string; body: string; source: string } | null {
  const code = jurisdictionOf(dealerCity);
  if (!code) return null;
  const b = BENCHMARKS[code];
  if (!b || b.type !== "allin") return null;
  return { code, body: b.body, source: b.source };
}

export function assessDocFee(analysis: any): DocFeeAssessment | null {
  const items: any[] = Array.isArray(analysis?.addOns) ? analysis.addOns : [];
  const doc = findDocFee(items);
  if (!doc) return null;
  const code = jurisdictionOf(analysis?.dealerCity);
  if (!code) return null;
  const b = BENCHMARKS[code];
  if (!b) return null; // no backed benchmark -> no claim (fail-safe)

  // The manufacturer's OWN published maximum dealer fee — a backed, brand-sourced
  // enrichment on top of the jurisdiction rule. Valid ONLY for a NEW vehicle of a
  // make whose ceiling we captured, in that province: the ceiling governs new
  // sales of that make. For a used car, an uncaptured make, or a fee at/under the
  // ceiling, we attach nothing — missing beats wrong (dealers-are-adversaries).
  const mfr = (analysis?.vehicleCondition === "new" && analysis?.make)
    ? assessDealerFeeVsCeiling(analysis.make, code, doc.price)
    : null;
  const ceiling = (mfr && mfr.over)
    ? { mfrCeiling: mfr.ceiling, mfrCeilingOverBy: mfr.overBy, mfrCeilingMake: String(analysis.make), mfrCeilingSource: mfr.source }
    : {};

  if (b.type === "allin") {
    return { docFee: doc.price, jurisdiction: code, kind: "allin", benchmark: null, overBy: null, body: b.body, source: b.source, ...ceiling };
  }
  if (b.type === "cap") {
    const over = doc.price > b.value;
    return { docFee: doc.price, jurisdiction: code, kind: over ? "over_cap" : "within_cap", benchmark: b.value, overBy: over ? Math.round(doc.price - b.value) : 0, note: b.note, source: b.source, ...ceiling };
  }
  // norm
  const over = doc.price >= b.value;
  return over ? { docFee: doc.price, jurisdiction: code, kind: "over_norm", benchmark: b.value, overBy: Math.round(doc.price - b.value), note: b.note, source: b.source, ...ceiling } : null;
}
