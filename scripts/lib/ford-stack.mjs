// ── Ford / Lincoln Canada MSRP scraper ─────────────────────────────────────
// MSRP only. Ford's ModelSlices API returns per-trim MSRP; the finance/lease
// APR lives in the separate `/estimate-payment` app (not yet captured), so
// this populates msrp_catalog only — no fabricated rates.
//
// IMPORTANT: Ford is behind Akamai. `curl` is blocked (HTTP 000), but Node's
// fetch (different TLS stack) + a real browser UA + the `application-id` header
// passes. The `application-id` is Ford's public FMA client id, captured from
// the shop.ford.ca pricing widget (see scripts/FORD-NOTES.md). CI runners on
// datacenter IPs MAY still be Akamai-blocked; runs locally.
//   GET https://www.ford.ca/cxservices/products/ModelSlices.json
//       ?plantype=MSRP&make={Make}&model={Model}&year={Year}&postalCode=...&appContext=T1&...
//   -> Response.Model.ModelSlices.ModelSlice[].{ name (trim), Pricing.MSRP }
import { sleep, inferFuelFromName, writeCatalogs, parseArgs } from "./catalog-io.mjs";

const APP_ID = "07152898-698b-456e-be56-d3d83011d0a6"; // public Ford FMA client id
const POSTAL = "M5V2T6";
const YEARS = [2027, 2026, 2025];
const HDRS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  "application-id": APP_ID, "Accept": "application/json", "Accept-Language": "en-CA,en;q=0.9",
};

// Model params are Ford's marketing names (verified 2026-07-26 from shop.ford.ca).
// Refresh from the showroom tiles if the lineup changes.
// Ford's build-&-price API is queried by SHORT name ("Mach-E"), but dealer
// listings and buyers use the full nameplate ("Mustang Mach-E"). Storing the
// short name split the same car across two catalog models with two different
// prices, and the lookup matched the stale one. Query short, store canonical.
export const FORD_MODEL_ALIASES = { "Mach-E": "Mustang Mach-E" };

export const FORD_MODELS = ["Escape", "Explorer", "Expedition", "Mustang", "Mach-E", "Bronco", "Bronco Sport", "Maverick", "Ranger", "F-150", "Super Duty", "Transit"];
export const LINCOLN_MODELS = ["Corsair", "Nautilus", "Aviator", "Navigator"];

async function modelSlices(make, model, year) {
  const url = `https://www.ford.ca/cxservices/products/ModelSlices.json?plantype=MSRP&planType=MSRP&make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&year=${year}&trimId=x&paymentFrequency=monthly&postalCode=${POSTAL}&zipcode=${POSTAL}&appContext=T1&modelSliceDefiners=modelId&modelSliceAttributes=modelId`;
  const res = await fetch(url, { headers: HDRS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return j?.Response?.Model?.ModelSlices?.ModelSlice || [];
}

export async function run(cfg) {
  // cfg: { make, models }
  const args = parseArgs();
  const models = args.model ? [args.model] : cfg.models;
  const byTrim = new Map(); // year|model|trim -> starting MSRP

  for (const model of models) {
    let slices = null, year = null;
    for (const y of (args.year ? [Number(args.year)] : YEARS)) {
      try { const s = await modelSlices(cfg.make, model, y); if (s.length) { slices = s; year = y; break; } }
      catch { /* try next year */ }
      await sleep(120);
    }
    if (!slices) { console.log(`  ${model}: no data`); continue; }
    for (const s of slices) {
      const msrp = Number(s?.Pricing?.MSRP) || Number(s?.Pricing?.BaseMSRP);
      const trim = (s.name || "").toString().replace(/[®™]/g, "").trim() || null;
      if (!(msrp > 0)) continue;
      const storedModel = (cfg.aliases && cfg.aliases[model]) || model;
      const key = `${year}|${storedModel}|${trim}`;
      const prev = byTrim.get(key);
      if (!prev || msrp < prev.msrp) byTrim.set(key, {
        year, make: cfg.make, model: storedModel, trim, msrp,
        fuel_type: inferFuelFromName(`${model} ${trim || ""}`) || (/mach-e|lightning|e-transit/i.test(`${model} ${trim}`) ? "BEV" : null),
        fetched_at: new Date().toISOString(),
      });
    }
    console.log(`  ${model} @${year}: ${slices.length} trims`);
    await sleep(120);
  }
  const msrpRows = [...byTrim.values()];
  console.log(`[${cfg.make}] ${msrpRows.length} MSRP rows`);
  await writeCatalogs(cfg.make, { msrpRows, financeRows: [], leaseRows: [] });
}
