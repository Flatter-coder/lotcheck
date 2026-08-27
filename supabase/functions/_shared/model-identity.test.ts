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
import { powertrainMarkers, powertrainCompatible, stripPowertrain } from "./model-identity.js";

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

// ---------------------------------------------------------------------------
// WORD ORDER (Vic, 2026-08-15): "RAV4 Hybrid XLE", "RAV4 HEV XLE",
// "RAV4 XLE HYBRID" and "RAV4 XLE HEV" are the same car. The base-model
// resolver matches on a PREFIX, so before stripPowertrain only the FIRST of the
// four ever found a catalog row — the other three silently returned no MSRP.
//
// `resolve` below mirrors resolveBaseModel in analyze-listing-url exactly:
// compatibility on the ORIGINAL strings, prefix match on the STRIPPED ones.
// ---------------------------------------------------------------------------
const resolve = (listing: string, cat: string) => {
  if (!powertrainCompatible(listing, cat)) return false;
  const em = stripPowertrain(listing).toUpperCase();
  const cm = stripPowertrain(cat).toUpperCase();
  return em === cm || em.startsWith(cm + " ");
};

console.log("\nword order — the marker can sit anywhere");
for (const l of ["RAV4 Hybrid XLE", "RAV4 HEV XLE", "RAV4 XLE HYBRID", "RAV4 XLE HEV"]) {
  check(`'${l}' resolves to 'RAV4 Hybrid'`, resolve(l, "RAV4 Hybrid"));
}
for (const l of ["RAV4 PHEV XSE", "RAV4 XSE PHEV", "RAV4 Plug-in Hybrid XSE", "RAV4 Prime XSE"]) {
  check(`'${l}' resolves to 'RAV4 Plug-in Hybrid'`, resolve(l, "RAV4 Plug-in Hybrid"));
}

console.log("\nand order must NOT let a plug-in reach a hybrid row");
check("'RAV4 XLE HEV' does not reach the plug-in row", !resolve("RAV4 XLE HEV", "RAV4 Plug-in Hybrid"));
check("'RAV4 XSE PHEV' does not reach the hybrid row", !resolve("RAV4 XSE PHEV", "RAV4 Hybrid"));
check("a bare 'RAV4 XLE' does not reach the hybrid row", !resolve("RAV4 XLE", "RAV4 Hybrid"));
check("a bare 'RAV4 XLE' DOES reach the plain row", resolve("RAV4 XLE", "RAV4"));

console.log("\nstripPowertrain must not eat a nameplate");
check("bZ4X survives stripping", stripPowertrain("bZ4X XLE") === "bZ4X XLE");
check("EV6 survives stripping", stripPowertrain("EV6 GT-Line") === "EV6 GT-Line");
check("Mach-E survives stripping", stripPowertrain("Mustang Mach-E Premium") === "Mustang Mach-E Premium");
check("Ioniq 5 survives stripping", stripPowertrain("Ioniq 5 Preferred") === "Ioniq 5 Preferred");
check("'Equinox EV LT' loses only the modifier", stripPowertrain("Equinox EV LT") === "Equinox LT");
check("'RAV4 Plug-in Hybrid' strips to the nameplate", stripPowertrain("RAV4 Plug-in Hybrid") === "RAV4");

console.log("\nnameplate matches still resolve after the change");
for (const [l, c] of [["bZ4X XLE", "bZ4X"], ["Mustang Mach-E Premium", "Mustang Mach-E"],
                      ["Blazer EV RS", "Blazer EV"], ["Equinox EV LT", "Equinox EV"],
                      ["Palisade Ultimate Calligraphy", "Palisade"],
                      ["Grand Cherokee L Limited", "Grand Cherokee"]] as Array<[string, string]>) {
  check(`'${l}' -> '${c}'`, resolve(l, c));
}
check("a gas Equinox still cannot reach the EV row", !resolve("Equinox LT", "Equinox EV"));

// ── Japanese-luxury numeric-h convention (added 2026-08-27) ────────────────
// Lexus/Acura/Infiniti/Honda/Nissan do not put the word "hybrid" in the
// nameplate: it is 350h / 500h / 450h+ / e:HEV / e-POWER / Sport Hybrid.
// None of those matched MARKERS, so "NX 350h" read as marker-FREE and matched
// the GAS "NX" series. Confirmed live on a real customer report: a 2026 Lexus
// NX 350h was anchored to the gas NX's $55,080 base MSRP while the dealer's
// own page stated $58,675 for that exact unit. [[powertrain-identity-rule]]
console.log("\nJapanese-luxury hybrid nameplates carry a powertrain marker");
for (const [s, want] of [["NX 350h Premium Hybrid AWD", "hybrid"], ["RX 500h F Sport", "hybrid"],
                         ["ES 300h", "hybrid"], ["MDX Sport Hybrid", "hybrid"],
                         ["Accord e:HEV", "hybrid"], ["Rogue e-POWER", "hybrid"],
                         ["NX 450h+", "phev"]] as Array<[string, string]>) {
  check(`'${s}' -> ${want}`, powertrainMarkers(s).has(want));
}
check("a plain gas '350' is NOT read as a hybrid", !powertrainMarkers("NX 350 AWD").has("hybrid"));
check("450h+ is a PLUG-IN, not merely a hybrid", powertrainMarkers("NX 450h+").has("phev"));
// The three claims that actually protect a buyer's money:
check("a gas NX can never inherit the hybrid NX's row", !resolve("NX 350 AWD", "NX Hybrid"));
check("a hybrid NX still reaches the NX Hybrid row", resolve("NX 350h Premium Hybrid AWD", "NX Hybrid"));
check("a hybrid NX can never inherit the GAS NX row", !resolve("NX 350h Premium Hybrid AWD", "NX"));

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail) process.exit(1);
