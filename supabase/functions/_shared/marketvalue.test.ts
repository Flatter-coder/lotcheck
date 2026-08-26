// Regression harness for the used-value band math (Phase 1, lotcheck provider).
//
// The number the report shows about a used car is only as trustworthy as the
// gate in front of it. These cases pin the rules that keep a thin or dirty
// comparable set from ever producing a confident-looking median:
//   * below the comp floor -> insufficient, never a number
//   * a salvage-cheap outlier and a typo-high outlier get trimmed, not averaged in
//   * a used car prefers a mileage-matched band, but only when it's dense enough
//   * the median/quartile helpers are correct on even and odd sets
//
// Run (Node 24+, from repo root):
//   node --experimental-strip-types supabase/functions/_shared/marketvalue.test.ts
import { computeBand, computeCpoPremium, servesComps, median, percentile, type CompRow } from "./marketvalue.ts";

let pass = 0, fail = 0;
const fails: string[] = [];
function check(ok: boolean, label: string, detail = "") {
  if (ok) pass++; else { fail++; fails.push(label); }
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        ${detail}`}`);
}

// --- helpers ---------------------------------------------------------------
check(median([1, 2, 3]) === 2, "median: odd set");
check(median([10, 20, 30, 40]) === 25, "median: even set averages the middle two");
check(percentile([10, 20, 30, 40, 50], 25) === 20, "percentile: p25 of 5 values");
check(percentile([10, 20, 30, 40, 50], 75) === 40, "percentile: p75 of 5 values");

// --- comp floor ------------------------------------------------------------
const four: CompRow[] = [1, 2, 3, 4].map((i) => ({ price: 30000 + i * 100 }));
check(computeBand(four, { minComps: 5 }).insufficient === true, "floor: 4 comps under a floor of 5 is insufficient");

// --- outlier trim ----------------------------------------------------------
// Six honest ~32.8k comps plus one salvage-cheap $9,000 and one typo $99,000.
const withOutliers: CompRow[] = [
  { price: 31200 }, { price: 32900 }, { price: 32800 }, { price: 33450 }, { price: 34100 }, { price: 33000 },
  { price: 9000 },   // salvage-cheap: below 0.4x median -> trimmed
  { price: 99000 },  // typo-high: above 2.0x median -> trimmed
];
const trimmed = computeBand(withOutliers, { minComps: 5 });
check(trimmed.insufficient !== true, "trim: honest set survives the gate");
check(trimmed.n === 6, "trim: both outliers dropped (8 -> 6)", `n=${trimmed.n}`);
check(trimmed.low === 31200 && trimmed.high === 34100, "trim: low/high are the honest extremes, not 9k/99k", `low=${trimmed.low} high=${trimmed.high}`);
check(trimmed.median >= 32800 && trimmed.median <= 33000, "trim: median sits in the honest cluster", `median=${trimmed.median}`);

// --- mileage-band selection ------------------------------------------------
// Five tight-mileage comps around 44,000 km, plus three high-mileage cheapies.
const mixedKm: CompRow[] = [
  { price: 33450, odometerKm: 39800 },
  { price: 32900, odometerKm: 46100 },
  { price: 34100, odometerKm: 43000 },
  { price: 33000, odometerKm: 45200 },
  { price: 33700, odometerKm: 41500 },
  { price: 27000, odometerKm: 120000 },
  { price: 26500, odometerKm: 132000 },
  { price: 25900, odometerKm: 141000 },
];
const banded = computeBand(mixedKm, { condition: "used", odometerKm: 44200, minComps: 5, kmBandPct: 0.30 });
check(banded.kmBasis === true, "km-band: dense mileage window is used");
check(banded.n === 5, "km-band: only the ~44k km comps count (high-mileage excluded)", `n=${banded.n}`);
check(banded.median >= 33000 && banded.median <= 33700, "km-band: median reflects the mileage-matched set", `median=${banded.median}`);

// Too few in-band comps -> fall back to the full set rather than a 2-comp band.
const sparseBand: CompRow[] = [
  { price: 33450, odometerKm: 44000 },
  { price: 33000, odometerKm: 45000 },   // only 2 near 44k
  { price: 27000, odometerKm: 120000 },
  { price: 26500, odometerKm: 132000 },
  { price: 25900, odometerKm: 141000 },
  { price: 26800, odometerKm: 128000 },
];
const fell = computeBand(sparseBand, { condition: "used", odometerKm: 44200, minComps: 5, kmBandPct: 0.30 });
check(fell.kmBasis === false, "km-band: falls back to full set when the window is too thin");
check(fell.insufficient !== true && fell.n === 6, "km-band: fallback still produces a band from all 6", `n=${fell.n}`);

// --- trim tally ------------------------------------------------------------
const trimSet: CompRow[] = [
  { price: 33450, trim: "GT" }, { price: 32900, trim: "GT" }, { price: 34100, trim: "GT" },
  { price: 31000, trim: "GS" }, { price: 30500, trim: "GX" }, { price: 33000, trim: "GT" },
];
const withTrim = computeBand(trimSet, { minComps: 5, trim: "gt" });
check(withTrim.trimMatches === 4, "trim: counts case-insensitive same-trim comps", `trimMatches=${withTrim.trimMatches}`);

// --- trim narrowing (like-for-like band) -----------------------------------
// Subject is an XLT: five XLT comps ~33k plus three loaded Lariats ~60k. With
// >=5 same-trim comps, the band narrows to XLT so a base/loaded mix never sets
// a $33k-$60k spread on "the same truck".
const trimNarrow: CompRow[] = [
  { price: 32000, trim: "XLT" }, { price: 33000, trim: "XLT" }, { price: 34000, trim: "XLT SuperCrew" },
  { price: 33500, trim: "XLT" }, { price: 32500, trim: "XLT" },
  { price: 58000, trim: "Lariat" }, { price: 61000, trim: "Lariat" }, { price: 60000, trim: "Lariat" },
];
const narrowed = computeBand(trimNarrow, { minComps: 5, trim: "XLT" });
check(narrowed.trimBasis === true, "trim-narrow: >=5 same-trim comps -> band is trim-specific");
check(narrowed.n === 5 && narrowed.high <= 34000, "trim-narrow: loaded Lariats excluded from an XLT band", `n=${narrowed.n} high=${narrowed.high}`);

// Subject is a Lariat but only 3 Lariats -> fall back to all trims, never a thin
// same-trim band.
const trimThin: CompRow[] = [
  { price: 32000, trim: "XLT" }, { price: 33000, trim: "XLT" }, { price: 34000, trim: "XLT" }, { price: 33500, trim: "XLT" }, { price: 32500, trim: "XLT" },
  { price: 58000, trim: "Lariat" }, { price: 61000, trim: "Lariat" }, { price: 60000, trim: "Lariat" },
];
const thinFell = computeBand(trimThin, { minComps: 5, trim: "Lariat" });
check(thinFell.trimBasis === false, "trim-narrow: <5 same-trim falls back to all trims");
check(thinFell.insufficient !== true && thinFell.n === 8, "trim-narrow: fallback bands the full set", `n=${thinFell.n}`);

// A generic subject trim ("Other/Don't Know") never narrows.
check(computeBand(trimNarrow, { minComps: 5, trim: "Other/Don't Know" }).trimBasis === false, "trim-narrow: generic subject trim does not narrow");

// Trim + mileage compose: XLTs, tight mileage subset dense enough -> both bases.
const trimKm: CompRow[] = [
  { price: 33000, trim: "XLT", odometerKm: 42000 }, { price: 33500, trim: "XLT", odometerKm: 45000 },
  { price: 32500, trim: "XLT", odometerKm: 40000 }, { price: 34000, trim: "XLT", odometerKm: 47000 },
  { price: 33200, trim: "XLT", odometerKm: 44000 }, { price: 28000, trim: "XLT", odometerKm: 130000 },
  { price: 27500, trim: "XLT", odometerKm: 145000 },
];
const both = computeBand(trimKm, { minComps: 5, trim: "XLT", condition: "used", odometerKm: 43000, kmBandPct: 0.30 });
check(both.trimBasis === true && both.kmBasis === true, "trim+km: narrows on trim AND mileage when both are dense", `trim=${both.trimBasis} km=${both.kmBasis} n=${both.n}`);

// --- empty / garbage -------------------------------------------------------
check(computeBand([], { minComps: 5 }).insufficient === true, "empty: no rows is insufficient");
check(computeBand([{ price: 0 }, { price: -5 }, { price: NaN as unknown as number }], { minComps: 1 }).insufficient === true, "garbage: non-positive/NaN prices are dropped");

// --- CPO premium -----------------------------------------------------------
// Non-certified used comps cluster ~36k (median 36k); a few certified sit ~40k.
const cpoRows: CompRow[] = [
  { price: 34000, certified: false }, { price: 35000, certified: false }, { price: 36000, certified: false },
  { price: 36000, certified: false }, { price: 37000, certified: false }, { price: 38000, certified: false },
  { price: 39000, certified: true }, { price: 40000, certified: true }, { price: 41000, certified: true },
];
const prem = computeCpoPremium(cpoRows, 40000, { minComps: 5 });
check(prem != null && prem.premium === 4000, "cpo: $40k certified vs $36k non-certified median -> $4,000 premium", `prem=${JSON.stringify(prem)}`);
check(prem?.nonCertifiedMedian === 36000, "cpo: baseline is the NON-certified median (36k), not the mixed pool");
check(prem?.nNonCertified === 6, "cpo: only the 6 non-certified comps form the baseline");
check(prem?.certifiedMedian === 40000, "cpo: certified-set median attached as context");
// Not enough non-certified comps -> null (never a guessed premium).
check(computeCpoPremium([{ price: 40000, certified: true }, { price: 35000, certified: false }, { price: 36000, certified: false }], 40000, { minComps: 5 }) === null,
  "cpo: thin non-certified comps -> null");
// Subject not priced above the non-certified median -> nothing to flag.
check(computeCpoPremium(cpoRows, 35000, { minComps: 5 }) === null, "cpo: certified NOT above the non-certified median -> null");
// No asking -> null.
check(computeCpoPremium(cpoRows, 0, { minComps: 5 }) === null, "cpo: no asking price -> null");

// --- province coverage guard (only Alberta is crawled today) ---------------
check(servesComps("AB") === true, "serves: Alberta is covered");
check(servesComps("ab") === true, "serves: case-insensitive");
check(servesComps("ON") === false, "serves: Ontario is NOT covered -> no value band");
check(servesComps("BC") === false, "serves: BC is NOT covered -> no value band");
check(servesComps(null) === false, "serves: unknown province is NOT served (missing beats wrong)");
check(servesComps("") === false, "serves: empty province is NOT served");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.error("FAILURES:\n  " + fails.join("\n  ")); process.exit(1); }
