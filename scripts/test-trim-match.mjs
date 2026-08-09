// Regression suite for the trim-fingerprinting matcher.
// Run: node scripts/test-trim-match.mjs
//
// Every real case we've ever failed or fixed is pinned here. If a future change
// to the matcher would re-break one, this goes RED before it can reach a user.
// No network, no vendors, no cost — pure logic.

import { pickTrimMsrp } from "../supabase/functions/_shared/trim-match.js";

// ---- Catalog fixtures (what SHOULD be in msrp_catalog, trim-aware) -----------
const BZ = [
  { trim: "XLE FWD",     msrp: 49063, fuel_type: "BEV", drivetrain: "FWD" },
  { trim: "XLE AWD",     msrp: 56463, fuel_type: "BEV", drivetrain: "AWD" },
  { trim: "Limited AWD", msrp: 64763, fuel_type: "BEV", drivetrain: "AWD" },
  { trim: "Woodland",    msrp: 59900, fuel_type: "BEV", drivetrain: "AWD" },
];

// 2026 Camry (hybrid-only). Trim = marketing grade; drivetrain separate.
// Digital Key 2.0 is standard ONLY on XLE + XSE — the distinctive feature.
const CAMRY = [
  { trim: "SE",                  msrp: 38792, fuel_type: "Hybrid", drivetrain: "FWD" },
  { trim: "SE Upgrade",          msrp: 40842, fuel_type: "Hybrid", drivetrain: "FWD" },
  { trim: "SE Upgrade",          msrp: 42487, fuel_type: "Hybrid", drivetrain: "AWD" },
  { trim: "SE Upgrade Nightshade", msrp: 43614, fuel_type: "Hybrid", drivetrain: "AWD" },
  { trim: "XLE", msrp: 49442, fuel_type: "Hybrid", drivetrain: "AWD", attrs: { digitalKey2: true } },
  { trim: "XSE", msrp: 49547, fuel_type: "Hybrid", drivetrain: "AWD", attrs: { digitalKey2: true } },
];

// Single-row (base) models — must still resolve to their one figure.
const COMPASS = [{ trim: null, msrp: 34700, fuel_type: "Gas" }];
const RZ      = [{ trim: null, msrp: 59990, fuel_type: "BEV" }];
const CX90PH  = [{ trim: null, msrp: 49999, fuel_type: "PHEV" }];

// ---- Cases: [label, rows, signals, expectedMsrp] -----------------------------
const CASES = [
  // THE JC FAILURE — bZ XLE AWD showed $45,990; must be $56,463.
  ["bZ XLE AWD (word-order 'AWD XLE' + AWD + price)", BZ,
    { trim: "AWD XLE", drivetrain: "AWD", fuelType: "BEV", quotedPrice: 54888 }, 56463],
  ["bZ XLE AWD (trim 'XLE AWD')", BZ,
    { trim: "XLE AWD", drivetrain: "AWD", fuelType: "BEV" }, 56463],
  ["bZ XLE FWD", BZ,
    { trim: "XLE FWD", drivetrain: "FWD", fuelType: "BEV" }, 49063],
  ["bZ Limited AWD", BZ,
    { trim: "Limited AWD", drivetrain: "AWD", fuelType: "BEV" }, 64763],
  ["bZ Woodland (name only)", BZ,
    { trim: "Woodland", drivetrain: "AWD", fuelType: "BEV" }, 59900],
  ["bZ AWD, no trim name -> drivetrain+price picks XLE AWD", BZ,
    { drivetrain: "AWD", fuelType: "BEV", quotedPrice: 55000 }, 56463],

  // CAMRY — 6 trims, some separated only by drivetrain or a feature.
  ["Camry XLE AWD (name+drive+price)", CAMRY,
    { trim: "XLE AWD", drivetrain: "AWD", fuelType: "Hybrid", quotedPrice: 49442 }, 49442],
  ["Camry XSE AWD (name)", CAMRY,
    { trim: "XSE AWD", drivetrain: "AWD", fuelType: "Hybrid" }, 49547],
  ["Camry SE FWD (base)", CAMRY,
    { trim: "SE", drivetrain: "FWD", fuelType: "Hybrid", quotedPrice: 38792 }, 38792],
  ["Camry SE Upgrade AWD (drivetrain splits FWD/AWD)", CAMRY,
    { trim: "SE Upgrade", drivetrain: "AWD", fuelType: "Hybrid" }, 42487],
  // No trim name — only the Digital Key 2.0 feature + AWD. This narrows to the
  // XLE/XSE tier (two trims $105 apart); EITHER is an accurate MSRP. The point is
  // it must NOT fall to the $38k SE tier. Accept either XLE or XSE.
  ["Camry, only 'Digital Key 2.0' feature + AWD -> XLE/XSE tier (~$49k, not $38k)", CAMRY,
    { drivetrain: "AWD", fuelType: "Hybrid", features: ["digitalKey2"], quotedPrice: 49500 }, [49442, 49547]],

  // SINGLE-ROW MODELS — must keep working (no regressions).
  ["Compass (single base row)", COMPASS, { trim: "Sport", fuelType: "Gas" }, 34700],
  ["Lexus RZ (single base row, trim present)", RZ, { trim: "AWD Luxury", fuelType: "BEV" }, 59990],
  ["Mazda CX-90 PHEV (single base row)", CX90PH, { trim: "GT AWD", fuelType: "PHEV" }, 49999],
];

let pass = 0, fail = 0;
for (const [label, rows, sig, expected] of CASES) {
  let got = null, basis = null;
  try { const r = pickTrimMsrp(rows, sig); got = r && r.msrp; basis = r && r.basis; } catch (e) { got = "THREW: " + e.message; }
  const ok = Array.isArray(expected) ? expected.includes(got) : got === expected;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}\n        expected ${expected}, got ${got}${basis ? ` (${basis})` : ""}`);
  ok ? pass++ : fail++;
}
console.log(`\n${pass}/${pass + fail} passed${fail ? `  — ${fail} FAILING` : "  ✓ all green"}`);
process.exit(fail ? 1 : 0);
