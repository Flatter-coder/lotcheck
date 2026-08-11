// ── Toyota Canada Inc. build-&-price platform scraper (Toyota + Lexus) ──────
//
// Toyota.ca and Lexus.ca run the SAME Adobe AEM stack ("tcidigital"), so one
// module scrapes both -- only the host, brand code, and vehicle-fragment
// folder differ. Everything comes from the brands' own public build-&-price
// JSON: verified values only, each tagged with the trim it came from and the
// date fetched, matching the analyze-quote edge function's "no guessing" rule.
//
// Endpoints (all public GETs):
//   buildnprice.categories.json            -> full series lineup + fuel tag
//   price_calculation/<brand>/prices.json  -> per-trim MSRP (vehicleStartPrice)
//   price_calculation/interest_rates.json  -> finance AND lease APR by term
//   graphql BnP-get-models                 -> model code -> trim name ("XSE")

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dedupeBy } from "./catalog-io.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const PROVINCE = "ON"; // MSRP is national; ON is canonical for rate lookups

const FUEL_MAP = {
  "Gas": "Gas", "Hybrid": "Hybrid", "Hybrid Available": "Hybrid",
  "Plug-in Hybrid": "PHEV", "Battery Electric": "BEV", "Fuel Cell Electric": "FCEV",
};

// The series `tag` is set at the line level, so a multi-powertrain line like
// Lexus ES (gas + hybrid + electric variants) tags every entry "Hybrid
// Available" even for the "ES All-Electric" series. When the series NAME is
// explicit about the powertrain, trust it over the line-level tag.
function inferFuel(name, tag) {
  const n = (name || "").toLowerCase();
  if (/plug-?in/.test(n)) return "PHEV";
  if (/all-electric|battery electric|\bev\b/.test(n)) return "BEV";
  if (/fuel cell/.test(n)) return "FCEV";
  return FUEL_MAP[tag] || null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchSeriesList(host, seriesPageSlug) {
  const paths = [
    `/jcr:content/root/container/buildnprice.categories.json`,
  ];
  for (const base of [`/build-price`, `/en/build-price`]) {
    for (const p of paths) {
      try {
        const data = await getJson(`${host}/content${base.replace("/build-price", "")}/build-price${p}`);
        const all = (data.categories || []).find(c => c.id === "categories:all") || data.categories?.[0];
        if (all?.seriesItems?.length) {
          const seen = new Set();
          return all.seriesItems.filter(s => !s.comingSoon && s.seriesCode && !seen.has(s.seriesCode) && seen.add(s.seriesCode));
        }
      } catch { /* try next */ }
    }
  }
  // Fallback: a known series page always returns the full list.
  const data = await getJson(`${host}/content/${host.includes("lexus") ? "lexus" : "toyota"}/en/build-price/${seriesPageSlug}/jcr:content/root/container/buildnprice.categories.json`);
  const all = (data.categories || []).find(c => c.id === "categories:all") || data.categories?.[0];
  const seen = new Set();
  return (all?.seriesItems || []).filter(s => !s.comingSoon && s.seriesCode && !seen.has(s.seriesCode) && seen.add(s.seriesCode));
}

async function fetchPrices(host, brand, seriesCode, year) {
  const brandPath = brand === "LEX" ? "lexus" : "toyota";
  const url = `${host}/bin/api/price_calculation/${brandPath}/prices.json?brand=${brand}&series=${seriesCode}&year=${year}&province=${PROVINCE}`;
  try {
    const data = await getJson(url);
    return data?.[PROVINCE]?.[year]?.[seriesCode] || null;
  } catch { return null; }
}

// interest_rates.json -> { finance: {term: apr}, lease: {term: {apr, km}} }.
// Rates are advertised at the series level, so the first model/package wins.
async function fetchRates(host, brand, seriesCode, year) {
  const url = `${host}/bin/api/price_calculation/interest_rates.json?brand=${brand}&series=${seriesCode}&year=${year}&province=${PROVINCE}`;
  let data;
  try { data = await getJson(url); } catch { return null; }
  const byModel = data?.[seriesCode]?.[year];
  if (!byModel) return null;
  for (const modelCode of Object.keys(byModel)) {
    const byPkg = byModel[modelCode];
    for (const pkg of Object.keys(byPkg)) {
      const prov = byPkg[pkg]?.[PROVINCE];
      if (!prov) continue;
      const out = { finance: {}, lease: {} };
      for (const [term, r] of Object.entries(prov.finance || {})) {
        if (r?.annualPercentageRate != null) out.finance[term] = { apr: r.annualPercentageRate, through: r.effectiveThroughDate || null };
      }
      for (const [term, r] of Object.entries(prov.lease || {})) {
        if (r?.annualPercentageRate != null) out.lease[term] = { apr: r.annualPercentageRate, km: r.annualAllowDistanceMeasureValue || null, through: r.effectiveThroughDate || null };
      }
      if (Object.keys(out.finance).length || Object.keys(out.lease).length) return out;
    }
  }
  return null;
}

const gradeCache = new Map();
async function fetchGrade(host, brandFolder, seriesCode, year, modelCode) {
  const key = `${host}-${seriesCode}-${year}-${modelCode}`;
  if (gradeCache.has(key)) return gradeCache.get(key);
  const modelPath = `/content/dam/tcidigital/vehicle-fragments/${brandFolder}/${seriesCode}/${year}-${modelCode.toLowerCase()}-models`;
  const url = `${host}/graphql/execute.json/tcidigital/BnP-get-models%3BmodelPath%3D${encodeURIComponent(modelPath)}%3b.json`;
  let grade = null;
  try { grade = (await getJson(url))?.data?.modelV2ByPath?.item?.grade || null; } catch { /* null */ }
  gradeCache.set(key, grade);
  return grade;
}

function candidateYears(pinYear) {
  if (pinYear) return [Number(pinYear)];
  const y = new Date().getUTCFullYear();
  return [y + 1, y, y - 1];
}

export async function scrapeBrand({ host, brand, brandFolder, makeName, seriesPageSlug, filterSeries, pinYear }) {
  const today = new Date().toISOString().slice(0, 10);
  let series = await fetchSeriesList(host, seriesPageSlug);
  if (filterSeries) series = series.filter(s => s.seriesCode === filterSeries);
  console.log(`[${makeName}] series to scrape: ${series.length}${filterSeries ? ` (filtered to ${filterSeries})` : ""}`);

  const msrpRows = [], financeRows = [], leaseRows = [];
  const skipped = { noGrade: 0, fractional: 0 };

  for (const s of series) {
    const fuel = inferFuel(s.name, s.tag);
    let hitYear = null;
    for (const year of candidateYears(pinYear)) {
      const byModel = await fetchPrices(host, brand, s.seriesCode, year);
      if (!byModel || !Object.keys(byModel).length) continue;
      hitYear = year;

      for (const [modelCode, pkgs] of Object.entries(byModel)) {
        const pkg = (Array.isArray(pkgs) && (pkgs.find(p => p.basePackage) || pkgs[0])) || null;
        const msrp = pkg?.vehicleStartPrice?.amount;
        if (!msrp) continue;
        // A published MSRP is a whole dollar figure. Fractional values mean the
        // API handed us a CALCULATED price (fees/levies folded in) rather than
        // the advertised sticker -- the exact bug that put $83,586.92 on a
        // Land Cruiser whose real MSRP is $90,615. Never store those.
        if (!Number.isInteger(Number(msrp))) { skipped.fractional++; continue; }
        const grade = await fetchGrade(host, brandFolder, s.seriesCode, year, modelCode);
        await sleep(100);
        // NEVER fall back to modelCode: internal codes ("BX", "WX", "HI") are not
        // Canadian marketing trims, can't be matched to a listing, and shipped
        // as real trim names once (2026-08-11 Land Cruiser regression).
        if (!grade) { skipped.noGrade++; continue; }
        msrpRows.push({ year, make: makeName, model: s.name, trim: grade, msrp, fuel_type: fuel, fetched_at: new Date().toISOString() });
      }

      const rates = await fetchRates(host, brand, s.seriesCode, year);
      if (rates) {
        for (const [term, r] of Object.entries(rates.finance)) {
          financeRows.push({ make: makeName, model: s.name, apr: r.apr, term_months: Number(term), promo: false, effective_date: today });
        }
        for (const [term, r] of Object.entries(rates.lease)) {
          leaseRows.push({ make: makeName, model: s.name, apr: r.apr, term_months: Number(term), annual_km: r.km, effective_date: today });
        }
      }
      break;
    }
    console.log(`  ${s.seriesCode.padEnd(4)} ${s.name}${hitYear ? ` @${hitYear}` : "  (no price data)"}`);
  }

  console.log(`[${makeName}] ${msrpRows.length} MSRP, ${financeRows.length} finance, ${leaseRows.length} lease rows.`);
  if (skipped.noGrade || skipped.fractional) console.log(`  quality gate rejected: ${skipped.noGrade} missing-grade, ${skipped.fractional} fractional-price`);
  // A grade can appear under two modelCodes (same year/model/trim) — collapse to
  // the lowest MSRP so we don't violate msrp_catalog's UNIQUE(year,make,model,trim).
  return {
    msrpRows: dedupeBy(msrpRows, r => `${r.year}|${r.make}|${r.model}|${r.trim ?? ""}`, "msrp"),
    financeRows: dedupeBy(financeRows, r => `${r.make}|${r.model}|${r.term_months}`, "apr"),
    leaseRows,
  };
}

// ── Supabase write (delete-then-insert per make) ───────────────────────────
async function replaceRows(table, rows, makeName, { fatal = true } = {}) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  try {
    // Match the make case-INSENSITIVELY: a scraper that changes its MAKE
    // constant casing (Mini -> MINI) otherwise orphans the entire old lineup,
    // which then lives forever as duplicate rows (observed 2026-08-11).
    // Provenance wins: rows carrying a source_url were verified by hand against
    // the manufacturer's own published page. A scraper refresh must never wipe
    // them (it did, on 2026-08-11, replacing toyota.ca-sourced Land Cruiser
    // MSRPs with calculated prices under internal trim codes).
    const guard = table === "msrp_catalog" ? "&source_url=is.null" : "";
    const del = await fetch(`${url}/rest/v1/${table}?make=ilike.${encodeURIComponent(makeName)}${guard}`, { method: "DELETE", headers });
    if (!del.ok && del.status !== 404) throw new Error(`DELETE ${table} -> HTTP ${del.status}: ${await del.text()}`);
    for (let i = 0; i < rows.length; i += 500) {
      const ins = await fetch(`${url}/rest/v1/${table}`, { method: "POST", headers: { ...headers, Prefer: "return=minimal" }, body: JSON.stringify(rows.slice(i, i + 500)) });
      if (!ins.ok) throw new Error(`INSERT ${table} -> HTTP ${ins.status}: ${await ins.text()}`);
    }
    console.log(`  ${table}: replaced with ${rows.length} rows.`);
  } catch (e) {
    if (fatal) throw e;
    console.warn(`  ⚠️ ${table} skipped (${e.message.split("\n")[0]}). Create the table to enable it.`);
  }
}

// Shared runner used by scrape-toyota / scrape-lexus wrappers.
export async function run(config) {
  const args = Object.fromEntries(process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  }));
  const { msrpRows, financeRows, leaseRows } = await scrapeBrand({ ...config, filterSeries: args.series, pinYear: args.year });

  if (!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)) {
    const outDir = join(__dirname, "..", "out");
    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(outDir, `${config.makeName.toLowerCase()}-${stamp}.json`);
    writeFileSync(file, JSON.stringify({ msrp_catalog: msrpRows, finance_rate_catalog: financeRows, lease_rate_catalog: leaseRows }, null, 2));
    console.log(`\nDRY RUN (no SUPABASE_SERVICE_ROLE_KEY). Rows written to:\n  ${file}`);
    console.table(msrpRows.slice(0, 6));
    console.table(financeRows.slice(0, 6));
    console.table(leaseRows.slice(0, 6));
    return;
  }

  console.log(`\nWriting ${config.makeName} to Supabase…`);
  // CATALOG_RATES_ONLY=1 refreshes only the rate tables (daily run).
  if (process.env.CATALOG_RATES_ONLY !== "1") await replaceRows("msrp_catalog", msrpRows, config.makeName);
  else console.log(`  (rates-only: msrp_catalog left unchanged for ${config.makeName})`);
  await replaceRows("finance_rate_catalog", financeRows, config.makeName);
  // lease_rate_catalog is a newer table; don't fail the run if it isn't created yet.
  await replaceRows("lease_rate_catalog", leaseRows, config.makeName, { fatal: false });
  console.log("Done.");
}
