// ============================================================================
// Remaining-warranty calculator (used vehicles). Given a catalog coverage
// string ("3-year/60,000 km", "5-year/100,000 km", "6-year/unlimited km"), the
// vehicle's model year, and its odometer, estimate how much of each original
// manufacturer warranty term is LEFT. A warranty ends at whichever limit comes
// first — time OR distance — so both are checked.
//
// ESTIMATE, and labelled as such downstream: the clock really starts on the
// in-service date, which we approximate with the model year (can be off by up
// to ~a year). Pure + deterministic (currentYear is passed in) so it unit-tests
// cleanly and never touches the DB.
// ============================================================================

export interface ParsedCoverage { years: number | null; km: number | null; } // km null = unlimited

export function parseCoverage(str: string | null | undefined): ParsedCoverage | null {
  if (!str) return null;
  const y = str.match(/(\d+)\s*-?\s*year/i);
  const kmMatch = str.match(/([\d,]+)\s*km/i);
  const unlimited = /unlimited/i.test(str);
  const years = y ? Number(y[1]) : null;
  if (years == null) return null;
  return { years, km: unlimited ? null : (kmMatch ? Number(kmMatch[1].replace(/,/g, "")) : null) };
}

export interface RemainingTerm {
  term: string;
  termYears: number;
  termKm: number | null;   // null = unlimited distance
  yearsLeft: number;       // may be <= 0
  kmLeft: number | null;   // null = unlimited distance or odometer unknown
  kmUnlimited: boolean;
  odometerKnown: boolean;
  active: boolean;
}

function remainingFor(cov: string | null | undefined, modelYear: number, odo: number | null, currentYear: number): RemainingTerm | null {
  const p = parseCoverage(cov);
  if (!p || p.years == null) return null;
  const elapsedYears = Math.max(0, currentYear - modelYear);
  const yearsLeft = p.years - elapsedYears;
  const odometerKnown = odo != null && Number.isFinite(odo);
  const kmLeft = (p.km == null || !odometerKnown) ? null : (p.km - (odo as number));
  const timeOk = yearsLeft > 0;
  const kmOk = p.km == null ? true : (!odometerKnown ? true : (kmLeft as number) > 0);
  return {
    term: cov as string,
    termYears: p.years,
    termKm: p.km,
    yearsLeft,
    kmLeft,
    kmUnlimited: p.km == null,
    odometerKnown,
    active: timeOk && kmOk,
  };
}

export interface RemainingWarranty {
  modelYear: number;
  odometerKm: number | null;
  asOfYear: number;
  estimated: true;
  basic: RemainingTerm | null;
  powertrain: RemainingTerm | null;
  sourceUrl: string | null;
}

// row = a manufacturer_warranties row (basic_coverage, powertrain_coverage, source_url…)
export function computeRemainingWarranty(
  row: { basic_coverage?: string | null; powertrain_coverage?: string | null; source_url?: string | null },
  modelYear: number | null | undefined,
  odometerKm: number | null | undefined,
  currentYear: number,
): RemainingWarranty | null {
  if (!row || !modelYear || !Number.isFinite(modelYear)) return null;
  const odo = (odometerKm != null && Number.isFinite(odometerKm)) ? Number(odometerKm) : null;
  const basic = remainingFor(row.basic_coverage, modelYear as number, odo, currentYear);
  const powertrain = remainingFor(row.powertrain_coverage, modelYear as number, odo, currentYear);
  if (!basic && !powertrain) return null;
  return { modelYear: modelYear as number, odometerKm: odo, asOfYear: currentYear, estimated: true, basic, powertrain, sourceUrl: row.source_url ?? null };
}
