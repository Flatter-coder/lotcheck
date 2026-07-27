// Volvo Canada MSRP scraper (MSRP only, model-level starting price).
// Volvo's /en-ca/build/{model} SSR exposes only the starting MSRP per model
// (data-testid="car-price-offer-price", bound to priceSummary.totalPrice).
// Per-trim (Core/Plus/Ultra) prices load via gated GraphQL, so this stores one
// starting-MSRP row per model (trim=null). Node fetch reaches Volvo (Akamai).
import { inferFuelFromName, sleep, writeCatalogs, parseArgs, UA } from "./lib/catalog-io.mjs";

const MAKE = "Volvo";
const HOST = "https://www.volvocars.com";
const HDRS = { "User-Agent": UA, "Accept": "text/html", "Accept-Language": "en-CA,en;q=0.9", "sec-ch-ua": '"Chromium";v="126"', "sec-ch-ua-platform": '"Windows"', "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate" };
const num = s => Number(String(s || "").replace(/[^0-9.]/g, "")) || 0;
const titleize = s => s.replace(/-/g, " ").replace(/\b(electric|hybrid|cross country)\b/gi, m => m.replace(/\b\w/g, c => c.toUpperCase()))
  .replace(/\b([a-z])(\w*)/gi, (_, a, b) => a.toUpperCase() + b).replace(/\b(Ex|Ec|Xc|Ev|Ev\d|V|S)(\d+)\b/g, (_, p, n) => p.toUpperCase() + n).trim();

async function main() {
  const args = parseArgs();
  const year = new Date().getUTCFullYear();
  // Candidate build slugs from the homepage nav.
  const home = await (await fetch(`${HOST}/en-ca/`, { headers: HDRS })).text();
  const slugs = [...new Set([...home.matchAll(/\/en-ca\/build\/([a-z0-9-]+)/g)].map(m => m[1]))]
    .filter(s => s && s !== "print");
  // Fall back to known lineup if nav discovery is thin.
  for (const s of ["xc90", "xc60", "xc40", "s90", "v90-cross-country", "v60-cross-country", "ex30-electric", "ex40-electric", "ec40-electric", "ex90-electric", "xc90-hybrid", "xc60-hybrid"]) if (!slugs.includes(s)) slugs.push(s);
  console.log(`[${MAKE}] ${slugs.length} candidate models`);

  const byModel = new Map();
  for (const slug of slugs) {
    if (args.model && slug !== args.model) continue;
    let html;
    try { html = await (await fetch(`${HOST}/en-ca/build/${slug}`, { headers: HDRS })).text(); }
    catch { await sleep(150); continue; }
    const m = html.match(/data-testid="car-price-offer-price"[^>]*><span>(\$[0-9,]+)/)
      || html.match(/data-sources="[^"]*totalPrice\.display"[^>]*><span>(\$[0-9,]+)/);
    const msrp = m ? num(m[1]) : 0;
    if (!(msrp > 0)) { await sleep(150); continue; }
    const model = titleize(slug.replace(/-(electric|hybrid)$/, ""));
    const fuel = /electric$|^e[xc]\d/.test(slug) ? "BEV" : /hybrid$/.test(slug) ? "PHEV" : inferFuelFromName(model);
    if (!byModel.has(model) || msrp < byModel.get(model).msrp)
      byModel.set(model, { year, make: MAKE, model, trim: null, msrp, fuel_type: fuel, fetched_at: new Date().toISOString() });
    await sleep(150);
  }
  const msrpRows = [...byModel.values()];
  console.log(`[${MAKE}] ${msrpRows.length} MSRP rows`);
  await writeCatalogs(MAKE, { msrpRows, financeRows: [], leaseRows: [] });
}
main().catch(e => { console.error(e); process.exit(1); });
