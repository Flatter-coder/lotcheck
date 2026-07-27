// Hyundai Canada MSRP + finance/lease-rate scraper.
// AEM backend REST API; MSRP + finance + lease all come from one per-trim call.
//   GetShowroomsModelJson?prov=ON&language=en          -> models (modelId, vehicleName)
//   getShowroomModelTrimsJson?modelId=&prov=ON&language=en -> trims (trimId, vehicleName)
//   trimallpurchaseOptions?trimId=&prov=ON&lang=en      -> msrp + purchaseOptions[]
// Rates are decimals (0.0279 = 2.79%).
//
// Usage: node scripts/scrape-hyundai.mjs [--year=2026]

import { getJson, sleep, inferFuelFromName, writeCatalogs, parseArgs } from "./lib/catalog-io.mjs";

const MAKE = "Hyundai";
const BASE = "https://www.hyundaicanada.com/api/backendservice/buildandprice";
const PROV = "ON";
// Hyundai sits behind an Imperva WAF that rejects bare requests; a real
// browser header set (Referer + client hints) passes it.
const HDR = {
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-CA,en;q=0.9",
  "Referer": "https://www.hyundaicanada.com/en/shopping-tools/buildandprice",
  "sec-ch-ua": '"Chromium";v="126", "Not.A/Brand";v="24"',
  "sec-ch-ua-platform": '"Windows"',
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "cors",
};

async function main() {
  const args = parseArgs();
  const today = new Date().toISOString().slice(0, 10);
  // data.models is an array-of-arrays (one inner array per lineup card).
  const models = ((await getJson(`${BASE}/GetShowroomsModelJson?prov=${PROV}&language=en`, HDR))?.data?.models || []).flat();
  const modelIds = [...new Set(models.map(m => m?.modelId).filter(Boolean))];
  console.log(`[${MAKE}] ${modelIds.length} unique models`);

  const msrpRows = [], financeRows = [], leaseRows = [];
  const finSeen = new Set(), leaseSeen = new Set();

  for (const modelId of modelIds) {
    let trims;
    try { trims = (await getJson(`${BASE}/getShowroomModelTrimsJson?modelId=${modelId}&prov=${PROV}&language=en`, HDR))?.data?.trims || []; }
    catch { continue; }
    for (const t of (Array.isArray(trims) ? trims : [])) {
      const year = Number(t.vehicleYear);
      if (!year || (args.year && year !== Number(args.year))) continue;
      const model = (t.vehicleName || "").trim();
      const trimName = (t.trimNameEn || t.trimName || "").trim() || null;
      if (!model || !t.trimId) continue;
      let d;
      try { const r = await getJson(`${BASE}/trimallpurchaseOptions?trimId=${t.trimId}&prov=${PROV}&lang=en`, HDR); d = r?.data || r; }
      catch { await sleep(70); continue; }
      const msrp = Number(d?.msrp);
      if (!(msrp > 0)) { await sleep(70); continue; }
      msrpRows.push({ year, make: MAKE, model, trim: trimName, msrp, fuel_type: inferFuelFromName(`${model} ${trimName || ""}`), fetched_at: new Date().toISOString() });

      for (const po of (d.purchaseOptions || [])) {
        const type = (po.type || "").toUpperCase();
        if (type !== "FINANCE" && type !== "LEASE") continue;
        for (const o of (po.options || [])) {
          if (o.termUnit && String(o.termUnit).toUpperCase() !== "MONTH") continue;
          const term = Number(o.term), apr = Math.round(Number(o.rate) * 10000) / 100; // decimal -> percent
          if (!term || !Number.isFinite(apr)) continue;
          if (type === "FINANCE") {
            const k = `${model}|${term}`;
            if (!finSeen.has(k)) { finSeen.add(k); financeRows.push({ make: MAKE, model, apr, term_months: term, promo: false, effective_date: today }); }
          } else {
            const k = `${model}|${term}`;
            if (!leaseSeen.has(k)) { leaseSeen.add(k); leaseRows.push({ make: MAKE, model, apr, term_months: term, annual_km: null, effective_date: today }); }
          }
        }
      }
      await sleep(70);
    }
  }
  console.log(`[${MAKE}] ${msrpRows.length} MSRP, ${financeRows.length} finance, ${leaseRows.length} lease rows.`);
  await writeCatalogs(MAKE, { msrpRows, financeRows, leaseRows });
}
main().catch(e => { console.error(e); process.exit(1); });
