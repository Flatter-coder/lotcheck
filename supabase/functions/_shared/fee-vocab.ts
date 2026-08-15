// ============================================================================
// Quote-Data Flywheel — Phase 1: fee normalization + de-identified projection.
//
// The moat (see lotcheck-strategy-memo.md / quote-data-flywheel-scope.md): turn
// every analyzed quote into anonymous dealer-fee intelligence no seller-aligned
// incumbent can assemble.
//
// PHASE 1 STORES NOTHING. This module only (a) normalizes raw fee/add-on names
// to a controlled vocabulary so "Nitrogen Tire Fill" and "N2 fill" roll up, and
// (b) projects an analysis into DE-IDENTIFIED fee observations — NO buyer, NO
// VIN, NO odometer, NO trim-level unit, NO free text. The caller logs these
// (behind a flag) to validate the vocabulary. The actual capture (writing rows)
// is Phase 3 and is gated on legal sign-off (PIPA/PIPEDA/CPA).
// ============================================================================

export interface FeeObservation {
  dealer_id: string;        // opaque hash of dealer name+city (a business, not a person)
  region: string | null;    // coarse geo only, e.g. "Calgary, AB"
  make_segment: string | null; // e.g. "Hyundai / BEV" — NO trim, NO VIN
  fee_label: string;        // normalized controlled-vocabulary label
  amount: number;           // the fee $
  verdict: string | null;   // "flagged" | "standard" | ... from the analyzer
  observed_at: string;      // DATE ONLY (YYYY-MM-DD) — no time-of-day
}

// Controlled vocabulary. First matching entry wins; order = most specific first.
// Keep labels stable — they are the join keys for every downstream benchmark.
const FEE_RULES: Array<[RegExp, string]> = [
  [/\b(nitrogen|n2)\b/i, "nitrogen"],
  [/(market\s*(value\s*)?adjustment|additional\s*dealer\s*mark|^adm\b|dealer\s*mark[- ]?up)/i, "market_adjustment"],
  [/\brecon(dition(ing)?)?\b/i, "reconditioning"],
  [/(doc(ument(ation)?)?)\s*(fee|charge)|^doc\b/i, "documentation"],
  [/admin(istration|istrative)?\s*(fee|charge)?/i, "admin"],
  [/(paint|fabric|interior|exterior|appearance|protection\s*package|ceramic|sealant)/i, "protection_pkg"],
  [/(rust|undercoat|corrosion|rustproof)/i, "rustproofing"],
  [/(tire\s*&?\s*(and)?\s*(wheel|rim)|wheel\s*&?\s*(and)?\s*tire|road\s*hazard)/i, "tire_wheel"],
  [/(theft|vin\s*etch|anti[- ]?theft|window\s*etch)/i, "theft_protection"],
  [/(gap|guaranteed\s*asset)/i, "gap"],
  [/(extended\s*warranty|service\s*contract|protection\s*plan|mechanical\s*breakdown|vsc\b)/i, "extended_warranty"],
  [/(freight|pdi|pre[- ]?delivery|destination|transport)/i, "freight_pdi"],
  [/(amvic|omvic|regulatory|licen[sc]\w*|registration)/i, "regulatory"],
  [/(tire\s*(levy|tax|fee|recycl)|environmental|green\s*levy|(a\/?c|air\s*condition\w*)\s*tax|luxury\s*tax|excise)/i, "levy_tax"],
  [/(block\s*heater|wheel\s*lock|cargo|mats|accessor)/i, "accessories"],
  [/(delivery|dealer\s*prep|preparation)/i, "delivery_prep"],
];

export function normalizeFeeLabel(raw: unknown): string {
  const s = String(raw || "").trim();
  if (!s) return "unlabeled";
  for (const [re, label] of FEE_RULES) if (re.test(s)) return label;
  return "other";
}

// Opaque, stable, non-reversible id for a DEALER (a business — not personal
// data). FNV-1a over lowercased "name|city".
export function dealerId(name?: string | null, city?: string | null): string {
  const key = `${String(name || "").toLowerCase().trim()}|${String(city || "").toLowerCase().trim()}`;
  if (!key.replace("|", "")) return "unknown";
  let h = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return "d_" + (h >>> 0).toString(16).padStart(8, "0");
}

// Project an analysis into de-identified fee observations. Emits ONLY the
// fields above — nothing that identifies the buyer or the specific vehicle.
export function buildFeeObservations(a: any): FeeObservation[] {
  if (!a || !Array.isArray(a.addOns)) return [];
  const region = (a.dealerCity && String(a.dealerCity).trim()) || null;
  const dealer_id = dealerId(a.dealerName, a.dealerCity);
  const make_segment = [a.make, a.fuelType].filter(Boolean).join(" / ") || null;
  const observed_at = String(a.issuedAt || new Date().toISOString()).slice(0, 10);
  const out: FeeObservation[] = [];
  for (const x of a.addOns) {
    const amount = Number(x?.price);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    out.push({ dealer_id, region, make_segment, fee_label: normalizeFeeLabel(x?.name), amount, verdict: x?.verdict ?? null, observed_at });
  }
  return out;
}
