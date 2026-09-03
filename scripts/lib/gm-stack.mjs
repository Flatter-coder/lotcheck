// ── GM Canada (Chevrolet / GMC / Buick / Cadillac) MSRP scraper ────────────
// All four brands share the "byo-vc" configurator. MSRP is an unauthenticated
// GET; finance/lease APR is behind GM's session-gated IPE engine (403 to a
// scraper), so this populates msrp_catalog ONLY -- no fabricated rates.
//
// Flow:
//   1. {host}/en/build-and-price
//        -> byo-vc/client/en/CA/{brand}/{carline}/{year}/{body} tuples
//   2. {host}/byo-vc/api/v3/trim-matrix/en/CA/{brand}/{carline}/{year}/{body}
//        -> trims[].{ trimName, styleId, driveType, cabSize, configurations[] }
//        ENUMERATION ONLY. Its msrp field is never stored (see below).
//   3. {host}/byo-vc/api/v3/fully-configured/en/CA/{brand}/{carline}/{year}/{body}/{postal}?styleId=
//        -> modelMatrix.styles[styleId].baseMsrp  (the published sticker)
//
// WHY STEP 3 EXISTS (refresh run 33616461313, 2026-09-01). The original
// scraper stored trim-matrix `msrp.amount.value` fetched with
// `?postalCode=M5V2T6`. Every one of those values was fractional (37,393.50),
// so the shared quality gate correctly dropped 111/111 Chevrolet, 27/27 Buick
// and 62/62 Cadillac rows as "calculated, not published", and the catalog
// went stale. Investigated 2026-09-02 against the live endpoints:
//
//   - With the postal code, trim-matrix adds the province's levies (Ontario:
//     $22.00 OMVIC + $22.50 tire EHF = the .50). Without it the value is a
//     whole number, but it is STILL a construction: for the 2026 Equinox LT
//     FWD it is 37,349 = 34,599 sticker + 2,300 freight + 100 A/C + 350 of
//     something GM does not itemize; for the 2026 Escalade it also folds in
//     the estimated federal luxury tax. Neither the sticker nor the all-in.
//     A whole number is necessary for a published figure, not sufficient.
//   - fully-configured returns, per style, `baseMsrp` flagged
//     `enhancedPricingType: "BASE-MSRP"` and `priceState: "Actual"`, beside
//     the itemised `destinationPrice`, and summary.prices lists acTax (100),
//     dealerFee (699), the province's miscFees and, where it applies, the
//     luxury tax. baseMsrp + those = totalMsrp = the "Starting at" price on
//     chevrolet.ca, whose disclosure (msrp_2020) reads "Price includes
//     freight; $100 A/C charge; up to $699 dealer fee; ... other fees,
//     levies and duties". So baseMsrp is the figure BEFORE freight, A/C,
//     dealer fee and levies: price_basis = excl_freight.
//   - Cross-checked against GM Canada's own words: the 2027 Bolt press
//     release (gm.ca, 2025-10-09) says "$39,999 MSRP" and "Starting at
//     $43,470" with the same freight-inclusive footnote; fully-configured
//     returns baseMsrp 39,999 for the Bolt LT, identical for a Calgary and a
//     Toronto postal code, and 39,999 + 2,600 + 100 + 699 + provincial levies
//     reproduces both the $43,433 (AB) and $43,470 (NB) page prices.
//
// The path needs SOME postal code (the API rejects the call without one) but
// baseMsrp does not vary with it -- verified T2P1J9 vs M5V2T6 on 2026-09-02.
// The postal code only changes the levies, which we do not store.
//
// GMC HOST. www.gmc.ca does not resolve: SERVFAIL from the Telus resolver AND
// from 8.8.8.8 on 2026-09-02 (a zone-level failure, not a runner egress
// problem), which is what "[GMC] page fetch failed: fetch failed" was.
// www.gmccanada.ca is GM's own Akamai alias (www.gmccanada.ca.edgekey.net)
// and serves the identical build-and-price page and byo-vc API.
import { getJson, sleep, inferFuelFromName, writeCatalogs, parseArgs, UA } from "./catalog-io.mjs";

// Any valid Canadian postal code; the sticker is national (see header).
export const POSTAL = "T2P1J9";
export const PRICE_BASIS = "excl_freight";

export const GM_BRANDS = {
  chevrolet: { host: "https://www.chevrolet.ca",      make: "Chevrolet" },
  gmc:       { host: "https://www.gmccanada.ca",      make: "GMC" },
  buick:     { host: "https://www.buick.ca",          make: "Buick" },
  cadillac:  { host: "https://www.cadillaccanada.ca", make: "Cadillac" },
};

// Slug tokens GM writes in capitals or with punctuation. The list is what the
// four B&P pages exposed on 2026-09-02; anything not here is title-cased.
const TOKENS = {
  ev: "EV", hd: "HD", gx: "GX", xl: "XL", iq: "IQ", iql: "IQL", esv: "ESV",
  xt4: "XT4", xt5: "XT5", xt6: "XT6", ct4: "CT4", ct5: "CT5", ct4v: "CT4-V", ct5v: "CT5-V",
  z06: "Z06", zr1: "ZR1", zr1x: "ZR1X", eray: "E-Ray", gs: "Grand Sport",
  "2500hd": "2500HD", "3500hd": "3500HD",
};
// Whole slugs whose name carries no powertrain marker although the vehicle is
// battery-electric. GM's own body titles are "Hummer EV Pickup" and
// "Hummer EV SUV"; "Hummer" alone would violate the powertrain-identity rule
// (model-identity.js refuses a catalog name that drops a marker the listing
// carries, so a bare "Hummer" row would never even match).
const WHOLE = { hummer: "Hummer EV Pickup", hummersuv: "Hummer EV SUV" };

// The model name comes from the BODY slug when the body is more specific than
// the carline. Corvette is one carline with five bodies (corvette,
// corvette-z06, corvette-eray, corvette-zr1, corvette-zr1x, corvette-gs) and
// each has a "1LZ"/"1LT" trim: naming them all "Corvette" made the keys
// collide and dedupe kept the cheapest -- a ZR1 1LZ would have been quoted the
// Z06's sticker. Same for silverado/2025/silverado-2500hd and
// sierra/2025/sierra_2500hd, which the carline alone reads as a half-ton.
export function modelName(carline, body) {
  const b = String(body || "").toLowerCase().replace(/_/g, "-");
  const c = String(carline || "").toLowerCase().replace(/_/g, "-");
  const slug = b.startsWith(c) ? b : c;
  if (WHOLE[slug]) return WHOLE[slug];
  return slug.split("-").filter(Boolean)
    .map(w => TOKENS[w] || w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Powertrain from the configuration GM returns, never from the name. GM's
// data carries evPowertrains/battery for electric styles and an engine
// description ("3.0L Duramax Turbo Diesel engine", "5.3L V8 engine") for the
// rest. null when it says none of that -- a null is honest, a guess is not.
export function fuelFromConfig(cfg) {
  if (!cfg) return null;
  const eng = String(cfg.engine?.description || "").replace(/<[^>]+>/g, "");
  if ((cfg.evPowertrains && cfg.evPowertrains.length) || cfg.battery || /electric/i.test(eng)) return "BEV";
  if (/plug-?in/i.test(eng)) return "PHEV";
  if (/hybrid/i.test(eng)) return "Hybrid";
  if (/diesel/i.test(eng)) return "Diesel";
  if (/\d\.\dL|\bV[68]\b|\bengine\b/i.test(eng)) return "Gas";
  return null;
}

// The same class of defect tci-stack's flagAllOnePowertrain refuses: a whole
// nameplate tagged one powertrain while a powertrain-marked sibling exists.
// Here the fuel comes from GM's per-style data, so this should never fire;
// it is the backstop for the day GM's data is wrong, because a gas "Equinox"
// row tagged BEV would be matched to an Equinox EV listing as its sticker.
export function refuseMistaggedLines(rows) {
  const models = new Set(rows.map(r => `${r.year}|${r.model.toLowerCase()}`));
  const byLine = new Map();
  for (const r of rows) { const k = `${r.year}|${r.model}`; (byLine.get(k) || byLine.set(k, []).get(k)).push(r); }
  const refused = new Set();
  for (const [k, line] of byLine) {
    const [year, model] = k.split("|");
    const nameFuel = inferFuelFromName(model);
    if (nameFuel) continue;                       // the name carries its own marker
    if (!line.every(r => r.fuel_type === "BEV")) continue;
    if (models.has(`${year}|${model.toLowerCase()} ev`)) refused.add(k);
  }
  for (const k of refused) console.error(`  REFUSED: ${k} -- every trim tagged BEV while "${k.split("|")[1]} EV" exists; rows withheld.`);
  return rows.filter(r => !refused.has(`${r.year}|${r.model}`));
}

// One style -> its published sticker, or null with the reason. Every check is
// a reason to store NOTHING for the style: a missing row is recoverable, a
// wrong MSRP is a wrong claim in a buyer's report.
async function fetchBaseMsrp(host, brandCode, t, styleId) {
  const url = `${host}/byo-vc/api/v3/fully-configured/en/CA/${brandCode}/${t.carline}/${t.year}/${t.body}/${POSTAL}?styleId=${styleId}`;
  let data;
  try { data = await getJson(url); } catch (e) { return { reason: e.message }; }
  if (Number(data?.config?.styleId) !== Number(styleId)) return { reason: `API answered style ${data?.config?.styleId}, asked ${styleId}` };
  const style = (data?.modelMatrix?.styles || []).find(s => Number(s.styleId) === Number(styleId));
  if (!style) return { reason: "style not in modelMatrix" };
  if (style.priceState !== "Actual") return { reason: `priceState ${style.priceState}` };
  if (style.vehicleInfo?.enhancedPricingType !== "BASE-MSRP") return { reason: `pricing type ${style.vehicleInfo?.enhancedPricingType}` };
  const base = Number(style.baseMsrp?.value);
  if (!(Number.isInteger(base) && base > 0)) return { reason: `baseMsrp ${style.baseMsrp?.value}` };
  // The summary's standardVehiclePrice is the same sticker seen from the
  // other side of the response; if the two disagree the response is not
  // describing the style we asked for.
  const std = Number(data?.config?.summary?.prices?.standardVehiclePrice?.value);
  if (std !== base) return { reason: `baseMsrp ${base} != standardVehiclePrice ${std}` };
  return { msrp: base, url };
}

async function scrapeBrand(brandCode, { pin, model: onlyModel } = {}) {
  const { host, make } = GM_BRANDS[brandCode];
  // Keyed by year|model|trim so config variants (FWD/AWD, cab/box, engine)
  // collapse to one "starting at" sticker per trim -- the catalog's
  // exact-trim lookup. Every candidate is a fetched baseMsrp; the minimum of
  // published figures is itself a published figure.
  const byTrim = new Map();

  let html;
  try { html = await (await fetch(`${host}/en/build-and-price`, { headers: { "User-Agent": UA } })).text(); }
  catch (e) { console.warn(`[${make}] page fetch failed: ${e.message}`); return []; }

  const re = new RegExp(`byo-vc/client/en/CA/${brandCode}/([a-z0-9_-]+)/(20[0-9]{2})/([a-z0-9_-]+)`, "g");
  const seen = new Set();
  const tuples = [...html.matchAll(re)].map(m => ({ carline: m[1], year: Number(m[2]), body: m[3] }))
    .filter(t => { const k = `${t.carline}/${t.year}/${t.body}`; return seen.has(k) ? false : seen.add(k); })
    .filter(t => !pin || t.year === Number(pin))
    .filter(t => !onlyModel || t.carline === onlyModel || t.body === onlyModel);
  console.log(`[${make}] ${tuples.length} model/year/body tuples`);

  let styles = 0, skipped = 0;
  for (const t of tuples) {
    let matrix;
    // NO postalCode: the parameter only adds provincial levies, and this call
    // is for the style list, not the price.
    try { matrix = await getJson(`${host}/byo-vc/api/v3/trim-matrix/en/CA/${brandCode}/${t.carline}/${t.year}/${t.body}`); }
    catch (e) { console.warn(`  ${t.carline}/${t.year}/${t.body}: trim-matrix ${e.message.split(" for ")[0]}`); await sleep(120); continue; }
    const model = modelName(t.carline, t.body);
    const nameFuel = inferFuelFromName(model);

    for (const trim of (matrix.trims || [])) {
      const trimName = String(trim.trimName || trim.code || "").trim() || null;
      const styleId = Number(trim.styleId);
      if (!(styleId > 0)) continue;
      styles++;
      const got = await fetchBaseMsrp(host, brandCode, t, styleId);
      await sleep(120);
      if (!got.msrp) { skipped++; console.warn(`  skip ${model} ${trimName ?? ""} #${styleId}: ${got.reason}`); continue; }

      // Fuel of the cheapest configuration of THIS style, from GM's data.
      const cfgs = (trim.configurations || []).slice().sort((a, b) => (Number(a?.msrp?.amount?.value) || Infinity) - (Number(b?.msrp?.amount?.value) || Infinity));
      const fuel = fuelFromConfig(cfgs[0]) ?? (nameFuel === "BEV" ? "BEV" : null);
      // Name and data must agree on the powertrain, or the row is withheld:
      // "Equinox EV" with a gasoline engine description is a wrong car.
      if (nameFuel && fuel && nameFuel !== fuel) { skipped++; console.warn(`  skip ${model} ${trimName ?? ""} #${styleId}: name says ${nameFuel}, GM config says ${fuel}`); continue; }

      const key = `${t.year}|${model}|${trimName}`;
      const prev = byTrim.get(key);
      if (!prev || got.msrp < prev.msrp) {
        byTrim.set(key, {
          year: t.year, make, model, trim: trimName, msrp: got.msrp, fuel_type: fuel,
          price_basis: PRICE_BASIS, source_url: got.url, fetched_at: new Date().toISOString(),
        });
      }
    }
  }
  const msrpRows = refuseMistaggedLines([...byTrim.values()]);
  console.log(`[${make}] ${styles} styles fetched, ${skipped} skipped, ${msrpRows.length} MSRP rows`);
  return msrpRows;
}

export async function run() {
  const args = parseArgs();
  const brands = args.brand ? [args.brand] : Object.keys(GM_BRANDS);
  const all = [];
  for (const b of brands) {
    if (!GM_BRANDS[b]) { console.warn(`unknown brand "${b}" (expected one of ${Object.keys(GM_BRANDS).join(", ")})`); continue; }
    try { all.push(...await scrapeBrand(b, { pin: args.year, model: args.model })); }
    catch (e) { console.warn(`[${GM_BRANDS[b].make}] skipped: ${e.message}`); }
  }
  // Group by make so each brand's msrp_catalog rows are replaced independently.
  const byMake = {};
  for (const r of all) (byMake[r.make] ||= []).push(r);
  for (const make of Object.keys(byMake)) {
    await writeCatalogs(make, { msrpRows: byMake[make], financeRows: [], leaseRows: [] }, { priceBasis: PRICE_BASIS });
  }
  if (!Object.keys(byMake).length) console.log("No rows.");
}
