// Mercedes-Benz Canada MSRP scraper (MSRP only).
// The public inventory service returns every year/class/model with MSRP.
// Finance/lease rates come from the payment-estimator app (config not yet
// captured — see recon notes), so this is MSRP-only for now.
//   GET https://nafta-service.mbusa.com/api/inv/v1/en_ca/new/models
//   -> result.years.{YYYY}.classes.{CLASS}.models.{id}.{ msrp, modelName }
import { inferFuelFromName, writeCatalogs, parseArgs } from "./lib/catalog-io.mjs";
import { fetchRetry } from "./lib/fetch-retry.mjs";

const MAKE = "Mercedes-Benz";

async function main() {
  const args = parseArgs();
  // fetchRetry: one transient 504 from this service killed the 2026-08-19
  // daily refresh for the whole make. 5xx/429/network errors get 3 bounded
  // attempts with backoff; a 4xx still fails fast below.
  const res = await fetchRetry("https://nafta-service.mbusa.com/api/inv/v1/en_ca/new/models", {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36", "Accept": "application/json", "Accept-Encoding": "gzip" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const years = (await res.json())?.result?.years || {};

  const byKey = new Map();
  for (const y of Object.keys(years)) {
    const year = Number(y);
    if (args.year && year !== Number(args.year)) continue;
    const classes = years[y].classes || {};
    for (const cn of Object.keys(classes)) {
      const models = classes[cn].models || {};
      for (const id of Object.keys(models)) {
        const m = models[id];
        const msrp = Number(m.msrp);
        const model = (m.modelName || "").trim();
        if (!(msrp > 0) || !model) continue;
        const key = `${year}|${model}`;
        if (!byKey.has(key)) byKey.set(key, { year, make: MAKE, model, trim: null, msrp, fuel_type: inferFuelFromName(model) || (/\beq[bces]?\b/i.test(model) ? "BEV" : null), fetched_at: new Date().toISOString() });
      }
    }
  }
  const msrpRows = [...byKey.values()];
  console.log(`[${MAKE}] ${msrpRows.length} MSRP rows across ${new Set(msrpRows.map(r => r.year)).size} years`);
  await writeCatalogs(MAKE, { msrpRows, financeRows: [], leaseRows: [] });
}
main().catch(e => { console.error(e); process.exit(1); });
