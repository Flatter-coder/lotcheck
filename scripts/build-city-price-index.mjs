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
import { buildCatalogIndex, classifyNewCar, tallyNewCars, makerVsDealerStatus, isSourceReason } from "./lib/maker-match.mjs";

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

// A row's dealers: every dealer listing the car (dealer_ids, from
// fn_listing_once) -- dealer_id is null when there is more than one.
const dealersOf = (rows) => new Set(rows.flatMap((r) => r.dealer_ids ?? [r.dealer_id])).size;

// matchedRows: [{ dealer_id, dealer_ids?, deviationPct, deviationDollars, updated_at }]
// One city's worth, already filtered to confident matches. One row per car.
export function computeCityStats(matchedRows) {
  const n_listings = matchedRows.length;
  const n_dealers = dealersOf(matchedRows);
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

// ---- province-wide read vs the CATALOG sticker ------------------------------
//
// WHY. The public market cards used fn_alberta_msrp_deviation, which compares
// asking price against the MSRP the DEALER states on their own page — so a
// dealer who prints MSRP = asking price is invisible to the over-sticker stat
// (proven 2026-08-19: Southpointe Toyota Tacoma Hybrid, asking $89,130, page
// MSRP $89,130). This read anchors to OUR catalog instead, exact trim matches
// only, and never lets the dealer supply the reference.
//
// BASIS-AWARE BY BOUNDS. An Alberta advertised price is all-in by regulation
// (AMVIC); a catalog MSRP usually is not. Only 28 of 1,084 catalog rows hold
// the manufacturer's own all_in_price (checked live 2026-08-19), so demanding
// a point reference would gate the read forever. Instead every row yields a
// WINDOW [msrp, msrp + ceiling] that is guaranteed to contain the true all-in
// figure, and the three calls are made only where the window allows them:
//   under  price below the window floor  — sound whatever the basis, because
//          mandatory adds only ever RAISE the reference
//   over   price above the window ceiling — sound whatever the basis
//   at     only where the row IS the all-in figure (window is a point)
//   indeterminate  inside the window — the row's exact freight figure would
//          decide, and we do not hold it, so no direction is claimed
// Every published percentage is a FLOOR of the true distance from the all-in
// sticker: proven by cross-multiplication in test-market-vs-catalog.mjs, so
// the read can understate a discount or a markup but never overstate one.

export const PROVINCE_MIN_LISTINGS = Number(process.env.PROVINCE_INDEX_MIN_LISTINGS) || 25;

// Ceilings on the mandatory adds a row's basis can omit. NOT an estimate of
// any car's freight (msrp_all_in_price.sql forbids deriving all_in_price by
// adding a constant) — an upper BOUND used only to refuse a call inside it.
// The largest verified package: Land Cruiser $3,780 freight/PDI + Toyota's
// $1,148 itemised fees = $4,928; the ceiling clears it with margin. Raising
// it makes the read more conservative (more indeterminate), never wrong.
export const FREIGHT_FEES_CEILING = 5500;  // excl_freight or unknown basis
export const FEES_ONLY_CEILING = 1500;     // incl_freight: freight is in, fees are not
export const AT_TOLERANCE_PCT = 0.05;      // same rounding shade fn_alberta_msrp_deviation uses

// The price the dealer is actually asking. The crawler writes sale_price as
// final ?? asking (see crawl-alberta-inventory.mjs), so sale_price is the
// effective advertised price whenever any price exists — same column
// fn_alberta_msrp_deviation reads.
export function effectivePrice(l) {
  if (Number(l?.sale_price) > 0) return Number(l.sale_price);
  if (Number(l?.list_price) > 0) return Number(l.list_price);
  return null;
}

// The window a catalog row bounds the true ALL-IN sticker into.
// exact:true means the window is a point — the manufacturer's own figure.
export function referenceWindow(row) {
  if (Number(row?.all_in_price) > 0) {
    const a = Number(row.all_in_price);
    return { low: a, high: a, exact: true };
  }
  const msrp = Number(row?.msrp);
  if (!(msrp > 0)) return null;
  if (row.price_basis === "incl_freight") return { low: msrp, high: msrp + FEES_ONLY_CEILING, exact: false };
  // excl_freight, or basis unknown — unknown is treated as the widest window,
  // because guessing a basis is how a freight gap becomes a markup claim.
  return { low: msrp, high: msrp + FREIGHT_FEES_CEILING, exact: false };
}

// One matched (listing price, catalog row) -> a directional call, or an honest
// refusal to make one. floorPct is negative under, positive over, and always a
// floor of the true distance from the all-in sticker.
export function classifyVsCatalog(price, row) {
  if (!(Number(price) > 0)) return null;
  const w = referenceWindow(row);
  if (!w) return null;
  const pctLow = ((price - w.low) / w.low) * 100;
  const pctHigh = ((price - w.high) / w.high) * 100;
  if (pctLow < -AT_TOLERANCE_PCT) return { dir: "under", floorPct: pctLow, exact: w.exact };
  if (pctHigh > AT_TOLERANCE_PCT) return { dir: "over", floorPct: pctHigh, exact: w.exact };
  if (w.exact) return { dir: "at", floorPct: pctLow, exact: true };
  return { dir: "indeterminate", floorPct: null, exact: false };
}

// Dealer-sticker inflation: the listing prints its OWN sticker above even the
// highest legitimate all-in figure for that exact trim. Returns the floor of
// the inflation percentage, or null when the stated sticker is absent or sits
// at/below the ceiling (a dealer stating an all-in-basis sticker is not
// inflating — that ambiguity is exactly what the ceiling absorbs).
export function stickerInflationFloor(statedMsrp, row) {
  const stated = Number(statedMsrp);
  if (!(stated > 0)) return null;
  const w = referenceWindow(row);
  if (!w || !(stated > w.high)) return null;
  return ((stated - w.high) / w.high) * 100;
}

// One vehicle_listing row -> the exact-basis catalog ROW it matched (the full
// row, so basis columns travel with it), or null. Same contract as
// matchListingToMsrp: candidates already scoped to year+make+model, and a
// "starting_at" guess is excluded, never averaged in.
export function pickExactCatalogRow(listing, catalogRows) {
  const price = effectivePrice(listing);
  if (!price) return null;
  const match = pickTrimMsrp(catalogRows || [], { trim: listing?.trim, quotedPrice: price });
  if (!match || match.basis !== "exact" || !(match.msrp > 0)) return null;
  // pickTrimMsrp returns the figure, not the row; recover the row by its
  // (trim, msrp) identity within this model's candidates. Among identical
  // twins prefer the one whose window is tightest — an all-in figure beats a
  // stamped basis beats an unknown one.
  const rank = (r) => (Number(r.all_in_price) > 0 ? 0 : r.price_basis === "incl_freight" ? 1 : 2);
  const twins = (catalogRows || [])
    .filter((r) => Number(r?.msrp) === match.msrp && (r?.trim || null) === (match.trim || null))
    .sort((a, b) => rank(a) - rank(b));
  if (!twins.length) return null;
  return { row: twins[0], price };
}

// provRows: [{ dealer_id, dir, floorPct, exact, statedMsrp, inflFloorPct, updated_at }]
export function computeProvinceRead(provRows, { minListings = PROVINCE_MIN_LISTINGS, staleDays = STALE_DAYS, now = Date.now() } = {}) {
  const rows = provRows || [];
  const directional = rows.filter((r) => r.dir !== "indeterminate");
  const byDir = (d) => rows.filter((r) => r.dir === d).length;
  const pcts = directional.map((r) => r.floorPct).sort((a, b) => a - b);
  const underPcts = rows.filter((r) => r.dir === "under").map((r) => r.floorPct).sort((a, b) => a - b);
  const stated = rows.filter((r) => Number(r.statedMsrp) > 0);
  const inflPcts = stated.filter((r) => r.inflFloorPct != null).map((r) => r.inflFloorPct).sort((a, b) => a - b);
  const updates = rows.map((r) => new Date(r.updated_at).getTime()).filter(Number.isFinite);
  const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
  const stats = {
    n_matched: rows.length,
    n_directional: directional.length,
    // paired with n_directional on the page ("N listings from D dealers"), so
    // it counts dealers behind the DIRECTIONAL calls, not every match
    n_dealers: dealersOf(directional),
    under_n: byDir("under"),
    at_n: byDir("at"),
    over_n: byDir("over"),
    indeterminate_n: byDir("indeterminate"),
    all_in_n: rows.filter((r) => r.exact).length,
    median_pct: round2(percentile(pcts, 0.5)),
    p25_pct: round2(percentile(pcts, 0.25)),
    p75_pct: round2(percentile(pcts, 0.75)),
    median_discount_pct: round2(percentile(underPcts, 0.5)),
    // same 21-point inverse-CDF shape fn_alberta_msrp_deviation returned, so
    // the page's band math consumes it unchanged
    curve: pcts.length >= 2 ? Array.from({ length: 21 }, (_, i) => round2(percentile(pcts, i / 20))) : null,
    sticker_stated_n: stated.length,
    sticker_inflated_n: inflPcts.length,
    sticker_inflated_median_pct: round2(percentile(inflPcts, 0.5)),
    min_updated_at: updates.length ? new Date(Math.min(...updates)).toISOString() : null,
    max_updated_at: updates.length ? new Date(Math.max(...updates)).toISOString() : null,
  };
  // Same structural gate discipline as gatePublishable: the k-floor counts
  // DIRECTIONAL calls only (indeterminate rows back no claim), and stale data
  // never publishes.
  stats.is_publishable =
    stats.n_directional >= minListings &&
    !!stats.max_updated_at &&
    now - new Date(stats.max_updated_at).getTime() <= staleDays * 86_400_000;
  return stats;
}

// ---- orchestration -----------------------------------------------------

// The run log's account of every live new car: the reason tally, each make's
// share, and for every reason the model groups behind it with the dealer's own
// trim words beside what our catalogue holds -- enough to see WHICH gap to fix
// next without a database session.
function printAccounting(items, tally, catalog, idx) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\nACCOUNTED FOR: ${tally.n} live new cars -- ${tally.matched} matched, ${tally.source} source's gap, ${tally.ours} our gap.`);
  for (const [k, v] of Object.entries(tally.reasons).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(k, 30)} ${String(v).padStart(6)}  ${isSourceReason(k) ? "source" : "OURS"}`);
  }
  const makes = new Map();
  for (const { l, r } of items) {
    const k = String(l.make || "?");
    const m = makes.get(k) || { n: 0, matched: 0, reasons: {} };
    m.n++;
    if (r.matched) m.matched++; else m.reasons[r.reason] = (m.reasons[r.reason] || 0) + 1;
    makes.set(k, m);
  }
  const catByMake = new Map();
  for (const c of catalog) {
    const k = String(c.make || "").toLowerCase();
    const m = catByMake.get(k) || { rows: 0, trimmed: 0, drive: 0, fuel: 0, years: new Set(), fetched: null };
    m.rows++; if (String(c.trim || "").trim()) m.trimmed++; if (c.drivetrain) m.drive++; if (c.fuel_type) m.fuel++;
    m.years.add(c.year); if (c.fetched_at && (!m.fetched || c.fetched_at > m.fetched)) m.fetched = c.fetched_at;
    catByMake.set(k, m);
  }
  console.log("\nBY MAKE (cars matched/total | catalogue rows, trimmed, drivetrain, fuel, years, newest fetch):");
  for (const [k, m] of [...makes].sort((a, b) => b[1].n - a[1].n)) {
    const c = catByMake.get(k.toLowerCase());
    const top = Object.entries(m.reasons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, v]) => `${r}=${v}`).join(" ");
    console.log(`  ${pad(k, 16)} ${String(m.matched).padStart(5)}/${String(m.n).padEnd(5)} | ` +
      (c ? `${c.rows} rows, ${c.trimmed} trimmed, ${c.drive} drive, ${c.fuel} fuel, ${[...c.years].sort().join("/")}, ${String(c.fetched || "never").slice(0, 10)}` : "no catalogue rows") +
      `  ${top}`);
  }
  const byReason = new Map();
  for (const { l, r } of items) {
    if (r.matched) continue;
    const g = `${l.year} ${l.make} ${l.model}`;
    if (!byReason.has(r.reason)) byReason.set(r.reason, new Map());
    const groups = byReason.get(r.reason);
    const e = groups.get(g) || { n: 0, trims: new Map(), l, whys: new Set() };
    e.n++; e.trims.set(l.trim || "(none)", (e.trims.get(l.trim || "(none)") || 0) + 1); if (r.why) e.whys.add(r.why);
    groups.set(g, e);
  }
  for (const [reason, groups] of [...byReason].sort((a, b) => (tally.reasons[b[0]] || 0) - (tally.reasons[a[0]] || 0))) {
    console.log(`\n[${reason}] ${tally.reasons[reason]} cars, ${groups.size} model groups`);
    for (const [g, e] of [...groups].sort((a, b) => b[1].n - a[1].n).slice(0, 14)) {
      const trims = [...e.trims].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, n]) => `"${t}"x${n}`).join(", ");
      console.log(`  ${String(e.n).padStart(4)}  ${g}  trims: ${trims}${e.whys.size ? `  why: ${[...e.whys].join("/")}` : ""}`);
      const ymm = idx.byYMM.get(`${e.l.year}|${String(e.l.make || "").toLowerCase()}|${String(e.l.model || "").toLowerCase()}`);
      if (ymm) {
        console.log(`        catalogue: ${ymm.slice(0, 12).map((c) => `${c.trim || "(no trim)"}${c.drivetrain ? "/" + c.drivetrain : ""}${c.fuel_type ? "/" + c.fuel_type : ""} $${c.msrp}`).join(" | ")}`);
      } else {
        const mm = idx.models.get(String(e.l.make || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());
        if (mm) console.log(`        catalogue models for the make: ${[...mm.values()].slice(0, 30).map((x) => `${x.name}[${[...x.years].sort().join("/")}]`).join(", ")}`);
      }
    }
  }
}

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

  // One row per live CAR, group feeds excluded: fn_listing_once
  // (20260924b_count_a_car_once.sql). A car on two dealers' sites is one car;
  // dealer_id is null for it and dealer_ids names both. Ordered by vin so the
  // Range pages are stable -- and vin is SELECTED, because PostgREST cannot
  // order an RPC by a column the select leaves out ("column record.vin does
  // not exist", HTTP 400). That killed this step and the daily report after
  // it on 2026-09-25. test-city-price-index.mjs now checks every rpc/ read.
  console.log("Reading dealer_source, fn_listing_once, msrp_catalog...");
  const [dealers, allCars, catalog] = await Promise.all([
    fetchAll(url, headers, "dealer_source", "select=id,city,province,active&active=eq.true&group_feed=is.false"),
    fetchAll(url, headers, "rpc/fn_listing_once", "select=vin,dealer_id,dealer_ids,year,make,model,trim:trim_name,list_price,sale_price,msrp,updated_at,condition&condition=eq.new&order=vin"),
    fetchAll(url, headers, "msrp_catalog", "select=year,make,model,trim,msrp,fuel_type,drivetrain,attrs,price_basis,all_in_price,fetched_at"),
  ]);
  const dealerCity = new Map(dealers.map((d) => [d.id, d.city]));
  const dealerProvince = new Map(dealers.map((d) => [d.id, d.province]));
  // Unchanged scope: only cars an ACTIVE dealer lists. A car with one dealer
  // is placed where that dealer is; a shared car only where ALL its active
  // dealers agree (city by cityKey, so spelling variants still agree).
  const listings = [];
  for (const c of allCars) {
    const ids = (c.dealer_ids || []).filter((id) => dealerCity.has(id));
    if (!ids.length) continue;
    const provinces = new Set(ids.map((id) => dealerProvince.get(id)));
    const cities = new Set(ids.map((id) => cityKey(dealerCity.get(id))));
    listings.push({
      ...c, dealer_ids: ids,
      province: provinces.size === 1 ? dealerProvince.get(ids[0]) : null,
      city: cities.size === 1 ? dealerCity.get(ids[0]) : null,
      splitCity: cities.size > 1,
    });
  }
  console.log(`  ${dealers.length} active dealers, ${listings.length} live new cars, ${catalog.length} msrp_catalog rows.`);

  const catalogIdx = buildCatalogIndex(catalog);

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
  const provRows = [];           // province read — a city is NOT required here
  let matched = 0, unmatched = 0, noCity = 0, twoCities = 0;
  const noCityDealers = new Map();
  for (const l of listings) {
    const key = `${l.year}|${(l.make || "").toLowerCase()}|${(l.model || "").toLowerCase()}`;

    // Province-wide read vs the CATALOG sticker. Runs before the city gate on
    // purpose: a dealer with no roster city still sells cars in Alberta, and
    // dropping their inventory here would thin the very read the k-floor
    // protects.
    if (l.province === "AB") {
      const picked = pickExactCatalogRow(l, catalogByYMM.get(key));
      if (picked) {
        const cls = classifyVsCatalog(picked.price, picked.row);
        if (cls) {
          provRows.push({
            dealer_id: l.dealer_id,
            dealer_ids: l.dealer_ids,
            dir: cls.dir,
            floorPct: cls.floorPct,
            exact: cls.exact,
            statedMsrp: Number(l.msrp) > 0 ? Number(l.msrp) : null,
            inflFloorPct: stickerInflationFloor(l.msrp, picked.row),
            updated_at: l.updated_at,
          });
        }
      }
    }

    const raw = l.city;
    const city = cityKey(raw);
    // A car on two dealers' sites in different cities belongs to neither city.
    if (l.splitCity) { twoCities++; continue; }
    // A dealer with no city silently removes its ENTIRE inventory from the
    // index. Counting that is not enough — name the dealers, or real listings
    // vanish from a published number with nothing to chase.
    if (!city) {
      noCity++;
      const who = l.dealer_ids.join("+");
      noCityDealers.set(who, (noCityDealers.get(who) || 0) + 1);
      continue;
    }
    if (!cityNames.has(city)) cityNames.set(city, new Set());
    cityNames.get(city).add(raw);
    const m = matchListingToMsrp(l, catalogByYMM.get(key));
    if (!m) { unmatched++; continue; }
    matched++;
    if (!byCity.has(city)) byCity.set(city, []);
    byCity.get(city).push({ dealer_id: l.dealer_id, dealer_ids: l.dealer_ids, deviationPct: m.deviationPct, deviationDollars: m.deviationDollars, updated_at: l.updated_at });
  }
  console.log(`  matched ${matched} cars to a confident MSRP, ${unmatched} unmatched/low-confidence, ${noCity} with no active dealer city, ${twoCities} listed in two cities (no city index).`);
  // THE DAILY REPORT'S "manufacturer vs Alberta dealer prices" check mark. This
  // index IS that comparison -- every live new car measured against its maker's
  // own figure. Every car is ACCOUNTED FOR (scripts/lib/maker-match.mjs):
  // matched, or held back for a named reason that says whose gap it is. Green
  // only when every held-back car is the source's; one of ours keeps it amber.
  // Counted over EVERY live new car, not only those with a single city -- the
  // old tally dropped cars listed in two cities from both of its numbers.
  const accountedFor = listings.map((l) => ({ l, r: classifyNewCar(l, catalogIdx) }));
  const tally = tallyNewCars(accountedFor.map((x) => x.r));
  const status = makerVsDealerStatus(tally);
  printAccounting(accountedFor, tally, catalog, catalogIdx);
  console.log(`\n  maker vs dealer: ${status.state.toUpperCase()} -- ${status.note}`);
  if (process.env.CATALOG_STATUS_OUT) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(process.env.CATALOG_STATUS_OUT, JSON.stringify(status));
  }
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

  // Province read vs the catalog sticker (basis-aware — see the block above
  // computeProvinceRead for why the calls are made from bounds, not points).
  const prov = computeProvinceRead(provRows);
  console.log(`\nAlberta vs catalog sticker: ${prov.n_matched} exact matches — ` +
    `${prov.under_n} under, ${prov.at_n} at, ${prov.over_n} over, ` +
    `${prov.indeterminate_n} indeterminate (inside the freight window), ` +
    `${prov.all_in_n} judged against a manufacturer all-in figure.`);
  console.log(`  dealer-stated stickers: ${prov.sticker_stated_n} printed, ` +
    `${prov.sticker_inflated_n} above the window ceiling` +
    (prov.sticker_inflated_n ? ` (median floor +${prov.sticker_inflated_median_pct}%)` : "") + ".");
  console.log(`  publishable: ${prov.is_publishable} (n_directional=${prov.n_directional}, floor ${PROVINCE_MIN_LISTINGS}, fresh within ${STALE_DAYS}d).`);

  if (DRY) { console.log("\nDRY RUN — writing nothing."); return; }

  const writeHeaders = { ...headers, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" };
  if (!rows.length) {
    console.log("\nnothing matched — existing city_dealer_index rows left untouched.");
  } else {
    const res = await fetch(`${url}/rest/v1/city_dealer_index?on_conflict=city,province`, {
      method: "POST", headers: writeHeaders, body: JSON.stringify(rows),
    });
    if (!res.ok) throw new Error(`write city_dealer_index -> HTTP ${res.status}: ${await res.text()}`);
    console.log(`\nWrote ${rows.length} city_dealer_index rows.`);
  }

  if (!provRows.length) {
    console.log("no exact catalog matches — existing province_market_read row left untouched.");
  } else {
    const res = await fetch(`${url}/rest/v1/province_market_read?on_conflict=province`, {
      method: "POST", headers: writeHeaders,
      body: JSON.stringify([{ province: "AB", computed_at: new Date().toISOString(), ...prov }]),
    });
    if (!res.ok) throw new Error(`write province_market_read -> HTTP ${res.status}: ${await res.text()}`);
    console.log("Wrote the AB province_market_read row.");
  }
}

// Only run when executed directly — test-city-price-index.mjs imports the
// pure functions above and must not trigger a live Supabase read on import.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
