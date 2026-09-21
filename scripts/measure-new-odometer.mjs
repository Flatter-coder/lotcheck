// Measures the odometer distribution of dealer-labelled NEW Alberta listings.
//
// This is the evidence behind DELIVERY_KM in supabase/functions/_shared/condition.ts.
// A threshold nobody can re-measure is one nobody can defend, and the number it
// replaced ("5,000, because that felt like a lot") is exactly what happens
// without this. Run it before changing DELIVERY_KM; paste the result into the
// comment there.
//
// Reads fn_market_comps, which is already deployed and already grants anon
// execute -- no new production surface for a measurement. Keeps no row data.
//
//   node scripts/measure-new-odometer.mjs
//
// Last run 2026-09-21: 8,281 readings / 221 combos, p50 10 km, p90 90 km,
// 93.3% at or under 100 km, valley at 501-1000 (0.3%), second population above
// 2,000 km.

import { readFileSync } from "node:fs";
const key = readFileSync("src/App.jsx","utf8").match(/SB_ANON_KEY\s*=\s*["']([^"']+)/)[1];
const U = "https://debigtyjhjamipooajhk.supabase.co";
const H = { apikey:key, Authorization:`Bearer ${key}`, "Content-Type":"application/json" };

// model list from the catalogue (anon-readable), paginated properly
let rows=[], off=0;
for(;;){
  const r = await fetch(`${U}/rest/v1/msrp_catalog?select=year,make,model&order=id.asc&offset=${off}&limit=1000`,{headers:H});
  const j = await r.json(); rows = rows.concat(j);
  if (j.length < 1000) break; off += 1000;
}
const combos = [...new Map(rows.filter(r=>r.year>=2025).map(r=>[`${r.year}|${r.make}|${r.model}`, r])).values()];
console.error(`probing ${combos.length} year/make/model combos...`);

const km = [];
let calls=0, withRows=0;
for (const c of combos) {
  const res = await fetch(`${U}/rest/v1/rpc/fn_market_comps`, { method:"POST", headers:H, body: JSON.stringify({
    p_year:c.year, p_make:c.make, p_model:c.model, p_condition:"new", p_year_span:1, p_limit:500 })});
  calls++;
  if(!res.ok){ if(calls<3) console.error("ERR", res.status, (await res.text()).slice(0,120)); continue; }
  const arr = await res.json();
  if(Array.isArray(arr) && arr.length){ withRows++; for(const v of arr) if(v.odometerKm!=null && v.odometerKm>=0) km.push(Number(v.odometerKm)); }
}
km.sort((a,b)=>a-b);
const pct = p => km.length ? km[Math.min(km.length-1, Math.floor(p/100*km.length))] : null;
const band = (lo,hi)=>km.filter(v=>v>=lo&&v<=hi).length;
const pctOf = n => km.length ? (100*n/km.length).toFixed(1)+"%" : "-";
console.log(`calls ${calls} · combos returning listings ${withRows} · odometer readings ${km.length}`);
console.log(`p50 ${pct(50)} · p75 ${pct(75)} · p90 ${pct(90)} · p95 ${pct(95)} · p99 ${pct(99)} · max ${km[km.length-1]}`);
console.log("");
console.log("band            count    share   cumulative");
let cum=0;
for(const [lab,lo,hi] of [["0 km",0,0],["1-50",1,50],["51-100",51,100],["101-250",101,250],["251-500",251,500],["501-1000",501,1000],["1001-2000",1001,2000],["2001-5000",2001,5000],["5001-10000",5001,10000],["10001+",10001,1e9]]){
  const n=band(lo,hi); cum+=n;
  console.log(`${lab.padEnd(14)} ${String(n).padStart(6)}  ${pctOf(n).padStart(7)}  ${pctOf(cum).padStart(7)}`);
}
console.log("");
for(const t of [500,1000,1500,2000,3000,5000]) console.log(`  above ${String(t).padStart(5)} km: ${band(t+1,1e9)} (${pctOf(band(t+1,1e9))})`);
