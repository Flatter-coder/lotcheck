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
  // NOT "RAV4" -- aa6183a deliberately made "RAV4 Hybrid" a nameplate of its own.
  // msrp_catalog keys hybrid rows as "RAV4 Hybrid", and the lookup matches with
  // no wildcard, so collapsing to "RAV4" makes those rows dead AND lets a hybrid
  // inherit its gas sibling's MSRP -- the exact blur the powertrain-identity rule
  // forbids. The recall path is unaffected: modelCandidates tries "RAV4 Hybrid"
  // first and falls through to "RAV4", which is what TC actually knows (pinned by
  // the LIVE fixture below, which still expects "found").
  { make: "Toyota", model: "RAV4 Hybrid XSE", expect: "RAV4 Hybrid", note: "trim strips, powertrain does NOT" },
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
  { year: 2024, make: "Toyota", model: "RAV4 Hybrid XSE", expect: "found", note: "base is RAV4 Hybrid; TC does not know it, so the candidate list falls through to RAV4" },
  { year: 2024, make: "Honda", model: "Civic Touring", expect: "found" },
  { year: 2024, make: "Hyundai", model: "Santa Fe Calligraphy", expect: "found", note: "multi-word base" },
  { year: 2023, make: "Ford", model: "Mustang Mach-E Premium", expect: "found", note: "resolves to Mustang Mach-E, not Mustang" },
  { year: 2026, make: "Toyota", model: "Zephyr", expect: "unconfirmed", note: "fail-safe: unknown model never reads as all-clear" },
];
