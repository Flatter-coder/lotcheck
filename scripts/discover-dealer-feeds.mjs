// Dealer feed discovery — finds which Alberta dealers publish a machine-readable
// inventory feed, and confirms it responds before anything goes in the crawl seed.
//
// WHY IT EXISTS. dealer_source must only ever contain hosts we have SEEN answer.
// A guessed hostname in that table is a silent 404 every single night: the crawl
// looks healthy, the dataset quietly has a hole, and nobody finds out. So the
// seed grows only by confirmation, never by inference.
//
// WHERE CANDIDATES COME FROM. OpenStreetMap already gives us every shop=car in
// Alberta, and the Overpass query update-alberta-dealers.mjs runs has always
// asked for `out center tags` — meaning the `website` tag has been coming back
// and being discarded. This picks it up. Free, no vendor, no new dependency.
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
//   node scripts/discover-dealer-feeds.mjs                      # probe, report, write nothing
//   node scripts/discover-dealer-feeds.mjs --out found.json     # also save the results
//   node scripts/discover-dealer-feeds.mjs --write              # upsert confirmed SM360 hosts into dealer_source
//   node scripts/discover-dealer-feeds.mjs --limit 40           # probe a sample first
import { writeFileSync } from "node:fs";

const ARG = (name, dflt = null) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : dflt; };
const WRITE = process.argv.includes("--write");
const LIMIT = Number(ARG("--limit", "0")) || 0;
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
const CONCURRENCY = 4;
const BATCH_PAUSE_MS = 500;
const PROBE_TIMEOUT_MS = 12_000;

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
function toOrigin(raw) {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s || /^(mailto:|tel:)/i.test(s)) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)) return null;
    // Social pages are not dealer sites and will never carry a feed.
    if (/facebook|instagram|twitter|x\.com|linkedin|youtube|google\./i.test(u.hostname)) return null;
    return `https://${u.hostname}`;
  } catch { return null; }
}

async function trySM360(host) {
  for (const section of ["new-inventory", "used-inventory"]) {
    try {
      const r = await fetch(`${host}/en/${section}/api/listing?page=1`, {
        headers: { "User-Agent": UA, Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!r.ok) continue;
      if (!/json/.test(r.headers.get("content-type") || "")) continue;
      const d = await r.json();
      const veh = d?.vehicles || [];
      if (!veh.length) continue;
      // Only count it as usable if the VIN is actually present — a feed without
      // serialNo is not the dataset we came for.
      const withVin = veh.filter((v) => typeof v?.serialNo === "string" && /^[A-HJ-NPR-Z0-9]{17}$/.test(v.serialNo.trim().toUpperCase())).length;
      return { platform: "sm360", section, page1: veh.length, withVin, pages: Number(d?.pagination?.numberOfPages) || 1 };
    } catch { /* try the other section */ }
  }
  return null;
}

async function tryConvertus(host) {
  for (const path of ["/vehicles/new/", "/en/new-inventory/", "/"]) {
    try {
      const r = await fetch(`${host}${path}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (!r.ok) continue;
      const html = await r.text();
      if (!/convertus-vms|convertus\.rocks/i.test(html)) continue;
      const m = html.match(/["']?cp["']?\s*[:=]\s*["']?(\d{2,6})/i);
      return { platform: "convertus", cp: m ? m[1] : null };
    } catch { /* next path */ }
  }
  return null;
}

async function probe(cand) {
  try {
    const sm = await trySM360(cand.host);
    if (sm) return { ...cand, ...sm };
    const cv = await tryConvertus(cand.host);
    if (cv) return { ...cand, ...cv };
    return { ...cand, platform: null };
  } catch (e) {
    return { ...cand, platform: null, error: e.message };
  }
}

async function main() {
  console.log("Fetching Alberta shop=car from OpenStreetMap...");
  const osm = await fetchOverpass();
  const elements = osm?.elements || [];

  const byHost = new Map();
  for (const el of elements) {
    const t = el?.tags || {};
    const host = toOrigin(t.website || t["contact:website"] || t.url);
    if (!host || byHost.has(host)) continue;
    byHost.set(host, { host, name: t.name || null, city: t["addr:city"] || null });
  }
  let candidates = [...byHost.values()];
  console.log(`${elements.length} OSM dealers, ${candidates.length} with a usable website tag.`);
  if (LIMIT) { candidates = candidates.slice(0, LIMIT); console.log(`--limit ${LIMIT}: probing a sample.`); }

  const results = [];
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    results.push(...await Promise.all(batch.map(probe)));
    process.stdout.write(`\r  probed ${Math.min(i + CONCURRENCY, candidates.length)}/${candidates.length}`);
    if (i + CONCURRENCY < candidates.length) await sleep(BATCH_PAUSE_MS);
  }
  console.log("");

  const sm360 = results.filter((r) => r.platform === "sm360");
  const convertus = results.filter((r) => r.platform === "convertus");

  console.log(`\n── SM360 (crawlable today): ${sm360.length} ──`);
  for (const r of sm360.sort((a, b) => (b.pages || 0) - (a.pages || 0))) {
    console.log(`  ${r.host.padEnd(42)} ${String(r.withVin).padStart(2)}/${r.page1} VINs on p1 · ~${r.pages} pages · ${r.name ?? ""}`);
  }
  console.log(`\n── Convertus (detected, not yet crawlable): ${convertus.length} ──`);
  for (const r of convertus) console.log(`  ${r.host.padEnd(42)} cp=${r.cp ?? "?"} · ${r.name ?? ""}`);
  console.log(`\n── no feed detected: ${results.length - sm360.length - convertus.length} ──`);

  const estimated = sm360.reduce((n, r) => n + (r.pages || 1) * (r.page1 || 24), 0);
  console.log(`\nEstimated units reachable from SM360 dealers alone: ~${estimated.toLocaleString()}`);

  if (OUT) { writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), sm360, convertus }, null, 2)); console.log(`\nSaved -> ${OUT}`); }

  if (!WRITE) { console.log("\n(no --write: nothing added to dealer_source)"); return; }

  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error("--write needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(url, key);
  // Only SM360 hosts that actually returned VINs get seeded. A confirmed feed
  // that carries no VIN is not something the crawler can use.
  const seed = sm360.filter((r) => r.withVin > 0)
    .map((r) => ({ host: r.host, platform: "sm360", name: r.name, city: r.city, province: "AB" }));
  if (!seed.length) { console.log("nothing to seed"); return; }
  const { error } = await supabase.from("dealer_source").upsert(seed, { onConflict: "host", ignoreDuplicates: true });
  if (error) { console.error("seed failed:", error.message); process.exit(1); }
  console.log(`\nSeeded ${seed.length} confirmed SM360 dealers into dealer_source.`);
}

await main();
