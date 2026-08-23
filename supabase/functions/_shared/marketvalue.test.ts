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
import { computeBand, median, percentile, type CompRow } from "./marketvalue.ts";

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

// --- empty / garbage -------------------------------------------------------
check(computeBand([], { minComps: 5 }).insufficient === true, "empty: no rows is insufficient");
check(computeBand([{ price: 0 }, { price: -5 }, { price: NaN as unknown as number }], { minComps: 1 }).insufficient === true, "garbage: non-positive/NaN prices are dropped");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.error("FAILURES:\n  " + fails.join("\n  ")); process.exit(1); }
