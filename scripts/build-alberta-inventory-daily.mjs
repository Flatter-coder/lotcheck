#!/usr/bin/env node
// ── Alberta inventory daily: today's new-for-sale and used-for-sale counts ──
//
// Run after a real (non-dry-run) crawl, in the same job so the DB is fresh:
//   node scripts/build-alberta-inventory-daily.mjs
//   node scripts/build-alberta-inventory-daily.mjs --date=2026-09-04   # backfill
//
// SOURCE OF TRUTH IS listing_observation, NOT a log. The crawl writes one
// listing_observation row per listing it actually saw each day
// (fn_upsert_listings, see 20260903_listing_observation.sql) — that is a
// direct database fact, unlike re-parsing a GitHub Actions log line, which is
// how this same class of number went wrong before. [[verify-in-production-before-done]]
//
// A day with zero observations writes NOTHING and exits non-zero — a crawl
// that did not run, or ran dry, must never be read as "zero cars for sale in
// Alberta today". [[report-never-empty]] [[catalog-refresh-can-empty-catalog]]
import { createClient } from "@supabase/supabase-js";
import { issuedAmvicHosts } from "./lib/amvic-hosts.mjs";
import { aggregateDailyCounts } from "./lib/inventory-daily.mjs";

function parseArgs() {
  const out = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function pageAll(supabase, table, cols, filterFn) {
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select(cols).range(from, from + PAGE - 1);
    if (filterFn) q = filterFn(q);
    const { data, error } = await q;
    if (error) throw new Error(`could not read ${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const day = args.date || new Date().toISOString().slice(0, 10);
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"); process.exit(1); }
  const supabase = createClient(url, key);

  const dealers = await pageAll(supabase, "dealer_source", "id,name,active", (q) => q.eq("active", true));
  const dealerName = new Map(dealers.map((d) => [d.id, d.name]));

  // listing_observation.observed_on = day, joined to vehicle_listing for
  // dealer and condition. Supabase's embedded-resource select does the join
  // in one round trip.
  const observations = await pageAll(
    supabase, "listing_observation",
    "listing_id,vehicle_listing!inner(dealer_id,condition)",
    (q) => q.eq("observed_on", day)
  );

  if (!observations.length) {
    console.error(`No listing_observation rows for ${day} — no crawl ran (or it was --dry-run). Writing nothing.`);
    process.exit(1);
  }

  // group -> one row per (dealer, condition)
  const grouped = new Map(); // key "dealerId|condition" -> n
  for (const o of observations) {
    const vl = o.vehicle_listing;
    if (!vl || !vl.condition) continue;
    const k = `${vl.dealer_id}|${vl.condition}`;
    grouped.set(k, (grouped.get(k) || 0) + 1);
  }
  const counts = [...grouped.entries()].map(([k, n]) => {
    const [dealerId, condition] = k.split("|");
    return { dealerId: Number(dealerId), dealerName: dealerName.get(Number(dealerId)), condition, n };
  });

  const agg = aggregateDailyCounts(counts);
  const dealersSeen = new Set(counts.map((c) => c.dealerId)).size;

  const [arrivedRes, delistedRes, pricedRes] = await Promise.all([
    supabase.from("vehicle_listing").select("id", { count: "exact", head: true }).eq("first_seen_on", day),
    supabase.from("vehicle_listing").select("id", { count: "exact", head: true }).eq("delisted_on", day),
    supabase.from("listing_price_history").select("id", { count: "exact", head: true }).eq("observed_on", day),
  ]);
  for (const [label, res] of [["arrived", arrivedRes], ["delisted", delistedRes], ["price_events", pricedRes]]) {
    if (res.error) throw new Error(`could not count ${label}: ${res.error.message}`);
  }

  let amvicHosts = null;
  try { amvicHosts = (await issuedAmvicHosts(supabase)).size; }
  catch (e) { console.warn("could not read AMVIC issued hosts (coverage will be null):", e.message); }

  const row = {
    day,
    computed_at: new Date().toISOString(),
    dealers_active: dealers.length,
    dealers_seen: dealersSeen,
    dealers_flagged: agg.dealersFlagged,
    amvic_issued_hosts: amvicHosts,
    new_units_raw: agg.newRaw,
    new_units_verified: agg.newVerified,
    used_units_raw: agg.usedRaw,
    used_units_verified: agg.usedVerified,
    arrived: arrivedRes.count ?? 0,
    delisted: delistedRes.count ?? 0,
    price_events: pricedRes.count ?? 0,
    notes: agg.notes,
  };

  console.log(`[${day}] ${dealersSeen} dealers seen (${agg.dealersFlagged} flagged).`);
  console.log(`  new:  ${row.new_units_verified.toLocaleString("en-CA")} verified / ${row.new_units_raw.toLocaleString("en-CA")} raw`);
  console.log(`  used: ${row.used_units_verified.toLocaleString("en-CA")} verified / ${row.used_units_raw.toLocaleString("en-CA")} raw`);
  console.log(`  arrived ${row.arrived} · delisted ${row.delisted} · price events ${row.price_events}`);
  if (amvicHosts) console.log(`  coverage: ${dealers.length} active dealers / ${amvicHosts} AMVIC-issued hosts = ${((dealers.length / amvicHosts) * 100).toFixed(1)}%`);
  if (row.notes) console.log(`  FLAGGED: ${row.notes}`);

  const res = await fetch(`${url}/rest/v1/alberta_inventory_daily?on_conflict=day`, {
    method: "POST",
    headers: {
      apikey: key, Authorization: `Bearer ${key}`,
      "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify([row]),
  });
  if (!res.ok) throw new Error(`write alberta_inventory_daily -> HTTP ${res.status}: ${await res.text()}`);
  console.log(`\nWrote alberta_inventory_daily for ${day}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
