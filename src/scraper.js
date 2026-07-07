// ─────────────────────────────────────────────────────────────────────────────
// LotCheck — Apify → Supabase Pipeline
// Scrapes Kijiji + AutoTrader Canada daily, stores in Supabase
// Runs via GitHub Actions cron (see scrape.yml)
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";
import { ApifyClient } from "apify-client";

// ── CONFIG — reads from GitHub Secrets (never hardcode keys) ─────────────────
const APIFY_TOKEN  = process.env.APIFY_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL || "https://debigtyjhjamipooajhk.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!APIFY_TOKEN || !SUPABASE_KEY) {
  console.error("❌ Missing APIFY_TOKEN or SUPABASE_SERVICE_ROLE_KEY environment variables");
  process.exit(1);
}

// ── SEARCH URLS — Alberta only (Calgary, Edmonton), all fuel types ───────────
// Kijiji location IDs: Calgary=1700199, Edmonton=1700203
const SEARCH_URLS = [
  // ── Alberta only, per Vic's decision 2026-07-06: the other provinces'
  // scraping cost real money for a market LotCheck has no actual presence
  // in yet (no dealer relationships, no local rebate depth). Narrowing
  // concentrates the same daily scrape capacity on Alberta specifically,
  // meaning deeper, more frequent re-checks of the listings that actually
  // matter right now instead of spreading thin across the whole country.
  // The two Canada-wide EV/Hybrid searches that used to exist here were
  // removed too, since "Canada-wide" directly conflicts with "Alberta
  // only" -- Calgary and Edmonton's general searches below already pick up
  // any EV/Hybrid/PHEV posted in those cities, just without that extra
  // national-level net for those fuel types specifically.
  "https://www.kijiji.ca/b-cars-trucks/calgary/c174l1700199",
  "https://www.kijiji.ca/b-cars-trucks/edmonton/c174l1700203",
];

// ── PROVINCE DETECTION from city/location string ─────────────────────────────
function detectProvince(location = "") {
  const l = location.toLowerCase();
  if (l.includes("calgary") || l.includes("edmonton") || l.includes("alberta") || l.includes(", ab")) return "AB";
  if (l.includes("vancouver") || l.includes("victoria") || l.includes("british columbia") || l.includes(", bc")) return "BC";
  if (l.includes("toronto") || l.includes("ottawa") || l.includes("ontario") || l.includes(", on")) return "ON";
  if (l.includes("montreal") || l.includes("quebec") || l.includes(", qc")) return "QC";
  if (l.includes("winnipeg") || l.includes("manitoba") || l.includes(", mb")) return "MB";
  if (l.includes("halifax") || l.includes("nova scotia") || l.includes(", ns")) return "NS";
  if (l.includes("fredericton") || l.includes("moncton") || l.includes(", nb")) return "NB";
  return "AB"; // default
}

// ── FUEL TYPE DETECTION ───────────────────────────────────────────────────────
function detectFuel(item) {
  const title = (item.title || "").toLowerCase();
  const desc  = (item.description || "").toLowerCase();
  const text  = title + " " + desc;

  // Always check title first for PHEV keywords — most reliable signal
  // Kijiji's "Fuel Type" attribute often says "Hybrid" for PHEVs
  const isPHEVTitle = text.includes("plug-in hybrid") || text.includes("phev")
    || text.includes("prime") || text.includes(" phev")
    || title.includes("outlander phev") || title.includes("escape phev")
    || title.includes("rav4 prime") || title.includes("prius prime")
    || title.includes("pacifica hybrid") || title.includes("sportage phev")
    || title.includes("niro phev") || title.includes("sorento phev")
    || title.includes("cx-70 phev") || title.includes("cx-90 phev")
    || title.includes("tucson phev") || title.includes("santa fe phev");
  if (isPHEVTitle) return "PHEV";

  if (text.includes("hybrid")) return "Hybrid";

  // Explicit gas-engine signature — displacement + cylinder count is about
  // as unambiguous an internal-combustion signal as exists (e.g. "4.7L V8",
  // "5.7L HEMI", "3.6L V6", "2.0L turbo 4-cylinder"). Checked BEFORE any
  // looser inference, since a title stating this outright should always
  // win. This exact pattern ("4.7L V8" in the title) was previously being
  // overridden by the loose "electric" fallback below and mislabeled BEV.
  const gasEngineSignature = /\d\.\d\s?l\b|\bv[- ]?6\b|\bv[- ]?8\b|\bhemi\b|\d[- ]?cylinder/i;
  if (gasEngineSignature.test(title)) return "Gas";

  // 2. Trust Kijiji's own "Fuel Type" attribute
  const attr = (item.attributes?.["Fuel Type"] || item.attributes?.fuelType || "").toLowerCase();
  if (attr === "electric" || attr === "battery electric") return "BEV";
  if (attr === "plug-in hybrid" || attr === "phev")       return "PHEV";
  if (attr === "hybrid-electric" || attr === "hybrid")    return "Hybrid";
  if (attr === "diesel")                                  return "Diesel";
  if (attr === "gas" || attr === "gasoline")              return "Gas";

  // 3. Fall back to title/description scanning — requires a SPECIFIC
  // EV-indicating phrase, not a bare "electric" substring. That loose
  // match was catching "electric windows," "electric seats," "electric
  // mirrors" — standard equipment mentions on ordinary gas vehicles — and
  // mislabeling them BEV. Confirmed in production: a 2020 Jeep Cherokee,
  // a 2024 Dodge Hornet, and a 2013 Ram 1500 with "4.7L V8" in the title
  // were all incorrectly tagged BEV because of this.
  const strongEVPattern = /\ball[- ]?electric\b|\bfully electric\b|\bbattery electric\b|\belectric vehicle\b|\b100% electric\b|\bzero emission\b/;
  if (strongEVPattern.test(text)) return "BEV";
  if (text.includes("diesel")) return "Diesel";
  return "Gas";
}

// ── NORMALIZE Apify item → LotCheck listing ───────────────────────────────────
function normalize(item) {
  // Fixed 2026-07-06: this was `item.location?.name || item.locationName`,
  // but per the actor's real output schema, `location` is already a plain
  // string (e.g. "Toronto"), not an object -- so `.name` on a string is
  // always undefined, and `locationName` isn't a real field at all. Both
  // halves of that fallback silently failed on every single listing,
  // which is exactly why every listing in the database was landing on the
  // hardcoded "AB"/"Canada" defaults below regardless of where it actually
  // came from -- confirmed directly: 336/336 published listings showed
  // province="AB" and city="Canada" before this fix.
  const location = item.location || "";
  const province = detectProvince(location);
  const city = location.split(",")[0]?.trim() || "Canada";

  // Extract year/make/model from title like "2023 Toyota RAV4 Prime XSE"
  const titleMatch = (item.title || "").match(/^(\d{4})\s+(\w+)\s+(.+)/);
  const year  = titleMatch ? parseInt(titleMatch[1]) : (parseInt(item.attributes?.Year) || item.year || 2020);
  const make  = titleMatch ? titleMatch[2] : (item.attributes?.Make || item.make || "Unknown");
  const model = titleMatch ? titleMatch[3].split(" ").slice(0,2).join(" ") : (item.attributes?.Model || item.model || "Unknown");

  const price = item.priceAmount || parseInt(String(item.price || "0").replace(/[^0-9]/g, "")) || 0;
  const km    = parseInt(String(item.attributes?.Kilometers || item.mileage || item.kilometers || "0").replace(/[^0-9]/g, "")) || 0;

  return {
    external_id:  item.url || item.adId || item.id,
    name:         item.title || `${year} ${make} ${model}`,
    make,
    model,
    year,
    price,
    km,
    fuel:         detectFuel(item),
    source:       "Kijiji",
    dealer:       Boolean(item.isDealer || item.dealer),
    listing_url:  item.url || "",
    image_url:    item.images?.[0] || item.image || "",
    city,
    province,
    scraped_at:   new Date().toISOString(),
    status:       "pending",
  };
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🍁 LotCheck scraper starting...");
  console.log(`📍 Supabase: ${SUPABASE_URL}`);

  const apify    = new ApifyClient({ token: APIFY_TOKEN });
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Test Supabase connection
  const { error: pingError } = await supabase.from("listings").select("id").limit(1);
  if (pingError) {
    console.error("❌ Supabase connection failed:", pingError.message);
    process.exit(1);
  }
  console.log("✅ Supabase connected");

  // Run Apify scraper
  console.log(`🔍 Scraping ${SEARCH_URLS.length} URLs...`);
  let run;
  try {
    run = await apify.actor("automation-lab/kijiji-scraper").call(
      {
        startUrls: SEARCH_URLS.map(url => ({ url })),
        // Fixed 2026-07-06: this was "maxItems", which this actor doesn't
        // actually recognize as an input -- it's silently ignored, and the
        // actor falls back to its own default of 100 listings/run instead.
        // The real parameter name is "maxListings". Confirmed against real
        // Apify billing data before this fix: actual usage was running around
        // ~186 listings/day total, nowhere near the 1000 this was meant to
        // allow, which is exactly why most listings only ever got a single
        // price_history point before falling out of the daily "newest" results.
        maxListings: 1000,
        proxyConfiguration: { useApifyProxy: true },
      },
      // Fixed 2026-07-07: maxListings:1000 was correctly reaching the actor,
      // but the actor's own run timeout defaults to 300 seconds -- and
      // Kijiji rate-limits this actor hard (repeated HTTP 429s on individual
      // listing detail fetches, each retry costing real time). Confirmed in
      // production: run #24 hit the 300s timeout having only made it through
      // page 5 of the FIRST search URL (Calgary) -- it never even started
      // the second URL (Edmonton), and only reached 184 of the requested
      // 1000. `timeout` is a run-options argument, separate from the actor's
      // own input above, hence the second argument here rather than folding
      // it into the object above. 1200s (20 min) gives real headroom for
      // Kijiji's rate limiting without an unbounded run; GitHub Actions'
      // own job timeout defaults to hours, so it's not the binding
      // constraint here -- only the actor's internal one was. Longer actor
      // runtime does mean more Apify compute usage per run than before;
      // worth a glance at the Apify usage dashboard after a few days to see
      // the real cost impact under the Starter plan.
      { timeout: 1200 }
    );
  } catch (err) {
    console.error("❌ Apify run failed:", err.message);
    process.exit(1);
  }

  console.log(`✅ Apify run complete: ${run.id}`);
  const { items } = await apify.dataset(run.defaultDatasetId).listItems();
  console.log(`📦 ${items.length} raw listings fetched`);

  // Filter valid listings (price > 0, has title)
  const valid = items
    .map(normalize)
    .filter(l => l.price > 0 && l.name && l.external_id);

  console.log(`✅ ${valid.length} valid listings after filtering`);

  // Fixed 2026-07-07: a run this slow gives Kijiji's own live "newest"
  // sorting plenty of time to shift listings between pages mid-scrape (a
  // listing gets bumped/reposted and jumps from page 3 to page 1, say),
  // so the SAME external_id can turn up twice in `valid` across different
  // pages of the same run. Confirmed in production: run #24's batch
  // covering rows 100-150 failed outright with Postgres error "ON CONFLICT
  // DO UPDATE command cannot affect row a second time" -- which fires
  // whenever one upsert batch contains the same conflict-target value
  // (external_id) more than once. That's not a partial failure -- the
  // WHOLE batch of 50 gets rejected, silently losing every listing in it
  // (and cascading into lost price_history rows for those listings' foreign
  // keys too). Deduping by external_id before slicing into batches removes
  // the possibility entirely, regardless of which page order caused the
  // repeat -- keeping the LAST occurrence, which reflects whatever Kijiji
  // returned most recently for that listing within this run.
  const dedupedMap = new Map();
  for (const listing of valid) {
    dedupedMap.set(listing.external_id, listing);
  }
  const deduped = Array.from(dedupedMap.values());
  if (deduped.length !== valid.length) {
    console.log(`🔁 Removed ${valid.length - deduped.length} duplicate listing(s) seen across multiple pages this run`);
  }

  // Upsert listings in batches of 50
  let upserted = 0;
  const BATCH = 50;
  for (let i = 0; i < deduped.length; i += BATCH) {
    const batch = deduped.slice(i, i + BATCH);
    const { error } = await supabase
      .from("listings")
      .upsert(batch, { onConflict: "external_id", ignoreDuplicates: false });

    if (error) {
      console.error(`❌ Batch ${i}-${i+BATCH} failed:`, error.message);
    } else {
      upserted += batch.length;
      console.log(`📝 Upserted ${upserted}/${deduped.length} listings`);
    }
  }

  // Record price history for all valid listings.
  // Previously this was ONE bulk insert for the whole run (up to ~100 rows).
  // A Postgres multi-row INSERT is atomic — if a single row in that batch
  // failed any constraint, the ENTIRE insert rolled back silently, meaning
  // every listing scraped that run got zero price history, permanently
  // (no retry). Confirmed in production: 39 of 90 live listings had zero
  // price_history rows despite being scraped the same day as everything
  // else. Fixed by batching (isolates failures to one batch instead of the
  // whole run) and deduplicating by external_id first (defends against an
  // intra-batch duplicate causing a constraint failure).
  const seen = new Set();
  const priceHistory = valid
    .filter(l => {
      if (seen.has(l.external_id)) return false;
      seen.add(l.external_id);
      return true;
    })
    .map(l => ({
      listing_external_id: l.external_id,
      price: l.price,
      recorded_at: new Date().toISOString(),
    }));

  let historySaved = 0;
  for (let i = 0; i < priceHistory.length; i += BATCH) {
    const batch = priceHistory.slice(i, i + BATCH);
    const { error: histError } = await supabase
      .from("price_history")
      .insert(batch);

    if (histError) {
      console.error(`⚠️ Price history batch ${i}-${i + BATCH} failed:`, histError.message, histError.details || "");
    } else {
      historySaved += batch.length;
      console.log(`📈 Price history ${historySaved}/${priceHistory.length} saved`);
    }
  }

  console.log(`\n🍁 LotCheck scrape complete!`);
  console.log(`   Listings upserted: ${upserted}`);
  console.log(`   Price points saved: ${historySaved}/${priceHistory.length}`);
}

main().catch(err => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});
