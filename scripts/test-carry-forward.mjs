// Regression guard for the enrichment wipe.
//
// msrp_catalog.drivetrain was 0/881 populated when anyone finally looked. The
// cause was not a bad write, it was the refresh: replaceRows() deletes every
// row for a make and re-inserts what the scraper produced, and no scraper
// emits drivetrain, so hand-verified values from official sources were
// silently deleted. Backfilling without fixing that just queues the same loss
// for the next refresh. These cases fail against the code that lost it.
//
// Run: node scripts/test-carry-forward.mjs

import { mergeCarryForward, CARRY_FORWARD } from "./lib/catalog-io.mjs";

let pass = 0, fail = 0;
function check(label, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "\n        " + detail}`);
  cond ? pass++ : fail++;
}

// What a scraper produces: price and fuel only, never drivetrain.
const scraped = [
  { year: 2026, make: "Toyota", model: "Camry", trim: "XLE", msrp: 49442, fuel_type: "Hybrid" },
  { year: 2026, make: "Toyota", model: "Camry", trim: "SE",  msrp: 38792, fuel_type: "Hybrid" },
  { year: 2026, make: "Toyota", model: "Camry", trim: null,  msrp: 37000, fuel_type: "Hybrid" },
];
// What is already in the table, enriched by hand / by the NRCan backfill.
const existing = [
  { year: 2026, model: "Camry", trim: "XLE", drivetrain: "AWD", price_basis: "incl_freight", attrs: { digitalKey2: true } },
  { year: 2026, model: "Camry", trim: "SE",  drivetrain: "FWD", source_url: "https://toyota.ca/..." },
  { year: 2026, model: "Camry", trim: null,  drivetrain: "FWD" },
];

const { rows, carried } = mergeCarryForward(scraped, existing);
const byTrim = (t) => rows.find((r) => (r.trim ?? null) === t);

check("drivetrain survives a delete-then-insert refresh",
  byTrim("XLE").drivetrain === "AWD" && byTrim("SE").drivetrain === "FWD",
  `got XLE=${byTrim("XLE").drivetrain} SE=${byTrim("SE").drivetrain}`);

check("a NULL trim is a real key, not a mismatch",
  byTrim(null).drivetrain === "FWD", `got ${JSON.stringify(byTrim(null))}`);

check("attrs and price_basis carry too",
  byTrim("XLE").price_basis === "incl_freight" && byTrim("XLE").attrs?.digitalKey2 === true,
  JSON.stringify(byTrim("XLE")));

check("source_url carries", byTrim("SE").source_url?.includes("toyota.ca"), JSON.stringify(byTrim("SE")));

check("the scraper's own fields are untouched",
  byTrim("XLE").msrp === 49442 && byTrim("XLE").fuel_type === "Hybrid", JSON.stringify(byTrim("XLE")));

check("carried count is reported", carried === 6, `carried=${carried}`);

// A fresh scrape that DOES know better must win — carry-forward only fills gaps.
const withDrive = [{ year: 2026, model: "Camry", trim: "XLE", msrp: 49442, drivetrain: "RWD" }];
check("a fresh value is never overwritten by the old one",
  mergeCarryForward(withDrive, existing).rows[0].drivetrain === "RWD",
  JSON.stringify(mergeCarryForward(withDrive, existing).rows[0]));

// A trim the table has never seen inherits nothing — but the key must still be
// PRESENT (explicitly null), see the homogeneity case below.
const newTrim = [{ year: 2026, model: "Camry", trim: "TRD", msrp: 45000 }];
check("an unseen trim inherits nothing",
  mergeCarryForward(newTrim, existing).rows[0].drivetrain === null,
  JSON.stringify(mergeCarryForward(newTrim, existing).rows[0]));

// Model years are distinct vehicles; last year's drivetrain must not leak.
const nextYear = [{ year: 2027, model: "Camry", trim: "XLE", msrp: 51000 }];
check("a different model year does not inherit",
  mergeCarryForward(nextYear, existing).rows[0].drivetrain === null,
  JSON.stringify(mergeCarryForward(nextYear, existing).rows[0]));

// PGRST102 regression (2026-08-13): PostgREST bulk INSERT requires every
// object in the batch to share ONE key set. Carrying enrichment onto only the
// rows that had a predecessor made the batch heterogeneous, the INSERT 400'd
// with "All object keys must match" AFTER the DELETE had run, and eleven makes
// (Mazda 74, Kia 106, Ford 78, …) left msrp_catalog in production. Every row
// must leave the merge with every carry column present.
{
  const mixed = [
    { year: 2026, model: "Camry", trim: "XLE", msrp: 49442 },  // has a predecessor -> carries
    { year: 2026, model: "Camry", trim: "TRD", msrp: 45000 },  // brand new -> carries nothing
  ];
  const merged = mergeCarryForward(mixed, existing).rows;
  const keySets = merged.map((r) => Object.keys(r).sort().join(","));
  check("batch stays homogeneous when only some rows carry (PGRST102 class)",
    new Set(keySets).size === 1 && CARRY_FORWARD.every((c) => c in merged[1]),
    `key sets diverged: ${JSON.stringify(keySets)}`);
}

check("every enrichment column is covered by a case",
  CARRY_FORWARD.every((c) => ["drivetrain", "attrs", "price_basis", "source_url"].includes(c)),
  `CARRY_FORWARD=${CARRY_FORWARD.join(",")} — add a case for any new column`);

// Empty inputs must not throw: an empty scrape already emptied a table once.
check("empty inputs are safe",
  mergeCarryForward([], existing).rows.length === 0 && mergeCarryForward(scraped, []).carried === 0,
  "threw or mis-merged on empty input");

console.log(`\n${pass}/${pass + fail} passed${fail ? `  — ${fail} FAILING` : "  ✓ all green"}`);
process.exit(fail ? 1 : 0);
