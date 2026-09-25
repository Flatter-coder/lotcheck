// Porsche Canada MSRP scraper (MSRP only -- Porsche exposes no financing).
//
// Reads the configurator page of every model code linked from each series'
// configure page (lib/porsche-configurator.mjs explains why: the old
// models.porsche.com source now redirects to a page with no prices, and
// Porsche went stale 2026-09-22). One row per model code: model = nameplate,
// trim = variant, msrp = Porsche's own "Base price", which it lists apart from
// the destination charge -- so the basis is excl_freight on its own wording.
//   https://www.porsche.com/canada/en/models/{series}/configure/
//   https://configurator.porsche.com/en-CA/mode/model/{code}
import { inferFuelFromName, sleep, writeCatalogs, parseArgs, UA } from "./lib/catalog-io.mjs";
import { configuratorCodes, parseConfigurator, splitName } from "./lib/porsche-configurator.mjs";

const MAKE = "Porsche";
const SERIES = ["911", "718", "taycan", "panamera", "macan", "cayenne"];

async function get(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

async function main() {
  const args = parseArgs();
  const list = args.series ? [args.series] : SERIES;
  const codes = [];
  for (const s of list) {
    try {
      const found = configuratorCodes(await get(`https://www.porsche.com/canada/en/models/${s}/configure/`));
      console.log(`  ${s}: ${found.length} model codes`);
      for (const c of found) if (!codes.includes(c)) codes.push(c);
    } catch (e) { console.warn(`  ${s}: ${e.message}`); }
    await sleep(800);
  }

  const msrpRows = [];
  let missed = 0;
  for (const code of codes) {
    try {
      const p = parseConfigurator(await get(`https://configurator.porsche.com/en-CA/mode/model/${code}`), code);
      if (!p) { missed++; console.warn(`  ${code}: no base price on the page`); }
      else {
        const { model, trim } = splitName(p.name);
        msrpRows.push({ year: p.year, make: MAKE, model, trim, msrp: p.base,
          fuel_type: inferFuelFromName(p.name) || (/electric|taycan|^macan\b/i.test(p.name) ? "BEV" : null),
          fetched_at: new Date().toISOString() });
        console.log(`  ${code}  ${p.year} ${p.name}: base $${p.base.toLocaleString("en-CA")}` +
          (p.destination ? ` · destination $${p.destination.toLocaleString("en-CA")}` : "") +
          (p.dealerFeeMax ? ` · max dealer fee $${p.dealerFeeMax.toLocaleString("en-CA")}` : ""));
      }
    } catch (e) { missed++; console.warn(`  ${code}: ${e.message}`); }
    await sleep(800);
  }
  console.log(`[${MAKE}] ${msrpRows.length} MSRP rows from ${codes.length} model codes${missed ? ` (${missed} unread)` : ""}`);
  await writeCatalogs(MAKE, { msrpRows, financeRows: [], leaseRows: [] }, { priceBasis: "excl_freight" });
}
main().catch(e => { console.error(e); process.exit(1); });
