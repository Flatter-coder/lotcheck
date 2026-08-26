// Regression suite for the CPO catalog (cpo.ts).
// Run: node --experimental-strip-types supabase/functions/_shared/cpo.test.ts
//
// Guards the two things that keep this backed and defamation-safe:
//  - a make we haven't cataloged returns null (NEVER a false "in-house" cry);
//  - an eligibility concern fires only for an OFFICIAL threshold clearly exceeded.

import { resolveCpoProgram, assessCertifiedClaim } from "./cpo.ts";

let pass = 0, fail = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`}`);
  ok ? pass++ : fail++;
};
const ok = (label: string, cond: boolean) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); cond ? pass++ : fail++; };

// ── Catalog resolution ───────────────────────────────────────────────────────
check("Toyota resolves to TCUV", resolveCpoProgram("Toyota")?.program, "Toyota Certified Used Vehicles (TCUV)");
check("Chevrolet resolves to GM Certified", resolveCpoProgram("Chevrolet")?.program, "GM Certified Pre-Owned");
ok("GM siblings share GM's program — Buick resolves to GM Certified", resolveCpoProgram("Buick")?.program === "GM Certified Pre-Owned");
ok("case-insensitive lookup", resolveCpoProgram("honda")?.program === "Honda Certified Pre-Owned");
check("uncataloged make -> null (not in catalog != no program)", resolveCpoProgram("Kia"), null);

// ── assessCertifiedClaim: cataloged make returns what the OEM program includes ─
const t = assessCertifiedClaim({ make: "Toyota", odometerKm: 60000, modelYear: 2023, currentYear: 2026 });
ok("Toyota certified -> program + 160-pt inspection surfaced", t?.program === "Toyota Certified Used Vehicles (TCUV)" && t?.inspectionPoints === 160);
ok("Toyota (no published age/km) -> no eligibility concern", t?.eligibilityConcern === null);

// ── SOFT eligibility: official threshold clearly exceeded -> concern ──────────
const hondaOver = assessCertifiedClaim({ make: "Honda", odometerKm: 165000, modelYear: 2021, currentYear: 2026 });
ok("Honda 165,000 km exceeds the official 150,000 km limit -> concern", (hondaOver?.eligibilityConcern || "").includes("150,000 km"));
const hondaOk = assessCertifiedClaim({ make: "Honda", odometerKm: 80000, modelYear: 2023, currentYear: 2026 });
ok("Honda within limits -> no concern", hondaOk?.eligibilityConcern === null);

// ── Secondary-sourced make: NO hard eligibility concern (Hyundai is dealer-only)
const hyOver = assessCertifiedClaim({ make: "Hyundai", odometerKm: 200000, modelYear: 2018, currentYear: 2026 });
ok("Hyundai (secondary source) never hard-flags eligibility", hyOver?.eligibilityConcern === null);
ok("Hyundai still surfaces the program", hyOver?.program === "H-Promise Certified Pre-Owned");

// ── No false in-house: an uncataloged make returns null, never an accusation ──
check("uncataloged make -> null from assessCertifiedClaim (no false 'in-house')",
  assessCertifiedClaim({ make: "Kia", odometerKm: 10000, modelYear: 2025, currentYear: 2026 }), null);

// ── Every cataloged program is internally sane ───────────────────────────────
for (const mk of ["Toyota", "Honda", "Hyundai", "Ford", "Chevrolet", "Mazda", "BMW"]) {
  const p = resolveCpoProgram(mk);
  ok(`${mk}: has program name + source`, !!p && !!p.program && !!p.source);
}

console.log(`\n${pass}/${pass + fail} passed${fail ? "  -- FAILING" : "  all green"}`);
process.exit(fail ? 1 : 0);
