// Two more inventory sources beyond SM360/Convertus, both confirmed live
// 2026-08-18 against real Alberta dealers with a plain honest-UA fetch (no JS
// rendering needed):
//
//   jsonld_itemlist  a JSON-LD `ItemList` of `Car` nodes on a model/category
//                     page (confirmed: Wolfe Chevrolet f/k/a Westgate Chev,
//                     Village Honda -- both WordPress + Yoast SEO). Requires
//                     enumerating category pages from the /new/ or /used/
//                     index first; each category paginates via rel="next".
//
//   edealer           a `vehicleArray = {...}` object keyed by vehicle id,
//                     inline in a <script> tag on the EDealer platform
//                     (confirmed: Rainbow Ford, static.edealer.ca). The
//                     richest of the three sources -- separate vin/year/make/
//                     model/trim fields and a real MSRP, no trim-string
//                     splitting needed. One page per section (new/used) holds
//                     the complete section; no further pagination observed.
//
// Both platforms were misidentified by the URL-pattern guesses in the old
// scratch script (harvest-listing-urls.mjs) -- Rainbow Ford's `/new/vehicle/
// ....htm` URLs look like a generic "D2C" shape but the site is actually
// EDealer. Detection here is by CONTENT (a script tag that parses, an
// ItemList that parses), never by URL shape alone.
import { validateVin } from "../../supabase/functions/_shared/invariants.ts";

const num = (x) => { const v = Number(x); return Number.isFinite(v) ? v : null; };
const pos = (x) => { const v = Number(x); return Number.isFinite(v) && v > 0 ? v : null; };

// ── jsonld_itemlist ──────────────────────────────────────────────────────

// Every <script type="application/ld+json"> block, parsed. Malformed JSON
// (truncated fetch, hand-edited theme) skips that one block rather than
// throwing -- a page can carry several ld+json blocks (site nav, org info,
// breadcrumbs) and only one of them is ever the vehicle ItemList.
function jsonLdBlocks(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { out.push(JSON.parse(m[1])); } catch { /* skip this block */ }
  }
  return out;
}

// A block can itself be an ItemList, or a @graph array containing one
// (Yoast's shape). Walks both without assuming which.
function findItemLists(blocks) {
  const lists = [];
  for (const b of blocks) {
    const nodes = Array.isArray(b) ? b : (Array.isArray(b?.["@graph"]) ? b["@graph"] : [b]);
    for (const n of nodes) if (n?.["@type"] === "ItemList" && Array.isArray(n.itemListElement)) lists.push(n);
  }
  return lists;
}

// name is "{year} {make} {model} {trim...}" (Yoast composes it that way on
// every site seen). Stripping the known year/make/model prefix leaves
// whatever trim words remain -- imperfect on a model whose own name contains
// the make word twice, but conservative: an unstripped leftover just means a
// slightly noisier sig.trim into pickTrimMsrp, never a wrong VIN or price.
function trimFromName(name, year, make, model) {
  if (!name) return null;
  let rest = String(name).trim();
  for (const part of [year, make, model]) {
    if (!part) continue;
    const re = new RegExp("^" + String(part).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*", "i");
    rest = rest.replace(re, "");
  }
  rest = rest.trim();
  return rest || null;
}

// One ItemList "Car" -> one row for fn_upsert_listings, or null if there is
// no valid VIN. Mirrors normalizeSm360/normalizeConvertus in
// crawl-alberta-inventory.mjs -- same contract, same "no VIN, no row" rule.
export function normalizeJsonLdCar(item, condition) {
  const check = validateVin(item?.vehicleIdentificationNumber);
  if (!check.present || !check.valid) return null;
  // Field name varies by site/theme even for the same schema.org property:
  // villagehonda.com uses vehicleModelDate (the correct schema.org name),
  // wolfechevrolet.com's Yoast output uses the shorter modelDate. Both real,
  // confirmed live 2026-08-18 -- check both rather than picking one.
  const year = num(item?.vehicleModelDate ?? item?.modelDate);
  const make = item?.brand?.name ?? null;
  const model = item?.model ?? null;
  const price = pos(item?.offers?.price);
  const conditionUrl = String(item?.itemCondition || item?.offers?.itemCondition || "");
  return {
    vin: check.vin,
    stock_no: item?.sku ?? null,
    year, make, model,
    trim: trimFromName(item?.name, year, make, model),
    // Prefer the page's own condition (the section this ItemList came from)
    // over the item's itemCondition URL, which some themes leave blank.
    condition: condition || (/used/i.test(conditionUrl) ? "used" : "new"),
    odometer_km: num(item?.mileageFromOdometer?.value),
    // No MSRP field in this shape -- filled by trim-match to msrp_catalog,
    // same as SM360.
    msrp: null,
    list_price: price,
    sale_price: price,
    date_entry: null,
    days_in_inventory: null,
    certified: null,
    demo: null,
    damaged: null,
    status: null,
  };
}

// Extracts every Car from every ItemList on one page.
export function extractJsonLdVehicles(html, condition) {
  const lists = findItemLists(jsonLdBlocks(html));
  const rows = [];
  for (const list of lists) {
    // villagehonda.com's real output nests one array deeper than the
    // ItemList spec (`itemListElement":[[{...}]]`, confirmed live
    // 2026-08-18) -- a stray extra bracket in their generator, not a
    // documented variant. Flatten one level so a ListItem is always the
    // thing being read, whichever shape a theme emits.
    const elements = list.itemListElement.flat();
    for (const li of elements) {
      const item = li?.item;
      if (item?.["@type"] !== "Car") continue;
      const row = normalizeJsonLdCar(item, condition);
      if (row) rows.push(row);
    }
  }
  return rows;
}

// Category/model links on a /new/ or /used/ index page -- e.g.
// /inventory/new-chevrolet-silverado_1500/. Excludes pagination siblings
// (-page-2 etc; those are discovered by following rel="next" FROM a category
// page, not linked from the index) and anything outside /inventory/.
export function discoverCategoryPages(html, origin) {
  const out = new Set();
  const re = /href="(\/inventory\/(?:new|used)-[a-z0-9_]+(?:-[a-z0-9_]+)*\/)"/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/-page-\d+\/?$/.test(m[1])) continue;
    try { out.add(new URL(m[1], origin).href); } catch { /* skip */ }
  }
  return [...out];
}

// The rel="next" link on a category page, or null at the last page.
export function findNextPage(html) {
  const m = html.match(/rel="next"\s+href="([^"]+)"/i) || html.match(/href="([^"]+)"\s+rel="next"/i);
  return m ? m[1] : null;
}

// ── edealer ──────────────────────────────────────────────────────────────

// `vehicleArray = {...}` sits inline in a large <script> block. Bracket-depth
// matched (respecting quoted strings) rather than regex-captured to the next
// `};`, because a vehicle's own free-text fields (descriptions, option lists)
// can legitimately contain `}` or `;`. Returns the raw object text, or null
// if the marker is absent (site not on this platform / page shape changed).
export function extractVehicleArrayText(html) {
  const marker = "vehicleArray = {";
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const objStart = start + marker.length - 1;
  let depth = 0, inStr = false, i = objStart;
  for (; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (c === "\\") { i++; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  if (depth !== 0) return null; // never closed -- truncated fetch, don't guess
  return html.slice(objStart, i);
}

// One vehicleArray entry -> one row. EDealer states real vin/year/make/model/
// trim fields directly (no name-string splitting needed) and its own
// OriginalMSRP -- but msrp stays null here anyway, same posture as every
// other source: a figure only this crawler asserts, unconfirmed against the
// SAME package/trim ambiguity that produced the IONIQ 9 false accusation, is
// worth less than the one trim-match already regression-tested end to end.
// OriginalPrice is the dealer's own current asking price either way.
export function normalizeEdealerVehicle(v) {
  const check = validateVin(v?.vin);
  if (!check.present || !check.valid) return null;
  const price = pos(v?.OriginalPrice);
  return {
    vin: check.vin,
    stock_no: v?.stockNum ?? null,
    year: num(v?.year),
    make: v?.make ?? null,
    model: v?.model ?? null,
    trim: v?.trim || null,
    condition: /used/i.test(String(v?.condition || "")) ? "used" : "new",
    odometer_km: num(v?.mileage),
    msrp: null,
    list_price: price,
    sale_price: price,
    date_entry: null,
    days_in_inventory: null,
    certified: null,
    demo: v?.demo === "1" || v?.demo === 1 || v?.demo === true,
    damaged: null,
    status: null,
  };
}

// Every vehicle on one EDealer page. Returns [] (not null) if the marker is
// absent, so a caller can treat "found the platform, no units" the same way
// as "an empty section" rather than a parse failure.
export function extractEdealerVehicles(html) {
  const text = extractVehicleArrayText(html);
  if (!text) return [];
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  const rows = [];
  for (const v of Object.values(parsed || {})) {
    const row = normalizeEdealerVehicle(v);
    if (row) rows.push(row);
  }
  return rows;
}
