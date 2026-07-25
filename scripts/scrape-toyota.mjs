// ── Toyota Canada MSRP + finance-rate scraper (pilot) ──────────────────────
//
// Fills LotCheck's `msrp_catalog` and `finance_rate_catalog` tables from
// Toyota Canada's OWN build-&-price data endpoints -- the same JSON the
// public toyota.ca configurator reads. Nothing here is guessed or typed from
// memory: every number carries the model code / trim it came from and the date
// it was fetched, exactly matching the "verified values only" design of the
// analyze-quote edge function.
//
// Data sources (all public GETs on toyota.ca):
//   1. buildnprice.categories.json  -> the full series lineup (A-Z), fuel tag
//   2. price_calculation/toyota/prices.json -> per-trim MSRP + advertised rate
//   3. graphql BnP-get-models       -> model code -> trim name ("XSE" etc.)
//
// Usage:
//   node scripts/scrape-toyota.mjs                 # all series, dry-run if no key
//   node scripts/scrape-toyota.mjs --series=PHV    # one series (pilot)
//   node scripts/scrape-toyota.mjs --year=2027     # pin a model year
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/scrape-toyota.mjs
//
// Without SUPABASE_SERVICE_ROLE_KEY it does NOT touch the database -- it writes
// the normalized rows it WOULD insert to scripts/out/ so you can eyeball them.
// With the key it replaces all make='Toyota' rows in both tables (a clean
// scheduled refresh: delete-then-insert, so no stale trims linger).

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MAKE = "Toyota";
const BRAND = "TOY";
const PROVINCE = "ON"; // MSRP is national; ON is a canonical province for the rate
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const BASE = "https://www.toyota.ca";

// Toyota's build&price fuel tags -> the fuelType vocabulary analyze-quote uses.
const FUEL_MAP = {
  "Gas": "Gas",
  "Hybrid": "Hybrid",
  "Hybrid Available": "Hybrid",
  "Plug-in Hybrid": "PHEV",
  "Battery Electric": "BEV",
  "Fuel Cell Electric": "FCEV",
};

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  })
);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// The categories endpoint lives under any series page but returns the whole
// lineup. Use the generic build-price container.
async function fetchSeriesList() {
  const url = `${BASE}/content/toyota/en/build-price/jcr:content/root/container/buildnprice.categories.json`;
  let data;
  try {
    data = await getJson(url);
  } catch {
    // Fallback: the per-series path also returns the full list.
    data = await getJson(`${BASE}/content/toyota/en/build-price/prius-plug-in-hybrid/jcr:content/root/container/buildnprice.categories.json`);
  }
  const all = (data.categories || []).find(c => c.id === "categories:all") || data.categories?.[0];
  const items = (all?.seriesItems || []).filter(s => !s.comingSoon && s.seriesCode);
  // De-dupe by seriesCode (a series can appear in several category tabs).
  const seen = new Set();
  return items.filter(s => (seen.has(s.seriesCode) ? false : seen.add(s.seriesCode)));
}

// prices.json is keyed [province][year][series][modelCode] -> [{...packages}].
async function fetchPrices(seriesCode, year) {
  const url = `${BASE}/bin/api/price_calculation/toyota/prices.json?brand=${BRAND}&series=${seriesCode}&year=${year}&province=${PROVINCE}`;
  try {
    const data = await getJson(url);
    return data?.[PROVINCE]?.[year]?.[seriesCode] || null;
  } catch {
    return null;
  }
}

// modelCode ("ACABUC") -> trim/grade name ("XSE"). One graphql call per code.
const gradeCache = new Map();
async function fetchGrade(seriesCode, year, modelCode) {
  const key = `${seriesCode}-${year}-${modelCode}`;
  if (gradeCache.has(key)) return gradeCache.get(key);
  const modelPath = `/content/dam/tcidigital/vehicle-fragments/TOYOTA/${seriesCode}/${year}-${modelCode.toLowerCase()}-models`;
  const url = `${BASE}/graphql/execute.json/tcidigital/BnP-get-models%3BmodelPath%3D${encodeURIComponent(modelPath)}%3b.json`;
  let grade = null;
  try {
    const data = await getJson(url);
    grade = data?.data?.modelV2ByPath?.item?.grade || null;
  } catch { /* fall through to null */ }
  gradeCache.set(key, grade);
  return grade;
}

// Candidate model years to probe per series, newest first. Toyota lists the
// upcoming year before the calendar rolls over, so look one ahead too.
function candidateYears() {
  if (args.year) return [Number(args.year)];
  const y = new Date().getUTCFullYear();
  return [y + 1, y, y - 1];
}

async function scrape() {
  const today = new Date().toISOString().slice(0, 10);
  let series = await fetchSeriesList();
  if (args.series) series = series.filter(s => s.seriesCode === args.series);
  console.log(`Series to scrape: ${series.length}${args.series ? ` (filtered to ${args.series})` : ""}`);

  const msrpRows = [];
  const rateRows = [];
  const rateSeen = new Set(); // one manufacturer rate row per model+term

  for (const s of series) {
    const fuel = FUEL_MAP[s.tag] || null;
    let hitYear = null;
    for (const year of candidateYears()) {
      const byModel = await fetchPrices(s.seriesCode, year);
      if (!byModel || !Object.keys(byModel).length) continue;
      hitYear = year;
      for (const [modelCode, pkgs] of Object.entries(byModel)) {
        const pkg = (Array.isArray(pkgs) && (pkgs.find(p => p.basePackage) || pkgs[0])) || null;
        const msrp = pkg?.vehicleStartPrice?.amount;
        if (!msrp) continue;
        const grade = await fetchGrade(s.seriesCode, year, modelCode);
        await sleep(120); // be polite to toyota.ca
        msrpRows.push({
          year, make: MAKE, model: s.name,
          trim: grade || modelCode,
          msrp, fuel_type: fuel, fetched_at: new Date().toISOString(),
        });
        const apr = pkg?.rate?.amount;
        const term = pkg?.numberOfTerms?.amount;
        const rKey = `${s.name}|${term}`;
        if (apr != null && term && !rateSeen.has(rKey)) {
          rateSeen.add(rKey);
          rateRows.push({
            make: MAKE, model: s.name,
            apr, term_months: term, promo: false, effective_date: today,
          });
        }
      }
      break; // newest year with data wins
    }
    console.log(`  ${s.seriesCode.padEnd(4)} ${s.name}${hitYear ? ` @${hitYear}` : "  (no price data)"}`);
  }

  console.log(`\nExtracted ${msrpRows.length} MSRP rows, ${rateRows.length} rate rows.`);
  return { msrpRows, rateRows };
}

// ── Supabase write (delete-then-insert Toyota rows) ────────────────────────
async function replaceRows(table, rows) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = {
    apikey: key, Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  // Delete existing Toyota rows so a refresh never leaves stale trims behind.
  const del = await fetch(`${url}/rest/v1/${table}?make=eq.${encodeURIComponent(MAKE)}`, { method: "DELETE", headers });
  if (!del.ok && del.status !== 404) throw new Error(`DELETE ${table} -> HTTP ${del.status}: ${await del.text()}`);
  // Insert in chunks.
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const ins = await fetch(`${url}/rest/v1/${table}`, {
      method: "POST", headers: { ...headers, Prefer: "return=minimal" }, body: JSON.stringify(chunk),
    });
    if (!ins.ok) throw new Error(`INSERT ${table} -> HTTP ${ins.status}: ${await ins.text()}`);
  }
  console.log(`  ${table}: replaced with ${rows.length} rows.`);
}

async function main() {
  const { msrpRows, rateRows } = await scrape();
  const hasKey = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!hasKey) {
    const outDir = join(__dirname, "out");
    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(outDir, `toyota-${stamp}.json`);
    writeFileSync(file, JSON.stringify({ msrp_catalog: msrpRows, finance_rate_catalog: rateRows }, null, 2));
    console.log(`\nDRY RUN (no SUPABASE_SERVICE_ROLE_KEY). Rows written to:\n  ${file}`);
    console.log("\nSample MSRP rows:");
    console.table(msrpRows.slice(0, 8));
    console.log("Rate rows:");
    console.table(rateRows);
    return;
  }

  console.log("\nWriting to Supabase…");
  await replaceRows("msrp_catalog", msrpRows);
  await replaceRows("finance_rate_catalog", rateRows);
  console.log("Done.");
}

main().catch(e => { console.error(e); process.exit(1); });
