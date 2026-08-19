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

import { mergeCarryForward, CARRY_FORWARD, uniformKeys, assessCollapse } from "./lib/catalog-io.mjs";

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
  { year: 2026, model: "Camry", trim: "SE",  drivetrain: "FWD", source_url: "https://toyota.ca/...", fuel_type: "Hybrid" },
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

// fuel_type joined CARRY_FORWARD on 2026-08-19. Most scrapers cannot state it --
// inferFuelFromName only fires on "hybrid"/"plug-in"/"EV" in the trim string --
// so a value established from an authoritative source has to survive the next
// delete-then-insert or the backfill is pointless.
check("fuel_type carries", byTrim("SE").fuel_type === "Hybrid", JSON.stringify(byTrim("SE")));

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
  CARRY_FORWARD.every((c) => ["drivetrain", "attrs", "price_basis", "source_url", "fuel_type"].includes(c)),
  `CARRY_FORWARD=${CARRY_FORWARD.join(",")} — add a case for any new column`);

// Empty inputs must not throw: an empty scrape already emptied a table once.
check("empty inputs are safe",
  mergeCarryForward([], existing).rows.length === 0 && mergeCarryForward(scraped, []).carried === 0,
  "threw or mis-merged on empty input");

// ---------------------------------------------------------------------------
// The wipe of 2026-08-14. Carry-forward WORKED and that is what broke it: rows
// that matched gained keys, rows that did not keep the scraper's key set, and
// PostgREST rejects a bulk INSERT whose objects disagree (400 PGRST102 "All
// object keys must match"). The DELETE had already committed, so 12 makes went
// to zero -- Kia, Honda, Ford, Mazda, Nissan, Subaru, VW and more. 883 rows /
// 32 makes became 412 / 21.
// ---------------------------------------------------------------------------
const keysOf = (rs) => rs.map((r) => Object.keys(r).sort().join(","));
const allSame = (rs) => new Set(keysOf(rs)).size <= 1;

// TWO INDEPENDENT LAYERS now stand between that batch and PostgREST, and both
// are tested here because each covers a case the other does not.
//
// LAYER 1 — mergeCarryForward emits EVERY carry column on EVERY row, explicit
// null where there is nothing to carry. This used to be the bug: only matched
// rows gained keys. It is now the first line of defence.
check("LAYER 1: mergeCarryForward alone emits homogeneous CARRY_FORWARD keys",
  allSame(mergeCarryForward(scraped, existing).rows) &&
  CARRY_FORWARD.every((c) => mergeCarryForward(scraped, existing).rows.every((r) => c in r)),
  `key sets: ${[...new Set(keysOf(mergeCarryForward(scraped, existing).rows))].join("  |  ")}`);

// LAYER 2 — uniformKeys is NOT redundant, and this is the proof. It normalises
// EVERY key; mergeCarryForward only ever touches CARRY_FORWARD. A scraper that
// emits a field on some rows and omits it on others (here: fuel_type) produces
// exactly the PGRST102 shape, and layer 1 cannot see it.
// Uses all_in_price, NOT fuel_type: fuel_type is now carried forward, so layer 1
// fills it and the rows would no longer diverge -- which would quietly turn this
// case into a no-op and make uniformKeys look like dead code. The point is a
// SCRAPER field that carry-forward does not cover, and all_in_price is one.
const ragged = [
  { year: 2026, make: "Toyota", model: "Camry", trim: "XLE", msrp: 49442, all_in_price: 52000 },
  { year: 2026, make: "Toyota", model: "Camry", trim: "SE",  msrp: 38792 },  // no all_in_price
];
check("LAYER 2: a scraper field missing on some rows still diverges after layer 1",
  !allSame(mergeCarryForward(ragged, existing).rows),
  "if this passes, uniformKeys may now be dead code — check before deleting it");

check("LAYER 2: uniformKeys catches what layer 1 cannot",
  allSame(uniformKeys(mergeCarryForward(ragged, existing).rows)) &&
  uniformKeys(mergeCarryForward(ragged, existing).rows)
    .find((r) => r.trim === "SE").all_in_price === null,
  `key sets: ${[...new Set(keysOf(uniformKeys(mergeCarryForward(ragged, existing).rows)))].join("  |  ")}`);

const shipped = uniformKeys(mergeCarryForward(scraped, existing).rows);
check("THE FIX: uniformKeys makes every row's key set identical",
  allSame(shipped), `key sets: ${[...new Set(keysOf(shipped))].join("  |  ")}`);

// The exact shape that killed the insert: one make's batch where some rows
// matched a previous row and one (a brand-new trim) matched nothing.
const mixed = uniformKeys(mergeCarryForward([...scraped, ...newTrim], existing).rows);
check("in a mixed batch, the row that matched nothing is padded to null",
  allSame(mixed) &&
  mixed.find((r) => r.trim === "TRD").drivetrain === null &&
  mixed.find((r) => r.trim === "XLE").drivetrain === "AWD",
  JSON.stringify(mixed.find((r) => r.trim === "TRD")));

check("real values are preserved, not flattened to null",
  shipped.find((r) => r.trim === "XLE").drivetrain === "AWD" &&
  shipped.find((r) => r.trim === "XLE").msrp === 49442,
  JSON.stringify(shipped.find((r) => r.trim === "XLE")));

check("falsy-but-real values survive (0 and false are not missing)",
  uniformKeys([{ a: 0, b: false }, { a: 1 }])[0].a === 0 &&
  uniformKeys([{ a: 0, b: false }, { a: 1 }])[0].b === false &&
  uniformKeys([{ a: 0, b: false }, { a: 1 }])[1].b === null,
  JSON.stringify(uniformKeys([{ a: 0, b: false }, { a: 1 }])));

check("id is never sent — the database owns it",
  !("id" in uniformKeys([{ id: 5176, msrp: 1 }])[0]),
  JSON.stringify(uniformKeys([{ id: 5176, msrp: 1 }])[0]));

check("uniformKeys is safe on empty input",
  uniformKeys([]).length === 0 && uniformKeys(null).length === 0, "threw on empty");

// ---------------------------------------------------------------------------
// The second wipe, independent of the first: a PARTIAL scrape. Toyota returned
// 7 rows (bZ, bZ Woodland, C-HR) instead of its full lineup on 2026-08-14. The
// old guard only fired at exactly zero, so the delete ran and the job logged
// "replaced with 7 rows" as success. No RAV4 in the catalog is why the MSRP
// checkpoint cannot pass.
// ---------------------------------------------------------------------------
check("a partial scrape is REFUSED (Toyota 400 -> 7)",
  assessCollapse(400, 7).collapse, JSON.stringify(assessCollapse(400, 7)));

check("a total wipe is refused (Kia 106 -> 0 would never reach here, but guard it)",
  assessCollapse(106, 0).collapse, JSON.stringify(assessCollapse(106, 0)));

check("a normal refresh is allowed through",
  !assessCollapse(78, 78).collapse && !assessCollapse(78, 74).collapse,
  JSON.stringify(assessCollapse(78, 74)));

check("exactly half is allowed — the guard is >50% loss, not >=",
  !assessCollapse(100, 50).collapse && assessCollapse(100, 49).collapse,
  `50=${JSON.stringify(assessCollapse(100, 50))} 49=${JSON.stringify(assessCollapse(100, 49))}`);

check("a make too small to judge is not blocked (Fiat has 2 rows)",
  !assessCollapse(2, 1).collapse && !assessCollapse(9, 1).collapse,
  JSON.stringify(assessCollapse(2, 1)));

check("a make GROWING is never a collapse",
  !assessCollapse(10, 400).collapse, JSON.stringify(assessCollapse(10, 400)));

check("the collapse reason names both counts, so the log says what was saved",
  /400/.test(assessCollapse(400, 7).reason) && /7/.test(assessCollapse(400, 7).reason),
  assessCollapse(400, 7).reason);

console.log(`\n${pass}/${pass + fail} passed${fail ? `  — ${fail} FAILING` : "  ✓ all green"}`);
process.exit(fail ? 1 : 0);
