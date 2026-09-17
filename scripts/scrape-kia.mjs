// Kia Canada MSRP scraper (MSRP only).
// Kia's build-and-price page embeds the full lineup as HTML-entity-encoded JSON.
// We decode it and JSON.parse the `models` arrays (string-aware bracket match) so
// trim names and prices are associated CORRECTLY by structure, never by regex
// proximity. Rates aren't exposed as a clean API, so this is MSRP-only.
//   model.{model, year}, model.trims[].{ trimNameEN, priceDetails.{PROV}.msrp, isHev/isPhev }
import { writeCatalogs, parseArgs, UA } from "./lib/catalog-io.mjs";

const MAKE = "Kia";
const PROV = "ON";
const SOURCE_URL = "https://www.kia.ca/en/shopping-tools/build-and-price";

// EX-FREIGHT, AND KIA SAYS SO ITSELF -- this is evidence, not inference.
//
// priceDetails[PROV] carries the figure and its fees as SEPARATE fields:
//
//   { msrp: 42445, msrpGross: 42445, dnd: 2185, adminFee: 699, acTax: 100,
//     otherTaxes: 145.75, regulatoryFees: 22, tireRecyclingFee: 22.5,
//     oilFilterFee: 1.25, ppsa: 126, ... }        (2026 Carnival LX, ON)
//
// `dnd` is delivery and destination -- freight and PDI -- and it sits BESIDE
// msrp rather than inside it. Kia's own fine print on the same page agrees:
// "Excludes delivery and destination charges, levies, applicable taxes,
//  registration, insurance, license fees and dealer fees of up to..."
// Captured 2026-09-17.
//
// Until today this scraper wrote 107 rows a day with no basis recorded, and
// nothing that subtracted could tell them from a freight-inclusive figure.
// [[msrp-100-percent-accuracy]] [[fee-catalog]]
//
// WORTH TAKING NEXT, AND DELIBERATELY NOT TAKEN HERE: those sibling fields are
// Kia's own itemisation, so an all_in_price for all 107 rows is within reach
// without inventing anything. It needs the AB keys rather than ON (fees differ
// by province even where msrp does not) and a decision on which components an
// Alberta advertised price must contain. That is a capture, not a stamp, and
// it belongs in its own change.

// String-aware matcher: given the index of an opening bracket, return the index
// of its balanced close (ignores brackets inside JSON strings).
function matchBracket(s, open, oc, cc) {
  let depth = 0, inStr = false, esc = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === oc) depth++;
    else if (c === cc) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

async function main() {
  const args = parseArgs();
  const raw = await (await fetch("https://www.kia.ca/en/shopping-tools/build-and-price", { headers: { "User-Agent": UA } })).text();
  const h = raw.replace(/&#34;/g, '"').replace(/&amp;/g, "&").replace(/\\u0026/g, "&");

  // Parse every `models` array in the page and collect models.
  const models = [];
  const KEY = '"models":[';
  for (let idx = h.indexOf(KEY); idx >= 0; idx = h.indexOf(KEY, idx + 1)) {
    const openB = idx + KEY.length - 1;
    const end = matchBracket(h, openB, "[", "]");
    if (end < 0) continue;
    try {
      const arr = JSON.parse(h.slice(openB, end + 1));
      for (const m of arr) if (m && m.model && Array.isArray(m.trims)) models.push(m);
    } catch { /* not a clean array here — skip */ }
  }

  const byKey = new Map(); // year|model|trim -> row (lowest MSRP wins)
  for (const m of models) {
    const model = String(m.model).trim();
    const year = Number(m.year);
    if (!model || !year || (args.year && year !== Number(args.year))) continue;
    for (const t of m.trims) {
      const pd = t.priceDetails || {};
      const msrp = Number(pd[PROV]?.msrp ?? pd.QC?.msrp ?? Object.values(pd)[0]?.msrp);
      if (!(msrp > 0)) continue;
      const trim = String(t.trimNameEN || t.trim || "").trim() || null;
      const fuel = (t.isPhev || t.isPackagePhev) ? "PHEV" : (t.isHev || t.isPackageHev) ? "Hybrid" : /\bEV\d?\b|electric|niro ev/i.test(`${model} ${trim}`) ? "BEV" : null;
      const key = `${year}|${model}|${trim}`;
      const prev = byKey.get(key);
      if (!prev || msrp < prev.msrp) byKey.set(key, { year, make: MAKE, model, trim, msrp, fuel_type: fuel, source_url: SOURCE_URL, fetched_at: new Date().toISOString() });
    }
  }
  const msrpRows = [...byKey.values()];
  console.log(`[${MAKE}] ${msrpRows.length} MSRP rows across ${new Set(msrpRows.map(r => r.model)).size} models`);
  await writeCatalogs(MAKE, { msrpRows, financeRows: [], leaseRows: [] }, { priceBasis: "excl_freight" });
}
main().catch(e => { console.error(e); process.exit(1); });
