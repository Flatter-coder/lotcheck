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
  // A term whose own text says it varies. See HEDGE below: when true, NOTHING
  // above may be published as this vehicle's coverage — the numbers are the
  // make's headline figure, not this model's, and `active` is a guess.
  hedged: boolean;
  hedgeText: string | null;
}

// A ROW THAT HEDGES IS A ROW THAT CANNOT ANSWER.
//
// manufacturer_warranties stores ONE basic/powertrain/corrosion string per
// MAKE. Real terms vary by model and by the date the car was first sold, and
// whoever populated the Tesla row knew it — they wrote
// "8-year/160,000 km (battery & drive unit, varies by model)". That
// parenthetical was a footnote for a human. The parser read past it, took the
// 160,000, and rendered it as this car's number.
//
// It was wrong in both directions on the two cars that exposed it (2026-09-12):
//   * 2020 Model X — real term 8yr/240,000 km. Our row said the car was past
//     its cap at 198,909 km. It had 41,091 km of headroom. A FALSE NEGATIVE on
//     the most expensive component on the vehicle, against the buyer.
//   * 2017 Model X — real term 8 years, NO distance cap. Our row invented a
//     160,000 km limit and would have killed a warranty the odometer has no
//     bearing on.
// (160,000 km is in fact the ceiling of Tesla's Extended Service Agreement — a
// different product that expressly excludes batteries and drive units.)
//
// Both are stated-as-fact claims about a named vehicle, which is exactly the
// exposure shape in [[ai-defamation-entity-match-lesson]]. So the hedge now
// REFUSES rather than annotates: a hedged term is carried through marked, and
// every renderer must say it cannot state the figure. Missing beats wrong.
// [[no-single-point-of-failure]] [[msrp-100-percent-accuracy]]
const HEDGE_RE = /\b(varies?|depend(?:s|ing)?|differs?|check with|see dealer|by model|by trim|model[- ]specific)\b/i;

function remainingFor(cov: string | null | undefined, modelYear: number, odo: number | null, currentYear: number): RemainingTerm | null {
  const p = parseCoverage(cov);
  if (!p || p.years == null) return null;
  // Detected BEFORE any arithmetic, so a hedged row can never reach a renderer
  // carrying a confident-looking yearsLeft/kmLeft it has no right to.
  const hedgeHit = typeof cov === "string" ? HEDGE_RE.exec(cov) : null;
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
    hedged: !!hedgeHit,
    hedgeText: hedgeHit ? (cov as string) : null,
  };
}

// PICK THE RIGHT ROW — ONE PLACE, NOT FOUR.
//
// manufacturer_warranties is read in four separate edge functions, each with its
// own `make ilike ... limit 1`. That is four authors for one fact, and it is how
// the Tesla defect stayed invisible: no single place was responsible for
// choosing a row, so no single place could be wrong out loud.
//
// Warranty terms vary by MODEL and by WHEN THE CAR WAS SOLD. Tesla's own
// Canadian warranty PDF says so: "Any Model S or Model X purchased prior to the
// effective date ... is subject to the applicable Battery and Drive Unit
// Warranty effective as of the date of purchase." For a used-car product the
// binding terms are the ones in force at the car's first sale.
//
// Specificity order, most specific first:
//   1. model matches AND the model year falls inside [year_from, year_to]
//   2. model matches, row has no year bounds
//   3. no model on the row (the make-wide fallback)
// A row that loses is never blended with one that wins — picking a row is the
// whole job, and a merged row would describe no real vehicle.
//
// Rows are matched case-insensitively and the model comparison is loose at the
// edges only (exact, or the row's model is a whole-word prefix of the vehicle's,
// so "Model X" matches "Model X 100D" but never "Model 3").
export function pickWarrantyRow<T extends { make?: string | null; model?: string | null; year_from?: number | null; year_to?: number | null }>(
  rows: T[] | null | undefined,
  model: string | null | undefined,
  modelYear: number | null | undefined,
): T | null {
  if (!rows || !rows.length) return null;
  const want = String(model || "").trim().toLowerCase();
  const yr = (modelYear != null && Number.isFinite(modelYear)) ? Number(modelYear) : null;

  const modelHit = (rowModel: string | null | undefined): boolean => {
    const rm = String(rowModel || "").trim().toLowerCase();
    if (!rm || !want) return false;
    if (rm === want) return true;
    // whole-word prefix only: "model x" matches "model x 100d", not "model 3".
    return want.startsWith(rm + " ");
  };
  const inYears = (r: T): boolean => {
    if (yr == null) return false;
    const lo = r.year_from ?? null, hi = r.year_to ?? null;
    if (lo == null && hi == null) return false;
    return (lo == null || yr >= lo) && (hi == null || yr <= hi);
  };

  const scoped = rows.filter((r) => modelHit(r.model));
  // 1. model + year window
  const exact = scoped.filter(inYears);
  if (exact.length) return exact[0];
  // 2. model, no year bounds at all (an open row must not beat a year window)
  const openModel = scoped.filter((r) => (r.year_from ?? null) == null && (r.year_to ?? null) == null);
  if (openModel.length) return openModel[0];
  // A model-scoped row EXISTS but this year falls outside every window: that is
  // a gap in the catalogue, not permission to use the make-wide row, whose
  // figure would be the wrong era's. Refuse by returning null.
  if (scoped.length) return null;
  // 3. the make-wide fallback
  return rows.find((r) => !String(r.model || "").trim()) ?? null;
}

export interface RemainingWarranty {
  modelYear: number;
  odometerKm: number | null;
  asOfYear: number;
  estimated: true;
  basic: RemainingTerm | null;
  powertrain: RemainingTerm | null;
  corrosion: RemainingTerm | null;   // rust-through / perforation — often time-only, unlimited km
  sourceUrl: string | null;
}

// row = a manufacturer_warranties row (basic_coverage, powertrain_coverage,
// corrosion_coverage, source_url…). corrosion is usually the ONE time-only line
// (unlimited km), so on a high-km car it's the coverage most likely still worth
// checking — which is exactly why the report surfaces it (matches Collette's).
export function computeRemainingWarranty(
  row: { basic_coverage?: string | null; powertrain_coverage?: string | null; corrosion_coverage?: string | null; source_url?: string | null },
  modelYear: number | null | undefined,
  odometerKm: number | null | undefined,
  currentYear: number,
): RemainingWarranty | null {
  if (!row || !modelYear || !Number.isFinite(modelYear)) return null;
  const odo = (odometerKm != null && Number.isFinite(odometerKm)) ? Number(odometerKm) : null;
  const basic = remainingFor(row.basic_coverage, modelYear as number, odo, currentYear);
  const powertrain = remainingFor(row.powertrain_coverage, modelYear as number, odo, currentYear);
  const corrosion = remainingFor(row.corrosion_coverage, modelYear as number, odo, currentYear);
  if (!basic && !powertrain && !corrosion) return null;
  return { modelYear: modelYear as number, odometerKm: odo, asOfYear: currentYear, estimated: true, basic, powertrain, corrosion, sourceUrl: row.source_url ?? null };
}
