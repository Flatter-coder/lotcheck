// Guards the rule that an EV / plug-in / hybrid is a different vehicle from
// the base nameplate, and must never inherit its MSRP.
//
// The case that shipped: a live "2026 Chevrolet Equinox EV LT" was reported
// with an MSRP of $44,942 — the gasoline 2027 Equinox RS sticker — because the
// catalog holds no Equinox EV rows and the base-model resolver strips by
// prefix. MSRP anchors the whole "Price vs MSRP" card, so a wrong sticker is
// worse than no sticker.
//
// Run:  npm run test:model-identity
import { powertrainMarkers, powertrainCompatible } from "./model-identity.js";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? " — " + detail : ""}`); }
}

console.log("\nthe listing that shipped wrong");
check("'Equinox EV LT' must NOT resolve to gas 'Equinox'",
  !powertrainCompatible("Equinox EV LT", "Equinox"));
check("'Equinox EV LT' DOES resolve to 'Equinox EV'",
  powertrainCompatible("Equinox EV LT", "Equinox EV"));

console.log("\nboth directions are refused");
check("gas 'RAV4 XLE' must not take a 'RAV4 Prime' price",
  !powertrainCompatible("RAV4 XLE", "RAV4 Prime"));
check("'RAV4 Prime SE' must not take the gas 'RAV4' price",
  !powertrainCompatible("RAV4 Prime SE", "RAV4"));
check("'F-150 Lightning' must not take the gas 'F-150' price",
  !powertrainCompatible("F-150 Lightning Lariat", "F-150"));
check("'Escape Plug-In Hybrid' must not take the gas 'Escape' price",
  !powertrainCompatible("Escape Plug-In Hybrid", "Escape"));

console.log("\nplug-in is never reduced to plain hybrid");
check("'Prius Plug-in Hybrid' != 'Prius Hybrid'",
  !powertrainCompatible("Prius Plug-in Hybrid XSE", "Prius Hybrid"));
check("PHEV marker suppresses the hybrid marker",
  !powertrainMarkers("Prius Plug-in Hybrid").has("hybrid") &&
  powertrainMarkers("Prius Plug-in Hybrid").has("phev"));
check("'4xe' reads as plug-in", powertrainMarkers("Wrangler 4xe Willys").has("phev"));
check("'Recharge' reads as plug-in", powertrainMarkers("XC60 Recharge").has("phev"));

console.log("\ntrim noise still strips normally (the behaviour we keep)");
check("'Palisade Ultimate Calligraphy' -> 'Palisade' still allowed",
  powertrainCompatible("Palisade Ultimate Calligraphy", "Palisade"));
check("'Grand Cherokee L Limited' -> 'Grand Cherokee' still allowed",
  powertrainCompatible("Grand Cherokee L Limited", "Grand Cherokee"));
check("'Silverado 1500 High Country' -> 'Silverado 1500' still allowed",
  powertrainCompatible("Silverado 1500 High Country", "Silverado 1500"));
check("plain gas model to plain gas model",
  powertrainCompatible("Traverse RS", "Traverse"));

console.log("\nlike-for-like electrics still match");
check("'Blazer EV RS' -> 'Blazer EV'", powertrainCompatible("Blazer EV RS", "Blazer EV"));
check("'Mustang Mach-E Premium' -> 'Mustang Mach-E'",
  powertrainCompatible("Mustang Mach-E Premium", "Mustang Mach-E"));
check("'bZ4X XLE' -> 'bZ4X'", powertrainCompatible("bZ4X XLE", "bZ4X"));
check("hybrid to hybrid", powertrainCompatible("Crosstrek Hybrid Limited", "Crosstrek Hybrid"));

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail) process.exit(1);
