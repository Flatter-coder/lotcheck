// Porsche Canada MSRP scraper (MSRP only).
// Porsche exposes no financing through its configurator, so this is MSRP-only.
// Prices live in the Next.js SSR payload of each model-start page as escaped
// JSON: price\":N,\"modelGroup\":{\"key\":\"...\"}. One "model" per modelGroup
// (base = lowest configuration price).
//   https://models.porsche.com/en-CA/model-start/{series}   series: 911 cayenne macan panamera taycan
import { inferFuelFromName, sleep, writeCatalogs, parseArgs, UA } from "./lib/catalog-io.mjs";

const MAKE = "Porsche";
const SERIES = ["911", "cayenne", "macan", "panamera", "taycan"];
const YEAR = new Date().getUTCFullYear(); // configurator shows the current sales year
const titleize = k => k.split("-").map(w => /^(gt|gts)$/i.test(w) ? w.toUpperCase() : /^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

async function main() {
  const args = parseArgs();
  const list = args.series ? [args.series] : SERIES;
  const byGroup = new Map(); // modelGroup.key -> lowest MSRP

  for (const s of list) {
    let html;
    try { html = await (await fetch(`https://models.porsche.com/en-CA/model-start/${s}`, { headers: { "User-Agent": UA } })).text(); }
    catch (e) { console.warn(`  ${s}: ${e.message}`); continue; }
    const m = [...html.matchAll(/price\\":([0-9.]+),\\"modelGroup\\":\{\\"key\\":\\"([^\\"]+)\\"/g)];
    for (const x of m) {
      const price = Number(x[1]), key = x[2];
      if (!(price > 0)) continue;
      if (!byGroup.has(key) || price < byGroup.get(key)) byGroup.set(key, price);
    }
    console.log(`  ${s}: ${new Set(m.map(x => x[2])).size} model groups`);
    await sleep(150);
  }

  const msrpRows = [...byGroup.entries()].map(([key, msrp]) => {
    const model = titleize(key);
    return { year: YEAR, make: MAKE, model, trim: null, msrp,
      fuel_type: inferFuelFromName(model) || (/electric|taycan/i.test(key) ? "BEV" : null),
      fetched_at: new Date().toISOString() };
  });
  console.log(`[${MAKE}] ${msrpRows.length} MSRP rows`);
  await writeCatalogs(MAKE, { msrpRows, financeRows: [], leaseRows: [] });
}
main().catch(e => { console.error(e); process.exit(1); });
