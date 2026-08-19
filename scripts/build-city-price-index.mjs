// City price index — Stage 4 of data-pipeline-scope.md. Turns our own Alberta
// inventory dataset (dealer_source / vehicle_listing, built by
// crawl-alberta-inventory.mjs) into a per-city advertised-price-vs-MSRP figure,
// gated so a thin city can never show a number.
//
// THIS SCRIPT MAKES NO REQUEST TO ANY DEALER SITE. It only reads our own
// Supabase tables and writes our own city_dealer_index table, so it is not the
// activity that's with counsel (see 20260811_alberta_inventory.sql) — that's
// crawl-alberta-inventory.mjs, which fetches dealer feeds. This is safe to run,
// and to schedule, independently of that sign-off.
//
// THE MATCH. A dealer's own trim string ("SE Upgrade Nightshade") does not
// equal a catalog key -- that's exactly what pickTrimMsrp exists to resolve
// (fuel partition, drivetrain scoring, token overlap, price-proximity
// tiebreak; see supabase/functions/_shared/trim-match.js, regression-tested by
// npm run test:trim). Only an "exact" basis match is used here -- a
// "starting_at" guess is the same kind of low-confidence match
// alberta-scope.md requires excluding from the index (kept out, never shown).
//
// THE GATE IS WRITTEN, NOT READ. is_publishable is computed once here and
// stored on the row (MIN_DEALERS / MIN_LISTINGS / STALE_DAYS), so no reader
// can accidentally surface a thin city -- filtering on is_publishable=true is
// the only way to get a row that looks real.
//
// Run (Node 24+, from repo root):
//   node scripts/build-city-price-index.mjs --dry-run     # compute + print, write nothing
//   node scripts/build-city-price-index.mjs                # writes; needs SUPABASE_* env
import { pathToFileURL } from "node:url";
import { pickTrimMsrp } from "../supabase/functions/_shared/trim-match.js";

const DRY = process.argv.includes("--dry-run");

export const MIN_DEALERS = Number(process.env.CITY_INDEX_MIN_DEALERS) || 3;
export const MIN_LISTINGS = Number(process.env.CITY_INDEX_MIN_LISTINGS) || 12;
export const STALE_DAYS = Number(process.env.CITY_INDEX_STALE_DAYS) || 7;

// ---- pure helpers, exported for scripts/test-city-price-index.mjs ----------

// Ordinary (not interpolated) percentile -- fine at the sample sizes this gate
// even allows through (a handful to a few hundred listings per city), and it
// never invents a value between two real observations.
// A city is ONE row, however its roster spells it.
//
// dealer_source.city is free text off two rosters — AMVIC's licensee list and
// OpenStreetMap's addr:city — so the same place arrives as "St. Albert",
// "ST. ALBERT", "St Albert" and "Saint Albert". Grouping on the raw string
// makes each spelling its own city_dealer_index row (the unique constraint is
// on (city, province), so they coexist happily), and each fragment carries a
// share of the dealers and listings. A city with ample coverage can then sit
// below the publish gate in every fragment and appear NOWHERE — invisible for
// no reason but punctuation.
//
// Same shape as the RAV4 / RAV4 Hybrid split (9b9ba75): one thing, two keys,
// and the answer depends on which name the lookup happened to hit.
export function cityKey(raw) {
  if (raw == null) return null;
  let s = String(raw).normalize("NFKC").toLowerCase();
  s = s.replace(/,\s*(ab|alta|alberta)\.?\s*$/, "");        // "Leduc, AB"
  s = s.replace(/\bsainte\b|\bste\b/g, "ste");
  s = s.replace(/\bsaint\b|\bst\b/g, "st");                 // St / St. / Saint
  s = s.replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  return s || null;
}

// The label a human reads. Prefers a spelling the roster actually used over a
// reconstruction, so "Fort McMurray" keeps its capital M instead of being
// title-cased into "Fort Mcmurray" by a rule that cannot know about it.
export function prettyCity(variants) {
  const seen = [...(variants || [])].filter(Boolean).map((v) => String(v).trim().replace(/\s+/g, " ")).filter(Boolean);
  if (!seen.length) return null;
  const clean = seen.map((v) => v.replace(/,\s*(AB|Alta|Alberta)\.?$/i, "").trim()).filter(Boolean);
  const pool = clean.length ? clean : seen;
  const mixed = pool.find((v) => v !== v.toUpperCase() && v !== v.toLowerCase());
  if (mixed) return mixed;
  return pool[0].split(" ").map((w) =>
    w.split("-").map((p) => {
      const t = p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
      return t.length > 3 && /^(Mc|Mac)[a-z]/.test(t)
        ? t.replace(/^(Mc|Mac)([a-z])/, (_, a, b) => a + b.toUpperCase())
        : t;
    }).join("-")
  ).join(" ");
}

export function percentile(sortedNums, p) {
  if (!sortedNums.length) return null;
  const idx = Math.min(sortedNums.length - 1, Math.max(0, Math.round((sortedNums.length - 1) * p)));
  return sortedNums[idx];
}

// One vehicle_listing row -> a matched MSRP, or null if there is no confident
// trim match. `catalogRows` must already be scoped to this listing's
// year+make+model (candidates), same contract as pickTrimMsrp itself.
export function matchListingToMsrp(listing, catalogRows) {
  if (!(Number(listing?.list_price) > 0)) return null;
  const match = pickTrimMsrp(catalogRows || [], {
    trim: listing.trim,
    quotedPrice: listing.list_price,
  });
  // "starting_at" is an honest guess, not a confident trim match -- excluded
  // from the index the same way alberta-scope.md requires for low-confidence
  // rows, kept out rather than quietly averaged in.
  if (!match || match.basis !== "exact" || !(match.msrp > 0)) return null;
  const deviationDollars = listing.list_price - match.msrp;
  const deviationPct = (deviationDollars / match.msrp) * 100;
  return { msrp: match.msrp, deviationDollars, deviationPct };
}

// matchedRows: [{ dealer_id, deviationPct, deviationDollars, updated_at }]
// One city's worth, already filtered to confident matches.
export function computeCityStats(matchedRows) {
  const n_listings = matchedRows.length;
  const n_dealers = new Set(matchedRows.map((r) => r.dealer_id)).size;
  const pcts = matchedRows.map((r) => r.deviationPct).sort((a, b) => a - b);
  const dollars = matchedRows.map((r) => r.deviationDollars);
  const updates = matchedRows.map((r) => new Date(r.updated_at).getTime()).filter(Number.isFinite);
  return {
    n_dealers,
    n_listings,
    index_pct: percentile(pcts, 0.5),
    p25_pct: percentile(pcts, 0.25),
    p75_pct: percentile(pcts, 0.75),
    avg_deviation_dollars: dollars.length ? dollars.reduce((a, b) => a + b, 0) / dollars.length : null,
    min_updated_at: updates.length ? new Date(Math.min(...updates)).toISOString() : null,
    max_updated_at: updates.length ? new Date(Math.max(...updates)).toISOString() : null,
  };
}

// The publishable gate. Structural on purpose: n_dealers/n_listings/freshness
// are the only inputs, so nothing about presentation can talk it into true.
export function gatePublishable(stats, { minDealers = MIN_DEALERS, minListings = MIN_LISTINGS, staleDays = STALE_DAYS, now = Date.now() } = {}) {
  if (!stats || stats.n_dealers < minDealers || stats.n_listings < minListings) return false;
  if (!stats.max_updated_at) return false;
  const ageMs = now - new Date(stats.max_updated_at).getTime();
  return ageMs <= staleDays * 86_400_000;
}

// ---- orchestration -----------------------------------------------------

async function fetchAll(url, headers, table, params) {
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(`${url}/rest/v1/${table}?${params}`, {
      headers: { ...headers, Range: `${from}-${from + PAGE - 1}` },
    });
    if (!res.ok) throw new Error(`fetch ${table} -> HTTP ${res.status}: ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

async function main() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"); process.exit(1); }
  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  console.log("Reading dealer_source, vehicle_listing, msrp_catalog...");
  const [dealers, listings, catalog] = await Promise.all([
    fetchAll(url, headers, "dealer_source", "select=id,city,province,active&active=eq.true"),
    fetchAll(url, headers, "vehicle_listing", "select=dealer_id,year,make,model,trim,list_price,updated_at,condition,delisted_on&condition=eq.new&delisted_on=is.null"),
    fetchAll(url, headers, "msrp_catalog", "select=year,make,model,trim,msrp,fuel_type,drivetrain,attrs"),
  ]);
  console.log(`  ${dealers.length} active dealers, ${listings.length} live new-inventory listings, ${catalog.length} msrp_catalog rows.`);

  const dealerCity = new Map(dealers.map((d) => [d.id, d.city]));

  // Group msrp_catalog candidates by year|make|model so each listing's match
  // only searches its own model's trim ladder.
  const catalogByYMM = new Map();
  for (const r of catalog) {
    const k = `${r.year}|${(r.make || "").toLowerCase()}|${(r.model || "").toLowerCase()}`;
    if (!catalogByYMM.has(k)) catalogByYMM.set(k, []);
    catalogByYMM.get(k).push(r);
  }

  const byCity = new Map();
  const cityNames = new Map();   // key -> the spellings the roster used for it
  let matched = 0, unmatched = 0, noCity = 0;
  const noCityDealers = new Map();
  for (const l of listings) {
    const raw = dealerCity.get(l.dealer_id);
    const city = cityKey(raw);
    // A dealer with no city silently removes its ENTIRE inventory from the
    // index. Counting that is not enough — name the dealers, or real listings
    // vanish from a published number with nothing to chase.
    if (!city) { noCity++; noCityDealers.set(l.dealer_id, (noCityDealers.get(l.dealer_id) || 0) + 1); continue; }
    if (!cityNames.has(city)) cityNames.set(city, new Set());
    cityNames.get(city).add(raw);
    const key = `${l.year}|${(l.make || "").toLowerCase()}|${(l.model || "").toLowerCase()}`;
    const m = matchListingToMsrp(l, catalogByYMM.get(key));
    if (!m) { unmatched++; continue; }
    matched++;
    if (!byCity.has(city)) byCity.set(city, []);
    byCity.get(city).push({ dealer_id: l.dealer_id, deviationPct: m.deviationPct, deviationDollars: m.deviationDollars, updated_at: l.updated_at });
  }
  console.log(`  matched ${matched} listings to a confident MSRP, ${unmatched} unmatched/low-confidence, ${noCity} with no active dealer city.`);
  if (noCityDealers.size) {
    console.warn(`  ${noCityDealers.size} active dealer(s) have NO city and their listings are excluded entirely:`);
    for (const [id, n] of [...noCityDealers].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      console.warn(`    dealer_source.id=${id}  ${n} listing(s) dropped`);
    }
    console.warn("    Set dealer_source.city for these, or their inventory never reaches any city's index.");
  }

  const rows = [];
  for (const [city, cityRows] of byCity) {
    const stats = computeCityStats(cityRows);
    const is_publishable = gatePublishable(stats);
    rows.push({ city: prettyCity(cityNames.get(city)) || city, province: "AB", computed_at: new Date().toISOString(), ...stats, is_publishable });
  }
  rows.sort((a, b) => b.n_listings - a.n_listings);

  console.log(`\n${"city".padEnd(20)}${"dealers".padStart(8)}${"listings".padStart(10)}${"index%".padStart(9)}${"publishable".padStart(14)}`);
  for (const r of rows) {
    console.log(`${r.city.padEnd(20)}${String(r.n_dealers).padStart(8)}${String(r.n_listings).padStart(10)}${(r.index_pct == null ? "—" : r.index_pct.toFixed(1)).padStart(9)}${String(r.is_publishable).padStart(14)}`);
  }
  const publishableCount = rows.filter((r) => r.is_publishable).length;
  console.log(`\n${rows.length} cities with matched data, ${publishableCount} publishable (n_dealers>=${MIN_DEALERS}, n_listings>=${MIN_LISTINGS}, fresh within ${STALE_DAYS}d).`);

  if (DRY) { console.log("\nDRY RUN — writing nothing."); return; }
  if (!rows.length) { console.log("\nnothing matched — existing city_dealer_index rows left untouched."); return; }

  const writeHeaders = { ...headers, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" };
  const res = await fetch(`${url}/rest/v1/city_dealer_index?on_conflict=city,province`, {
    method: "POST", headers: writeHeaders, body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`write city_dealer_index -> HTTP ${res.status}: ${await res.text()}`);
  console.log(`\nWrote ${rows.length} city_dealer_index rows.`);
}

// Only run when executed directly — test-city-price-index.mjs imports the
// pure functions above and must not trigger a live Supabase read on import.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
