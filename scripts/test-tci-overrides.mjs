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

// Assert the TX entry by key, not by count: an override applies even when the
// scrape produced no rows for it (the RX line below is REFUSED upstream, so it
// arrives with zero scraped rows and still inserts), so `replaced` grows with
// every override, not with every corrupt input.
const txRep = replaced.find((r) => r.key === "lexus|tx|2026");
check("the corrupt TX rows are dropped and replaced", !!txRep && txRep.dropped === 3);
check("TX 350 Luxury is $69,855, Gas (the reported bug's correct value)", !!lux && lux.msrp === 69855 && lux.fuel_type === "Gas");
check("the base trim is 'Luxury', never 'PREMIUM'", tx.some((r) => r.trim === "Luxury") && !tx.some((r) => r.trim === "PREMIUM"));
check("no gas TX 350 trim is tagged Hybrid", !tx.some((r) => ["Luxury", "Ultra Luxury", "Executive 7-Pass", "F SPORT 3", "Executive 6-Pass", "F SPORT 3 + Towing Hitch"].includes(r.trim) && r.fuel_type !== "Gas"));
check("the TX 500h hybrids are present and tagged Hybrid", tx.some((r) => r.trim === "F SPORT Performance 2" && r.fuel_type === "Hybrid"));
check("non-overridden models pass through untouched", rows.some((r) => r.model === "NX" && r.msrp === 48000));

// ── 2026 Lexus RX 350 (gasoline) — lexusofroyaloak.com, 2026-09-02 ──────────
// The feed lists the RX 350 packages under series "RX" tagged "Hybrid
// Available"; inferFuel flattens that to Hybrid; the refresh guard then refuses
// the whole gas line (the "RX Hybrid" sibling proves the mis-tag) and NOTHING is
// written. The served catalog held ten hybrid/PHEV RX rows and no gas RX, and
// a gas RX 350 buyer was shown the hybrid ladder as "the factory range".
{
  const feedRx = [ // what the feed actually emits for series RX (dry run 2026-09-02 09:40Z), all mis-tagged
    { year: 2026, make: "Lexus", model: "RX", trim: "Luxury",             msrp: 68299, fuel_type: "Hybrid" },
    { year: 2026, make: "Lexus", model: "RX", trim: "F SPORT 2",          msrp: 70799, fuel_type: "Hybrid" },
    { year: 2026, make: "Lexus", model: "RX", trim: "Ultra Luxury",       msrp: 71804, fuel_type: "Hybrid" },
    { year: 2026, make: "Lexus", model: "RX", trim: "Executive",          msrp: 76304, fuel_type: "Hybrid" },
    { year: 2026, make: "Lexus", model: "RX", trim: "F SPORT 3",          msrp: 76304, fuel_type: "Hybrid" },
    { year: 2026, make: "Lexus", model: "RX", trim: "F SPORT Black Line", msrp: 79164, fuel_type: "Hybrid" },
  ];
  const hybridRx = [ // the real hybrid series, already correct, must not be touched
    { year: 2026, make: "Lexus", model: "RX Hybrid", trim: "Premium", msrp: 63645, fuel_type: "Hybrid" },
    { year: 2026, make: "Lexus", model: "RX Plug-in Hybrid", trim: "Ultra Premium", msrp: 78495, fuel_type: "PHEV" },
  ];
  const { rows: r2, replaced: rep2 } = applyTciOverrides([...feedRx, ...hybridRx], "Lexus");
  const rx = r2.filter((r) => r.model === "RX");
  const rxRep = rep2.find((r) => r.key === "lexus|rx|2026");
  check("RX: the six mis-tagged gas rows are dropped and replaced", !!rxRep && rxRep.dropped === 6 && rxRep.inserted === 7);
  check("RX: every gas RX 350 row is tagged Gas, none Hybrid", rx.length === 7 && rx.every((r) => r.fuel_type === "Gas"));
  check("RX: Premium base is present at $60,885 (the trim the feed refused as grade STD)", rx.some((r) => r.trim === "Premium" && r.msrp === 60885));
  check("RX: Luxury is $68,299 — the feed's own ex-freight figure, fuel corrected", rx.some((r) => r.trim === "Luxury" && r.msrp === 68299));
  // Five independent package deltas from Lexus.ca all land on the same base:
  // that arithmetic is the pinned configuration, so lock it.
  const base = rx.find((r) => r.trim === "Premium")?.msrp;
  const deltas = { "Luxury": 7414, "F SPORT 2": 9914, "Ultra Luxury": 10919, "Executive": 15419, "F SPORT 3": 15419, "F SPORT Black Line": 18279 };
  check("RX: every package row equals Premium + Lexus.ca's published package delta",
    Object.entries(deltas).every(([t, d]) => rx.find((r) => r.trim === t)?.msrp === base + d));
  check("RX: the hybrid and plug-in series pass through untouched",
    r2.some((r) => r.model === "RX Hybrid" && r.msrp === 63645 && r.fuel_type === "Hybrid")
    && r2.some((r) => r.model === "RX Plug-in Hybrid" && r.fuel_type === "PHEV"));
  check("RX: the all-one-powertrain guard is quiet once corrected", flagAllOnePowertrain(rx).length === 0);
}

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
