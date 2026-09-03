// ── Honda / Acura Canada MSRP + finance/lease-rate scraper (shared platform) ─
// Both run the same Sitecore "dmmapi" + api.honda.ca financials platform.
// Flow (all plain fetch, no browser at runtime — see scripts/HONDA-NOTES.md):
//   1. Build&Price page HTML  -> models { GUID, model_key, modelName, years[] }
//   2. dmmapi trimswithtransmissions/model/{GUID}/{year}
//                             -> trims[] NAMES keyed by trim detKey (no prices)
//   3. POST api.honda.ca .../website/price-calculator/{PROVINCE}
//        body [{ modelKey, modelYear }]
//                             -> Models[].Trims[].Transmissions[].Msrp  (MSRP)
//   4. POST api.honda.ca .../website/calculator/payment { ...config, PaymentOptions[] }
//                             -> per-term finance/lease APR             (rates)
//
// WHY MSRP AND RATES ARE TWO SEPARATE CALLS. Until 2026-09-02 the MSRP was read
// off the same calculator/payment response as the APRs, so when that endpoint
// started answering "403 Forbidden / Microsoft-Azure-Application-Gateway" on
// 2026-08-21, every Honda and Acura MSRP went dark along with the rates (run
// 33616461313: "Prologue EX: payment HTTP 403", every model). The block is not
// IP, UA or cookie based: an EMPTY body gets an application-level 400
// (ModelState errors), the real body gets the gateway 403, and the one field
// carrying an unusual character is InteriorColorKey
// ("bkblack_fabric_^2021_civic_sedan") -- a bare {"ProvinceKey":"O^N"} is
// enough to trip it. It is a WAF rule on "^" in the request body.
//
// price-calculator takes [{ modelKey, modelYear }] -- no colour keys, nothing
// for that rule to match -- and answers with the very ladder Honda's own model
// pages render as "MSRP Starting From". Verified 2026-09-02: Civic Sedan LX
// 2026 = 28440 on both endpoints; identical Msrp for ON/AB/BC/QC (only
// LevyTotal moves with province); colour surcharge is a separate MsrpMarkup
// (Crystal Black Pearl +550 -> 28990) so the trim figure is never a painted one.
//
// BASIS. The Msrp here excludes freight & PDI: the same response carries
// FreightPdiCost (1830 for Civic) and LevyTotal separately, and SellingPrice =
// Msrp + freight + levies. Honda's own tooltip beside the figure reads "Value
// does not include freight, PDI, applicable taxes, license, registration,
// levies and fees." -> price_basis "excl_freight".
import { getJson, sleep, inferFuelFromName, writeCatalogs, parseArgs, UA } from "./catalog-io.mjs";

const FIN_TERMS = [36, 48, 60, 72, 84];
const LEASE_TERMS = [24, 36, 48, 60];
const LEASE_KM = 20000;
// Fallback only: the Build&Price page states each model's years (HR-V is a 2027
// while everything else is 2026) and those are used first. This list is probed
// only when the page parse yields no years for a model.
const YEARS = [2026, 2025, 2027];
// MSRP is national -- the same figure came back for ON, AB, BC and QC on
// 2026-09-02 -- so the province only decides the levy lines we do not store.
// ON matches the rates request below.
const PROVINCE = "ON";

const dash = g => (g && g.length === 32)
  ? `${g.slice(0,8)}-${g.slice(8,12)}-${g.slice(12,16)}-${g.slice(16,20)}-${g.slice(20)}`.toLowerCase() : g;
const get = (o, path) => path.split(".").reduce((x, k) => (x == null ? x : x[k]), o);

// The build page carries Honda's own marketing casing ("CR-V", "HR-V", "MDX",
// "Civic Si"); dmmapi's model.name is shouted ("CRV", "CIVIC SEDAN") and the
// old titleCase() of it wrote "Cr-V", "Hr-V", "Mdx", "Adx" into the catalog
// (08-15 dry run). Prefer the page name; fold a fully-shouted word of four or
// more letters ("PROLOGUE") to title case and leave badge-style names (CR-V,
// MDX, ZDX, Type R) exactly as Honda writes them.
const MODEL_NAME_OVERRIDES = {
  // The page labels this model just "Type R"; the nameplate is Civic and the
  // catalog has carried "Civic Type R" since the first dry run.
  civic_type_r: "Civic Type R",
};
function modelDisplayName(key, pageName, dmmName) {
  if (MODEL_NAME_OVERRIDES[key]) return MODEL_NAME_OVERRIDES[key];
  const src = String(pageName || dmmName || key).trim();
  return src.split(/\s+/).map(w => (/^[A-Z]{4,}$/.test(w) ? w[0] + w.slice(1).toLowerCase() : w)).join(" ");
}

// Models from the Build&Price page JSS. Each model object opens with
//   {"id":"<32-hex>","name":"CRV","detKey":{"value":"cr-v"}, ... "modelName":{"value":"CR-V"}, ... "modelYears":[{... "year":{"value":"2026"}}]}
// Trim/colour objects also carry id+detKey but their detKey sits under
// "fields", never straight after "name", so the header regex does not see them.
// The old pattern only allowed [a-z0-9_] in the key and so silently dropped
// CR-V ("cr-v") -- Honda's best-selling model was absent from every run.
function parseModels(html) {
  const header = /"id":"([0-9A-F]{32})","name":"([^"]*)","detKey":\{"value":"([a-z][a-z0-9_-]*)"\}/g;
  const heads = [...html.matchAll(header)];
  const seen = new Set(), models = [];
  heads.forEach((m, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : Math.min(html.length, m.index + 40000);
    const block = html.slice(m.index, end);
    const name = block.match(/"modelName":\{"value":"([^"]*)"\}/)?.[1];
    if (!name || seen.has(m[1])) return;           // not a model object, or a repeat
    seen.add(m[1]);
    const years = [...new Set([...block.matchAll(/"year":\{"value":"(\d{4})"\}/g)].map(y => Number(y[1])))];
    models.push({ guid: m[1], key: m[3], name, years });
  });
  return models;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA, "AcceptLanguage": "en" },
    body: JSON.stringify(body),
  });
  // The gateway's 403 is an HTML page; flatten it so one refusal is one log line.
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).replace(/\s+/g, " ").slice(0, 120)}`);
  return res.json();
}

export async function run(cfg) {
  // cfg: { make, host, page, apiBase, apikey, site }
  //   apiBase is the worksheet root, e.g.
  //   https://api.honda.ca/financials-worksheets/H/Live/website
  const args = parseArgs();
  const today = new Date().toISOString().slice(0, 10);

  // 1. Enumerate models from the Build&Price page JSS.
  const html = await (await fetch(cfg.page, { headers: { "User-Agent": UA } })).text();
  const models = parseModels(html);
  const list = args.model ? models.filter(m => m.key === args.model) : models;
  console.log(`[${cfg.make}] ${list.length} models`);

  const msrpRows = [], financeRows = [], leaseRows = [];
  const finSeen = new Set(), leaseSeen = new Set();

  for (const mdl of list) {
    const years = args.year ? [Number(args.year)] : (mdl.years.length ? mdl.years : YEARS);
    // Page years are exact, so every one is read. The probe list is a guess, so
    // it stops at the first year that has trims (the pre-09-02 behaviour).
    const stopAtFirst = !args.year && !mdl.years.length;
    let anyYear = false;

    for (const year of years) {
      // 2. Trim names (and the config keys the rates call needs) from dmmapi.
      //    A model-year Honda does not sell answers HTTP 400 here.
      let tree = null;
      try {
        tree = await getJson(`${cfg.host}/dmmapi/trimswithtransmissions/model/${dash(mdl.guid)}/${year}?sc_apikey=${cfg.apikey}&sc_site=${cfg.site}&sc_lang=en`);
      } catch { /* no such model-year */ }
      const trims = get(tree, "model.modelYear.trims");
      if (!Array.isArray(trims) || !trims.length) continue;
      anyYear = true;
      const model = modelDisplayName(mdl.key, mdl.name, tree.model?.name);
      const nameByKey = new Map(trims.map(t => [get(t, "fields.detKey.value"), (t.name || "").trim()]));

      // 3. MSRP per trim from price-calculator. One trim can list several
      //    transmissions (each with its own Msrp); the lowest is the trim's
      //    "starting from" figure, matching the catalog's exact-trim lookup.
      let priced = 0;
      try {
        const pc = await postJson(`${cfg.apiBase}/price-calculator/${PROVINCE}`, [{ modelKey: mdl.key, modelYear: year }]);
        for (const pt of get(pc, "Models.0.Trims") || []) {
          const trim = nameByKey.get(pt.Key);
          if (!trim) { console.log(`  ${model} @${year}: price for unnamed trim key ${pt.Key} skipped`); continue; }
          const msrps = (pt.Transmissions || []).map(x => Number(x.Msrp)).filter(v => v > 0);
          if (!msrps.length) continue;
          msrpRows.push({
            year, make: cfg.make, model, trim, msrp: Math.min(...msrps),
            fuel_type: inferFuelFromName(`${model} ${trim}`),
            price_basis: "excl_freight",
            // The page a buyer can open to see the same ladder.
            source_url: `${cfg.page}/trims?model_key=${mdl.key}&model_year=${year}`,
            fetched_at: new Date().toISOString(),
          });
          priced++;
        }
      } catch (e) { console.log(`  ${model} @${year}: price-calculator ${e.message}`); }
      await sleep(150);

      // 4. Finance / lease APR from calculator/payment -- unchanged. This call
      //    has been refused by the gateway since 2026-08-21 (see header); it is
      //    left as-is so nothing here fabricates a rate, and writeCatalogs
      //    leaves the rate tables untouched when the arrays come back empty.
      for (const t of trims) {
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
          ProvinceKey: PROVINCE, ModelYear: year, ModelKey: mdl.key, TrimKey: trimKey,
          TransmissionKey: transmissionKey, ExteriorColorKey: exteriorColorKey, InteriorColorKey: interiorColorKey,
          IncludeFees: true, IncludeTaxes: false,
          Accessories: [], Protections: [], ProtectionAddOns: [], OwnerPrograms: [], OfferKeys: [], WarrantyKey: "",
          PaymentOptions: paymentOptions,
        };
        let resp;
        try { resp = await postJson(`${cfg.apiBase}/calculator/payment`, body); }
        catch (e) { console.log(`  ${model} ${t.name}: payment ${e.message}`); await sleep(120); continue; }

        for (const o of resp?.PaymentOptions || []) {
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
      console.log(`  ${model} @${year}: ${trims.length} trims, ${priced} priced`);
      if (stopAtFirst) break;
    }
    if (!anyYear) console.log(`  ${mdl.key}: no trims for ${years.join("/")}`);
  }
  console.log(`[${cfg.make}] ${msrpRows.length} MSRP, ${financeRows.length} finance, ${leaseRows.length} lease rows.`);
  await writeCatalogs(cfg.make, { msrpRows, financeRows, leaseRows }, { priceBasis: "excl_freight" });
}
