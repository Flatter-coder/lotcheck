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

// 2026 Rogue (gas) — official Nissan Canada newsroom ladder (all AWD, no FWD).
const ROGUE = [
  { trim: "S",          msrp: 34598, fuel_type: "Gas", drivetrain: "AWD" },
  { trim: "SV",         msrp: 38498, fuel_type: "Gas", drivetrain: "AWD" },
  { trim: "Dark Armor", msrp: 40798, fuel_type: "Gas", drivetrain: "AWD" },
  { trim: "Rock Creek", msrp: 41798, fuel_type: "Gas", drivetrain: "AWD" },
  { trim: "Platinum",   msrp: 46298, fuel_type: "Gas", drivetrain: "AWD" },
];

// 2027 Land Cruiser — returned to Canada; toyota.ca trims (Vic-provided capture).
const LANDCRUISER = [
  { trim: "1958",    msrp: 75450, fuel_type: "Hybrid" },
  { trim: "Cruiser", msrp: 84240, fuel_type: "Hybrid" },
  { trim: "Premium Package", msrp: 90615, fuel_type: "Hybrid" },
];

// Single-row (base) models — must still resolve to their one figure.
// Ford's real Mach-E shape: one row per trim, drivetrain NOT pinned — AWD and
// extended range are priced as options above the trim.
const MACHE = [
  { trim: "Select",  msrp: 44990, fuel_type: "BEV" },
  { trim: "Premium", msrp: 49990, fuel_type: "BEV" },
  { trim: "GT",      msrp: 69990, fuel_type: "BEV" },
];
// The same lineup from a catalog that DOES pin drivetrain — exact stays exact.
const MACHE_AWD = [
  { trim: "Premium", msrp: 49990, fuel_type: "BEV", drivetrain: "RWD" },
  { trim: "Premium", msrp: 56990, fuel_type: "BEV", drivetrain: "AWD" },
  { trim: "GT",      msrp: 69990, fuel_type: "BEV", drivetrain: "AWD" },
];
// The realistic scrape shape: Ford markets the GT as AWD-standard so the
// scraper captures "GT AWD", while Premium is captured plain. ONE row pins a
// drivetrain, which is enough to defeat a "does ANY row pin config" test.
const MACHE_MIXED = [
  { trim: "Select",  msrp: 44990, fuel_type: "BEV" },
  { trim: "Premium", msrp: 49990, fuel_type: "BEV" },
  { trim: "GT AWD",  msrp: 69990, fuel_type: "BEV" },
];
// IONIQ 9 — the catalog gap case (see msrp-exact-must-pin-config). The real
// lineup has 5 AWD-or-RWD trims spanning $59,999-$81,499; the catalog was
// missing the top two package trims ($76,499 Luxury, $81,499 Ultimate
// Calligraphy), leaving only the 3 below. A $83,899 asking price matched
// "Preferred AWD" ($64,999, correct drivetrain, so rowConfirmsConfig passed)
// and was labelled exact -- an $18,900 "over MSRP" accusation against a named
// dealer, when the real explanation was two missing catalog rows.
const IONIQ9_GAPPED = [
  { trim: "Essential RWD", msrp: 59999, fuel_type: "BEV" },
  { trim: "Preferred AWD", msrp: 64999, fuel_type: "BEV" },
  { trim: "Preferred AWD+", msrp: 64999, fuel_type: "BEV" },
];
// The same lineup after backfilling the two missing rows.
const IONIQ9_FULL = [
  ...IONIQ9_GAPPED,
  { trim: "Preferred AWD with Luxury Package", msrp: 76499, fuel_type: "BEV" },
  { trim: "Preferred AWD+ with Ultimate Calligraphy Package", msrp: 81499, fuel_type: "BEV" },
];

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

  // ROGUE — the Fish Creek case: per-trim resolution incl. Rock Creek.
  ["Rogue Rock Creek (trim name)", ROGUE,
    { trim: "Rock Creek", drivetrain: "AWD", fuelType: "Gas" }, 41798],
  ["Rogue Rock Creek (trim 'Rock Creek Intelligent AWD')", ROGUE,
    { trim: "Rock Creek Intelligent AWD", fuelType: "Gas" }, 41798],
  ["Rogue Platinum", ROGUE, { trim: "Platinum AWD", fuelType: "Gas" }, 46298],
  ["Rogue, no trim signal -> honest starting-at base", ROGUE,
    { fuelType: "Gas" }, 34598],

  ["Land Cruiser 1958", LANDCRUISER, { trim: "1958", fuelType: "Hybrid" }, 75450],
  ["Land Cruiser Cruiser trim", LANDCRUISER, { trim: "Cruiser", fuelType: "Hybrid" }, 84240],
  ["Land Cruiser, no trim -> honest starting-at", LANDCRUISER, { fuelType: "Hybrid" }, 75450],
  ["Land Cruiser Premium Package", LANDCRUISER, { trim: "Premium Package", fuelType: "Hybrid" }, 90615],

  // CONFIG-BLIND CATALOG — the Mach-E regression (see msrp-exact-must-pin-config).
  // Ford publishes ONE row per Mach-E trim; AWD and extended range are options
  // above it. A Premium AWD listing matched "Premium" at $49,990 and was
  // labelled exact, which downstream became a $13,018 inflation accusation
  // against a named dealer. The catalog cannot express drivetrain at all here,
  // so the honest answer is starting_at.
  //
  // NOTE on the $66,015 shape: it happened to come back starting_at even before
  // the fix, because the asking price sat nearest the GT and the price tiebreak
  // deadlocked GT against Premium. That was luck, not a guard — every other
  // shape of the same listing below returned "exact" on the shipped code. A
  // regression case written only around $66,015 would have pinned nothing.
  ["Mach-E Premium AWD, no price signal", MACHE,
    { trim: "Premium", drivetrain: "AWD", fuelType: "BEV" }, 49990, "starting_at"],
  ["Mach-E Premium AWD, price near the matched trim", MACHE,
    { trim: "Premium", drivetrain: "AWD", fuelType: "BEV", quotedPrice: 52990 }, 49990, "starting_at"],
  ["Mach-E Premium, drivetrain from VIN decode only", MACHE,
    { trim: "Premium", vinDrive: "AWD", fuelType: "BEV" }, 49990, "starting_at"],
  ["Mach-E, drivetrain only inside the trim string", MACHE,
    { trim: "Premium AWD", fuelType: "BEV" }, 49990, "starting_at"],
  ["Mach-E Premium AWD at $66,015 (the reported listing)", MACHE,
    { trim: "Premium", drivetrain: "AWD", vinDrive: "AWD", fuelType: "BEV", quotedPrice: 66015 },
    49990, "starting_at"],
  ["Mach-E with no drivetrain stated -> exact is fine", MACHE,
    { trim: "Premium", fuelType: "BEV" }, 49990, "exact"],
  ["Catalog that DOES pin drivetrain still returns exact", MACHE_AWD,
    { trim: "Premium", drivetrain: "AWD", fuelType: "BEV" }, 56990, "exact"],

  // MIXED CATALOG — one row pins a drivetrain, the rest don't. Scoring gave the
  // drivetrain match (+4) more weight than the trim name (+2) and nothing at all
  // for a trim name that CONFLICTS, so a Premium AWD listing picked the "GT AWD"
  // row and returned $69,990 labelled exact — the wrong trim, confidently.
  ["Mach-E Premium AWD vs mixed catalog -> right trim, honest label", MACHE_MIXED,
    { trim: "Premium", drivetrain: "AWD", fuelType: "BEV" }, 49990, "starting_at"],
  ["Mach-E GT AWD vs mixed catalog -> GT row confirms config, exact", MACHE_MIXED,
    { trim: "GT", drivetrain: "AWD", fuelType: "BEV" }, 69990, "exact"],

  // PRICE PLAUSIBILITY CEILING — IONIQ 9 (see msrp-exact-must-pin-config).
  // Catalog missing the two highest package trims: the $83,899 asking price
  // matched "Preferred AWD" ($64,999, correct AWD drivetrain, so
  // rowConfirmsConfig alone can't catch this) and was called exact -- an
  // $18,900 "over MSRP" accusation, root cause a missing row, not a markup.
  ["IONIQ 9, catalog missing top 2 trims -> $18,900 gap downgrades to starting_at", IONIQ9_GAPPED,
    { trim: "Preferred AWD", drivetrain: "AWD", fuelType: "BEV", quotedPrice: 83899 }, 64999, "starting_at"],
  // Same asking price, same signal shape, but a small/plausible gap (a few
  // hundred dollars) must NOT be suppressed -- the ceiling only fires past
  // BOTH 20% and $6,000.
  ["IONIQ 9, small plausible gap stays exact", IONIQ9_GAPPED,
    { trim: "Preferred AWD", drivetrain: "AWD", fuelType: "BEV", quotedPrice: 66500 }, 64999, "exact"],
  // After backfilling the missing rows, the SAME asking price against the
  // full lineup correctly matches the real top trim (Ultimate Calligraphy,
  // $81,499) on its distinctive tokens + closest price -- a $2,400 gap, well
  // under the ceiling, stays exact. Confirms the fix doesn't just suppress
  // the false accusation, it lets the real match through once the data is
  // complete.
  ["IONIQ 9, full catalog -> correct top trim, small honest gap stays exact", IONIQ9_FULL,
    { trim: "Preferred AWD+ with Ultimate Calligraphy Package", drivetrain: "AWD", fuelType: "BEV", quotedPrice: 83899 },
    81499, "exact"],

  // SINGLE-ROW MODELS — must keep working (no regressions).
  ["Compass (single base row)", COMPASS, { trim: "Sport", fuelType: "Gas" }, 34700],
  ["Lexus RZ (single base row, trim present)", RZ, { trim: "AWD Luxury", fuelType: "BEV" }, 59990],
  ["Mazda CX-90 PHEV (single base row)", CX90PH, { trim: "GT AWD", fuelType: "PHEV" }, 49999],
];

// A 5th tuple element asserts BASIS as well as value. The harness only ever
// checked the number, which is why the Mach-E defect shipped: the MSRP it
// returned was a real Ford price — it was the "exact" LABEL on it that caused
// a $13,018 accusation against a named dealer.
let pass = 0, fail = 0;
for (const [label, rows, sig, expected, wantBasis] of CASES) {
  let got = null, basis = null;
  try { const r = pickTrimMsrp(rows, sig); got = r && r.msrp; basis = r && r.basis; } catch (e) { got = "THREW: " + e.message; }
  const valueOk = Array.isArray(expected) ? expected.includes(got) : got === expected;
  const basisOk = !wantBasis || basis === wantBasis;
  const ok = valueOk && basisOk;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}\n        expected ${expected}${wantBasis ? " / " + wantBasis : ""}, got ${got}${basis ? ` (${basis})` : ""}`);
  ok ? pass++ : fail++;
}
console.log(`\n${pass}/${pass + fail} passed${fail ? `  — ${fail} FAILING` : "  ✓ all green"}`);
process.exit(fail ? 1 : 0);
