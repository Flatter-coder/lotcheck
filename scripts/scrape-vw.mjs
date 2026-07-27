// Volkswagen Canada MSRP + finance/lease scraper (full data).
// VW's public tools API (no auth, Content-Language header only):
//   GET globalapi.vwtools.ca/special-offers?province=ON&year=  -> models/trims + sales_code + advertised price
//   GET globalapi.vwtools.ca/finance?year=&sales_code=         -> financial_values.ON.apr (finance),
//                                                                 .alr (lease) by term, freight_pdi
// The advertised price is the selling price (incl freight), so MSRP = price − freight_pdi.
import { inferFuelFromName, sleep, writeCatalogs, parseArgs, UA } from "./lib/catalog-io.mjs";

const MAKE = "Volkswagen";
const HDRS = { "User-Agent": UA, "Content-Language": "en", "Accept": "application/json" };
const num = s => Number(String(s ?? "").replace(/[^0-9.]/g, "")) || 0;

async function fetchFinance(year, salesCode, cache) {
  if (cache.has(salesCode)) return cache.get(salesCode);
  let out = null;
  try {
    const f = await fetch(`https://globalapi.vwtools.ca/finance?year=${year}&sales_code=${salesCode}`, { headers: HDRS });
    if (f.ok) { const d = await f.json(); out = { freight: num(d.freight_pdi), fv: (d.financial_values || {}).ON || {} }; }
  } catch { /* skip */ }
  cache.set(salesCode, out);
  return out;
}

async function main() {
  const args = parseArgs();
  const today = new Date().toISOString().slice(0, 10);
  const y = new Date().getUTCFullYear();
  const years = args.year ? [Number(args.year)] : [y, y + 1];

  const msrpRows = [], financeRows = [], leaseRows = [];
  const finSeen = new Set(), leaseSeen = new Set(), finCache = new Map();

  for (const year of years) {
    let data;
    try { data = await (await fetch(`https://globalapi.vwtools.ca/special-offers?province=ON&year=${year}`, { headers: HDRS })).json(); }
    catch { continue; }
    const yd = data[year] || data[String(year)] || {};
    for (const modelKey of Object.keys(yd)) {
      const md = yd[modelKey];
      const model = (md.name || modelKey).trim();
      for (const t of (md.trims || [])) {
        const salesCode = t.sales_code || t.okapi_code;
        if (!salesCode) continue;
        const offers = t.offers || [];
        const priceStr = (offers.find(o => o.type === "finance") || offers.find(o => o.type === "lease") || offers.find(o => o.type === "cash") || {}).price;
        const advPrice = num(priceStr);
        const fin = await fetchFinance(year, salesCode, finCache);
        await sleep(90);
        const freight = fin?.freight || 0;
        const msrp = advPrice > 0 ? advPrice - freight : 0; // strip freight/PDI to get MSRP
        const trim = (t.trimline || "").trim() || null;
        if (msrp > 0) msrpRows.push({ year, make: MAKE, model, trim, msrp, fuel_type: inferFuelFromName(`${model} ${trim || ""}`) || (/\bid\.?\d?\b|buzz/i.test(model) ? "BEV" : null), fetched_at: new Date().toISOString() });
        // rate ladders (model-level; VW rates are set per sales_code but stored per model)
        const fv = fin?.fv || {};
        for (const [term, rate] of Object.entries(fv.apr || {})) {
          const r = Number(rate), k = `${model}|${term}`;
          // VW lists an explicit apr per term; 0 means a real 0% promo (not "unavailable").
          if (Number.isFinite(r) && !finSeen.has(k)) { finSeen.add(k); financeRows.push({ make: MAKE, model, apr: r, term_months: Number(term), promo: r === 0, effective_date: today }); }
        }
        for (const [term, rate] of Object.entries(fv.alr || {})) {
          const k = `${model}|${term}`;
          if (Number(rate) > 0 && !leaseSeen.has(k)) { leaseSeen.add(k); leaseRows.push({ make: MAKE, model, apr: Number(rate), term_months: Number(term), annual_km: null, effective_date: today }); }
        }
      }
    }
  }
  console.log(`[${MAKE}] ${msrpRows.length} MSRP, ${financeRows.length} finance, ${leaseRows.length} lease rows.`);
  await writeCatalogs(MAKE, { msrpRows, financeRows, leaseRows });
}
main().catch(e => { console.error(e); process.exit(1); });
