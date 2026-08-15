// Every real Build & Price summary captured on 2026-08-15, pinned.
//
// The cases that matter are the REFUSALS. Three times a premium colour was
// seeded into a catalog row as if it were the trim price, and each time the
// response was a warning comment that stopped nothing. These pin the refusal.
//
// Run: node scripts/test-bp-summary.mjs

import { assessSummary, deriveBaseFromPair, packageBundlesPaint, looksTwoTone, reconciles, AB_STATUTORY, corroborateWithLineup } from "./lib/bp-summary.mjs";

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "\n        " + detail}`);
  cond ? pass++ : fail++;
};

// ---------------------------------------------------------------------------
// SEEDABLE — a bare package line and a colour confirmed free.
// ---------------------------------------------------------------------------
const gas4Runner = { trim: "4Runner", msrpLine: 55520, exterior: "White", noCostExterior: true, blockHeater: 682, printedSubtotal: 59266 };
check("4Runner gas base seeds (no package, free White)",
  assessSummary(gas4Runner).seedable && assessSummary(gas4Runner).msrp === 55520,
  JSON.stringify(assessSummary(gas4Runner)));

const hyb4Runner = { trim: "4Runner Hybrid", msrpLine: 69207, exterior: "Black", noCostExterior: true, blockHeater: 682, printedSubtotal: 72953 };
check("4Runner Hybrid base seeds at 69207, not the gas 55520",
  assessSummary(hyb4Runner).msrp === 69207,
  JSON.stringify(assessSummary(hyb4Runner)));

const trailhunter = { trim: "Trailhunter", msrpLine: 69207, packageLine: "Trailhunter", packagePrice: 16447, exterior: "Everest", noCostExterior: true, blockHeater: 682, printedSubtotal: 89400 };
check("Trailhunter seeds at 85654 — bare package label, free colour",
  assessSummary(trailhunter).seedable && assessSummary(trailhunter).msrp === 85654,
  JSON.stringify(assessSummary(trailhunter)));

// ---------------------------------------------------------------------------
// REFUSED — paint bundled into the PACKAGE line.
// ---------------------------------------------------------------------------
for (const [label, pkg, price, colour] of [
  ["4Runner Hybrid Platinum", "Platinum with Premium Paint", 6272, "Supersonic Red"],
  ["4Runner Hybrid TRD PRO", "TRD PRO with Premium Paint", 13501, "Wave Maker"],
  ["Land Cruiser Premium Package", "Land Cruiser Premium Package with Premium Paint", 6765, "Heritage Blue"],
  ["Crown Signia AdvTech", "Limited - Advanced Technology Package with Premium Paint", 2425, "Oxygen White"],
]) {
  const s = { msrpLine: 69207, packageLine: pkg, packagePrice: price, exterior: colour, noCostExterior: true };
  check(`REFUSED: ${label} — package bundles the paint`,
    !assessSummary(s).seedable && /bundles the paint/.test(assessSummary(s).reason),
    assessSummary(s).reason);
}

// ---------------------------------------------------------------------------
// REFUSED — paint folded into the MSRP LINE with NO package line at all.
// This is the case the first version of the gate let through. The Crown Signia
// Limited has no package line, so a package-only check passes it, and it is
// $905 too high.
// ---------------------------------------------------------------------------
const csTwoTone = { trim: "Limited", msrpLine: 59460, exterior: "Oxygen White with Black Roof", blockHeater: 717, printedSubtotal: 63241 };
check("REFUSED: Crown Signia two-tone — no package line, still $905 of paint",
  !assessSummary(csTwoTone).seedable,
  assessSummary(csTwoTone).reason);

check("  ...and it is refused for the EXTERIOR, not for a package it does not have",
  /two-tone/.test(assessSummary(csTwoTone).reason),
  assessSummary(csTwoTone).reason);

check("REFUSED: Land Cruiser two-tone reads 80850, base is 80460",
  !assessSummary({ msrpLine: 80850, exterior: "Heritage Blue with Light Grey Roof", noCostExterior: true }).seedable,
  "a two-tone must refuse even when someone asserts the colour is free");

// An unknown colour is not a free colour.
check("REFUSED: unknown exterior is not assumed free",
  !assessSummary({ msrpLine: 52350, exterior: "Ruby Flare Pearl" }).seedable,
  "the RAV4 Limited case — $350 of pearl seeded as trim price");

check("REFUSED: exterior absent entirely",
  !assessSummary({ msrpLine: 50000 }).seedable, "no exterior recorded must never seed");

// ---------------------------------------------------------------------------
// Reconciliation catches a bad PARSE before it becomes a bad row.
// ---------------------------------------------------------------------------
check("REFUSED: figures that do not reconcile to the printed subtotal",
  !assessSummary({ msrpLine: 55520, exterior: "White", noCostExterior: true, blockHeater: 682, printedSubtotal: 60000 }).seedable,
  "a mis-parsed line must fail loudly, not seed quietly");

check("reconciliation is exact on the real 4Runner numbers",
  reconciles({ msrpLine: 55520, blockHeater: 682, printedSubtotal: 59266 }).ok &&
  Object.values(AB_STATUTORY).reduce((a, b) => a + b, 0) === 3064,
  JSON.stringify(reconciles({ msrpLine: 55520, blockHeater: 682, printedSubtotal: 59266 })));

// ---------------------------------------------------------------------------
// The recovery path: two builds of one trim isolate the paint.
// ---------------------------------------------------------------------------
const pair = deriveBaseFromPair({ msrpLine: 59460 }, { msrpLine: 58555 });
check("Crown Signia pair recovers base 58555 and a 905 two-tone",
  pair.ok && pair.baseMsrp === 58555 && pair.paintPremium === 905, JSON.stringify(pair));

const lcPair = deriveBaseFromPair({ msrpLine: 80850 }, { msrpLine: 80460 });
check("Land Cruiser pair recovers base 80460 and a 390 two-tone",
  lcPair.ok && lcPair.baseMsrp === 80460 && lcPair.paintPremium === 390, JSON.stringify(lcPair));

check("identical builds isolate nothing and say so",
  !deriveBaseFromPair({ msrpLine: 69207 }, { msrpLine: 69207 }).ok,
  "two identical MSRP lines must not report a paint premium of 0 as a finding");

// ---------------------------------------------------------------------------
// The primitives.
// ---------------------------------------------------------------------------
check("suffix detection is anchored to the END of the label",
  packageBundlesPaint("Platinum with Premium Paint") &&
  !packageBundlesPaint("Trailhunter") &&
  !packageBundlesPaint("Premium Paint Protection Package"),
  "a package merely CONTAINING the words must not trip the gate");

check("two-tone detection reads the roof, not the colour name",
  looksTwoTone("Oxygen White with Black Roof") &&
  looksTwoTone("Heritage Blue with Light Grey Roof") &&
  !looksTwoTone("Wind Chill Pearl") && !looksTwoTone("Everest"),
  "single-tone names must fall through to the evidence check, not be rejected here");

// ---------------------------------------------------------------------------
// Corroboration against toyota.ca's lineup page — the SECOND SOURCE. A summary
// SUPPLIES a number and a mis-parse goes undetected; the lineup page CHECKS it
// from a different Toyota surface. This is what "price verified" needs to mean.
// ---------------------------------------------------------------------------
const cs = corroborateWithLineup({ baseMsrp: 58555, blockHeater: 717, lineupFrom: 62354 });
check("lineup page confirms Crown Signia base 58555 to the cent", cs.agrees, JSON.stringify(cs));

const lc = corroborateWithLineup({ baseMsrp: 71670, blockHeater: 702, lineupFrom: 75454 });
check("lineup page confirms Land Cruiser 1958 base 71670 — unblocks a withheld trim",
  lc.agrees, JSON.stringify(lc));

check("a base still carrying paint is caught as ABOVE Toyota's own floor",
  corroborateWithLineup({ baseMsrp: 59460, blockHeater: 717, lineupFrom: 62354 }).delta === -905,
  "the Crown Signia two-tone sits $905 over the published floor");

check("a floor BELOW ours means a cheaper trim we have not captured",
  /cheaper trim/.test(corroborateWithLineup({ baseMsrp: 80460, blockHeater: 702, lineupFrom: 75454 }).verdict),
  "Land Cruiser base 80460 against a 75454 floor — the 1958 sits underneath it");

console.log(`\n${pass}/${pass + fail} passed${fail ? `  — ${fail} FAILING` : "  ✓ all green"}`);
process.exit(fail ? 1 : 0);
