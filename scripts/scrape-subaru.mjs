// Subaru Canada MSRP + finance/lease scraper.
// MSRP: the homepage embeds a <script id="Cars"> JSON blob with every trim.
// Rates: each model's WebPage.aspx pricing page carries <finance>/<leasestd>
// blocks with <payment term="N">…<data id="apr">X%</data>. Rates are model-level,
// so we fetch the (heavy ~3MB) pricing page once per model, not per trim.
import { sleep, writeCatalogs, parseArgs, UA } from "./lib/catalog-io.mjs";

const MAKE = "Subaru";
const num = s => Number(String(s || "").replace(/[^0-9.]/g, "")) || 0;

function parseRates(html) {
  const finance = [], lease = [];
  const grab = (block, arr) => {
    const seen = new Set();
    for (const m of block.matchAll(/<payment[^>]*term="(\d+)"[^>]*>[\s\S]*?<data id="apr">([0-9.]+)%?<\/data>/g)) {
      const term = Number(m[1]), apr = Number(m[2]);
      if (term && Number.isFinite(apr) && !seen.has(term)) { seen.add(term); arr.push({ term, apr }); }
    }
  };
  const fin = html.match(/<finance>([\s\S]*?)<\/finance>/);
  if (fin) grab(fin[1], finance);
  const ls = html.match(/<leasestd>([\s\S]*?)<\/leasestd>/);
  if (ls) grab(ls[1], lease);
  return { finance, lease };
}

async function main() {
  const args = parseArgs();
  const today = new Date().toISOString().slice(0, 10);
  const home = await (await fetch("https://www.subaru.ca/en/", { headers: { "User-Agent": UA } })).text();
  const m = home.match(/<script[^>]*id="Cars"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("Cars JSON not found");
  const brand = Object.values(JSON.parse(m[1].trim()))[0] || {};

  const msrpRows = [], financeRows = [], leaseRows = [];
  const ratesByModel = new Map(); // model -> {finance, lease}, fetched once

  for (const modelKey of Object.keys(brand)) {
    if (args.model && modelKey !== args.model) continue;
    for (const t of brand[modelKey]) {
      const model = (t.Range || modelKey).trim();
      const year = Number(t.year);
      const msrp = num(t.msrp);
      if (!(msrp > 0) || !year || !model) continue;
      const fuel = t.IsElectric ? "BEV" : t.IsPlugInHybrid ? "PHEV" : t.IsHybrid ? "Hybrid" : null;
      msrpRows.push({ year, make: MAKE, model, trim: (t.TrimName || "").trim() || null, msrp, fuel_type: fuel, fetched_at: new Date().toISOString() });

      // Fetch rates once per model (first trim with a pricing key).
      if (!ratesByModel.has(model) && t.Price && t.CarID) {
        try {
          // WebSiteID 282 = the pricing-page site (the trim's own WebSiteID is a different id).
          const url = `https://www.subaru.ca/WebPage.aspx?WebSiteID=282&WebPageID=${t.Price}&Range=${encodeURIComponent(model)}&ModelYear=${year}&CarID=${t.CarID}`;
          const html = await (await fetch(url, { headers: { "User-Agent": UA } })).text();
          ratesByModel.set(model, parseRates(html));
          await sleep(200);
        } catch { ratesByModel.set(model, { finance: [], lease: [] }); }
      }
    }
  }
  // Emit model-level rate rows.
  for (const [model, r] of ratesByModel) {
    for (const f of r.finance) financeRows.push({ make: MAKE, model, apr: f.apr, term_months: f.term, promo: false, effective_date: today });
    for (const l of r.lease) leaseRows.push({ make: MAKE, model, apr: l.apr, term_months: l.term, annual_km: null, effective_date: today });
  }
  console.log(`[${MAKE}] ${msrpRows.length} MSRP, ${financeRows.length} finance, ${leaseRows.length} lease rows.`);
  await writeCatalogs(MAKE, { msrpRows, financeRows, leaseRows });
}
main().catch(e => { console.error(e); process.exit(1); });
