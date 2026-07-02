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

// ── SEARCH URLS — all major Canadian cities, all fuel types ──────────────────
// Kijiji location IDs: Calgary=1700199, Vancouver=1700173, Toronto=1700273,
// Montreal=1700281, Edmonton=1700203, Winnipeg=1700192, Ottawa=1700185
const SEARCH_URLS = [
  // ── Alberta ──────────────────────────────────────────────────────────────
  "https://www.kijiji.ca/b-cars-trucks/calgary/c174l1700199",
  "https://www.kijiji.ca/b-cars-trucks/edmonton/c174l1700203",
  // ── British Columbia ──────────────────────────────────────────────────────
  "https://www.kijiji.ca/b-cars-trucks/vancouver/c174l1700173",
  // ── Ontario ───────────────────────────────────────────────────────────────
  "https://www.kijiji.ca/b-cars-trucks/toronto/c174l1700273",
  "https://www.kijiji.ca/b-cars-trucks/ottawa/c174l1700185",
  // ── Quebec ────────────────────────────────────────────────────────────────
  "https://www.kijiji.ca/b-cars-trucks/montreal/c174l1700281",
  // ── Manitoba ──────────────────────────────────────────────────────────────
  "https://www.kijiji.ca/b-cars-trucks/winnipeg/c174l1700192",
  // ── EVs across Canada ─────────────────────────────────────────────────────
  "https://www.kijiji.ca/b-cars-trucks/canada/electric/c174l0a138",
  "https://www.kijiji.ca/b-cars-trucks/canada/hybrid/c174l0a139",
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
  const location = item.location?.name || item.locationName || "";
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
    run = await apify.actor("automation-lab/kijiji-scraper").call({
      startUrls: SEARCH_URLS.map(url => ({ url })),
      maxItems: 1000,
      proxyConfiguration: { useApifyProxy: true },
    });
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

  // Upsert listings in batches of 50
  let upserted = 0;
  const BATCH = 50;
  for (let i = 0; i < valid.length; i += BATCH) {
    const batch = valid.slice(i, i + BATCH);
    const { error } = await supabase
      .from("listings")
      .upsert(batch, { onConflict: "external_id", ignoreDuplicates: false });

    if (error) {
      console.error(`❌ Batch ${i}-${i+BATCH} failed:`, error.message);
    } else {
      upserted += batch.length;
      console.log(`📝 Upserted ${upserted}/${valid.length} listings`);
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
