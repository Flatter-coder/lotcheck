// ── Mitsubishi Motors Canada MSRP scraper ──────────────────────────────────
// mitsubishi-motors.ca is a server-rendered Apollo app: every page ships its
// data inline as `window.__APOLLO_STATE__`, and the Build & Price configurator
// talks to an open GraphQL endpoint. Nothing here needs a browser, a key, or a
// paid render. Two manufacturer surfaces carry the trim ladder and they must
// agree before a row is written:
//
//   1. Model landing page  {host}/en/vehicles/{slug}   (plain GET)
//        __APOLLO_STATE__ -> TablesContainer.tableTabbed.products[]
//        = { name, code, fuelType, engineSize, drivetrain, price{value,baseValue} }
//        plus the MSRP footnote the table cites ("excluding taxes, freight and
//        pre-delivery inspection charges ..."), which fixes the basis.
//        This is the page a buyer can open and check, so it is source_url.
//   2. Configurator GraphQL  POST https://www-graphql.prod.mipulse.co/prod/graphql
//        operation getModelSelector -> getModelsSelector.models[]
//        keyed by the same model code (e.g. GM2WXTMCZL3M-NA_C61).
//        The selection.vehicle argument is the vehicle GUID from the
//        configurator page's `retiredVehicleInfo.latestVehicleInfo[]`
//        (bjp0e8elcw88ozs2ddv17l = Outlander), NOT the two-letter vehicle code
//        (DG). scripts/MITSUBISHI-NOTES.md tried the codes and got "Vehicle not
//        found" -- that was the one missing param.
//
// Where the two disagree on a price, the row is dropped (missing beats wrong).
// Where GraphQL is unreachable, the landing-page rows still ship: an
// availability failure degrades, it does not zero a make.
//
// POWERTRAIN: the GraphQL `fuelType` field says "Unleaded" for the Outlander
// PHEV as well as the gas Outlander. It is the fuel that goes in the tank, not
// the powertrain, and trusting it would tag a whole PHEV line as gas -- the
// exact defect class flagAllOnePowertrain exists for on the Toyota stack. The
// powertrain here is taken from the manufacturer's own model NAME ("Outlander
// PHEV") and cross-checked against `engineSize` ("PHEV SYSTEM"); a line whose
// engine says PHEV but whose name does not is refused rather than guessed.
import { sleep, writeCatalogs, parseArgs, UA } from "./catalog-io.mjs";

const MAKE = "Mitsubishi";
export const HOST = "https://www.mitsubishi-motors.ca";
export const CONFIGURATOR_PAGE = `${HOST}/en/buy/configure-your-mitsubishi/configurator`;
export const GRAPHQL = "https://www-graphql.prod.mipulse.co/prod/graphql";
// The CMS content path the configurator passes as `path` (getCmsPath() in the
// site bundle: "/" + market + pathname).
const CMS_PATH = "/ca/en/buy/configure-your-mitsubishi/configurator";

// Field-for-field subset of the site's own getModelSelector operation
// (mmc.*.js, key getModelsSelector). Only the fields this scraper reads.
const MODEL_SELECTOR_QUERY = `query getModelSelector($market:String!, $language:String!, $path:String!, $selection: SelectionInput!, $zipCode: String){
  getModelsSelector(market:$market, language:$language, path:$path, selection:$selection, zipCode:$zipCode){
    msrpLabel
    vehicleInfo { year name code }
    models { code name trimLine fuelType drivetrain engineType
      price { value baseValue fees { label value } } }
  }
}`;

const strip = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

async function getHtml(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// `window.__APOLLO_STATE__ = {...};` sits in an inline <script>. The object
// contains "</script>" inside string values, so a regex up to the closing tag
// is not safe; walk braces while honouring JSON string escapes instead.
export function readApolloState(html) {
  const marker = "window.__APOLLO_STATE__ =";
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const start = html.indexOf("{", i);
  let depth = 0, inStr = false, esc = false;
  for (let k = start; k < html.length; k++) {
    const c = html[k];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(html.slice(start, k + 1));
  }
  return null;
}

// Nameplates as the manufacturer prints them, in nav casing:
// "2026 OUTLANDER PHEV" -> "Outlander PHEV", "2027 RVR" -> "RVR".
const KEEP_UPPER = new Set(["RVR", "PHEV", "EV"]);
export function modelNameFromLabel(label) {
  return String(label || "").replace(/^\s*20\d{2}\s+/, "").trim().split(/\s+/)
    .map((w) => (KEEP_UPPER.has(w.toUpperCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
}

// Powertrain from the manufacturer's NAME first, engine string second, and a
// refusal where they disagree. Returns { fuel, refuse }.
export function inferPowertrain(modelName, engine) {
  const n = String(modelName || "").toLowerCase();
  const e = String(engine || "").toLowerCase();
  const engineElectrified = /phev|plug-?in|hybrid|electric|\bev\b|kwh/.test(e) && !/mild hybrid|48v/.test(e);
  if (/phev|plug-?in/.test(n)) return { fuel: "PHEV" };
  if (/\bev\b|electric/.test(n)) return { fuel: "BEV" };
  if (/hybrid/.test(n)) return { fuel: "Hybrid" };
  if (engineElectrified) return { fuel: null, refuse: `engine "${engine}" is electrified but the model name "${modelName}" carries no powertrain marker` };
  // "1.5L 4 CYL TURBO 48V BSG": a belt starter-generator mild hybrid that
  // Mitsubishi sells under the plain nameplate. Fuel is gasoline; it is not
  // the "Hybrid" powertrain class a buyer means by the word.
  if (/\d\.\dl|cylinder|\bcyl\b/.test(e)) return { fuel: "Gas" };
  return { fuel: null };
}

// The vehicles the site itself lists: header nav cards carry code + "YEAR
// NAME" + landing-page URL; the configurator block carries the GUID GraphQL
// needs and the model years it serves. Joined on the vehicle code.
export function enumerateVehicles(state) {
  const navByCodeYear = new Map();
  for (const [k, v] of Object.entries(state)) {
    if (!/^Vehicle_\d+_navlink$/.test(k) || !v?.code || !v?.name) continue; // "COMING SOON" cards have code null
    const cta = state[`$${k}.cta`];
    const year = Number((v.name.match(/^(20\d{2})\b/) || [])[1]);
    if (!year || !cta?.url) continue;
    navByCodeYear.set(`${v.code}|${year}`, { code: v.code, year, label: v.name, url: cta.url.startsWith("http") ? cta.url : HOST + cta.url });
  }
  const configurator = new Map();
  for (const [k, v] of Object.entries(state)) {
    if (v?.__typename !== "vehicleSelectorYear" || !v.vehicleCode || !v.vehicleGuid) continue;
    const years = Array.isArray(v.yearList?.json) ? v.yearList.json : Array.isArray(v.yearList) ? v.yearList : [];
    configurator.set(v.vehicleCode, { guid: v.vehicleGuid, years: years.map(Number).filter(Boolean) });
  }
  const out = [];
  const seen = new Set();
  for (const [, nav] of navByCodeYear) {
    const c = configurator.get(nav.code);
    out.push({ ...nav, guid: c?.guid ?? null });
    seen.add(`${nav.code}|${nav.year}`);
  }
  // A model year the configurator serves but the nav does not link yet (a
  // next-year launch) has no landing page; it is reported, never priced from
  // the configurator alone -- there is no page for the buyer to verify.
  for (const [code, c] of configurator) {
    for (const y of c.years) if (!seen.has(`${code}|${y}`)) out.push({ code, year: y, label: null, url: null, guid: c.guid });
  }
  return out.sort((a, b) => a.code.localeCompare(b.code) || b.year - a.year);
}

// The landing page's own trim ladder, with the footnote it cites.
export function parseModelPage(state) {
  const cp = Object.values(state).find((v) => v?.__typename === "ContentPage");
  const pageYear = Number((String(cp?.id || "").match(/\/(20\d{2})$/) || [])[1]) || null;
  let jsonLd = null;
  try { jsonLd = JSON.parse(Object.values(state).find((v) => v?.__typename === "JsonLD")?.jsonLDData || "null"); } catch { /* absent */ }

  const tables = Object.entries(state).filter(([k, v]) => /^\$TablesContainer_[^.]+\.tableTabbed$/.test(k) && v?.__typename === "ProductList");
  const products = [];
  let includeFees = false;
  for (const [tk, t] of tables) {
    if (t.includeFees) includeFees = true;
    for (const [k, p] of Object.entries(state)) {
      if (!k.startsWith(`${tk}.products.`) || !/\.products\.\d+$/.test(k)) continue;
      const price = state[`${k}.price`];
      products.push({ name: strip(p.name), code: p.code, fuelType: p.fuelType, engine: p.engineSize, drivetrain: p.drivetrain,
        value: price?.value, baseValue: price?.baseValue });
    }
  }
  // The footnote is identified by what it SAYS, not by its CMS id: the RVR
  // pages point their table at disclaimer "*", which is the driver-aids
  // notice, while the MSRP text sits under id "1" on the same page.
  const footnote = Object.values(state)
    .filter((v) => v?.__typename === "SimpleDisclaimer")
    .map((v) => strip(v.detail))
    .find((t) => /MSRP is the Manufacturer.s Suggested Retail Price/i.test(t)) || null;
  return { pageYear, sku: jsonLd?.sku ?? null, jsonLdName: jsonLd?.name ?? null, products, includeFees, footnote };
}

// The basis the page states, or nothing. "excluding taxes, freight and
// pre-delivery inspection charges" is the catalog's excl_freight; if the
// wording ever changes to include freight, no basis is stamped and the report
// falls back to its freight caveat rather than asserting one.
export function basisFromFootnote(footnote) {
  const t = String(footnote || "").toLowerCase();
  if (!t) return null;
  if (/excluding[^.]*freight/.test(t)) return "excl_freight";
  if (/includ(es|ing)[^.]*freight/.test(t)) return "incl_freight";
  return null;
}

// The configurator's getModelSelector, exactly as the page sends it: market,
// language, CMS path, and a selection whose `url` mirrors the browser
// location (the resolver parses it; without it the call throws
// "updateQueryStringParameter ... indexOf"). No zipCode: the site uses that
// for province all-in pricing and we want the published MSRP.
export async function fetchConfiguratorModels(guid, year) {
  const url = `/en/buy/configure-your-mitsubishi/configurator?vehicle=${guid}&year=${year}&step=ModelSelector`;
  const body = {
    operationName: "getModelSelector",
    query: MODEL_SELECTOR_QUERY,
    variables: { market: "ca", language: "en", path: CMS_PATH, selection: { vehicle: guid, year, url } },
  };
  const res = await fetch(GRAPHQL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA, Origin: HOST, Referer: `${HOST}/` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const j = await res.json();
  if (j.errors?.length) throw new Error(`GraphQL: ${j.errors.map((e) => e.message).join("; ").slice(0, 200)}`);
  const g = j.data?.getModelsSelector;
  if (!g) throw new Error("GraphQL: empty getModelsSelector");
  return { vehicleInfo: g.vehicleInfo, models: g.models || [], pageUrl: HOST + url };
}

export async function run() {
  const args = parseArgs();
  const wantYear = args.year ? Number(args.year) : null;
  const wantModel = args.model ? String(args.model).toLowerCase() : null;

  const state = readApolloState(await getHtml(CONFIGURATOR_PAGE));
  if (!state) throw new Error(`no __APOLLO_STATE__ on ${CONFIGURATOR_PAGE}`);
  let vehicles = enumerateVehicles(state);
  if (wantYear) vehicles = vehicles.filter((v) => v.year === wantYear);
  if (wantModel) vehicles = vehicles.filter((v) => v.code.toLowerCase() === wantModel || (v.url || "").toLowerCase().endsWith(`/${wantModel}`) || modelNameFromLabel(v.label).toLowerCase() === wantModel);
  console.log(`[${MAKE}] ${vehicles.length} vehicle/year entries on the site`);

  const msrpRows = [];
  let gqlDown = false;
  for (const v of vehicles) {
    const tag = `${v.code} ${v.year}`;
    if (!v.url) { console.log(`  ${tag}: configurator lists this model year but the site links no landing page yet -- not priced`); continue; }

    let page;
    try { page = parseModelPage(readApolloState(await getHtml(v.url)) || {}); }
    catch (e) { console.warn(`  ${tag}: landing page failed (${e.message})`); await sleep(300); continue; }
    const model = modelNameFromLabel(v.label);
    if (!page.products.length) { console.log(`  ${model} ${v.year}: no published trim table on ${v.url} -- not priced`); await sleep(300); continue; }
    // The page must be about the vehicle-year the nav sent us to. The JSON-LD
    // sku is the vehicle code and the content id ends in the model year.
    if (page.sku && page.sku !== v.code) { console.warn(`  ${tag}: ${v.url} declares sku ${page.sku}; skipped`); continue; }
    if (page.pageYear && page.pageYear !== v.year) { console.warn(`  ${tag}: ${v.url} is the ${page.pageYear} page; skipped`); continue; }
    if (page.includeFees) { console.warn(`  ${tag}: table is flagged includeFees -- not a published MSRP; skipped`); continue; }
    const basis = basisFromFootnote(page.footnote);
    if (!basis) console.warn(`  ${tag}: no MSRP basis footnote found on ${v.url}; rows carry price_basis null`);

    // Corroborate against the configurator, per model code.
    let gql = null;
    if (v.guid && !gqlDown) {
      try { gql = await fetchConfiguratorModels(v.guid, v.year); }
      catch (e) {
        if (/HTTP 5\d\d|fetch failed|ENOTFOUND|ECONNRESET|timeout/i.test(e.message)) { gqlDown = true; console.warn(`  configurator GraphQL unreachable (${e.message}); landing-page rows ship without corroboration`); }
        else console.warn(`  ${tag}: configurator query failed (${e.message}); rows ship without corroboration`);
      }
      await sleep(250);
    }
    const gqlByCode = new Map((gql?.models || []).map((m) => [m.code, m]));
    if (gql?.vehicleInfo?.name && gql.vehicleInfo.name !== model) console.warn(`  ${tag}: nav says "${model}", configurator says "${gql.vehicleInfo.name}"`);

    let kept = 0, dropped = 0;
    for (const p of page.products) {
      const msrp = Number(p.value);
      if (!(msrp > 0) || msrp !== Number(p.baseValue)) { dropped++; console.warn(`  ${model} ${p.name}: price ${p.value} != baseValue ${p.baseValue}; dropped`); continue; }
      const g = gqlByCode.get(p.code);
      if (gql && !g) { dropped++; console.warn(`  ${model} ${p.name} (${p.code}): on the page, not in the configurator; dropped`); continue; }
      if (g) {
        const gv = Number(g.price?.value);
        if (gv !== msrp || (g.price?.fees || []).length) { dropped++; console.warn(`  ${model} ${p.name}: page $${msrp} vs configurator $${gv} (${(g.price?.fees || []).length} fees); dropped`); continue; }
      }
      const { fuel, refuse } = inferPowertrain(model, p.engine || g?.engineType);
      if (refuse) { dropped++; console.error(`  REFUSED ${model} ${p.name}: ${refuse}`); continue; }
      msrpRows.push({
        year: v.year, make: MAKE, model, trim: p.name || null, msrp,
        fuel_type: fuel, price_basis: basis, source_url: v.url, fetched_at: new Date().toISOString(),
      });
      kept++;
    }
    console.log(`  ${model} ${v.year}: ${kept} trims${dropped ? `, ${dropped} dropped` : ""}${gql ? " (configurator agrees)" : ""} -- ${v.url}`);
    if (page.footnote) console.log(`    basis: ${basis ?? "none"} -- "${page.footnote.slice(0, 160)}..."`);
    await sleep(300);
  }

  console.log(`[${MAKE}] ${msrpRows.length} MSRP rows.`);
  await writeCatalogs(MAKE, { msrpRows, financeRows: [], leaseRows: [] });
}
