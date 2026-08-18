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
import { dedupeBy, writeCatalogs } from "./catalog-io.mjs";

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
        // vehicleStartPrice IS NOT AN MSRP AND NO FILTER CAN MAKE IT ONE.
        //
        // The integer test that used to live here treated a whole-dollar value
        // as evidence of a published sticker. Measured 2026-08-17, Land Cruiser
        // BLCAJA 2026, one vehicle, thirteen provinces:
        //
        //   ON 74681.92   AB 75335   BC 74648   QC 74559.5   SK 75250.5
        //   MB 75257.99   NS 74683.25  NB 74680.5  NL 74703  PE 74715.25
        //   YT 74659      NT 74648   NU 74689.25
        //
        // Twelve distinct values. MSRP is national, so this field is by
        // definition not it -- and note AB, BC, NL, YT and NT are all WHOLE
        // DOLLARS and all disagree. The old gate therefore did not just reject
        // good rows, it ADMITTED calculated ones: at province=ON it passed 7 of
        // 76 rows (C-HR, bZ, bZ Woodland), every one an Ontario-calculated
        // figure stored as though it were the manufacturer's price.
        //
        // Rows are still computed so this stays observable, but they are never
        // written -- see the ratesOnly note in run() below.
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
// replaceRows now comes from catalog-io.mjs. The local copy that used to live
// here had no empty-scrape guard, no carry-forward and no collapse check, so a
// partial Toyota scrape deleted the lineup and re-inserted 7 rows while
// printing "replaced with 7 rows" as if it had succeeded (2026-08-14).

// Shared runner used by scrape-toyota / scrape-lexus wrappers.
export async function run(config) {
  const args = Object.fromEntries(process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  }));
  const { msrpRows, financeRows, leaseRows } = await scrapeBrand({ ...config, filterSeries: args.series, pinYear: args.year });

  // WRITE THROUGH writeCatalogs, NOT THREE BARE AWAITS.
  // 5f4259d fixed exactly this defect -- an MSRP write that throws must not take
  // the finance and lease writes down with it -- and converted twenty scrapers
  // to the shared helper. This file and fca-stack.mjs kept their own hand-rolled
  // copy of the sequence and so kept the bug, which is why the Toyota run that
  // motivated 5f4259d is STILL losing its rates: the collapse guard correctly
  // refuses the MSRP rows, the refusal throws, and 123 finance + 120 lease rows
  // that were already in hand never get written.
  //
  // writeCatalogs also brings the dry-run path, the dedupe, the quality gate and
  // the ratesOnly option, all of which this file was duplicating or missing.
  // RATES ONLY, ALWAYS, FOR EVERY BRAND ON THIS PLATFORM.
  //
  // Toyota Canada and Lexus Canada expose no published national MSRP that this
  // scraper can reach. Checked 2026-08-17:
  //   - price_calculation/prices.json  -> vehicleStartPrice only, and it varies
  //     across all 13 provinces for the same vehicle, so it is a calculated
  //     figure, not a sticker. Lexus RX/NX behave identically.
  //   - the BnP-get-models GraphQL fragment -> grade/engine/body/options, no price
  //   - the series list -> pricingData: null
  //   - /bin/api/price_calculation/calculator.json -> 404
  //   - the Build & Price and vehicle overview pages -> JS shells, no price in HTML
  //
  // An MSRP may only be published with a KNOWN BASIS. A province-calculated
  // number relabelled as MSRP is exactly the wrong-denominator defect that
  // makes every downstream claim wrong, so the honest move is to write none.
  //
  // msrp_catalog keeps its hand-seeded Build & Price rows, which carry a real
  // basis and a dated capture. The rate tables ARE published and correct, and
  // they keep refreshing daily -- which is the half of the reference-point
  // model this job exists to serve.
  //
  // TO REVISIT: if Toyota ever publishes a national MSRP, the tell is
  // vehicleStartPrice returning the SAME value for every province. Until then
  // this stays rates-only.
  if (msrpRows.length) {
    console.log(`  ${msrpRows.length} MSRP row(s) computed but NOT written: vehicleStartPrice is a province-calculated price, not a published MSRP.`);
  }
  await writeCatalogs(config.makeName, { msrpRows: [], financeRows, leaseRows }, {
    ratesOnly: true,
  });
}
