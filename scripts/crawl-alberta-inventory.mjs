// Alberta inventory crawler — builds our own VIN dataset from the inventory
// feeds dealers publish on their own sites.
//
// WHY OURS. Every vehicle-data vendor worth buying also sells to dealers, which
// makes them a switch the other side of the table can ask to have flipped (see
// the vendor policy in CLAUDE.md). This dataset has no vendor, no contract, and
// nothing anyone can revoke for commercial reasons.
//
// WHAT WE TAKE, per unit: the VIN (SM360 calls it serialNo), the dealer's OWN
// date-entered-inventory and days-in-inventory counts, list vs sale price, and
// the basic condition facts. Nothing about a person — no buyer, no owner, no
// contact details. See the migration header for the privacy note.
//
// HOW IT BEHAVES. Identifies itself honestly in the User-Agent, crawls one
// dealer at a time with a delay between requests, caps pages per section, and
// treats any failure as "skip this dealer today" rather than something that
// could corrupt the table. A crawl that returns suspiciously little never
// mass-delists a lot (the guard lives in fn_mark_delisted).
//
// It HONOURS robots.txt (see lib/robots.mjs). Before touching a dealer it reads
// their robots.txt: a Disallow on the paths we'd fetch skips that section
// (leaving its inventory untouched, and marking the crawl partial so nothing is
// delisted); a Crawl-delay raises the between-page delay; and if robots.txt
// can't be read at all (any error but a clean 404) the dealer is skipped for the
// day, because we couldn't confirm we're welcome. This is the first line of the
// standing-crawl guardrails named in the legal brief (Q17).
//
// Run (Node 24+, from repo root):
//   node --experimental-strip-types scripts/crawl-alberta-inventory.mjs --dry-run
//   node --experimental-strip-types scripts/crawl-alberta-inventory.mjs --host https://www.tazaparkvw.com --dry-run
//   node --experimental-strip-types scripts/crawl-alberta-inventory.mjs        # writes; needs SUPABASE_* env
//
// --experimental-strip-types is required because we import validateVin from the
// edge functions' shared module rather than writing a second copy of VIN
// validation. One definition, one place to fix.
import { validateVin } from "../supabase/functions/_shared/invariants.ts";
import { extractJsonLdVehicles, discoverCategoryPages, findNextPage, extractEdealerVehicles } from "./lib/structured-inventory.mjs";
import { parseRobots, isPathAllowed } from "./lib/robots.mjs";
import { extractConvertusVmsRoot } from "../supabase/functions/_shared/convertus-vms.js";
import { pathToFileURL } from "node:url";

const DRY = process.argv.includes("--dry-run");
const HOST_ARG = (() => { const i = process.argv.indexOf("--host"); return i > -1 ? process.argv[i + 1] : null; })();

// An honest User-Agent. A standing crawler that pretends to be a person is
// harder to defend than one that says who it is and where to complain — and if
// a dealer chooses to block it, that is a signal we want to receive.
const UA = "LotCheckBot/1.0 (+https://lotcheck.ca/about; buyer-side vehicle price verification)";
// Per section. City GM's new inventory alone is 60 pages, so the old cap of 40
// silently truncated about a third of the largest lot in the seed — and a big
// lot is exactly where days-on-lot leverage lives, so that is the worst place
// to lose coverage. 150 pages is ~3,600 units at 24/page, comfortably past any
// real Alberta dealer, and the cap stays only as a runaway-pagination backstop.
// Hitting it still marks the crawl partial, which suppresses delisting.
const PAGE_CAP = 150;
const REQUEST_DELAY_MS = 800; // between page fetches, per dealer (the floor)
const FETCH_TIMEOUT_MS = 20_000;
// The delay actually used between page fetches. Defaults to the floor above and
// is raised per dealer to honour a robots.txt Crawl-delay. Module-level and set
// in main() before any crawl call — safe because we crawl one dealer at a time.
let effectiveDelayMs = REQUEST_DELAY_MS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (x) => { const v = Number(x); return Number.isFinite(v) ? v : null; };
// Feeds use 0 to mean "not stated" for prices and day counts — a real Ford
// F-150 came back with asking_price 0 and days_on_lot 0. Storing those as
// literal zeros would put a free car and a same-day arrival in the dataset and
// poison every average built on it. Absent is absent.
const pos = (x) => { const v = Number(x); return Number.isFinite(v) && v > 0 ? v : null; };

// SM360 hands back epoch milliseconds. Anything outside a sane window is a
// system default, not a real date, and must not become a days-on-lot claim.
function entryDate(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 946684800000 || v > 4102444800000) return null;
  return new Date(v).toISOString().slice(0, 10);
}

// One SM360 vehicle -> one row for fn_upsert_listings. Returns null if the unit
// has no valid VIN: a row we cannot key on is worse than no row.
function normalizeSm360(v, section) {
  const check = validateVin(v?.serialNo);
  if (!check.present || !check.valid) return null;
  const list = pos(v?.listPrice);
  const sale = pos(v?.salePrice);
  return {
    vin: check.vin,
    stock_no: v?.stockNo ?? null,
    year: num(v?.year),
    make: v?.make?.name ?? null,
    model: v?.model?.name ?? null,
    trim: v?.trim?.name ?? null,
    condition: section === "new-inventory" ? "new" : (v?.newVehicle === true ? "new" : "used"),
    odometer_km: num(v?.odometer),
    msrp: null,                          // SM360's listing feed states no MSRP
    list_price: list,
    // Some feeds omit salePrice when there is no markdown; fall back to list so
    // "cut to date" reads 0 rather than looking like a giveaway.
    sale_price: sale ?? list,
    date_entry: entryDate(v?.dateEntry),
    days_in_inventory: num(v?.daysInInventory),
    certified: v?.certified === true,
    demo: v?.demo === true,
    damaged: v?.severelyDamagedVehicle === true,
    status: v?.vehicleStatus ?? null,
  };
}

// ── Convertus ───────────────────────────────────────────────────────────────
// A WordPress plugin (convertus-vms) that proxies to vms.prod.convertus.rocks.
// The API host 403s a direct hit, so the dealer's own site is the way in — the
// same route scripts/lib/convertus-stack.mjs already uses for rate catalogs.
// Addressed by the dealer's `cp` id (the page's inventoryId), stored in
// dealer_source.platform_id.
//
// Confirmed live 2026-08-11 against two Alberta dealers: 76/76 valid VINs, and
// days_on_lot present on 99 of 100 units.
//
// DELIBERATELY IGNORED: invoice_price and wholesale_price. The names promise
// dealer cost; the data does not deliver it — on Denham Ford's new lot
// invoice_price is populated on every unit and simply mirrors msrp
// ($40,889 vs $40,889). Presenting that as "the dealer's invoice" would be a
// fabricated claim of exactly the kind the report exists to catch. If we ever
// want a cost anchor it has to be sourced, not inferred from a field name.
// Convertus inventory is read the ROBOTS-COMPLIANT way (2026-08-27): the
// dealer's own sitemap enumerates every vehicle detail page (VDP), and each VDP
// embeds the full vehicle record in a `var vmsData = {...}` blob — the same
// object the old ajax endpoint returned per unit, plus a real date_on_lot. That
// endpoint lived under /wp-content/plugins/, which convertus/WordPress dealers
// routinely Disallow in robots.txt (confirmed: Denham Ford, North Hill Mazda),
// so the crawl was skipping them entirely. The sitemap + VDP pages are allowed.
// See discoverConvertusVdps below and lib/robots.mjs.
const VDP_CAP = 600; // per section, a runaway-enumeration backstop like PAGE_CAP

// The ajax path reported days_on_lot but no entry DATE, so we derived one by
// subtracting. That is arithmetic on the dealer's own number, not our estimate —
// but it inherits their precision, so it can only ever be a day-resolution floor.
function entryFromDays(days) {
  const n = pos(days);
  if (n == null || n > 3650) return null;
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

// The VDP carries a REAL date_on_lot timestamp ("2025-10-08 06:47:47") — better
// than deriving one from a count. Validate and take the date part; reject the
// obvious system-default / future values so a bad field never becomes a claim.
function entryFromDate(s) {
  if (typeof s !== "string") return null;
  const d = s.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const t = Date.parse(d);
  if (!Number.isFinite(t) || t < 946684800000 || t > Date.now() + 86_400_000) return null;
  return d;
}
// Whole CALENDAR days between a validated YYYY-MM-DD entry date and today. Both
// ends are anchored at UTC midnight so the current time-of-day can't push the
// count up by one — the entry date has no time component, so neither should the
// comparison. (A residual <1-day UTC-vs-local edge is inherent to date-only data.)
function daysSince(dateStr) {
  if (!dateStr) return null;
  const t = Date.parse(dateStr); // YYYY-MM-DD -> UTC midnight
  if (!Number.isFinite(t)) return null;
  const now = new Date();
  const todayMid = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.floor((todayMid - t) / 86_400_000);
  return days >= 0 && days <= 3650 ? days : null;
}

// One convertus vehicle object -> one row. Works on both shapes of that object:
// the VDP's vmsData.vehicle (what the crawl reads now — carries date_on_lot) and
// the old ajax results[] item (days_on_lot). Prefers the real date_on_lot when
// present, falls back to deriving from a day count. Exported for the test.
export function normalizeConvertus(v, sc) {
  const check = validateVin(v?.vin);
  if (!check.present || !check.valid) return null;
  const strip = (s) => (typeof s === "string" ? s.replace(/<[^>]*>/g, "").trim() : null) || null;
  const sticker = pos(v?.asking_price);
  // The advertised ask is the LOWEST consumer-facing figure, mirroring the
  // byte-verified buyer path (convertus-vms.js): asking_price often just repeats
  // the MSRP sticker, while internet_price / sale_price carry the real
  // discounted price. final_price is deliberately excluded there, so it is here.
  const consumer = [pos(v?.internet_price), pos(v?.sale_price), pos(v?.asking_price)].filter((n) => n != null);
  const advertised = consumer.length ? Math.min(...consumer) : null;
  const msrp = pos(v?.msrp);
  const dateOnLot = entryFromDate(v?.date_on_lot);
  // Convertus encodes booleans as true/1/"1". Decode them ALL the same way —
  // in_transit/on_order used raw truthiness before, so a string "0" (falsy value,
  // truthy string) would have flipped a for-sale car to IN_TRANSIT.
  const flag = (x) => x === true || x === 1 || x === "1";
  return {
    vin: check.vin,
    stock_no: v?.stock_number ?? null,
    year: num(v?.year),
    make: v?.make ?? null,
    model: v?.model ?? null,
    trim: strip(v?.search_trim) ?? strip(v?.trim),
    condition: sc === "new" ? "new" : "used",
    odometer_km: num(v?.odometer),
    msrp,
    list_price: sticker ?? advertised,
    sale_price: advertised ?? sticker,
    date_entry: dateOnLot ?? entryFromDays(v?.days_on_lot),
    days_in_inventory: (dateOnLot ? daysSince(dateOnLot) : null) ?? pos(v?.days_on_lot),
    certified: flag(v?.certified),
    demo: flag(v?.demo),
    damaged: null,                       // Convertus states no equivalent — null, never false
    status: flag(v?.in_transit) ? "IN_TRANSIT" : (flag(v?.on_order) ? "ON_ORDER" : "FOR_SALE"),
  };
}

// "/path?query" for a robots check.
function urlPathAndQuery(u) { try { const x = new URL(u); return x.pathname + (x.search || ""); } catch { return u; } }
// Sitemap <loc> values are externally controlled. A loc on a DIFFERENT host
// would be robots-checked against the wrong dealer's robots.txt, so we only ever
// fetch URLs on the dealer's own host (a cross-host loc is dropped, and counted
// as a gap). Exported for the test.
export function sameHost(u, host) { try { return new URL(u).host === new URL(host).host; } catch { return false; } }
// Every <loc> value in a sitemap's XML.
function sitemapLocs(xml) {
  return (String(xml || "").match(/<loc>\s*([^<\s]+)\s*<\/loc>/g) || []).map((m) => m.replace(/<\/?loc>/g, "").trim());
}
// The real VDP URLs in a sitemap. Convertus VDPs are
// /vehicles/YYYY/make/model/city/prov/adId/ — the year segment is what tells
// them apart from the /vehicles/<section>/ listing page, which is also in the
// sitemap and must be excluded. Exported for the test.
export function vdpUrlsFromSitemap(xml) {
  return sitemapLocs(xml).filter((u) => /\/vehicles\/(?:19|20)\d\d\//.test(u));
}

// Enumerate a convertus dealer's VDPs for one section from its OWN sitemaps
// (which robots.txt exists to expose), checking every URL against robots — and
// its host — before fetching it. Never touches the Disallowed /wp-content ajax
// endpoint. Throws only if no sitemap index is reachable at all (a real
// failure). Returns { vdps, complete }: `complete` is false if ANY sub-sitemap
// or VDP was dropped (robots, cross-host, or a fetch failure) — the caller folds
// that into `partial` so a truncated enumeration NEVER reads as "the rest sold".
// `opts.fetcher`/`opts.delayMs` exist only so the test can drive it offline.
export async function discoverConvertusVdps(host, sc, robots, opts = {}) {
  const fetcher = opts.fetcher || fetchHtml;
  const delayMs = opts.delayMs ?? effectiveDelayMs;
  const want = sc === "new" ? /new-vehicle-\d+-sitemap\.xml/i : /used-vehicle-\d+-sitemap\.xml/i;
  let subMaps = [], readAnyIndex = false;
  for (const cand of ["/sitemap.xml", "/sitemap_index.xml"]) {
    const idxUrl = `${host}${cand}`;
    if (!isPathAllowed(robots, urlPathAndQuery(idxUrl))) continue;
    let idx;
    try { idx = await fetcher(idxUrl); readAnyIndex = true; } catch { continue; }
    const found = [...new Set(sitemapLocs(idx).filter((u) => want.test(u)))];
    if (found.length) { subMaps = found; break; }
  }
  if (!subMaps.length) {
    if (!readAnyIndex) throw new Error("no reachable sitemap index");
    return { vdps: [], complete: true }; // index read; dealer lists no vehicle sitemaps
  }
  const vdps = [], seen = new Set();
  let complete = true; // any dropped submap/VDP flips this -> caller suppresses delisting
  for (const smUrl of subMaps) {
    if (!sameHost(smUrl, host) || !isPathAllowed(robots, urlPathAndQuery(smUrl))) { complete = false; continue; }
    await sleep(delayMs);
    let sm;
    try { sm = await fetcher(smUrl); } catch (e) { console.warn(`    ${sc}: sitemap ${smUrl} failed (${e.message})`); complete = false; continue; }
    const urls = vdpUrlsFromSitemap(sm);
    // A vehicle sub-sitemap that fetched 200 but parsed to ZERO VDP URLs is
    // suspect (a gzip body read as text, a WAF interstitial, a truncated
    // response) — never a real vehicle sitemap with no vehicles. Treat it as
    // incomplete so its cars are not read as sold.
    if (!urls.length) { console.warn(`    ${sc}: sitemap ${smUrl} yielded 0 vehicle URLs — marking incomplete`); complete = false; continue; }
    for (const u of urls) {
      if (seen.has(u)) continue;
      if (!sameHost(u, host) || !isPathAllowed(robots, urlPathAndQuery(u))) { complete = false; continue; }
      seen.add(u); vdps.push(u);
    }
  }
  return { vdps, complete };
}

export async function crawlConvertus(host, sc, robots, opts = {}) {
  const fetcher = opts.fetcher || fetchHtml;
  const delayMs = opts.delayMs ?? effectiveDelayMs;
  const { vdps, complete } = await discoverConvertusVdps(host, sc, robots, { fetcher, delayMs }); // throws -> section failure
  if (!vdps.length) { console.warn(`    ${sc}: sitemap listed no vehicle pages — partial, no delisting`); return { rows: [], partial: true }; }
  // A gap in enumeration means we did NOT see the whole lot -> partial.
  let partial = !complete || vdps.length > VDP_CAP;
  if (vdps.length > VDP_CAP) console.warn(`    ${sc}: ${vdps.length} VDPs exceeds cap ${VDP_CAP} — crawled ${VDP_CAP}, rest skipped`);
  const rows = [];
  const cap = Math.min(vdps.length, VDP_CAP);
  for (let i = 0; i < cap; i++) {
    await sleep(delayMs); // a delay before every VDP fetch, per dealer
    let html;
    try { html = await fetcher(vdps[i]); }
    catch (e) { console.warn(`    ${sc}: VDP ${i + 1}/${cap} failed (${e.message})`); partial = true; continue; }
    const root = extractConvertusVmsRoot(html);
    const row = root?.vehicle ? normalizeConvertus(root.vehicle, sc) : null;
    if (row) rows.push(row);
    // A VDP that fetched 200 but yielded no readable unit is NOT "sold" — it's a
    // page we couldn't read. Mark partial so its VIN is never delisted for being
    // absent from `seen` (missing beats wrong).
    else partial = true;
  }
  return { rows, partial };
}

async function fetchPage(host, section, page) {
  const res = await fetch(`${host}/en/${section}/api/listing?page=${page}`, {
    headers: { "User-Agent": UA, Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!/json/.test(res.headers.get("content-type") || "")) throw new Error("non-JSON response");
  return res.json();
}

// Walks every page of one section. Throws on the FIRST page failing (we have
// nothing, so skip the dealer); a later page failing stops pagination but keeps
// what we already have, and reports partial so the caller can skip delisting.
async function crawlSection(host, section) {
  const rows = [];
  let pages = 1, partial = false;
  for (let page = 1; page <= Math.min(pages, PAGE_CAP); page++) {
    let data;
    try {
      data = await fetchPage(host, section, page);
    } catch (e) {
      if (page === 1) throw e;
      console.warn(`    page ${page} failed (${e.message}) — keeping ${rows.length} rows, stopping`);
      partial = true;
      break;
    }
    if (page === 1) pages = num(data?.pagination?.numberOfPages) || 1;
    const vehicles = data?.vehicles || [];
    if (!vehicles.length) break;
    for (const v of vehicles) { const row = normalizeSm360(v, section); if (row) rows.push(row); }
    if (page < Math.min(pages, PAGE_CAP)) await sleep(effectiveDelayMs);
  }
  if (pages > PAGE_CAP) {
    console.warn(`    ${section}: ${pages} pages exceeds cap ${PAGE_CAP} — crawled ${PAGE_CAP}, rest skipped`);
    partial = true;
  }
  return { rows, partial };
}

// ── jsonld_itemlist ─────────────────────────────────────────────────────────
// Confirmed live 2026-08-18: Wolfe Chevrolet (f/k/a Westgate Chev), Village
// Honda. Two-level crawl -- the /new/ or /used/ index links to model/category
// pages (e.g. /inventory/new-chevrolet-silverado_1500/), and EACH of those
// carries its own ItemList (up to 20 vehicles) with rel="next" pagination.
// See scripts/lib/structured-inventory.mjs for the parser itself.
async function fetchHtml(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function crawlJsonLdSection(host, section) {
  const indexHtml = await fetchHtml(`${host}/${section}/`); // throws -> caller treats as section failure, same as crawlSection's page-1 contract
  const categories = discoverCategoryPages(indexHtml, host);
  const rows = [];
  let partial = false;
  for (const catUrl of categories) {
    let url = catUrl, pages = 0;
    while (url && pages < PAGE_CAP) {
      let html;
      try {
        html = await fetchHtml(url);
      } catch (e) {
        console.warn(`    ${section} ${catUrl}: FAILED (${e.message}) — keeping what this category already gave`);
        partial = true;
        break;
      }
      rows.push(...extractJsonLdVehicles(html, section === "used" ? "used" : "new"));
      url = findNextPage(html);
      pages++;
      if (url) await sleep(effectiveDelayMs);
    }
    if (pages >= PAGE_CAP) { console.warn(`    ${section} ${catUrl}: exceeds page cap ${PAGE_CAP}`); partial = true; }
    await sleep(effectiveDelayMs);
  }
  return { rows, partial };
}

// ── edealer ──────────────────────────────────────────────────────────────
// Confirmed live 2026-08-18: Rainbow Ford. The whole section's inventory sits
// in one `vehicleArray = {...}` object on the /new/ or /used/ page itself --
// no further pagination observed, so this is a single fetch per section.
async function crawlEdealerSection(host, section) {
  const html = await fetchHtml(`${host}/${section}/`);
  return { rows: extractEdealerVehicles(html), partial: false };
}

// Fetch + parse a host's robots.txt for OUR agent. A 404 (no robots.txt) means
// "crawling allowed" — the standard convention. Any OTHER failure (5xx, network,
// timeout) means we could NOT confirm permission, so we skip the dealer today:
// fail-safe, matching the crawler's existing skip-on-failure stance. One fetch
// per dealer per run.
async function fetchRobots(host) {
  try {
    const res = await fetch(`${host}/robots.txt`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === 404) return { ok: true, robots: { rules: [], crawlDelay: null }, note: "no robots.txt (404) — crawling allowed" };
    if (!res.ok) return { ok: false, note: `robots.txt HTTP ${res.status} — can't confirm permission` };
    return { ok: true, robots: parseRobots(await res.text(), "lotcheckbot"), note: "robots.txt read" };
  } catch (e) {
    return { ok: false, note: `robots.txt unreachable (${e.message})` };
  }
}

// The URL path(s) the crawler will request for a section, checked against
// robots.txt before we fetch. If any is Disallowed the section is skipped.
function robotsPathsFor(platform, section) {
  // convertus now reads the sitemap index + the /vehicles/ VDP space; each VDP
  // URL is re-checked individually inside discoverConvertusVdps.
  if (platform === "convertus") return ["/sitemap.xml", "/vehicles/"];
  if (platform === "sm360") return [`/en/${section}/api/listing`];
  return [`/${section}/`]; // jsonld_itemlist + edealer
}

// A crawl section targets one condition (sm360 uses new-inventory/used-inventory;
// everything else uses new/used). The stored row `condition` is the authority
// for bucketing seen VINs, but the section tells us which conditions we actually
// attempted to crawl this run.
export function sectionCondition(section) { return /new/i.test(String(section)) ? "new" : "used"; }

// The per-condition fn_mark_delisted calls to make after a dealer's sections.
//
// TWO layers of safety:
//  1. dealerClean (= no section failed/partial/robots-skipped): if ANY section
//     was unhealthy, delist NOTHING. This is required because a row's stored
//     `condition` is NOT always its section's condition — sm360's used-inventory
//     feed can emit a newVehicle==true unit stored as condition 'new', and
//     edealer reads condition from the vehicle, not the section. So a failed
//     'used' section could otherwise leave a 'used'-sourced 'new' car out of
//     seenByCond.new and the 'new' delist would wrongly mark it sold. Gating on
//     the WHOLE dealer being clean means seenByCond is complete for every
//     condition before we delist any of it.
//  2. Per condition: only a condition we crawled with >=1 VIN is delisted, each
//     call scoped to that condition so the SQL's >50% guard is evaluated within
//     it — that is what catches a silent one-condition collapse (Finding B) that
//     a dealer-granular guard would let a healthy other condition mask.
// Exported for the test.
export function planSectionDelisting(condState, seenByCond, dealerClean = true) {
  if (!dealerClean) return [];
  const plan = [];
  for (const cond of Object.keys(condState)) {
    const st = condState[cond];
    // Dedup: two sections can map to the same condition (e.g. a used + certified
    // split both resolve to 'used'), and a duplicate VIN must not inflate the
    // saw-count and so defeat the SQL's >50% guard.
    const vins = [...new Set(seenByCond[cond] || [])];
    if (st?.crawled && st?.ok && vins.length) plan.push({ condition: cond, vins, count: vins.length });
  }
  return plan;
}

async function main() {
  let supabase = null;
  let dealers;

  if (DRY) {
    dealers = HOST_ARG
      ? [{ id: 0, host: HOST_ARG, name: HOST_ARG, platform: "sm360", sections: ["new-inventory", "used-inventory"] }]
      : [
          { id: 0, host: "https://www.tazaparkvw.com", name: "Taza Park Volkswagen", platform: "sm360", sections: ["used-inventory"] },
          { id: 0, host: "https://www.denhamford.ca", name: "Denham Ford", platform: "convertus", platform_id: "1285", sections: ["new", "used"] },
          { id: 0, host: "https://www.northhillmazda.com", name: "North Hill Mazda", platform: "convertus", platform_id: "2246", sections: ["used"] },
          { id: 0, host: "https://www.wolfechevrolet.com", name: "Wolfe Chevrolet", platform: "jsonld_itemlist", sections: ["new"] },
          { id: 0, host: "https://www.rainbowford.ca", name: "Rainbow Ford", platform: "edealer", sections: ["new"] },
        ];
    console.log(`DRY RUN — fetching live feeds, writing nothing.\n`);
  } else {
    const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) { console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (or pass --dry-run)"); process.exit(1); }
    const { createClient } = await import("@supabase/supabase-js");
    supabase = createClient(url, key);
    let q = supabase
      .from("dealer_source").select("id,host,name,sections,platform,platform_id")
      .eq("active", true).in("platform", ["sm360", "convertus", "jsonld_itemlist", "edealer"]);
    // --host re-crawls ONE dealer. Useful after raising a limit or fixing an
    // adapter: no reason to re-walk seven healthy lots to re-read the eighth.
    if (HOST_ARG) q = q.eq("host", HOST_ARG);
    const { data, error } = await q;
    if (error) { console.error("could not read dealer_source:", error.message); process.exit(1); }
    dealers = data || [];
    if (HOST_ARG && !dealers.length) { console.error(`no active dealer matches --host ${HOST_ARG}`); process.exit(1); }
  }

  let totals = { dealers: 0, rows: 0, new: 0, priced: 0, delisted: 0, failed: 0, robotsSkipped: 0 };

  for (const d of dealers) {
    console.log(`${d.name || d.host}`);
    // Seen VINs bucketed by the row's OWN condition; per-condition crawl state
    // drives per-condition delisting (no cross-section masking).
    const seenByCond = { new: [], used: [] };
    const condState = { new: { crawled: false, ok: true }, used: { crawled: false, ok: true } };
    let failed = false, partial = false;

    // Each platform names its sections differently: SM360 uses the URL segment
    // (new-inventory), everything else uses the plain new/used it links to.
    const isCvt = d.platform === "convertus";
    const isJsonLd = d.platform === "jsonld_itemlist";
    const isEdealer = d.platform === "edealer";
    const sections = d.sections?.length ? d.sections : (isCvt || isJsonLd || isEdealer ? ["new", "used"] : ["new-inventory", "used-inventory"]);
    // (convertus no longer needs platform_id — it enumerates VDPs from the
    // dealer's sitemap, not the platform-keyed ajax endpoint.)

    // robots.txt — a standing crawl honours it (legal brief Q17). One fetch per
    // dealer. If we can't confirm permission (non-404 error), skip the dealer.
    const rb = await fetchRobots(d.host);
    if (!rb.ok) { console.warn(`    skipped: ${rb.note}`); totals.robotsSkipped++; totals.dealers++; continue; }
    effectiveDelayMs = rb.robots.crawlDelay ? Math.max(REQUEST_DELAY_MS, rb.robots.crawlDelay * 1000) : REQUEST_DELAY_MS;
    if (rb.robots.crawlDelay) console.log(`    robots.txt crawl-delay ${rb.robots.crawlDelay}s — honouring (${effectiveDelayMs}ms between pages)`);

    for (const section of sections) {
      const cond = sectionCondition(section);
      condState[cond].crawled = true;

      // Per-section robots check. A Disallowed section is left completely
      // untouched — and its condition is marked incomplete so its inventory is
      // never read as delisted.
      const blockedPath = robotsPathsFor(d.platform, section).find((p) => !isPathAllowed(rb.robots, p));
      if (blockedPath) {
        console.log(`    ${section}: robots.txt disallows ${blockedPath} — skipping (inventory left untouched)`);
        partial = true;
        condState[cond].ok = false;
        continue;
      }

      let result;
      try {
        result = isCvt ? await crawlConvertus(d.host, section, rb.robots)
          : isJsonLd ? await crawlJsonLdSection(d.host, section)
          : isEdealer ? await crawlEdealerSection(d.host, section)
          : await crawlSection(d.host, section);
      } catch (e) {
        console.warn(`    ${section}: FAILED (${e.message})`);
        failed = true;
        condState[cond].ok = false;
        continue;
      }
      partial = partial || result.partial;
      if (result.partial) condState[cond].ok = false;
      console.log(`    ${section}: ${result.rows.length} units with valid VINs`);
      totals.rows += result.rows.length;

      if (DRY) {
        for (const r of result.rows.slice(0, 3)) {
          const cut = (r.list_price ?? 0) - (r.sale_price ?? 0);
          const offMsrp = r.msrp && r.sale_price ? r.msrp - r.sale_price : 0;
          const days = r.days_in_inventory != null ? `${r.days_in_inventory}d since ${r.date_entry ?? "?"}` : "days not stated";
          const price = r.sale_price != null ? `$${r.sale_price}` : "price not stated";
          console.log(`      ${r.vin}  ${r.year} ${r.make} ${r.model} ${(r.trim ?? "").slice(0, 28)} · ${days} · ${price}${cut > 0 ? ` (cut $${cut} off own list)` : ""}${offMsrp > 0 ? ` ($${offMsrp} off $${r.msrp} MSRP)` : ""}`);
        }
        for (const r of result.rows) seenByCond[r.condition === "new" ? "new" : "used"].push(r.vin);
        continue;
      }

      // Chunked so one dealer's whole lot is not a single oversized payload.
      for (let i = 0; i < result.rows.length; i += 200) {
        const chunk = result.rows.slice(i, i + 200);
        const { data, error } = await supabase.rpc("fn_upsert_listings", { p_dealer_id: d.id, p_rows: chunk });
        if (error) { console.warn(`    upsert failed: ${error.message}`); failed = true; break; }
        totals.new += data?.new || 0;
        totals.priced += data?.price_changes || 0;
      }
      for (const r of result.rows) seenByCond[r.condition === "new" ? "new" : "used"].push(r.vin);
    }

    if (!DRY) {
      // Delist only after a clean WHOLE-dealer crawl (any failed/partial section
      // -> nothing, because a row's stored condition isn't always its section's),
      // then PER CONDITION so the SQL's >50% guard runs within each condition and
      // a silent one-condition collapse can't be masked by a healthy other one.
      const plan = planSectionDelisting(condState, seenByCond, !failed && !partial);
      if (!plan.length && (failed || partial)) {
        console.log(`    delisting skipped (${failed ? "fetch failed" : "partial crawl"})`);
      }
      for (const { condition, vins, count } of plan) {
        const { data, error } = await supabase.rpc("fn_mark_delisted", { p_dealer_id: d.id, p_seen_vins: vins, p_saw_count: count, p_condition: condition });
        if (error) console.warn(`    delist (${condition}) failed: ${error.message}`);
        else { totals.delisted += data || 0; if (data) console.log(`    ${data} no longer listed (${condition})`); }
      }
      await supabase.rpc("fn_record_crawl", { p_dealer_id: d.id, p_ok: !failed, p_error: failed ? "crawl failed" : null });
    }

    if (failed) totals.failed++;
    totals.dealers++;
  }

  console.log(`\n${totals.failed ? "⚠" : "✅"} ${totals.dealers} dealers · ${totals.rows} units · ${totals.new} new · ${totals.priced} price events · ${totals.delisted} delisted · ${totals.failed} failed${totals.robotsSkipped ? ` · ${totals.robotsSkipped} skipped (robots.txt)` : ""}`);
  if (totals.failed === totals.dealers && totals.dealers > 0) process.exit(1);
}

// Run only when invoked directly, not when a test imports the exported helpers
// (normalizeConvertus, vdpUrlsFromSitemap, crawlConvertus, ...). argv[1] is
// absent under `node -e`/REPL, so guard it before pathToFileURL.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
