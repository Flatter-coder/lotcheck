// ── GM Canada (Chevrolet / GMC / Buick / Cadillac) MSRP scraper ────────────
// All four share the "byo-vc" configurator. MSRP is a clean unauthenticated
// GET; finance/lease APR is behind GM's session-gated IPE engine (403 to a
// scraper), so this populates msrp_catalog ONLY — no fabricated rates.
//   1. {host}/en/build-and-price  -> byo-vc/client/en/CA/{brand}/{carline}/{year}/{body} tuples
//   2. {host}/byo-vc/api/v3/trim-matrix/en/CA/{brand}/{carline}/{year}/{body}?postalCode=
//        -> trims[].{ trimName, msrp.amount.value }
import { getJson, sleep, inferFuelFromName, writeCatalogs, parseArgs, UA } from "./catalog-io.mjs";

const POSTAL = "M5V2T6";
export const GM_BRANDS = {
  chevrolet: { host: "https://www.chevrolet.ca",     make: "Chevrolet" },
  gmc:       { host: "https://www.gmc.ca",           make: "GMC" },
  buick:     { host: "https://www.buick.ca",         make: "Buick" },
  cadillac:  { host: "https://www.cadillaccanada.ca", make: "Cadillac" },
};

const titleModel = slug => slug.split("-").map(w => /^ev$/i.test(w) ? "EV" : w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

async function scrapeBrand(brandCode, { pin } = {}) {
  const { host, make } = GM_BRANDS[brandCode];
  const today = new Date().toISOString().slice(0, 10);
  // Keyed by year|model|trim so config variants (FWD/AWD/engine) collapse to
  // one "starting at" MSRP per trim — matches the catalog's exact-trim lookup.
  const byTrim = new Map();

  let html;
  try { html = await (await fetch(`${host}/en/build-and-price`, { headers: { "User-Agent": UA } })).text(); }
  catch (e) { console.warn(`[${make}] page fetch failed: ${e.message}`); return []; }

  // (carline, year, bodystyle) tuples from the byo-vc client links.
  const re = new RegExp(`byo-vc/client/en/CA/${brandCode}/([a-z0-9_-]+)/(20\\d{2})/([a-z0-9_-]+)`, "g");
  const seen = new Set();
  const tuples = [...html.matchAll(re)].map(m => ({ carline: m[1], year: Number(m[2]), body: m[3] }))
    .filter(t => { const k = `${t.carline}/${t.year}/${t.body}`; return seen.has(k) ? false : seen.add(k); })
    .filter(t => !pin || t.year === Number(pin));
  console.log(`[${make}] ${tuples.length} model/year/body tuples`);

  for (const t of tuples) {
    let data;
    try { data = await getJson(`${host}/byo-vc/api/v3/trim-matrix/en/CA/${brandCode}/${t.carline}/${t.year}/${t.body}?postalCode=${POSTAL}`); }
    catch { await sleep(90); continue; }
    const model = titleModel(t.carline);
    const fuel = inferFuelFromName(`${model}`) || (/-ev$|bolt|lyriq|hummer-ev/.test(t.carline) ? "BEV" : null);
    for (const trim of (data.trims || [])) {
      const msrp = Number(trim?.msrp?.amount?.value)
        || Number((trim.configurations || []).map(c => c?.msrp?.amount?.value).filter(Boolean).sort((a, b) => a - b)[0]);
      if (!(msrp > 0)) continue;
      const trimName = (trim.trimName || trim.code || "").toString().trim() || null;
      const key = `${t.year}|${model}|${trimName}`;
      const prev = byTrim.get(key);
      if (!prev || msrp < prev.msrp) byTrim.set(key, { year: t.year, make, model, trim: trimName, msrp, fuel_type: fuel, fetched_at: new Date().toISOString() });
    }
    await sleep(90);
  }
  const msrpRows = [...byTrim.values()];
  console.log(`[${make}] ${msrpRows.length} MSRP rows`);
  return msrpRows;
}

export async function run() {
  const args = parseArgs();
  const brands = args.brand ? [args.brand] : Object.keys(GM_BRANDS);
  const all = [];
  for (const b of brands) {
    try { all.push(...await scrapeBrand(b, { pin: args.year })); }
    catch (e) { console.warn(`[${GM_BRANDS[b].make}] skipped: ${e.message}`); }
  }
  // Group by make so each brand's msrp_catalog rows are replaced independently.
  const byMake = {};
  for (const r of all) (byMake[r.make] ||= []).push(r);
  for (const make of Object.keys(byMake)) {
    await writeCatalogs(make, { msrpRows: byMake[make], financeRows: [], leaseRows: [] });
  }
  if (!Object.keys(byMake).length) console.log("No rows.");
}
