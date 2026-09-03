// ============================================================================
// cpo.ts — Certified Pre-Owned program catalog + "certified" claim check.
//
// WHY. A used listing badged "certified" means one of two very different things:
//   1. a real MANUFACTURER CPO program — factory-backed powertrain-warranty
//      extension, a mandated multi-point inspection, recall repairs done; or
//   2. a dealer's own "in-house certified" — no factory warranty, just the
//      dealer's word.
// The premium a buyer pays is only justified by (1). This catalog holds each
// OEM program's official terms so the report can confirm the badge and show
// what certification actually buys.
//
// NO CERTIFICATION FEE. No manufacturer charges a separate line-item
// certification fee — verified across seven programs (2026-08). CPO is a PRICE
// PREMIUM baked into the asking price (~$1,500–$2,000 mass-market, more on
// luxury, per the APA), not an itemized charge. So we never show a "cert fee";
// we show what the premium buys and let the buyer weigh it against comparables.
//
// USED-FEE BENCHMARK (separate, and already handled). No Canadian province caps
// a used-car admin/doc fee amount (AMVIC/OMVIC/VSA/OPC). The only backed
// reference is the all-in advertised-pricing rule — the fee must already be
// INSIDE the advertised price — which docfee.ts's "allin" finding enforces for
// any condition. There is nothing new to build for that here.
//
// Figures are from each manufacturer's official CPO page where sourceKind is
// "official"; Hyundai is dealer-network only (secondary) pending an official
// capture. Eligibility is used only as a SOFT reference, never a hard
// accusation — programs change and some brands don't publish thresholds.
// ============================================================================

export interface CpoProgram {
  make: string;
  program: string;
  maxAgeYears: number | null;    // null = not published
  maxKm: number | null;          // null = not published
  powertrain: string | null;     // the CPO powertrain coverage, described
  inspectionPoints: number | null;
  exchange: string | null;       // exchange privilege
  source: string;
  sourceKind: "official" | "secondary";
  capturedOn: string;
  note?: string;
}

const num = (x: unknown): number | null => { const v = Number(x); return Number.isFinite(v) ? v : null; };
const norm = (s: unknown): string => String(s ?? "").trim().toLowerCase();

const PROGRAMS: CpoProgram[] = [
  { make: "Toyota", program: "Toyota Certified Used Vehicles (TCUV)", maxAgeYears: null, maxKm: null,
    powertrain: "minimum 6-month / 10,000 km powertrain, $0 deductible", inspectionPoints: 160, exchange: "7-day / 1,500 km exchange",
    source: "certified.toyota.ca", sourceKind: "official", capturedOn: "2026-08-26",
    note: "Toyota Canada does not publish age/km eligibility thresholds (dealer confirms)." },
  { make: "Honda", program: "Honda Certified Pre-Owned", maxAgeYears: 5, maxKm: 150000,
    powertrain: "7-year / 160,000 km powertrain (from original in-service date)", inspectionPoints: null, exchange: "7-day / 1,000 km exchange",
    source: "cuv.honda.ca", sourceKind: "official", capturedOn: "2026-08-26",
    note: "Older/higher-km cars fall under the separate Honda Approved Pre-Owned tier (180-day / 12,000 km only). Canadian inspection-point count not published." },
  { make: "Hyundai", program: "H-Promise Certified Pre-Owned", maxAgeYears: 6, maxKm: 120000,
    powertrain: "6-year / 120,000 km powertrain (1yr/20,000 km over factory)", inspectionPoints: null, exchange: "30-day / 2,000 km exchange",
    source: "Hyundai dealer network (H-Promise)", sourceKind: "secondary", capturedOn: "2026-08-26",
    note: "Verify against hyundaicanada.com; dealer sources give the inspection count as both 120 and 'up to 195', so it is left unstated." },
  { make: "Ford", program: "Ford Blue Advantage (Gold / Blue Certified)", maxAgeYears: 6, maxKm: 160000,
    powertrain: "Ford-backed Extended Service Plan included (Gold: 24-month / 40,000 km ESP)", inspectionPoints: 172, exchange: null,
    source: "ford.ca/certified-used", sourceKind: "official", capturedOn: "2026-08-26",
    note: "Two tiers — Gold (factory-backed ESP) vs Blue; confirm which applies." },
  { make: "Chevrolet", program: "GM Certified Pre-Owned", maxAgeYears: 6, maxKm: null,
    powertrain: "3-month / 5,000 km minimum, or the remainder of the factory warranty (QC: 6-month / 10,000 km)", inspectionPoints: 150, exchange: "30-day / 2,500 km exchange",
    source: "chevrolet.ca/en/certified-pre-owned", sourceKind: "official", capturedOn: "2026-08-26",
    note: "GM-wide (Chevrolet/Buick/GMC/Cadillac). Open recalls must be repaired before certification." },
  { make: "Mazda", program: "Mazda Certified Pre-Owned", maxAgeYears: 6, maxKm: 120000,
    powertrain: "minimum 6-month / 10,000 km powertrain, $0 deductible", inspectionPoints: 160, exchange: null,
    source: "cpo.mazda.ca", sourceKind: "official", capturedOn: "2026-08-26" },
  { make: "BMW", program: "BMW Certified Series", maxAgeYears: 5, maxKm: 120000,
    powertrain: "minimum 1 year (balance of the New Vehicle Limited Warranty, up to 4yr/80,000 km, or an extension)", inspectionPoints: null, exchange: null,
    source: "bmw.ca/cpo", sourceKind: "official", capturedOn: "2026-08-26" },
];

// GM's CPO program is one program across its brands; resolve the GM siblings to it.
const GM_SIBLINGS = new Set(["buick", "gmc", "cadillac"]);

/** The OEM CPO program for a make, or null if we have not cataloged one (null
 *  means "not in our catalog", NEVER "no OEM program exists" — do not infer
 *  in-house certification from a null). */
export function resolveCpoProgram(make: string): CpoProgram | null {
  const m = norm(make);
  const direct = PROGRAMS.find((p) => norm(p.make) === m);
  if (direct) return direct;
  if (GM_SIBLINGS.has(m)) {
    const gm = PROGRAMS.find((p) => norm(p.make) === "chevrolet");
    return gm ? { ...gm, make: String(make) } : null;
  }
  return null;
}

/** Assess a "certified" listing against the make's OEM CPO program. Returns null
 *  for a make we have not cataloged (we don't know its program — stay silent, do
 *  NOT cry "in-house"). For a cataloged make, returns what the OEM program
 *  includes plus a SOFT eligibility concern only when the figure is official and
 *  the vehicle clearly falls outside it. Data only — the caller writes neutral
 *  copy ("confirm this is [program], not a dealer in-house certification"). */
export function assessCertifiedClaim(input: {
  make: string;
  odometerKm?: number | null;
  modelYear?: number | null;
  currentYear?: number | null;
}): {
  make: string;
  program: string;
  powertrain: string | null;
  inspectionPoints: number | null;
  exchange: string | null;
  eligibilityConcern: string | null;
  source: string;
  sourceKind: "official" | "secondary";
  note?: string;
} | null {
  const p = resolveCpoProgram(input.make);
  if (!p) return null;

  // num() here is the coercing kind, so a listing with no odometer arrived as
  // 0 km and the certified-premium comparison was built around a reading the
  // page never published. [[read-num]]
  const odo = input.odometerKm == null ? null : num(input.odometerKm);
  const my = num(input.modelYear);
  const cy = num(input.currentYear);
  const age = (my != null && cy != null) ? cy - my : null;

  let eligibilityConcern: string | null = null;
  if (p.sourceKind === "official") {
    if (p.maxKm != null && odo != null && odo > p.maxKm) {
      eligibilityConcern = `${odo.toLocaleString("en-CA")} km is beyond ${p.program}'s ${p.maxKm.toLocaleString("en-CA")} km limit`;
    } else if (p.maxAgeYears != null && age != null && age > p.maxAgeYears) {
      eligibilityConcern = `at about ${age} model years, this is beyond ${p.program}'s ${p.maxAgeYears}-year limit`;
    }
  }

  return {
    make: String(input.make),
    program: p.program,
    powertrain: p.powertrain,
    inspectionPoints: p.inspectionPoints,
    exchange: p.exchange,
    eligibilityConcern,
    source: p.source,
    sourceKind: p.sourceKind,
    note: p.note,
  };
}
