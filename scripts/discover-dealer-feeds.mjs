// Dealer feed discovery — finds which Alberta dealers publish a machine-readable
// inventory feed, and confirms it responds before anything goes in the crawl seed.
//
// WHY IT EXISTS. dealer_source must only ever contain hosts we have SEEN answer.
// A guessed hostname in that table is a silent 404 every single night: the crawl
// looks healthy, the dataset quietly has a hole, and nobody finds out. So the
// seed grows only by confirmation, never by inference.
//
// WHERE CANDIDATES COME FROM. Two sources, both already ours:
//   --source osm   (default) OpenStreetMap shop=car in Alberta. The Overpass
//                  query update-alberta-dealers.mjs runs has always asked for
//                  `out center tags`, so the `website` tag has been coming back
//                  and being discarded. This picks it up. No DB needed.
//   --source amvic amvic_licensees.website — the REGULATOR'S list of licensed
//                  Alberta dealers, already refreshed weekly by
//                  scripts/amvic-refresh.mjs. Authoritative and far more
//                  complete than OSM, which had a website for only 131 of 466.
//                  Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
//
// WHAT IT PROBES. SM360 (the JSON listing feed the crawler reads) and Convertus
// (detected, not yet crawlable — recorded so we know the size of the prize).
// Detection logic mirrors scripts/probe-dealers.mjs, which proved both.
//
// POLITE BY DESIGN: honest User-Agent, small concurrency, a delay between
// batches, one or two requests per host, and meant to run rarely (monthly is
// plenty — dealership rosters and platforms change slowly).
//
// Run (from repo root):
//   node scripts/discover-dealer-feeds.mjs                      # probe OSM, report, write nothing
//   node scripts/discover-dealer-feeds.mjs --source amvic       # probe the regulator's roster instead
//   node scripts/discover-dealer-feeds.mjs --out found.json     # also save the results
//   node scripts/discover-dealer-feeds.mjs --write              # upsert confirmed SM360 hosts into dealer_source
//   node scripts/discover-dealer-feeds.mjs --limit 40           # probe a sample first
import { writeFileSync } from "node:fs";
import { extractJsonLdVehicles, discoverCategoryPages, extractEdealerVehicles } from "./lib/structured-inventory.mjs";
// ONE definition of what a dealer website reduces to. The scanner keys the
// catalogue on this and the probe files hosts by it; two copies would drift,
// and then a host the probe catalogued would be one the scanner cannot find.
import { toOrigin } from "../supabase/functions/_shared/dealer-catalog.ts";

const ARG = (name, dflt = null) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : dflt; };
const WRITE = process.argv.includes("--write");
const SOURCE = (ARG("--source", "osm") || "osm").toLowerCase();
const LIMIT = Number(ARG("--limit", "0")) || 0;
// Resume point. The 2026-08-19 run hit the job's 45-minute cap at 1,580 of
// 1,639 hosts, and there was no way to probe only the remainder — --limit takes
// the FIRST n. Skip is applied before limit, so --skip 1500 --limit 200 covers
// the tail without re-probing what already answered.
const SKIP = Number(ARG("--skip", "0")) || 0;
const OUT = ARG("--out");

const UA = "LotCheckBot/1.0 (+https://lotcheck.ca/about; buyer-side vehicle price verification)";
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
];
const QUERY = '[out:json][timeout:90];area["ISO3166-2"="CA-AB"]->.ab;nwr["shop"="car"](area.ab);out center tags;';
const ROUNDS = 4;
// Every candidate is a DIFFERENT host, and we hit each one once or twice, so
// the politeness that matters is per-host, not global — raising concurrency
// doesn't lean on anyone harder. The first full run managed only ~5s/host at
// 4-wide, which would blow the job timeout on a real candidate list.
const CONCURRENCY = 10;
const BATCH_PAUSE_MS = 250;
// A dealer feed that takes 12s to answer is one we could never crawl nightly
// anyway, so a slow host is a "no" for our purposes. Dead hosts dominated the
// wall clock at the old timeout.
const PROBE_TIMEOUT_MS = 5_000;

// ---- rescue pass -----------------------------------------------------------
// The probe runs on a GitHub runner, and a large share of dealer sites refuse
// datacenter IPs outright. West Wind Honda (Lethbridge) answered 403 to all
// SEVEN probes from CI and 200 from a normal connection, where our own parser
// reads 15 vehicles with VINs off it. So "EDealer: 0 across Alberta" was
// substantially a fact about our egress address, not about Alberta.
//
// 452 of 1,639 hosts (28%) never answered CI at all. Those get a second look
// through Scrapfly's Canadian residential pool, which is already in the stack
// for page render and is swappable plumbing under the vendor policy.
//
// DELIBERATELY CHEAP. Only hosts the direct pass could not reach are retried,
// so a reachable host never costs a credit. One /new/ fetch serves all three
// HTML detectors (EDealer, JSON-LD, Convertus) instead of one call each, and
// SM360's JSON endpoint is only tried when that page yields nothing — at most
// two billed calls per rescued host rather than seven.
const RESCUE = process.argv.includes("--rescue");
// .trim() is not defensive clutter: a secret pasted into `gh secret set` or
// the web form keeps whatever whitespace came with it, and a trailing newline
// turns the key into %0A-suffixed garbage that the API answers with a flat
// 401. That is indistinguishable from a wrong key, and it cost a full
// 452-host rescue pass to find.
const SCRAPFLY_KEY = (process.env.SCRAPFLY_API_KEY || "").trim();
const SCRAPFLY_CONCURRENCY = 5;      // the plan's hard ceiling
const SCRAPFLY_TIMEOUT_MS = 45_000;  // asp negotiation is slow by design
const RESCUABLE = new Set(["blocked", "unreachable", "timeout", "server-error"]);

async function scrapflyGet(url, accept = "text/html") {
  const u = new URL("https://api.scrapfly.io/scrape");
  u.searchParams.set("key", SCRAPFLY_KEY);
  u.searchParams.set("url", url);
  u.searchParams.set("asp", "true");        // the bot wall is the whole point
  u.searchParams.set("country", "ca");      // Canadian residential exit
  const r = await fetch(u, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(SCRAPFLY_TIMEOUT_MS) });
  if (!r.ok) {
    // Scrapfly puts the real reason in the body — ERR::AUTH::BAD_API_KEY reads
    // very differently from a throttle, and a bare status code made 452
    // identical failures say nothing about which one it was.
    let why = "";
    try { why = (await r.text()).slice(0, 200).replace(/\s+/g, " "); } catch { /* body already gone */ }
    throw new Error(`scrapfly HTTP ${r.status}${why ? " :: " + why : ""}`);
  }
  const j = await r.json();
  const res = j?.result || {};
  return {
    status: Number(res.status_code) || 0,
    contentType: String(res.content_type || accept),
    body: typeof res.content === "string" ? res.content : "",
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOverpass() {
  let lastErr;
  for (let round = 0; round < ROUNDS; round++) {
    for (const base of OVERPASS) {
      try {
        const res = await fetch(base, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
          body: new URLSearchParams({ data: QUERY }),
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) { lastErr = new Error(`${base}: HTTP ${res.status}`); continue; }
        return await res.json();
      } catch (e) { lastErr = e; }
    }
    await sleep(2000 * (round + 1));
  }
  throw lastErr ?? new Error("all Overpass mirrors failed");
}

// A tag can be "example.com", "http://example.com/inventory?x=1", or junk.
// Reduce to a bare https origin, or null if it isn't usable as one.

// Why a host produced nothing is the whole diagnostic value of this probe, and
// until now it was thrown away: every detector returned a bare null, so 1,607
// of 1,639 hosts collapsed into a single "no feed detected" count. That made
// "no dealer here runs EDealer" and "every EDealer request 403'd" the same
// output — and the province-wide EDealer count of ZERO was believed for a day
// on the strength of it, while a working EDealer dealer sat in Lethbridge.
//
// Absence has to say what kind of absence it is.
const note = (trace, detector, msg) => { if (trace) trace.push(`${detector}: ${msg}`); };

async function trySM360(host, trace) {
  for (const section of ["new-inventory", "used-inventory"]) {
    try {
      const r = await fetch(`${host}/en/${section}/api/listing?page=1`, {
        headers: { "User-Agent": UA, Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!r.ok) { note(trace, "sm360", `${section} HTTP ${r.status}`); continue; }
      const ct = r.headers.get("content-type") || "";
      if (!/json/.test(ct)) { note(trace, "sm360", `${section} not json (${ct.split(";")[0] || "no content-type"})`); continue; }
      const d = await r.json();
      const veh = d?.vehicles || [];
      if (!veh.length) { note(trace, "sm360", `${section} 200 but 0 vehicles`); continue; }
      // Only count it as usable if the VIN is actually present — a feed without
      // serialNo is not the dataset we came for.
      const withVin = veh.filter((v) => typeof v?.serialNo === "string" && /^[A-HJ-NPR-Z0-9]{17}$/.test(v.serialNo.trim().toUpperCase())).length;
      return { platform: "sm360", section, page1: veh.length, withVin, pages: Number(d?.pagination?.numberOfPages) || 1 };
    } catch (e) { note(trace, "sm360", `${section} ${e.name || e.message}`); }
  }
  return null;
}

async function tryConvertus(host, trace) {
  for (const path of ["/vehicles/new/", "/en/new-inventory/", "/"]) {
    try {
      const r = await fetch(`${host}${path}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (!r.ok) { note(trace, "convertus", `${path} HTTP ${r.status}`); continue; }
      const html = await r.text();
      if (!/convertus-vms|convertus\.rocks/i.test(html)) { note(trace, "convertus", `${path} 200, no convertus marker (${Math.round(html.length / 1024)}KB)`); continue; }
      // The dealer's cp is the page's inventoryId. Confirmed live against three
      // Alberta dealers 2026-08-11 — the older bare-`cp` pattern matched nothing
      // on any of them, which is why earlier probes all reported cp=?.
      const m = html.match(/inventory[_-]?id["']?\s*[:=]\s*["']?(\d{2,8})/i)
             || html.match(/[?&]cp=(\d{2,8})/)
             || html.match(/["']cp["']\s*:\s*["']?(\d{2,8})/)
             || html.match(/dealer[_-]?id["']?\s*[:=]\s*["']?(\d{2,8})/i);
      return { platform: "convertus", cp: m ? m[1] : null };
    } catch (e) { note(trace, "convertus", `${path} ${e.name || e.message}`); }
  }
  return null;
}

// EDealer: the section's whole inventory sits in one `vehicleArray = {...}`
// object on the /new/ page itself (confirmed live 2026-08-18, Rainbow Ford)
// -- reuses the SAME parser the crawler runs, so "detected" and "crawlable"
// can never drift apart the way a hand-duplicated detection regex would.
// EDealer hides behind whatever path the dealer's theme uses. SM360 and
// Convertus detection both try several; this tried exactly one, /new/, and
// that single assumption is half of why the probe reported ZERO EDealer sites
// across 1,639 Alberta hosts.
//
// Ken Sargent GMC in Grande Prairie is an EDealer site (applications.edealer.ca
// in its own privacy link) serving stock at /inventory/ — reachable, readable,
// and invisible to a probe that only ever asked for /new/. The other half was
// the datacenter IP block, which is a separate problem; this one is ours and
// costs four extra requests on hosts that were going to answer nothing anyway.
//
// EDEALER_PATHS is ordered cheapest-first: /new/ still wins on the theme we
// already support, so the common case costs exactly what it did before.
const EDEALER_PATHS = ["/new/", "/inventory/", "/new-inventory/", "/inventory/new/", "/vehicles/"];

async function tryEdealer(host, trace) {
  let sawEdealer = false;
  for (const path of EDEALER_PATHS) {
    try {
      const r = await fetch(`${host}${path}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (!r.ok) { note(trace, "edealer", `${path} HTTP ${r.status}`); continue; }
      const html = await r.text();
      const rows = extractEdealerVehicles(html);
      if (rows.length) return { platform: "edealer", section: path, page1: rows.length };

      // Three different findings, and they used to look identical:
      //   - a vehicleArray we could not read  -> OUR parser is broken
      //   - an EDealer page with no array     -> a NEWER theme we cannot read yet
      //   - neither                           -> simply not an EDealer site
      const hasArray = /vehicleArray\s*=\s*\{/.test(html);
      const isEdealer = /edealer/i.test(html);
      if (isEdealer) sawEdealer = true;
      const kb = Math.round(html.length / 1024);
      note(trace, "edealer", hasArray
        ? `${path} 200 WITH vehicleArray but the parser returned 0 rows — PARSER BUG (${kb}KB)`
        : isEdealer
          ? `${path} 200, EDealer markers but NO vehicleArray — newer theme, unsupported (${kb}KB)`
          : `${path} 200, not EDealer (${kb}KB)`);
    } catch (e) { note(trace, "edealer", `${path} ${e.name || e.message}`); }
  }
  if (sawEdealer) note(trace, "edealer", "host IS EDealer on some path but no page yielded vehicles");
  return null;
}


// jsonld_itemlist: vehicles live on model/category pages, not the /new/ index
// itself (confirmed live 2026-08-18, Wolfe Chevrolet + Village Honda both
// link category pages from /new/ with none of the vehicles inline there) --
// so this probe follows ONE category link to confirm the platform actually
// yields vehicles, not just that an ItemList of SOME kind exists somewhere.
async function tryJsonLdItemList(host, trace) {
  try {
    const r = await fetch(`${host}/new/`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!r.ok) { note(trace, "jsonld", `/new/ HTTP ${r.status}`); return null; }
    const indexHtml = await r.text();
    // Some themes put vehicles directly on the index page too -- check before
    // spending a second request.
    const direct = extractJsonLdVehicles(indexHtml, "new");
    if (direct.length) return { platform: "jsonld_itemlist", page1: direct.length };
    const categories = discoverCategoryPages(indexHtml, host);
    if (!categories.length) { note(trace, "jsonld", `/new/ 200, no JSON-LD vehicles and no category links (${Math.round(indexHtml.length / 1024)}KB)`); return null; }
    const r2 = await fetch(categories[0], { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!r2.ok) { note(trace, "jsonld", `category page HTTP ${r2.status}`); return null; }
    const rows = extractJsonLdVehicles(await r2.text(), "new");
    if (!rows.length) { note(trace, "jsonld", "category page 200 but no JSON-LD vehicles"); return null; }
    return { platform: "jsonld_itemlist", page1: rows.length };
  } catch (e) { note(trace, "jsonld", `/new/ ${e.name || e.message}`); return null; }
}

// Shape written to --out, both mid-run and at the end. `probed` makes a partial
// file self-describing: you can see it covered 300 of 800 rather than guessing
// whether 2 hits means a thin province or a killed job.
function snapshot(results) {
  const misses = results.filter((r) => !r.platform);
  const missBy = {};
  for (const m of misses) missBy[m.miss || "unclassified"] = (missBy[m.miss || "unclassified"] || 0) + 1;
  return {
    generatedAt: new Date().toISOString().slice(0, 10),
    probed: results.length,
    sm360: results.filter((r) => r.platform === "sm360"),
    convertus: results.filter((r) => r.platform === "convertus"),
    jsonld_itemlist: results.filter((r) => r.platform === "jsonld_itemlist"),
    edealer: results.filter((r) => r.platform === "edealer"),
    // The misses used to be dropped from the artifact entirely, so a run that
    // was refused by every host and a run that genuinely found nothing wrote
    // an identical file. They are the larger half of the result and now ship
    // with the reason attached.
    missSummary: missBy,
    misses: misses.map((m) => ({ host: m.host, city: m.city, name: m.name, miss: m.miss, trace: m.trace })),
  };
}

// Classifies a miss so the totals can be read honestly. "No dealer here runs
// EDealer" and "every request was refused" are different facts, and a bare
// count cannot tell them apart.
function classifyMiss(trace) {
  const t = trace.join(" | ");
  if (!trace.length) return "no-trace";
  // Order matters, and it is evidence-first. A host that returned a real 200
  // to ANY probe answered us — a 404 on one guessed path is an ordinary
  // negative, not a refusal, and counting it as "blocked" overstates how much
  // of the province is stonewalling us. Only 401/403/429 are refusals.
  if (/PARSER BUG/.test(t)) return "parser-bug";
  if (/200/.test(t)) return "responded-no-feed";
  if (/HTTP (401|403|429)/.test(t)) return "blocked";
  if (/HTTP 5\d\d/.test(t)) return "server-error";
  if (/TimeoutError|AbortError/.test(t)) return "timeout";
  if (/TypeError|ENOTFOUND|ECONNREFUSED|CertificateError|fetch failed/.test(t)) return "unreachable";
  if (/HTTP 404/.test(t)) return "responded-no-feed";   // answered, just not there
  return "responded-no-feed";
}

// One residential fetch of /new/, then every HTML detector reads that same
// page. Keeps the billed call count at one for the common case and reuses the
// SAME parsers the crawler runs, so "rescued" and "crawlable" cannot drift.
async function rescueHost(cand) {
  const trace = [];
  try {
    const page = await scrapflyGet(`${cand.host}/new/`);
    if (page.status < 200 || page.status >= 300) {
      note(trace, "rescue", `/new/ HTTP ${page.status} even via residential IP`);
      return { ...cand, platform: null, miss: "blocked-everywhere", rescued: true, trace };
    }
    const html = page.body;
    const ed = extractEdealerVehicles(html);
    if (ed.length) return { ...cand, platform: "edealer", page1: ed.length, rescued: true };
    const jl = extractJsonLdVehicles(html, "new");
    if (jl.length) return { ...cand, platform: "jsonld_itemlist", page1: jl.length, rescued: true };
    if (/convertus-vms|convertus\.rocks/i.test(html)) {
      const m = html.match(/inventory[_-]?id["']?\s*[:=]\s*["']?(\d{2,8})/i) || html.match(/[?&]cp=(\d{2,8})/);
      return { ...cand, platform: "convertus", cp: m ? m[1] : null, rescued: true };
    }
    // Only now is a second billed call worth it.
    try {
      const api = await scrapflyGet(`${cand.host}/en/new-inventory/api/listing?page=1`, "application/json");
      if (api.status >= 200 && api.status < 300) {
        const d = JSON.parse(api.body);
        const veh = d?.vehicles || [];
        if (veh.length) {
          const withVin = veh.filter((v) => typeof v?.serialNo === "string" && /^[A-HJ-NPR-Z0-9]{17}$/.test(v.serialNo.trim().toUpperCase())).length;
          return { ...cand, platform: "sm360", section: "new-inventory", page1: veh.length, withVin, pages: Number(d?.pagination?.numberOfPages) || 1, rescued: true };
        }
      }
      note(trace, "rescue", `sm360 api HTTP ${api.status}`);
    } catch (e) { note(trace, "rescue", `sm360 api ${e.message}`); }
    note(trace, "rescue", `/new/ 200 via residential IP, no feed markers (${Math.round(html.length / 1024)}KB)`);
    return { ...cand, platform: null, miss: "responded-no-feed", rescued: true, trace };
  } catch (e) {
    note(trace, "rescue", e.message);
    return { ...cand, platform: null, miss: "rescue-failed", rescued: true, trace };
  }
}

async function probe(cand) {
  const trace = [];
  try {
    const sm = await trySM360(cand.host, trace);
    if (sm) return { ...cand, ...sm };
    const cv = await tryConvertus(cand.host, trace);
    if (cv) return { ...cand, ...cv };
    const jl = await tryJsonLdItemList(cand.host, trace);
    if (jl) return { ...cand, ...jl };
    const ed = await tryEdealer(cand.host, trace);
    if (ed) return { ...cand, ...ed };
    return { ...cand, platform: null, miss: classifyMiss(trace), trace };
  } catch (e) {
    return { ...cand, platform: null, miss: "probe-threw", error: e.message, trace };
  }
}

// Every row in amvic_licensees with a website, paginated (PostgREST caps a
// response at 1000, and 21,866 licensees means a single unpaginated read
// silently truncates to the first page and reads like a real, small result —
// see the MUST-paginate note below). Shared by candidatesFromAmvic() (the
// probe candidate list) and the write-time license cross-check, so there is
// exactly one place that reads this table, not two copies that could drift.
async function fetchAmvicLicenseesWithWebsite(supabase) {
  const all = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    // ORDER BY is not decoration here. A paginated read with no ordering has
    // NO guaranteed row order, so successive .range() windows can overlap and
    // leave gaps — the candidate list silently loses licensees and gains
    // duplicates, and "1,639 distinct hosts" stops being a number you can
    // trust or reproduce. It also makes a capped run unresumable: --skip can
    // only mean something if run N and run N+1 agree on the order.
    const { data, error } = await supabase
      .from("amvic_licensees").select("id,name,trade_name,city,website,facility_status,facility_type")
      .not("website", "is", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error("could not read amvic_licensees:", error.message); process.exit(1); }
    all.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return all;
}

// The regulator's own roster of licensed Alberta dealers.
//
// facility_status holds AMVIC's OWN string, verbatim — "Issued" is the valid
// one, not "Active". Filtering on /active/i (as this did first) matches nothing
// and returns an empty candidate list that looks exactly like "no licensed
// dealer has a website." Allowlist the good status; count and report the rest
// rather than dropping them silently.
//
// Only ~54% of records are Issued. Note that a lapsed licensee can still be
// running a live website (the migration for this table found 65 of them) — we
// do not crawl those for inventory, but the mismatch is itself worth surfacing
// to a buyer somewhere else.
async function candidatesFromAmvic() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error("--source amvic needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(url, key);
  // MUST paginate — see fetchAmvicLicenseesWithWebsite.
  const all = await fetchAmvicLicenseesWithWebsite(supabase);
  const rows = all.filter((r) => /issued/i.test(r.facility_status || ""));
  const byStatus = new Map();
  for (const r of all) { const k = r.facility_status || "(none)"; byStatus.set(k, (byStatus.get(k) || 0) + 1); }
  console.log(`${all.length} AMVIC licensees with a website. Status breakdown:`);
  for (const [k, n] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(4)}  ${k}`);
  console.log(`Probing the ${rows.length} with an Issued licence.`);
  if (!rows.length) { console.error("No Issued licensees found — check facility_status values before assuming there are none."); process.exit(1); }
  // AMVIC licenses salespeople and body shops too, not just dealerships, so
  // most of this list will never have an inventory feed. Print the type mix so
  // a later run can filter to the types that matter instead of spending probe
  // budget on autobody shops.
  const byType = new Map();
  for (const r of rows) { const k = r.facility_type || "(none)"; byType.set(k, (byType.get(k) || 0) + 1); }
  console.log("Facility types among Issued licensees with a website:");
  for (const [k, n] of [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`   ${String(n).padStart(4)}  ${k}`);
  return { rows: rows.map((r) => ({ website: r.website, name: r.trade_name || r.name, city: r.city })), total: all.length };
}

async function candidatesFromOsm() {
  console.log("Fetching Alberta shop=car from OpenStreetMap...");
  const osm = await fetchOverpass();
  const elements = osm?.elements || [];
  const rows = elements.map((el) => {
    const t = el?.tags || {};
    return { website: t.website || t["contact:website"] || t.url, name: t.name || null, city: t["addr:city"] || null };
  });
  console.log(`${elements.length} OSM dealers.`);
  return { rows, total: elements.length };
}

async function main() {
  const { rows } = SOURCE === "amvic" ? await candidatesFromAmvic() : await candidatesFromOsm();

  const byHost = new Map();
  for (const r of rows) {
    const host = toOrigin(r.website);
    if (!host || byHost.has(host)) continue;
    byHost.set(host, { host, name: r.name || null, city: r.city || null });
  }
  let candidates = [...byHost.values()];
  console.log(`${candidates.length} distinct usable hosts (source: ${SOURCE}).`);
  if (SKIP) {
    const before = candidates.length;
    candidates = candidates.slice(SKIP);
    console.log(`--skip ${SKIP}: resuming at host ${SKIP + 1} of ${before} (${candidates.length} left to probe).`);
    if (!candidates.length) { console.log("nothing left after the skip — the list is shorter than you think."); return; }
  }
  if (LIMIT) { candidates = candidates.slice(0, LIMIT); console.log(`--limit ${LIMIT}: probing a sample.`); }

  // Results are flushed to disk as we go. The first full run took 16 minutes for
  // 198 hosts and the file was only written at the very end — a job timeout
  // would have killed it with nothing to show and no way to tell how far it
  // got. Partial results beat no results, always.
  const results = [];
  const flush = () => { if (OUT) { try { writeFileSync(OUT, JSON.stringify(snapshot(results), null, 2)); } catch { /* keep probing */ } } };
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    results.push(...await Promise.all(batch.map(probe)));
    const done = Math.min(i + CONCURRENCY, candidates.length);
    process.stdout.write(`\r  probed ${done}/${candidates.length}`);
    if (done % 100 < CONCURRENCY) flush();
    if (i + CONCURRENCY < candidates.length) await sleep(BATCH_PAUSE_MS);
  }
  console.log("");
  flush();

  if (RESCUE) {
    const stuck = results.filter((r) => !r.platform && RESCUABLE.has(r.miss));
    if (!SCRAPFLY_KEY) {
      console.warn(`\n--rescue asked for but SCRAPFLY_API_KEY is not set — ${stuck.length} unreachable host(s) left unrescued.`);
    } else if (!stuck.length) {
      console.log("\n--rescue: every host answered directly, nothing to retry.");
    } else {
      console.log(`\n── rescue pass: ${stuck.length} host(s) that never answered, retried on a Canadian residential IP ──`);
      const byHost = new Map(results.map((r, i) => [r.host, i]));
      let done = 0, recovered = 0;
      for (let i = 0; i < stuck.length; i += SCRAPFLY_CONCURRENCY) {
        const batch = stuck.slice(i, i + SCRAPFLY_CONCURRENCY);
        const out = await Promise.all(batch.map(rescueHost));
        for (const r of out) {
          results[byHost.get(r.host)] = r;
          if (r.platform) { recovered++; console.log(`   RECOVERED  ${r.platform.padEnd(16)} ${r.host}  ${r.city ?? ""}`); }
        }
        done += batch.length;
        process.stdout.write(`\r  rescued ${done}/${stuck.length}  (${recovered} feeds recovered)`);
        flush();
      }
      console.log("");
      console.log(`\n  ${recovered} feed(s) recovered that a datacenter IP could not see.`);
    }
  }

  const sm360 = results.filter((r) => r.platform === "sm360");
  const convertus = results.filter((r) => r.platform === "convertus");
  const jsonldList = results.filter((r) => r.platform === "jsonld_itemlist");
  const edealerList = results.filter((r) => r.platform === "edealer");

  console.log(`\n── SM360 (crawlable today): ${sm360.length} ──`);
  for (const r of sm360.sort((a, b) => (b.pages || 0) - (a.pages || 0))) {
    console.log(`  ${r.host.padEnd(42)} ${String(r.withVin).padStart(2)}/${r.page1} VINs on p1 · ~${r.pages} pages · ${r.name ?? ""}`);
  }
  console.log(`\n── Convertus (crawlable when cp resolves): ${convertus.length} ──`);
  for (const r of convertus) console.log(`  ${r.host.padEnd(42)} cp=${r.cp ?? "NOT FOUND — not seedable"} · ${r.name ?? ""}`);
  console.log(`\n── JSON-LD ItemList (crawlable today): ${jsonldList.length} ──`);
  for (const r of jsonldList) console.log(`  ${r.host.padEnd(42)} ${r.page1} vehicles on first probed page · ${r.name ?? ""}`);
  console.log(`\n── EDealer (crawlable today): ${edealerList.length} ──`);
  for (const r of edealerList) console.log(`  ${r.host.padEnd(42)} ${r.page1} vehicles on /new/ · ${r.name ?? ""}`);
  const misses = results.filter((r) => !r.platform);
  console.log(`\n── no feed detected: ${misses.length} ──`);
  // The point of this block: a zero in the lists above is only meaningful next
  // to these numbers. A province-wide "EDealer: 0" means something completely
  // different when 300 hosts refused the request than when they all answered.
  const missBy = {};
  for (const m of misses) missBy[m.miss || "unclassified"] = (missBy[m.miss || "unclassified"] || 0) + 1;
  for (const [k, n] of Object.entries(missBy).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(5)}  ${k}`);
  }
  const parserBugs = misses.filter((m) => m.miss === "parser-bug");
  if (parserBugs.length) {
    console.log(`\n!! ${parserBugs.length} host(s) served a feed we RECOGNISED but could not parse — this is our bug, not theirs:`);
    for (const p of parserBugs) console.log(`     ${p.host.padEnd(42)} ${p.city ?? ""}  ${(p.trace || []).find((t) => /PARSER BUG/.test(t)) || ""}`);
  }
  const reached = results.length - misses.filter((m) => ["blocked", "unreachable", "timeout", "server-error"].includes(m.miss)).length;
  console.log(`\nCoverage of this run: ${reached}/${results.length} hosts actually answered. A platform count is only`);
  console.log(`as good as that number — the rest were refused, unreachable or timed out.`);

  const estimated = sm360.reduce((n, r) => n + (r.pages || 1) * (r.page1 || 24), 0);
  console.log(`\nEstimated units reachable from SM360 dealers alone: ~${estimated.toLocaleString()}`);

  if (OUT) { flush(); console.log(`\nSaved -> ${OUT}`); }

  // THE ANSWER TO "CAN LOTCHECK RUN ALL OF THEM", printed whether or not this
  // run writes anything, and the verdicts written back so the LIVE SCAN gets the
  // same knowledge rather than rediscovering each wall on a buyer's time.
  reportReadCapability(results);
  await recordReachability(results);

  if (!WRITE) { console.log("\n(no --write: nothing added to dealer_source)"); return; }

  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error("--write needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(url, key);
  // Only hosts that returned something the crawler can actually use get seeded:
  // SM360 must have produced VINs, Convertus must have yielded a cp, and
  // jsonld_itemlist/edealer must have yielded at least one real vehicle on
  // probe — without that a seeded host is unaddressable or empty, either way
  // a nightly no-op that looks like coverage.
  let seed = [
    ...sm360.filter((r) => r.withVin > 0)
      .map((r) => ({ host: r.host, platform: "sm360", platform_id: null, name: r.name, city: r.city, province: "AB", sections: ["new-inventory", "used-inventory"] })),
    ...convertus.filter((r) => r.cp)
      .map((r) => ({ host: r.host, platform: "convertus", platform_id: r.cp, name: r.name, city: r.city, province: "AB", sections: ["new", "used"] })),
    ...jsonldList.filter((r) => r.page1 > 0)
      .map((r) => ({ host: r.host, platform: "jsonld_itemlist", platform_id: null, name: r.name, city: r.city, province: "AB", sections: ["new", "used"] })),
    ...edealerList.filter((r) => r.page1 > 0)
      .map((r) => ({ host: r.host, platform: "edealer", platform_id: null, name: r.name, city: r.city, province: "AB", sections: ["new", "used"] })),
  ];
  if (!seed.length) { console.log("nothing to seed"); return; }

  // LICENSE GATE — non-negotiable, applies regardless of --source. Alberta law
  // (the Fair Trading Act's AVSA rules, AMVIC's enabling regulation) requires a
  // dealer to hold an Issued AMVIC facility license to sell vehicles at all, so
  // a host we have no confirmed Issued license for is not a dealer we should be
  // pointing a standing crawl at — feed-detection finding a working feed is not
  // the same question as "is this business licensed to operate."
  //
  // --source osm has NO license signal at all (OpenStreetMap tags carry no
  // regulatory status), so without this every OSM-found host would seed purely
  // on "a feed answered." --source amvic already pre-filtered to Issued before
  // probing, but this re-checks against a FRESH read rather than trusting the
  // in-memory list from earlier in the same run — a license that lapsed in the
  // minutes between probing and writing must not slip through on a stale copy.
  console.log("\nCross-checking every seed candidate against a fresh amvic_licensees read (Issued only)...");
  const licensees = await fetchAmvicLicenseesWithWebsite(supabase);
  const issuedHosts = new Set(
    licensees.filter((r) => /issued/i.test(r.facility_status || ""))
      .map((r) => toOrigin(r.website)).filter(Boolean)
  );
  const beforeGate = seed.length;
  const rejected = seed.filter((s) => !issuedHosts.has(s.host));
  seed = seed.filter((s) => issuedHosts.has(s.host));
  if (rejected.length) {
    console.log(`  ${rejected.length} of ${beforeGate} candidate(s) REFUSED — no confirmed Issued AMVIC license for this host:`);
    for (const r of rejected.slice(0, 20)) console.log(`    ${r.host}  (${r.platform}) ${r.name ?? ""}`);
    if (rejected.length > 20) console.log(`    … and ${rejected.length - 20} more`);
  }
  if (!seed.length) { console.log("\nnothing left to seed after the license gate"); return; }

  const { error } = await supabase.from("dealer_source").upsert(seed, { onConflict: "host", ignoreDuplicates: true });
  if (error) { console.error("seed failed:", error.message); process.exit(1); }
  console.log(`\nSeeded ${seed.length} confirmed, AMVIC-Issued dealers into dealer_source (of ${beforeGate} platform-confirmed candidates).`);
}

// ---------------------------------------------------------------------------
// CAN LOTCHECK READ ALBERTA? — the answer as a number, and written back.
//
// Vic, 2026-08-31: "i need to to know that every single car website all 1639
// can by ran by lotcheck without issues". That is a measurement, not a promise,
// and this probe already collects everything it needs — it just threw the
// reachability half away, keeping only the hosts that turned out to have a
// crawlable feed.
//
// EVERY probed host now writes its verdict into the catalogue, and the run
// prints the coverage. Two things come of that. Vic gets a number. And the LIVE
// SCAN gets it too: chooseFetchPlan reads exactly these columns, so a host this
// probe found refuses a plain GET is one the next buyer's scan sends straight
// to the anti-bot render instead of rediscovering the wall on their time.
//
// "Read" here means the page ANSWERED with real content, by whichever route —
// which is the question that decides whether a report is possible. Whether the
// host also has a crawlable inventory feed is the separate, narrower question
// this probe was originally written for, and it is still reported separately.
const READ_DIRECT = new Set(["responded-no-feed", "parser-bug"]);   // it answered us
const NOT_A_WALL  = new Set(["timeout", "unreachable", "server-error", "no-trace"]);

async function recordReachability(results) {
  if (!WRITE) { console.log("\n(no --write: reachability not written to the catalogue)"); return; }
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(url, key);
  const now = new Date().toISOString();

  // Only hosts the catalogue already holds. Creating rows here would route
  // around the AMVIC licence gate that dealer_source's roster rests on -- the
  // loader and the observe RPC both apply it, and this must not be the third
  // way in. A host we probed but never catalogued is simply not ours to file.
  const known = new Map();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("dealer_source").select("id,host")
      .order("id", { ascending: true }).range(from, from + 999);
    if (error) { console.error("could not read dealer_source:", error.message); return; }
    for (const r of data || []) known.set(r.host.toLowerCase().replace(/^https:\/\/www\./, "https://"), r.host);
    if (!data || data.length < 1000) break;
  }

  let wrote = 0, skipped = 0;
  for (const r of results) {
    const host = known.get(String(r.host).toLowerCase().replace(/^https:\/\/www\./, "https://"));
    if (!host) { skipped++; continue; }
    const readDirect = !!r.platform && !r.rescued ? true : READ_DIRECT.has(r.miss);
    const walled = r.miss === "blocked";
    const patch = {
      last_direct_status: readDirect ? "ok" : walled ? "refused" : (r.miss || "network"),
      ...(readDirect ? { last_direct_ok_at: now, fetch_strategy: "direct" } : {}),
      // A timeout or a DNS failure is a fact about the moment, not about
      // whether this host takes datacenter traffic -- so it is recorded and
      // NOT allowed to send every future scan down the paid path.
      ...(walled ? { last_direct_fail_at: now, fetch_strategy: "asp" } : {}),
      ...(r.rescued ? { last_asp_ok_at: now } : {}),
      ...(r.platform ? { observed_platform: r.platform } : {}),
    };
    const { error } = await supabase.from("dealer_source").update(patch).eq("host", host);
    if (!error) wrote++;
  }
  console.log(`\nCatalogue: reachability written for ${wrote} host(s)${skipped ? `, ${skipped} probed host(s) are not catalogued` : ""}.`);
}

function reportReadCapability(results) {
  const n = results.length;
  const direct = results.filter((r) => (r.platform && !r.rescued) || READ_DIRECT.has(r.miss)).length;
  const viaAsp = results.filter((r) => r.rescued).length;
  const blocked = results.filter((r) => r.miss === "blocked" && !r.rescued).length;
  const flaky = results.filter((r) => NOT_A_WALL.has(r.miss) && !r.rescued).length;
  const pct = (x) => n ? `${((x / n) * 100).toFixed(1)}%` : "-";
  console.log("\n" + "=".repeat(64));
  console.log("CAN LOTCHECK READ ALBERTA?");
  console.log("=".repeat(64));
  console.log(`  hosts probed                 ${String(n).padStart(5)}`);
  console.log(`  answered a plain GET         ${String(direct).padStart(5)}   ${pct(direct)}`);
  console.log(`  answered only via anti-bot   ${String(viaAsp).padStart(5)}   ${pct(viaAsp)}`);
  console.log(`  refused us outright          ${String(blocked).padStart(5)}   ${pct(blocked)}`);
  console.log(`  timed out / unreachable      ${String(flaky).padStart(5)}   ${pct(flaky)}`);
  console.log(`  ${"-".repeat(60)}`);
  console.log(`  READABLE BY LOTCHECK         ${String(direct + viaAsp).padStart(5)}   ${pct(direct + viaAsp)}`);
  console.log("=".repeat(64));
  // A number with no caveat is a claim. Say what this run could not settle.
  if (flaky) console.log(`  ${flaky} host(s) neither answered nor refused -- a timeout is not a verdict, re-probe those before counting them out.`);
  if (!results.some((r) => r.rescued)) console.log("  (no anti-bot pass in this run -- re-run with --rescue for the true readable figure)");
}

await main();
