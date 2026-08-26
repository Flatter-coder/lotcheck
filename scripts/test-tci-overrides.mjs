// Regression suite for the Toyota/Lexus catalog overrides (tci-overrides.mjs).
// Run: node scripts/test-tci-overrides.mjs
//
// Locks the fix for the 2026 Lexus TX MSRP defect: the scraper stored the gas
// TX 350 trims as Hybrid and named the base "Premium" instead of "Luxury", so a
// TX 350 Luxury listing resolved to $81,484 (F SPORT 3). These overrides run on
// every refresh; if one drifts, this fails before it reaches the catalog.

import { TCI_OVERRIDES, applyTciOverrides, flagAllOnePowertrain } from "./lib/tci-overrides.mjs";

let pass = 0, fail = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); cond ? pass++ : fail++; };

// A realistic corrupt scrape: every TX trim tagged Hybrid, base named PREMIUM.
const corruptTx = [
  { year: 2026, make: "Lexus", model: "TX", trim: "PREMIUM",          msrp: 69855, fuel_type: "Hybrid" },
  { year: 2026, make: "Lexus", model: "TX", trim: "Ultra Luxury",     msrp: 72608, fuel_type: "Hybrid" },
  { year: 2026, make: "Lexus", model: "TX", trim: "F SPORT 3",        msrp: 81484, fuel_type: "Hybrid" },
];
const other = [{ year: 2026, make: "Lexus", model: "NX", trim: "Signature", msrp: 48000, fuel_type: "Gas" }];

const { rows, replaced } = applyTciOverrides([...corruptTx, ...other], "Lexus");
const tx = rows.filter((r) => r.model === "TX");
const lux = tx.find((r) => r.trim === "Luxury");

check("the corrupt TX rows are dropped and replaced", replaced.length === 1 && replaced[0].dropped === 3);
check("TX 350 Luxury is $69,855, Gas (the reported bug's correct value)", !!lux && lux.msrp === 69855 && lux.fuel_type === "Gas");
check("the base trim is 'Luxury', never 'PREMIUM'", tx.some((r) => r.trim === "Luxury") && !tx.some((r) => r.trim === "PREMIUM"));
check("no gas TX 350 trim is tagged Hybrid", !tx.some((r) => ["Luxury", "Ultra Luxury", "Executive 7-Pass", "F SPORT 3", "Executive 6-Pass", "F SPORT 3 + Towing Hitch"].includes(r.trim) && r.fuel_type !== "Gas"));
check("the TX 500h hybrids are present and tagged Hybrid", tx.some((r) => r.trim === "F SPORT Performance 2" && r.fuel_type === "Hybrid"));
check("non-overridden models pass through untouched", rows.some((r) => r.model === "NX" && r.msrp === 48000));

// A different make must not be touched by a Lexus override.
check("override is make-scoped", applyTciOverrides(corruptTx, "Toyota").replaced.length === 0);

// The guard catches the corrupt all-Hybrid TX, and is quiet once corrected.
check("guard flags the all-Hybrid TX (>=4 trims would fire)", flagAllOnePowertrain([...corruptTx,
  { year: 2026, make: "Lexus", model: "TX", trim: "A", msrp: 1, fuel_type: "Hybrid" }]).length === 1);
check("guard is quiet after the override (mixed Gas + Hybrid)", flagAllOnePowertrain(tx).length === 0);

// Every override row is a whole-dollar MSRP with a real fuel — the same bar the
// scraper's own quality gate applies.
const allRows = TCI_OVERRIDES.flatMap((o) => o.rows);
check("every override MSRP is a positive whole dollar", allRows.every((r) => Number.isInteger(r.msrp) && r.msrp > 0));
check("every override fuel is Gas/Hybrid/PHEV/BEV", allRows.every((r) => ["Gas", "Hybrid", "PHEV", "BEV"].includes(r.fuel_type)));

console.log(`\n${pass}/${pass + fail} passed${fail ? "  -- FAILING" : "  all green"}`);
process.exit(fail ? 1 : 0);
