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

// VW ITEMISES EVERY FEE IN ITS OFFER FINE PRINT, and the fine print is
// province-specific. An Alberta offer reads, verbatim:
//
//   "...having a cash selling price of $29,956.00, including $26 PPSA
//    registration fee (including third-party registering agent fee), $2,050
//    freight and PDI, $100 air conditioning levy, $25 tire recycling levy,
//    $10 AMVIC fee and $750 representative dealer admin fee (actual fee is set
//    by dealers and varies...)"
//
// So the advertised price INCLUDES all of it, and the components are named.
// The $10 AMVIC fee is what makes this an Alberta figure -- the Ontario text
// names OMVIC instead, which is why this scraper must not ask Ontario.
//
// PARSED CONSERVATIVELY: each pattern must match its own label, so a stray
// dollar figure elsewhere in the sentence cannot be read as freight. A figure
// that does not match is left out rather than guessed.
function feesFromLegal(legal) {
  const t = String(legal || "").replace(/\s+/g, " ");
  const money = (re) => { const m = t.match(re); if (!m) return null; const n = Number(String(m[1]).replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
  const out = {
    freight_and_pdi:       money(/\$([\d,]+)\s*(?:\.\d{2})?\s+freight and PDI/i),
    air_conditioning_levy: money(/\$([\d,]+)\s+air conditioning levy/i),
    tire_recycling_levy:   money(/\$([\d,]+)\s+tire recycling levy/i),
    amvic_fee:             money(/\$([\d,]+)\s+AMVIC fee/i),
    ppsa_fee:              money(/\$([\d,]+)\s+PPSA registration fee/i),
    dealer_admin_fee:      money(/\$([\d,]+)\s+(?:representative )?dealer admin(?:istration)? fee/i),
  };
  // THE HEDGE IS EVIDENCE, NOT NOISE. VW calls its admin fee "representative"
  // and says the actual one is set by the dealer. A buyer shown $750 without
  // that caveat would take it for a fixed charge.
  if (/actual fee is set by dealers/i.test(t)) out.dealer_admin_fee_is_representative = true;
  for (const k of Object.keys(out)) if (out[k] === null) delete out[k];
  return out;
}

async function main() {
  const args = parseArgs();
  const today = new Date().toISOString().slice(0, 10);
  const y = new Date().getUTCFullYear();
  const years = args.year ? [Number(args.year)] : [y, y + 1];

  const msrpRows = [], financeRows = [], leaseRows = [];
  const freightSeen = new Map();
  const finSeen = new Set(), leaseSeen = new Set(), finCache = new Map();

  for (const year of years) {
    let data;
    // Alberta, not Ontario. VW's special offers are province-scoped and this
    // call asked ON while the product serves AB.
    try { data = await (await fetch(`https://globalapi.vwtools.ca/special-offers?province=AB&year=${year}`, { headers: HDRS })).json(); }
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
        // VW publishes an advertised price that INCLUDES freight/PDI; subtracting
        // it yields a conventional MSRP. That makes these rows explicitly
        // excl_freight (stamped at write time), so a report comparing them to an
        // all-in advertised price can say what the difference contains.
        const msrp = advPrice > 0 ? advPrice - freight : 0;
        const trim = (t.trimline || "").trim() || null;
        const legalText = ((t.offers || []).map((o) => o?.legal).filter(Boolean))[0] || null;
        const vwFees = feesFromLegal(legalText);
        if (vwFees.freight_and_pdi) freightSeen.set(model, vwFees.freight_and_pdi);
        if (msrp > 0) msrpRows.push({
          year, make: MAKE, model, trim, msrp,
          fuel_type: inferFuelFromName(`${model} ${trim || ""}`) || (/\bid\.?\d?\b|buzz/i.test(model) ? "BEV" : null),
          attrs: Object.keys(vwFees).length ? { ...vwFees, price_components_province: "AB" } : undefined,
          fetched_at: new Date().toISOString(),
        });
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
  await writeCatalogs(MAKE, { msrpRows, financeRows, leaseRows }, { priceBasis: "excl_freight" });

  if (freightSeen.size) {
    console.log(`[${MAKE}] freight and PDI from VW's own offer fine print (Alberta):`);
    for (const [model, amt] of [...freightSeen].sort((a, b) => b[1] - a[1])) console.log(`    ${String(amt).padStart(5)}  ${model}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
