// ─────────────────────────────────────────────────────────────────────────────
// LotCheck — Listing Verification Pipeline
// Runs BEFORE any listing is published to the public app
// Catches bad data, scams, duplicates, and price anomalies
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://debigtyjhjamipooajhk.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Price sanity ranges by fuel type (CAD) ────────────────────────────────────
const PRICE_FLOORS = { BEV:8000, PHEV:10000, Hybrid:5000, Gas:2000, Diesel:5000 };
const PRICE_CAPS   = { BEV:150000, PHEV:120000, Hybrid:100000, Gas:150000, Diesel:100000 };

// ── Minimum real listing title length ─────────────────────────────────────────
const MIN_NAME_LENGTH = 8;

// ── Suspicious keywords — auto-reject ─────────────────────────────────────────
const SCAM_KEYWORDS = [
  "paypal only","western union","money order","cashier check",
  "deployed overseas","military","out of country","ebay motors",
  "god fearing","missionary","inspection fee","shipping only",
  "whatsapp me","contact me at","email only for details",
];

// ── Known bad price patterns ───────────────────────────────────────────────────
const PLACEHOLDER_PRICES = [1, 100, 111, 222, 333, 999, 1000, 1111, 9999, 99999, 100000, 123456];

// ─────────────────────────────────────────────────────────────────────────────
// VERIFY — runs every check, returns {passed, score, flags, action}
// action: 'publish' | 'review' | 'reject'
// ─────────────────────────────────────────────────────────────────────────────
function verifyListing(listing) {
  const flags = [];
  let score = 100; // start at 100, deduct for issues
  let action = "publish";

  const name  = (listing.name || "").toLowerCase();
  const price = Number(listing.price) || 0;
  const km    = Number(listing.km) || 0;
  const year  = Number(listing.year) || 0;
  const fuel  = listing.fuel || "Gas";
  const desc  = (listing.description || "").toLowerCase();
  const combined = name + " " + desc;

  // ── 1. Price floor check ──────────────────────────────────────────────────
  if (price < PRICE_FLOORS[fuel] || price === 0) {
    flags.push(`PRICE_TOO_LOW: $${price} for ${fuel} (floor: $${PRICE_FLOORS[fuel]})`);
    action = "reject"; score -= 50;
  }

  // ── 2. Price ceiling check ────────────────────────────────────────────────
  if (price > PRICE_CAPS[fuel]) {
    flags.push(`PRICE_TOO_HIGH: $${price} for ${fuel} (cap: $${PRICE_CAPS[fuel]})`);
    action = "review"; score -= 20;
  }

  // ── 3. Placeholder price ──────────────────────────────────────────────────
  if (PLACEHOLDER_PRICES.includes(price)) {
    flags.push(`PLACEHOLDER_PRICE: $${price}`);
    action = "reject"; score -= 60;
  }

  // ── 4. Year sanity ────────────────────────────────────────────────────────
  const currentYear = new Date().getFullYear();
  if (year < 2000 || year > currentYear + 2) {
    flags.push(`INVALID_YEAR: ${year}`);
    action = "reject"; score -= 40;
  }

  // ── 5. Odometer sanity ────────────────────────────────────────────────────
  if (km > 500000) {
    flags.push(`KM_TOO_HIGH: ${km.toLocaleString()} km`);
    action = "review"; score -= 15;
  }
  if (km < 0) {
    flags.push(`KM_NEGATIVE: ${km}`);
    action = "reject"; score -= 50;
  }

  // ── 6. Scam keyword detection ─────────────────────────────────────────────
  const scamHits = SCAM_KEYWORDS.filter(kw => combined.includes(kw));
  if (scamHits.length > 0) {
    flags.push(`SCAM_KEYWORDS: ${scamHits.join(", ")}`);
    action = "reject"; score -= 80;
  }

  // ── 7. Missing critical fields ────────────────────────────────────────────
  if (!listing.name || listing.name.length < MIN_NAME_LENGTH) {
    flags.push(`NAME_TOO_SHORT: "${listing.name}"`);
    action = "reject"; score -= 30;
  }
  if (!listing.make || listing.make === "Unknown") {
    flags.push("MISSING_MAKE");
    action = "review"; score -= 20;
  }
  if (!listing.model || listing.model === "Unknown") {
    flags.push("MISSING_MODEL");
    action = "review"; score -= 20;
  }
  if (!listing.external_id) {
    flags.push("MISSING_EXTERNAL_ID");
    action = "reject"; score -= 50;
  }
  if (!listing.listing_url) {
    flags.push("MISSING_URL");
    action = "review"; score -= 10;
  }

  // ── 8. Price vs year anomaly (new car priced like beater) ─────────────────
  if (year >= currentYear - 1 && price < 15000 && fuel !== "Gas") {
    flags.push(`PRICE_ANOMALY: ${year} ${fuel} for only $${price}`);
    action = "review"; score -= 25;
  }

  // ── 9. Odometer vs year anomaly (brand new car with 200k km) ─────────────
  const carAge = currentYear - year;
  const maxReasonableKm = Math.max(30000, carAge * 35000); // 35k km/year max
  if (km > maxReasonableKm && carAge < 10) {
    flags.push(`KM_YEAR_MISMATCH: ${year} car with ${km.toLocaleString()} km (max expected: ${maxReasonableKm.toLocaleString()})`);
    action = "review"; score -= 15;
  }

  // ── 10. EV price vs EVAP cap (flag if over $50k — no rebate) ─────────────
  if ((fuel === "BEV" || fuel === "PHEV") && price > 50000) {
    flags.push(`OVER_EVAP_CAP: $${price} — rebate badge will be hidden`);
    // Not a rejection, just informational — UI handles this
  }

  // ── Final score cap ───────────────────────────────────────────────────────
  score = Math.max(0, score);

  // Override action based on score
  if (score < 30) action = "reject";
  else if (score < 70) action = "review";
  else if (action === "publish" && flags.length > 0) action = "review";

  return {
    passed: action === "publish",
    score,
    flags,
    action,
    verified_at: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DEDUP — find near-duplicate listings (same make/model/year/price ± 5%)
// ─────────────────────────────────────────────────────────────────────────────
async function findDuplicates(listing, existingListings) {
  const dupes = existingListings.filter(ex => {
    if (ex.external_id === listing.external_id) return false;
    if (ex.make !== listing.make) return false;
    if (ex.model !== listing.model) return false;
    if (ex.year !== listing.year) return false;
    if (ex.province !== listing.province) return false;
    const priceDiff = Math.abs(ex.price - listing.price) / listing.price;
    const kmDiff = Math.abs((ex.km || 0) - (listing.km || 0));
    return priceDiff < 0.05 && kmDiff < 5000; // within 5% price + 5k km
  });
  return dupes;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN — verify all pending listings in Supabase
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🔍 LotCheck Verification Pipeline starting...");

  // Get all listings pending verification
  const { data: pending, error } = await supabase
    .from("listings")
    .select("*")
    .is("verified_at", null)
    .limit(500);

  if (error) { console.error("❌ Fetch failed:", error.message); process.exit(1); }
  console.log(`📦 ${pending.length} listings to verify`);

  // Get all existing published listings for dedup check
  const { data: existing } = await supabase
    .from("listings")
    .select("external_id,make,model,year,price,km,province")
    .eq("status", "published")
    .limit(5000);

  let published = 0, reviewed = 0, rejected = 0;

  for (const listing of pending) {
    const result = verifyListing(listing);

    // Check for duplicates
    const dupes = await findDuplicates(listing, existing || []);
    if (dupes.length > 0) {
      result.flags.push(`DUPLICATE: matches ${dupes.length} existing listing(s)`);
      result.action = "review";
      result.score = Math.min(result.score, 60);
    }

    // Update listing status in Supabase
    const update = {
      status: result.action === "publish" ? "published" : result.action,
      verified_at: result.verified_at,
      verification_score: result.score,
      verification_flags: result.flags.join(" | ") || null,
    };

    await supabase
      .from("listings")
      .update(update)
      .eq("external_id", listing.external_id);

    if (result.action === "publish") published++;
    else if (result.action === "review") reviewed++;
    else rejected++;

    if (result.flags.length > 0) {
      console.log(`  ${result.action.toUpperCase()} [${result.score}] ${listing.name} — ${result.flags[0]}`);
    }
  }

  console.log(`\n✅ Verification complete:`);
  console.log(`   Published: ${published}`);
  console.log(`   Needs review: ${reviewed}`);
  console.log(`   Rejected: ${rejected}`);
}

main().catch(err => { console.error("💥", err); process.exit(1); });
