// Genesis Canada MSRP + finance/lease-rate scraper.
// JSON API on acquisition.genesis.ca ("Genesis at home"). MSRP and rates are
// separate endpoints joined on extTrimId:
//   GetLatestYearModelsJson?province=ON            -> models (name + year)
//   GetTrimsJson?province=ON&modelName=&year=      -> trims (extTrimId, msrp)
//   GetPaymentOptions?language=en&extTrimId=&province=ON -> finance/lease by term
//
// The site was rebuilt from Sitecore to AEM around 2026-08-09 and the service
// moved from /genesis/service/GenesisShowroom to /api/genesisbackend/…, which
// 404'd every run from 2026-08-11 until 2026-08-13 (the refresh stayed green;
// that gap is why catalog-refresh.yml now verifies fresh rows per make). Same
// method names and shapes, except optionDictionary keys are now UPPERCASE
// (FINANCE/LEASE) and the old anualKmList typo became annualKmList — read both.
//
// Usage: node scripts/scrape-genesis.mjs [--year=2026]
//        SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/scrape-genesis.mjs

import { getJson, sleep, inferFuelFromName, writeCatalogs, parseArgs } from "./lib/catalog-io.mjs";

const MAKE = "Genesis";
const BASE = "https://acquisition.genesis.ca/api/genesisbackend/GenesisShowroom";
const PROV = "ON";

async function main() {
  const args = parseArgs();
  const today = new Date().toISOString().slice(0, 10);
  const models = (await getJson(`${BASE}/GetLatestYearModelsJson?province=${PROV}`)).models || [];
  const msrpRows = [], financeRows = [], leaseRows = [];
  const finSeen = new Set(), leaseSeen = new Set();

  for (const m of models) {
    const model = (m.modelName || "").trim();
    const year = Number(m.modelYear);
    if (!model || !year || (args.year && year !== Number(args.year))) continue;
    let trimData;
    try {
      trimData = await getJson(`${BASE}/GetTrimsJson?province=${PROV}&modelName=${encodeURIComponent(model)}&year=${year}`);
    } catch { continue; }
    const trims = (trimData.trims && (trimData.trims[year] || Object.values(trimData.trims)[0])) || [];
    const fuel = inferFuelFromName(model);

    for (const t of trims) {
      const msrp = Number(t.msrp);
      if (!(msrp > 0)) continue;
      msrpRows.push({ year, make: MAKE, model, trim: (t.trimName || "").trim() || null, msrp, fuel_type: fuel, fetched_at: new Date().toISOString() });

      if (t.extTrimId != null) {
        try {
          const pay = await getJson(`${BASE}/GetPaymentOptions?language=en&extTrimId=${t.extTrimId}&province=${PROV}`);
          const od = pay.optionDictionary || {};
          for (const f of (od.FINANCE || od.finance || [])) {
            const term = Number(f.term), apr = Number(f.rate);
            const k = `${model}|${term}`;
            if (term && Number.isFinite(apr) && !finSeen.has(k)) { finSeen.add(k); financeRows.push({ make: MAKE, model, apr, term_months: term, promo: false, effective_date: today }); }
          }
          for (const l of (od.LEASE || od.lease || [])) {
            const term = Number(l.term), apr = Number(l.rate);
            const kms = l.annualKmList || l.anualKmList;
            const km = Array.isArray(kms) && kms.length ? Number(kms[Math.min(1, kms.length - 1)]) : null; // a mid km bucket; Genesis rate is km-independent
            const k = `${model}|${term}`;
            if (term && Number.isFinite(apr) && !leaseSeen.has(k)) { leaseSeen.add(k); leaseRows.push({ make: MAKE, model, apr, term_months: term, annual_km: km, effective_date: today }); }
          }
        } catch { /* keep MSRP even if rates fail */ }
        await sleep(90);
      }
    }
    console.log(`  ${model} @${year}: ${trims.length} trims`);
  }
  console.log(`[${MAKE}] ${msrpRows.length} MSRP, ${financeRows.length} finance, ${leaseRows.length} lease rows.`);
  await writeCatalogs(MAKE, { msrpRows, financeRows, leaseRows });
}
main().catch(e => { console.error(e); process.exit(1); });
