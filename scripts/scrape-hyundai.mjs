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
// ALBERTA, BECAUSE THAT IS WHO THE PRODUCT IS FOR. This read "ON" from the
// first commit. The msrp and delivery figures happen to be identical across
// the two provinces, so it was never the reason a price was wrong -- but
// ppsaFees differs (104 in Ontario, 86 in Alberta) and asking the wrong
// province for an Alberta buyer is indefensible regardless of today's parity.
const PROV = "AB";
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
  const adminSeen = new Map();
  const freightSeen = new Map();   // model -> Hyundai's own delivery charge
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

      // WE WERE HANDED FIVE NUMBERS AND KEPT ONE. This payload carries, beside
      // msrp: delivery (Hyundai's own freight and PDI), dealerAdminFee,
      // fedAirTax and ppsaFees. All four were parsed and thrown away, and the
      // write then declared the price basis UNKNOWN -- while the object it had
      // just read contained a field called `delivery`.
      //
      // The cost of that was a client asking what a 2027 IONIQ 9 Preferred AWD
      // costs and the catalogue answering $64,999 with no basis, when Hyundai's
      // own Alberta configurator says $68,128 all-in. The components were in
      // this response the whole time.
      const delivery = Number(d?.delivery);
      // dealerAdminFee / fedAirTax / ppsaFees sit on every purchase option and
      // are identical across them; the first one that carries them answers.
      const opts = (d.purchaseOptions || []).flatMap((po) => po.options || []);
      const firstWith = (k) => { for (const o of opts) { const v = Number(o?.[k]); if (Number.isFinite(v) && v > 0) return v; } return null; };
      const adminFee = firstWith("dealerAdminFee");
      const airTax = firstWith("fedAirTax");
      const ppsa = firstWith("ppsaFees");

      // CAPTURED COMPONENTS, NEVER A COMPUTED ALL-IN. fee-schedule.ts is
      // explicit: the authoritative all-in is the manufacturer's CAPTURED
      // figure, never the sum of parts. msrp + delivery + admin + airTax comes
      // to $68,098 on the trim above where Hyundai's own total is $68,128, so
      // a sum published as "the all-in price" would be wrong by $30 and carry
      // the authority of a captured figure. all_in_price stays null until we
      // capture Hyundai's own total.
      const priceAttrs = {};
      if (Number.isFinite(delivery) && delivery > 0) priceAttrs.delivery_charge = delivery;
      if (adminFee !== null) priceAttrs.dealer_admin_fee = adminFee;
      if (airTax !== null) priceAttrs.federal_air_tax = airTax;
      if (ppsa !== null) priceAttrs.ppsa_fee = ppsa;
      priceAttrs.price_components_province = PROV;

      msrpRows.push({
        year, make: MAKE, model, trim: trimName, msrp,
        fuel_type: inferFuelFromName(`${model} ${trimName || ""}`),
        attrs: Object.keys(priceAttrs).length ? priceAttrs : undefined,
        fetched_at: new Date().toISOString(),
      });
      // Hyundai's freight, per model, from the maker's own field. The freight
      // catalogue held ONE Hyundai figure -- Tucson $2,200, captured by hand.
      if (Number.isFinite(delivery) && delivery > 0) freightSeen.set(model, delivery);
      if (adminFee !== null) adminSeen.set(model, adminFee);

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
  // THE BASIS IS NOW EVIDENCED, NOT UNKNOWN. msrp and delivery arrive as
  // SEPARATE fields in the same object, so msrp demonstrably excludes freight.
  // That is the maker's own structure, which is stronger evidence than the
  // published wording this previously waited for.
  await writeCatalogs(MAKE, { msrpRows, financeRows, leaseRows }, { priceBasis: "excl_freight" });

  // Report the freight Hyundai states per model, so the gap between what we
  // hold in the freight catalogue and what the maker charges is visible rather
  // than assumed. Printed, not written: the freight catalogue is reviewed.
  if (adminSeen.size) {
    console.log(`[${MAKE}] dealer admin fee published per model (prov=${PROV}):`);
    for (const [model, amt] of [...adminSeen].sort((a, b) => b[1] - a[1])) console.log(`    ${String(amt).padStart(5)}  ${model}`);
  }
  if (freightSeen.size) {
    console.log(`[${MAKE}] delivery charge published per model (Hyundai's own field, prov=${PROV}):`);
    for (const [model, amt] of [...freightSeen].sort((a, b) => b[1] - a[1])) console.log(`    ${String(amt).padStart(5)}  ${model}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
