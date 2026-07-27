// ── Nissan / Infiniti Canada MSRP scraper (shared platform) ────────────────
// Each vehicle page embeds a hidden #individualVehiclePriceJSON iframe whose
// body is price JSON: {"{year}-{model}":{ Retail:{ grades:{ "{code}-{GRADE}":
// { gradePrice } } } }}. Retail.gradePrice is the national MSRP. Node fetch
// reaches the sites (Akamai blocks curl). MSRP only — rates need the gated
// GraphQL (see scripts/NISSAN-NOTES.md).
import { inferFuelFromName, sleep, writeCatalogs, parseArgs, UA } from "./catalog-io.mjs";

const titleize = s => s.replace(/[_-]+/g, " ").trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

export async function run(cfg) {
  // cfg: { make, host }
  const args = parseArgs();
  const listing = await (await fetch(`${cfg.host}/vehicles.html`, { headers: { "User-Agent": UA } })).text();
  const urls = [...new Set([...listing.matchAll(/\/vehicles\/[a-z0-9-]+\/[a-z0-9-]+\.html/g)].map(m => m[0]))]
    .filter(u => !/^\/vehicles\/[a-z-]+\/\d{4}-/.test(u)); // drop year-prefixed duplicate variants
  console.log(`[${cfg.make}] ${urls.length} vehicle pages`);

  const byKey = new Map();
  for (const u of urls) {
    let html;
    try { html = await (await fetch(cfg.host + u, { headers: { "User-Agent": UA } })).text(); }
    catch { await sleep(150); continue; }
    const m = html.match(/<iframe id="individualVehiclePriceJSON"[^>]*>([\s\S]*?)<\/iframe>/);
    if (!m) continue;
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    for (const ymKey of Object.keys(data)) {
      const ym = ymKey.match(/^(\d{4})-(.+)$/);
      if (!ym) continue;
      const year = Number(ym[1]);
      const model = titleize(ym[2]);
      if (args.year && year !== Number(args.year)) continue;
      const grades = data[ymKey]?.Retail?.grades || {};
      for (const [gradeKey, g] of Object.entries(grades)) {
        const msrp = Number(g?.gradePrice);
        if (!(msrp > 0)) continue;
        let trim = titleize(gradeKey.split("-").slice(1).join("-") || gradeKey);
        // Infiniti grade keys embed the model (QX65_SPORT) — strip the leading model token.
        if (trim && trim.toLowerCase().startsWith(model.toLowerCase() + " ")) trim = trim.slice(model.length).trim();
        trim = trim || null;
        const key = `${year}|${model}|${trim}`;
        const prev = byKey.get(key);
        if (!prev || msrp < prev.msrp) byKey.set(key, {
          year, make: cfg.make, model, trim, msrp,
          fuel_type: inferFuelFromName(`${model} ${trim || ""}`) || (/leaf|ariya/i.test(model) ? "BEV" : null),
          fetched_at: new Date().toISOString(),
        });
      }
    }
    await sleep(150);
  }
  const msrpRows = [...byKey.values()];
  console.log(`[${cfg.make}] ${msrpRows.length} MSRP rows across ${new Set(msrpRows.map(r => r.model)).size} models`);
  await writeCatalogs(cfg.make, { msrpRows, financeRows: [], leaseRows: [] });
}
