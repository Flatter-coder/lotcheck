// ── Honda / Acura Canada build-&-price scraper (shared platform) ───────────
// Both run the same Sitecore "dmmapi" + api.honda.ca calculator platform.
// Flow (all curl-able, no browser at runtime — see scripts/HONDA-NOTES.md):
//   1. Build&Price page HTML  -> models { GUID, model_key }
//   2. dmmapi trimswithtransmissions/model/{GUID}/{year}
//                             -> trims[] with trim/transmission/colour detKeys
//   3. POST api.honda.ca .../calculator/payment { ...config, PaymentOptions[] }
//                             -> per-term MSRP + finance/lease APR
import { getJson, sleep, inferFuelFromName, writeCatalogs, parseArgs, UA } from "./catalog-io.mjs";

const FIN_TERMS = [36, 48, 60, 72, 84];
const LEASE_TERMS = [24, 36, 48, 60];
const LEASE_KM = 20000;
const YEARS = [2026, 2025, 2027];

const dash = g => (g && g.length === 32)
  ? `${g.slice(0,8)}-${g.slice(8,12)}-${g.slice(12,16)}-${g.slice(16,20)}-${g.slice(20)}`.toLowerCase() : g;
const titleCase = s => String(s || "").toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
const get = (o, path) => path.split(".").reduce((x, k) => (x == null ? x : x[k]), o);

async function postPayment(apiBase, body) {
  const res = await fetch(apiBase, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA, "AcceptLanguage": "en" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`payment HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

export async function run(cfg) {
  // cfg: { make, host, page, apiBase, apikey, site }
  const args = parseArgs();
  const today = new Date().toISOString().slice(0, 10);

  // 1. Enumerate models from the Build&Price page JSS (id GUID + detKey model_key).
  const html = await (await fetch(cfg.page, { headers: { "User-Agent": UA } })).text();
  const seen = new Set();
  const models = [...html.matchAll(/"id":"([0-9A-F]{32})"[^{}]*?"detKey":\{"value":"([a-z][a-z0-9_]+)"\}/g)]
    .map(m => ({ guid: m[1], key: m[2] }))
    .filter(m => (seen.has(m.guid) ? false : seen.add(m.guid)));
  const list = args.model ? models.filter(m => m.key === args.model) : models;
  console.log(`[${cfg.make}] ${list.length} models`);

  const msrpRows = [], financeRows = [], leaseRows = [];
  const finSeen = new Set(), leaseSeen = new Set();

  for (const mdl of list) {
    let trims = null, model = null, year = null;
    for (const y of (args.year ? [Number(args.year)] : YEARS)) {
      try {
        const r = await getJson(`${cfg.host}/dmmapi/trimswithtransmissions/model/${dash(mdl.guid)}/${y}?sc_apikey=${cfg.apikey}&sc_site=${cfg.site}&sc_lang=en`);
        const ts = get(r, "model.modelYear.trims");
        if (Array.isArray(ts) && ts.length) { trims = ts; model = titleCase(r.model.name); year = y; break; }
      } catch { /* try next year */ }
    }
    if (!trims) { console.log(`  ${mdl.key}: no trims`); continue; }

    for (const t of trims) {
      const fuel = inferFuelFromName(`${model} ${t.name || ""}`);
      const trimKey = get(t, "fields.detKey.value");
      const tx = t.transmissions?.[0];
      const transmissionKey = get(tx, "fields.detKey.value");
      const ext = tx?.exteriorColors?.[0];
      const exteriorColorKey = get(ext, "fields.color.fields.detKey.value");
      const interiorColorKey = get(ext, "fields.defaultInteriorColor.fields.color.fields.detKey.value")
        || get(ext, "fields.interiorColors.0.fields.color.fields.detKey.value");
      if (!trimKey || !transmissionKey || !exteriorColorKey || !interiorColorKey) continue;

      const paymentOptions = [
        ...FIN_TERMS.map((term, i) => ({ ClientRequestId: `f${i}`, PaymentMethod: "Finance", PaymentFrequency: "Monthly", Term: term, DownPaymentAmount: 0, TradeInValueAmount: 0, TradeInOwingAmount: 0, LeaseAnnualKmAllowance: 0, LeaseAdditionalAnnualKm: 0 })),
        ...LEASE_TERMS.map((term, i) => ({ ClientRequestId: `l${i}`, PaymentMethod: "Lease", PaymentFrequency: "Monthly", Term: term, DownPaymentAmount: 0, TradeInValueAmount: 0, TradeInOwingAmount: 0, LeaseAnnualKmAllowance: LEASE_KM, LeaseAdditionalAnnualKm: 0 })),
      ];
      const body = {
        ProvinceKey: "ON", ModelYear: year, ModelKey: mdl.key, TrimKey: trimKey,
        TransmissionKey: transmissionKey, ExteriorColorKey: exteriorColorKey, InteriorColorKey: interiorColorKey,
        IncludeFees: true, IncludeTaxes: false,
        Accessories: [], Protections: [], ProtectionAddOns: [], OwnerPrograms: [], OfferKeys: [], WarrantyKey: "",
        PaymentOptions: paymentOptions,
      };
      let resp;
      try { resp = await postPayment(cfg.apiBase, body); }
      catch (e) { console.log(`  ${model} ${t.name}: ${e.message}`); await sleep(120); continue; }

      const opts = resp?.PaymentOptions || [];
      const msrp = Number(opts.find(o => o.Msrp)?.Msrp);
      if (msrp > 0) {
        msrpRows.push({ year, make: cfg.make, model, trim: (t.name || "").trim() || null, msrp, fuel_type: fuel, fetched_at: new Date().toISOString() });
      }
      for (const o of opts) {
        const apr = Number(o.Apr), term = Number(o.Term);
        if (!term || !Number.isFinite(apr) || apr <= 0) continue;
        if (o.PaymentMethod === "Finance") {
          const k = `${model}|${term}`;
          if (!finSeen.has(k)) { finSeen.add(k); financeRows.push({ make: cfg.make, model, apr, term_months: term, promo: false, effective_date: today }); }
        } else if (o.PaymentMethod === "Lease") {
          const k = `${model}|${term}`;
          if (!leaseSeen.has(k)) { leaseSeen.add(k); leaseRows.push({ make: cfg.make, model, apr, term_months: term, annual_km: LEASE_KM, effective_date: today }); }
        }
      }
      await sleep(150);
    }
    console.log(`  ${model} @${year}: ${trims.length} trims`);
  }
  console.log(`[${cfg.make}] ${msrpRows.length} MSRP, ${financeRows.length} finance, ${leaseRows.length} lease rows.`);
  await writeCatalogs(cfg.make, { msrpRows, financeRows, leaseRows });
}
