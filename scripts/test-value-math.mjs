// Regression suite for the rebuilt value-report math (marketvalue.ts):
// mileageAdjustedValue, valueTiers, pickNamedComps.
// Run: node --experimental-strip-types scripts/test-value-math.mjs
//
// The bar is Collette's report: her 2022 Odyssey EX-L at 148,000 km is worth
// ~$30k retail, NOT the $41,390 raw median (which is the price of much
// lower-km comps). The mileage fit must step the number DOWN to her mileage.

import { mileageAdjustedValue, valueTiers, pickNamedComps, median } from "../supabase/functions/_shared/marketvalue.ts";

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : detail}`); cond ? pass++ : fail++; };

// Collette's real Alberta comps (from the approved report), price-vs-km.
const COMPS = [
  { price: 41390, odometerKm: 39587,  trim: "Touring",       dealerName: "LotCheck crawl",         city: null },
  { price: 41900, odometerKm: 68770,  trim: "EX-L RES",      dealerName: "Honda Certified",        city: "Edmonton" },
  { price: 38888, odometerKm: 83031,  trim: "EX",            dealerName: "Adrenalin Motors",       city: "Red Deer" },
  { price: 39995, odometerKm: 92390,  trim: "Touring",       dealerName: "LotCheck crawl",         city: null },
  { price: 40909, odometerKm: 98452,  trim: "EX-L RES",      dealerName: "West Edmonton VW",       city: "Edmonton" },
  { price: 32998, odometerKm: 121531, trim: "EX-L FWD+Nav",  dealerName: "Calgary dealer",         city: "Calgary" },
  { price: 34988, odometerKm: 127151, trim: "EX-L RES",      dealerName: "Wheaton Honda",          city: "Edmonton" },
];
const RAW_MEDIAN = median(COMPS.map((c) => c.price)); // ~$39,995

// ---- mileage adjustment steps the number DOWN to 148k ----
{
  const adj = mileageAdjustedValue(COMPS, 148000, RAW_MEDIAN);
  check("returns a mileage adjustment for a 148k subject", !!adj, ` got ${JSON.stringify(adj)}`);
  check("slope is negative (price falls with km)", adj && adj.slopePerKm < 0, ` slope ${adj && adj.slopePerKm}`);
  check("estimate is WELL BELOW the raw median (not $41,390)", adj && adj.estimate < RAW_MEDIAN - 4000, ` est ${adj && adj.estimate} vs median ${RAW_MEDIAN}`);
  check("estimate lands in a believable high-km range ($26k–$36k)", adj && adj.estimate >= 26000 && adj.estimate <= 36000, ` est ${adj && adj.estimate}`);
  check("flagged as extrapolated (148k is past the comps' 127k ceiling)", adj && adj.extrapolated === true);
  check("estimate never exceeds the raw median (clamp)", adj && adj.estimate <= RAW_MEDIAN);
}

// ---- guards: no fabrication when the signal isn't there ----
check("fewer than 5 comps -> null (won't trust a slope)", mileageAdjustedValue(COMPS.slice(0, 4), 148000, RAW_MEDIAN) === null);
check("no subject km -> null", mileageAdjustedValue(COMPS, null, RAW_MEDIAN) === null);
check("price RISING with km (no usable signal) -> null",
  mileageAdjustedValue([{price:20000,odometerKm:20000},{price:25000,odometerKm:60000},{price:30000,odometerKm:100000},{price:35000,odometerKm:140000},{price:40000,odometerKm:180000}], 150000, 30000) === null);
check("comps without km -> null", mileageAdjustedValue(COMPS.map((c) => ({ ...c, odometerKm: null })), 148000, RAW_MEDIAN) === null);

// ---- three exits: trade < private < retail, spreads correct ----
{
  const adj = mileageAdjustedValue(COMPS, 148000, RAW_MEDIAN);
  const t = valueTiers(adj.estimate, { topEnd: true });
  check("tiers computed", !!t);
  check("trade < private < retail (point)", t && t.trade.point < t.privateParty.point && t.privateParty.point < t.retail.point, ` ${t && JSON.stringify({tr:t.trade.point,pv:t.privateParty.point,rt:t.retail.point})}`);
  check("private ≈ 8–15% under retail estimate", t && t.privateParty.high <= adj.estimate * 0.94 && t.privateParty.high >= adj.estimate * 0.84);
  check("trade ≈ 15–25% under retail estimate", t && t.trade.high <= adj.estimate * 0.84 && t.trade.high >= adj.estimate * 0.72);
  check("topEnd places the subject at the HIGH end of each range", t && t.privateParty.point === t.privateParty.high && t.trade.point === t.trade.high);
  const mid = valueTiers(adj.estimate, { topEnd: false });
  check("no strong condition -> mid-range placement", mid && mid.privateParty.point > mid.privateParty.low && mid.privateParty.point < mid.privateParty.high);
  check("valueTiers(0) -> null (no fabrication)", valueTiers(0) === null);
}

// ---- named comps: sorted by mileage, capped, spans the range ----
{
  const named = pickNamedComps(COMPS, 8);
  check("named comps returned, sorted by km ascending", named.length === 7 && named[0].odometerKm < named[named.length - 1].odometerKm);
  check("carries dealer names for the table", named.some((c) => c.dealerName && c.dealerName !== "LotCheck crawl"));
  // a large pool is sampled down, still spanning low->high km
  const big = Array.from({ length: 40 }, (_, i) => ({ price: 40000 - i * 300, odometerKm: 30000 + i * 4000 }));
  const s = pickNamedComps(big, 8);
  check("large pool sampled to the cap", s.length === 8);
  check("sample still spans low to high km", s[0].odometerKm <= 40000 && s[s.length - 1].odometerKm >= 180000);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
