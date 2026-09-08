#!/usr/bin/env node
// Offline assertions for aggregateDailyCounts — no database in the loop.
// Run: npm run test:inventory-daily
import { aggregateDailyCounts, aggregateByCity, PLAUSIBLE_MAX_PER_DEALER_PER_CONDITION } from "./lib/inventory-daily.mjs";

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.error(`  FAIL ${label}`); }
}

// 1) plain case: everything under the cap counts toward verified, and raw == verified.
{
  const r = aggregateDailyCounts([
    { dealerId: 1, dealerName: "Revolution Ford", condition: "used", n: 31 },
    { dealerId: 1, dealerName: "Revolution Ford", condition: "new", n: 40 },
    { dealerId: 2, dealerName: "Okotoks Volkswagen", condition: "used", n: 75 },
  ]);
  ok("under-cap rows count toward verified", r.usedVerified === 106 && r.newVerified === 40);
  ok("raw equals verified when nothing is flagged", r.usedRaw === r.usedVerified && r.newRaw === r.newVerified);
  ok("nothing flagged, no note", r.dealersFlagged === 0 && r.notes === null);
}

// 2) the actual Shaw-shaped case: one dealer far over the cap on BOTH conditions.
{
  const r = aggregateDailyCounts([
    { dealerId: 9, dealerName: "Shaw GMC Chevrolet Buick", condition: "used", n: 5163 },
    { dealerId: 9, dealerName: "Shaw GMC Chevrolet Buick", condition: "new", n: 5038 },
    { dealerId: 1, dealerName: "Murray Chevrolet Cadillac Medicine Hat", condition: "used", n: 312 },
  ]);
  ok("flagged dealer excluded from used-verified", r.usedVerified === 312);
  ok("flagged dealer excluded from new-verified", r.newVerified === 0);
  ok("flagged dealer still counted in raw (both conditions)", r.usedRaw === 5163 + 312 && r.newRaw === 5038);
  ok("exactly one dealer flagged, not one per condition", r.dealersFlagged === 1);
  ok("note names the dealer and the cap", r.notes && r.notes.includes("Shaw") && r.notes.includes("5,163"));
}

// 3) boundary: exactly at the cap counts; one unit over does not.
{
  const atCap = aggregateDailyCounts([{ dealerId: 3, dealerName: "X", condition: "used", n: PLAUSIBLE_MAX_PER_DEALER_PER_CONDITION }]);
  ok("exactly at the cap is verified", atCap.usedVerified === PLAUSIBLE_MAX_PER_DEALER_PER_CONDITION && atCap.dealersFlagged === 0);
  const overCap = aggregateDailyCounts([{ dealerId: 3, dealerName: "X", condition: "used", n: PLAUSIBLE_MAX_PER_DEALER_PER_CONDITION + 1 }]);
  ok("one unit over the cap is flagged", overCap.usedVerified === 0 && overCap.dealersFlagged === 1);
}

// 4) missing-read-as-zero guard: a non-numeric n never silently becomes NaN-poisoned totals.
{
  const r = aggregateDailyCounts([{ dealerId: 4, dealerName: "Y", condition: "used", n: null }, { dealerId: 5, dealerName: "Z", condition: "used", n: 20 }]);
  ok("a null count reads as zero, not NaN", Number.isFinite(r.usedVerified) && r.usedVerified === 20);
}

// 5) empty input is a legitimate zero day, not a crash.
{
  const r = aggregateDailyCounts([]);
  ok("empty input returns all zeros", r.newRaw === 0 && r.usedRaw === 0 && r.dealersFlagged === 0 && r.notes === null);
}

// 6) aggregateByCity: splits by city, caps INDEPENDENTLY per city, drops no-city dealers.
{
  const dealerCityKey = new Map([[1, "calgary"], [2, "calgary"], [9, "edmonton"], [99, null]]);
  const rows = aggregateByCity([
    { dealerId: 1, dealerName: "Calgary A", condition: "used", n: 40 },
    { dealerId: 2, dealerName: "Calgary B", condition: "used", n: 60 },
    { dealerId: 9, dealerName: "Shaw-like", condition: "used", n: 5163 },
    { dealerId: 99, dealerName: "No City Motors", condition: "used", n: 500 },
  ], dealerCityKey);
  const calgary = rows.find((r) => r.cityKey === "calgary");
  const edmonton = rows.find((r) => r.cityKey === "edmonton");
  ok("no-city dealer produces no city row", rows.length === 2);
  ok("calgary sums its own dealers only", calgary.usedVerified === 100 && calgary.dealersSeen === 2);
  ok("a cap-exceeding dealer is flagged within ITS city, not the other one", edmonton.dealersFlagged === 1 && edmonton.usedVerified === 0 && calgary.dealersFlagged === 0);
}

// 7) aggregateByCity: empty input is zero cities, not a crash.
{
  const rows = aggregateByCity([], new Map());
  ok("no counts means no city rows", rows.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
