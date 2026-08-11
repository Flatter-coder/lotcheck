// Published-MSRP capture: read each manufacturer's OWN advertised "Starting at"
// price off its OWN page, and store it with the page URL as provenance.
//
// This exists because the build-&-price APIs lie to us in different ways:
//   * Toyota `vehicleStartPrice`  -> a constant $653.08 under the published
//     price, always ending .92
//   * GM `msrp.amount.value`      -> half-dollars (43442.5)
// Both were stored as sticker prices and corrupted ~17% of the catalog before
// the quality gate existed (2026-08-11). A figure the manufacturer prints next
// to the words "Starting at", on a page a buyer can open, is the only one that
// belongs in a report.
//
// Run: node scripts/scrape-published-msrp.mjs            (needs SCRAPFLY_API_KEY)
//      node scripts/scrape-published-msrp.mjs --dry-run  (render + print, no writes)
//      node scripts/scrape-published-msrp.mjs --make=Chevrolet
//
// Cost: one render per model line (~$0.009). The full target list below is a
// few cents a week.

import { renderPage, extractStartingPrices, toCatalogRows } from "./lib/published-price.mjs";
import { writeCatalogs } from "./lib/catalog-io.mjs";

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
}));
const DRY = !!args["dry-run"];

// Targets are the pages that actually print a published price. Toyota/Lexus are
// deliberately absent: their model pages render no trim prices at all (verified
// 2026-08-11 -- no price API call, nothing in the DOM), so there is nothing
// honest to read there yet. See the notes in scripts/COVERAGE.md.
const TARGETS = [
  { make: "Chevrolet", model: "Equinox",      year: 2027, url: "https://www.chevrolet.ca/en/suvs/equinox" },
  { make: "Chevrolet", model: "Trax",         year: 2027, url: "https://www.chevrolet.ca/en/suvs/trax" },
  { make: "Chevrolet", model: "Traverse",     year: 2026, url: "https://www.chevrolet.ca/en/suvs/traverse" },
  { make: "Chevrolet", model: "Silverado 1500", year: 2026, url: "https://www.chevrolet.ca/en/trucks/silverado-1500" },
  { make: "Chevrolet", model: "Blazer EV",    year: 2026, url: "https://www.chevrolet.ca/en/electric/blazer-ev", fuelType: "BEV" },
  { make: "GMC",       model: "Sierra 1500",  year: 2026, url: "https://www.gmc.ca/en/trucks/sierra-1500" },
  { make: "GMC",       model: "Terrain",      year: 2026, url: "https://www.gmc.ca/en/suvs/terrain" },
  { make: "GMC",       model: "Yukon",        year: 2026, url: "https://www.gmc.ca/en/suvs/yukon" },
  { make: "Buick",     model: "Encore GX",    year: 2026, url: "https://www.buick.ca/en/suvs/encore-gx" },
  { make: "Buick",     model: "Envista",      year: 2026, url: "https://www.buick.ca/en/suvs/envista" },
  { make: "Cadillac",  model: "XT5",          year: 2026, url: "https://www.cadillaccanada.ca/en/suvs/xt5" },
  { make: "Cadillac",  model: "LYRIQ",        year: 2026, url: "https://www.cadillaccanada.ca/en/electric/lyriq", fuelType: "BEV" },
  { make: "Ford",      model: "Mustang Mach-E", year: 2026, url: "https://www.ford.ca/suvs/mach-e/models/", fuelType: "BEV" },
  { make: "Ford",      model: "Bronco Sport", year: 2026, url: "https://www.ford.ca/suvs/bronco-sport/models/" },
  { make: "Ford",      model: "Escape",       year: 2026, url: "https://www.ford.ca/suvs/escape/models/" },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const only = args.make ? String(args.make).toLowerCase() : null;
  const targets = TARGETS.filter(t => !only || t.make.toLowerCase() === only);
  const byMake = new Map();
  let ok = 0, empty = 0, failed = 0;

  for (const t of targets) {
    try {
      const html = await renderPage(t.url);
      const pairs = extractStartingPrices(html);
      if (!pairs.length) {
        empty++;
        console.warn(`  ${t.make} ${t.model}: rendered but no "starting at" price found — page layout may have changed.`);
        continue;
      }
      const rows = toCatalogRows(t, pairs);
      if (!byMake.has(t.make)) byMake.set(t.make, []);
      byMake.get(t.make).push(...rows);
      ok++;
      console.log(`  ${t.make} ${t.model}: ${rows.length} published prices — ${rows.map(r => `${r.trim || "(base)"} $${r.msrp.toLocaleString()}`).join(", ")}`);
    } catch (e) {
      failed++;
      console.warn(`  ${t.make} ${t.model}: ${e.message}`);
    }
    await sleep(1200);
  }

  console.log(`\n${ok} pages captured, ${empty} rendered-but-empty, ${failed} failed.`);
  if (DRY) { console.log("--dry-run: no writes."); return; }

  for (const [make, rows] of byMake) {
    // Published prices are hand-checkable and carry source_url, so they are the
    // rows the API scrapers must never overwrite (catalog-io guards on that).
    await writeCatalogs(make, { msrpRows: rows }, { upsert: true });
  }
  // A capture run that produced nothing should fail loudly rather than look green.
  if (!byMake.size) { console.error("No published prices captured — nothing written."); process.exit(1); }
}

main().catch(e => { console.error("published-msrp failed:", e.message); process.exit(1); });
