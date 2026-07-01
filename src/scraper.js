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
  const text = `${item.title || ""} ${item.description || ""} ${item.attributes?.fuelType || ""}`.toLowerCase();
  if (text.includes("electric") && !text.includes("hybrid")) return "BEV";
  if (text.includes("plug-in hybrid") || text.includes("phev")) return "PHEV";
  if (text.includes("hybrid")) return "Hybrid";
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
  const year  = titleMatch ? parseInt(titleMatch[1]) : (item.year || 2020);
  const make  = titleMatch ? titleMatch[2] : (item.make || "Unknown");
  const model = titleMatch ? titleMatch[3].split(" ").slice(0,2).join(" ") : (item.model || "Unknown");

  const price = parseInt(String(item.price || "0").replace(/[^0-9]/g, "")) || 0;
  const km    = parseInt(String(item.mileage || item.kilometers || "0").replace(/[^0-9]/g, "")) || 0;

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

  // Record price history for all valid listings
  const priceHistory = valid.map(l => ({
    listing_external_id: l.external_id,
    price: l.price,
    recorded_at: new Date().toISOString(),
  }));

  const { error: histError } = await supabase
    .from("price_history")
    .insert(priceHistory);

  if (histError) {
    console.error("⚠️ Price history insert failed:", histError.message);
  } else {
    console.log(`📈 ${priceHistory.length} price history records saved`);
  }

  console.log(`\n🍁 LotCheck scrape complete!`);
  console.log(`   Listings upserted: ${upserted}`);
  console.log(`   Price points saved: ${priceHistory.length}`);
}

main().catch(err => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});
