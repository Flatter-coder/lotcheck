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

// ---------------------------------------------------------------------------
// The abbreviations dealers actually write (Vic, 2026-08-15). A listing says
// "RAV4 HEV" or "RAV4 PHEV" at least as often as it spells the words out, and
// on the 2026 RAV4 the two are $5,500 apart: XSE is $50,900 as a hybrid and
// $56,400 as a plug-in. Getting this wrong is an accusation-grade error under
// the report's most consequential card.
// ---------------------------------------------------------------------------
console.log("\nHEV / PHEV abbreviations");
check("'RAV4 PHEV XSE' matches the plug-in catalog row",
  powertrainCompatible("RAV4 PHEV XSE", "RAV4 Plug-in Hybrid"));
check("'RAV4 PHEV XSE' does NOT match the hybrid row — $5,500 apart",
  !powertrainCompatible("RAV4 PHEV XSE", "RAV4 Hybrid"));
check("'RAV4 HEV XLE' matches the hybrid row",
  powertrainCompatible("RAV4 HEV XLE", "RAV4 Hybrid"));
check("'RAV4 HEV XLE' does NOT match the plug-in row",
  !powertrainCompatible("RAV4 HEV XLE", "RAV4 Plug-in Hybrid"));
check("'RAV4 Prime' is a plug-in, not a hybrid",
  !powertrainCompatible("RAV4 Prime XSE", "RAV4 Hybrid"));

// The ordering rule, stated directly: "Plug-in Hybrid" CONTAINS "Hybrid", so a
// naive marker scan tags it as both and a plug-in silently becomes a hybrid.
// The stronger claim has to win.
check("'Plug-in Hybrid' carries the phev marker only, not hybrid too",
  powertrainMarkers("RAV4 Plug-in Hybrid").has("phev") &&
  !powertrainMarkers("RAV4 Plug-in Hybrid").has("hybrid"));
check("'PHEV' resolves the same way as 'Plug-in Hybrid'",
  powertrainCompatible("RAV4 PHEV", "RAV4 Plug-in Hybrid"));
check("a bare hybrid is not upgraded to a plug-in",
  !powertrainCompatible("RAV4 Hybrid", "RAV4 Plug-in Hybrid"));

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail) process.exit(1);
