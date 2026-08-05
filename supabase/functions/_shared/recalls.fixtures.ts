// Recall regression fixtures. Every recall miss becomes a permanent case here so
// WE catch the regression, not a user. Run: see recalls.test.ts.
//
// Two kinds:
//  - CANON_FIXTURES: pure canonicalModel(make,model) expectations (no network).
//    Guards the base-model normalization — the naming traps that caused misses.
//  - LIVE_FIXTURES: full lookupRecalls() tri-state against LIVE Transport Canada.
//    `expect` is the CATEGORY, not a count (recalls get added/closed over time):
//      "found"       -> checked && count>0
//      "clean"       -> checked && count===0 && confirmed===true   (safe "none open")
//      "unconfirmed" -> checked && count===0 && confirmed===false  (fail-safe "couldn't confirm")

export const CANON_FIXTURES: Array<{ make: string; model: string; expect: string | null; note?: string }> = [
  { make: "Toyota", model: "bZ Woodland", expect: "bZ", note: "2nd miss: renamed bZ4X trim must reduce to bZ" },
  { make: "Toyota", model: "bZ4X", expect: "bZ4X", note: "must stay bZ4X, NOT collapse to bZ" },
  { make: "Hyundai", model: "Palisade Ultimate Calligraphy", expect: "Palisade", note: "1st miss: trim leak" },
  { make: "Toyota", model: "RAV4 Hybrid XSE", expect: "RAV4", note: "trim + powertrain strip" },
  { make: "Hyundai", model: "Santa Fe Calligraphy", expect: "Santa Fe", note: "multi-word base survives" },
  { make: "Toyota", model: "Grand Highlander Hybrid", expect: "Grand Highlander", note: "must beat Highlander" },
  { make: "Ford", model: "Mustang Mach-E Premium", expect: "Mustang Mach-E", note: "must NOT collapse to Mustang" },
  { make: "Ford", model: "Mustang GT", expect: "Mustang", note: "plain Mustang still resolves" },
  { make: "Hyundai", model: "Ioniq 5 N", expect: "Ioniq 5 N", note: "longest wins over Ioniq 5" },
  { make: "Hyundai", model: "Ioniq 5 Preferred", expect: "Ioniq 5" },
  { make: "RAM", model: "1500 Laramie", expect: "1500", note: "case-insensitive make key (RAM)" },
  { make: "Toyota", model: "Zephyr", expect: null, note: "unknown model -> null, caller falls back safely" },
];

export const LIVE_FIXTURES: Array<{ year: number; make: string; model: string; expect: string; note?: string }> = [
  { year: 2026, make: "Toyota", model: "bZ Woodland", expect: "clean", note: "2nd miss: new MY, no recall yet, base bZ is TC-known -> CONFIRMED clean (not amber)" },
  { year: 2026, make: "Hyundai", model: "Palisade Ultimate Calligraphy", expect: "found", note: "1st miss: must still surface the 2026 Palisade recalls despite trim" },
  { year: 2023, make: "Toyota", model: "bZ4X", expect: "found", note: "wheel-hub recall history" },
  { year: 2024, make: "Toyota", model: "RAV4 Hybrid XSE", expect: "found", note: "trim strips to RAV4, which has recalls" },
  { year: 2024, make: "Honda", model: "Civic Touring", expect: "found" },
  { year: 2024, make: "Hyundai", model: "Santa Fe Calligraphy", expect: "found", note: "multi-word base" },
  { year: 2023, make: "Ford", model: "Mustang Mach-E Premium", expect: "found", note: "resolves to Mustang Mach-E, not Mustang" },
  { year: 2026, make: "Toyota", model: "Zephyr", expect: "unconfirmed", note: "fail-safe: unknown model never reads as all-clear" },
];
