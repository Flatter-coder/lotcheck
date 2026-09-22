// Mazda Canada MSRP + finance/lease-rate scraper.
// React app -> AWS API Gateway JSON. MSRP + finance + lease all in one call.
//   /api/ModelYears?prov_code=ON&lang_code=en          -> model_years (carline+year slugs)
//   /api/Trims/{year}/{carlineSlug}/?prov_code=ON&lang_code=en -> trims[].financial{msrp,apr[],lease[]}
// Rates are decimals (0.0199 = 1.99%). Header x-requested-with: XMLHttpRequest.
//
// Usage: node scripts/scrape-mazda.mjs [--year=2026]

import { getJson, sleep, inferFuelFromName, writeCatalogs, parseArgs } from "./lib/catalog-io.mjs";

const MAKE = "Mazda";
const GW = "https://n8xgyscaa3.execute-api.ca-central-1.amazonaws.com/prod";
const HDR = { "x-requested-with": "XMLHttpRequest" };
// Alberta. Mazda returns a PER-PROVINCE itemised fee list, so this is not
// cosmetic: Alberta carries AMVIC 10, Ontario OMVIC 22, and only one of those
// is a fee an Alberta buyer pays.
const PROV = "AB";

async function main() {
  const args = parseArgs();
  const today = new Date().toISOString().slice(0, 10);
  const modelYears = (await getJson(`${GW}/api/ModelYears?prov_code=${PROV}&lang_code=en`, HDR))?.data?.model_years || [];
  console.log(`[${MAKE}] ${modelYears.length} model-years`);

  const msrpRows = [], financeRows = [], leaseRows = [];
  const freightSeen = new Map();
  const finSeen = new Set(), leaseSeen = new Set();

  for (const my of modelYears) {
    const year = Number(my.year?.url_slug || my.year?.title);
    const carSlug = my.carline?.url_slug || my.carline?.voi_leads_name;
    const model = (my.carline?.voi_leads_name || my.carline?.title || carSlug || "").replace(/^MAZDA\s+/i, "").trim();
    if (!year || !carSlug || (args.year && year !== Number(args.year))) continue;

    let trims;
    try { trims = (await getJson(`${GW}/api/Trims/${year}/${encodeURIComponent(carSlug)}/?prov_code=${PROV}&lang_code=en`, HDR))?.data?.trims || []; }
    catch { await sleep(80); continue; }

    for (const t of (Array.isArray(trims) ? trims : [])) {
      const f = t.financial || {};
      const msrp = Number(f.msrp);
      if (!(msrp > 0)) continue;
      // trim name = full title minus the leading "{year} {model} "
      let trim = String(t.name || t.title || "").replace(`${year} `, "").trim();
      if (model && trim.toLowerCase().startsWith(model.toLowerCase())) trim = trim.slice(model.length).trim();
      trim = trim || null;
      // MAZDA ITEMISES EVERY FEE, BY PROVINCE. financial.fees for Alberta:
      //   Freight 1455 · PDE 740 · Administration Fee 795 · A/C Tax 100
      //   · AMVIC 10 · Tire Stewardship 25
      // Freight and PDE are the two halves of what the report calls Freight &
      // PDI -- $2,195 on a CX-5, which is a figure we previously held for no
      // Mazda model at all. The Administration Fee of 795 also confirms the
      // brand ceiling already in fee-schedule.ts, captured independently.
      //
      // msrp sits BESIDE these, not over them, which is the evidence that
      // Mazda's msrp excludes freight.
      const feeAttrs = {};
      let freight = null, pde = null;
      for (const fee of (f.fees || [])) {
        const amt = Number(fee?.price);
        if (!Number.isFinite(amt)) continue;
        const name = String(fee?.title || "").trim();
        feeAttrs[`fee_${name.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase()}`] = amt;
        if (/^freight$/i.test(name)) freight = amt;
        if (/^pde$/i.test(name)) pde = amt;
      }
      if (Object.keys(feeAttrs).length) feeAttrs.price_components_province = PROV;
      // Freight AND PDE together are "Freight & PDI". Reported, not written:
      // the freight catalogue is reviewed, not machine-filled.
      if (freight !== null || pde !== null) freightSeen.set(model, { freight, pde, total: (freight || 0) + (pde || 0) });

      msrpRows.push({
        year, make: MAKE, model, trim, msrp,
        fuel_type: inferFuelFromName(`${model} ${trim || ""}`),
        attrs: Object.keys(feeAttrs).length ? feeAttrs : undefined,
        fetched_at: new Date().toISOString(),
      });

      for (const a of (f.apr || [])) {
        const term = Number(a.term), apr = Math.round(Number(a.rate) * 10000) / 100;
        const k = `${model}|${term}`;
        if (term && Number.isFinite(apr) && !finSeen.has(k)) { finSeen.add(k); financeRows.push({ make: MAKE, model, apr, term_months: term, promo: false, effective_date: today }); }
      }
      for (const l of (f.lease || [])) {
        const term = Number(l.term), apr = Math.round(Number(l.rate) * 10000) / 100;
        const k = `${model}|${term}`;
        if (term && Number.isFinite(apr) && !leaseSeen.has(k)) { leaseSeen.add(k); leaseRows.push({ make: MAKE, model, apr, term_months: term, annual_km: null, effective_date: today }); }
      }
    }
    console.log(`  ${model} @${year}: ${trims.length} trims`);
    await sleep(80);
  }
  console.log(`[${MAKE}] ${msrpRows.length} MSRP, ${financeRows.length} finance, ${leaseRows.length} lease rows.`);
  // excl_freight on the maker's own structure: msrp is one field and Freight
  // is another, in the same object.
  await writeCatalogs(MAKE, { msrpRows, financeRows, leaseRows }, { priceBasis: "excl_freight" });

  if (freightSeen.size) {
    console.log(`[${MAKE}] Freight + PDE published per model (Mazda's own itemisation, prov=${PROV}):`);
    for (const [model, v] of [...freightSeen].sort((a, b) => b[1].total - a[1].total)) {
      console.log(`    ${String(v.total).padStart(5)}  ${String(model).padEnd(22)} (freight ${v.freight ?? "-"} + PDE ${v.pde ?? "-"})`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
