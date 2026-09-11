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
import { aggregateDailyCounts, aggregateByCity } from "./lib/inventory-daily.mjs";
// Reused, not reimplemented: dealer_source.city is free text off two rosters
// (AMVIC + OSM), so "St. Albert" / "ST. ALBERT" / "Saint Albert" are the same
// place under three spellings. build-city-price-index.mjs already solved
// this for the price-index feature; a second, independent city-grouping
// function here would be the exact two-authors-per-fact shape that has
// caused a real defect before (the RAV4 / RAV4 Hybrid split).
import { cityKey, prettyCity, MIN_DEALERS } from "./build-city-price-index.mjs";

function parseArgs() {
  const out = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// UNORDERED .range() PAGINATION IS HOW A COUNT STOPS BEING REPRODUCIBLE.
// scripts/amvic-activities.mjs hit this once already at 21,866 rows: without
// an ORDER BY, Postgres is free to return a different slice on each request,
// so paging can silently skip or duplicate rows between pages. This is the
// exact shape of the 2026-09-07 defect that undercounted this report by
// Shaw's entire ~10,000-unit block — orderCol is now REQUIRED, not optional,
// so a future caller cannot reintroduce the same bug by omission.
async function pageAll(supabase, table, cols, orderCol, filterFn) {
  if (!orderCol) throw new Error(`pageAll(${table}): orderCol is required — unordered pagination silently drops rows`);
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select(cols).order(orderCol, { ascending: true }).range(from, from + PAGE - 1);
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

  const dealers = await pageAll(supabase, "dealer_source", "id,name,active,city", "id", (q) => q.eq("active", true));
  const dealerName = new Map(dealers.map((d) => [d.id, d.name]));

  // dealerId -> normalized cityKey (or null for dealers with no city --
  // excluded from every per-city row, same as city_dealer_index). A separate
  // map keeps each key's ORIGINAL spelling variants so prettyCity() can pick
  // a real one instead of reconstructing a title-cased guess.
  const dealerCityKey = new Map();
  const cityVariants = new Map();
  for (const d of dealers) {
    const ck = cityKey(d.city);
    dealerCityKey.set(d.id, ck);
    if (ck) { if (!cityVariants.has(ck)) cityVariants.set(ck, []); cityVariants.get(ck).push(d.city); }
  }

  // listing_observation.observed_on = day, joined to vehicle_listing for
  // dealer and condition. Supabase's embedded-resource select does the join
  // in one round trip. Ordered by listing_id -- the table's own PK has no
  // surrogate id column, and observed_on is already pinned by the filter, so
  // listing_id alone gives a stable, gap-free page boundary.
  const observations = await pageAll(
    supabase, "listing_observation",
    "listing_id,vehicle_listing!inner(dealer_id,condition)",
    "listing_id",
    (q) => q.eq("observed_on", day)
  );

  // A STANDING CROSS-CHECK, not a one-time fix. Compares the paged, joined
  // read above against a plain HEAD count of the same filter with no join and
  // no pagination involved. If a future change to the join, the embed syntax,
  // or the pagination reintroduces a gap, THIS throws instead of silently
  // writing a low number as if it were the truth. [[no-single-point-of-failure]]
  const rawCount = await supabase.from("listing_observation").select("*", { count: "exact", head: true }).eq("observed_on", day);
  if (rawCount.error) throw new Error(`could not count listing_observation: ${rawCount.error.message}`);
  if (rawCount.count !== observations.length) {
    throw new Error(
      `listing_observation read mismatch for ${day}: paged+joined query returned ${observations.length} rows, ` +
      `a plain count says ${rawCount.count}. Refusing to write a report that may be undercounting. ` +
      `(This is the exact defect class that undercounted 2026-09-07 by Shaw's entire block.)`
    );
  }

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
  const seenIds = new Set(counts.map((c) => c.dealerId));
  const dealersSeen = seenIds.size;

  // NAME THE DEALERS WITH ZERO OBSERVATIONS TODAY, don't just subtract them
  // silently into "8 dealers not seen". An active dealer with no observation
  // row is either a real zero-inventory day, a crawl failure the "2 failed"
  // count already covers, OR -- as found 2026-09-07 -- a dealer whose
  // fn_upsert_listings calls report success while never writing the
  // heartbeat, which no amount of correct pagination on THIS side will catch.
  // [[no-silent-caps]] this is the log line that would have surfaced Shaw
  // immediately instead of a multi-hour investigation.
  const silentDealers = dealers.filter((d) => !seenIds.has(d.id));
  if (silentDealers.length) {
    console.log(`  ${silentDealers.length} active dealer(s) contributed ZERO observations today:`);
    for (const d of silentDealers) console.log(`    id=${d.id}  ${d.name ?? "(unnamed)"}`);
  }
  const silentNote = silentDealers.length
    ? `${silentDealers.length} active dealer(s) recorded no observation today and are excluded from every count above: ` +
      silentDealers.map((d) => d.name ?? `dealer ${d.id}`).join(", ") + "."
    : null;

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
    notes: [agg.notes, silentNote].filter(Boolean).join(" ") || null,
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

  // ---- per-city rows: the SAME cap, run again inside each city ------------
  const cityAgg = aggregateByCity(counts, dealerCityKey);
  const cityRows = cityAgg.map((c) => ({
    day, city: prettyCity(cityVariants.get(c.cityKey)) || c.cityKey, province: "AB",
    computed_at: new Date().toISOString(),
    dealers_seen: c.dealersSeen, dealers_flagged: c.dealersFlagged,
    new_units_verified: c.newVerified, new_units_raw: c.newRaw,
    used_units_verified: c.usedVerified, used_units_raw: c.usedRaw,
    notes: c.notes,
  }));

  console.log(`\n${cityRows.length} cit${cityRows.length === 1 ? "y" : "ies"} with at least one dealer seen (${cityRows.filter((r) => r.dealers_seen >= MIN_DEALERS).length} clear the ${MIN_DEALERS}-dealer publish gate):`);
  for (const c of cityRows.sort((a, b) => b.used_units_verified - a.used_units_verified)) {
    console.log(`  ${c.city.padEnd(20)} ${String(c.dealers_seen).padStart(2)} dealer(s)  new ${c.new_units_verified}  used ${c.used_units_verified}${c.dealers_seen < MIN_DEALERS ? "  (below publish gate)" : ""}`);
  }

  if (cityRows.length) {
    const cityRes = await fetch(`${url}/rest/v1/city_inventory_daily?on_conflict=day,city,province`, {
      method: "POST",
      headers: {
        apikey: key, Authorization: `Bearer ${key}`,
        "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(cityRows),
    });
    if (!cityRes.ok) throw new Error(`write city_inventory_daily -> HTTP ${cityRes.status}: ${await cityRes.text()}`);
    console.log(`Wrote ${cityRows.length} city_inventory_daily row(s) for ${day}.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
