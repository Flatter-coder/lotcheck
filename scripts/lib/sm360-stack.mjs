// ── SM360 dealer-inventory feed scraper (shared) ───────────────────────────
// SM360 (Dilawri) dealer sites expose a public inventory JSON feed carrying the
// manufacturer MSRP (listPrice) plus the advertised finance/lease APR — useful
// when the manufacturer's own site gates prices (BMW) or hides rates (Mercedes).
//   GET {dealer}/en/new-inventory/api/listing?page=N
//   -> vehicles[].{ year, make.name, model.name, trim.name, listPrice,
//                   paymentOptions.finance.term.{term,apr}, paymentOptions.lease.term.{term,apr,kmPerYearPlan} }
// MSRP is per-configured-VIN, so we keep the LOWEST listPrice per (year,model,
// trim) = the trim's starting MSRP. Rates are the default-term advertised APR.
// Add more dealers to a make's list for wider trim coverage.
import { inferFuelFromName, sleep, writeCatalogs, parseArgs, UA } from "./catalog-io.mjs";

const HDRS = { "User-Agent": UA, "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" };

function fuelFor(model, trim) {
  const n = `${model} ${trim || ""}`;
  if (/\bi[4578]\b|\bix\b|\beq[besc]\b|\beqe\b|\beqs\b|electric|\bev\b/i.test(n)) return "BEV";
  if (/phev|plug-?in|4matic.*e\b|xdrive45e|e-drive|recharge/i.test(n)) return "PHEV";
  return inferFuelFromName(n);
}

export async function run(cfg) {
  // cfg: { make, dealers: [origin, …], matchMake?: string (defaults to make) }
  const args = parseArgs();
  const today = new Date().toISOString().slice(0, 10);
  const wantMake = (cfg.matchMake || cfg.make).toUpperCase();
  const byTrim = new Map();
  const finSeen = new Set(), leaseSeen = new Set();
  const financeRows = [], leaseRows = [];

  for (const dealer of cfg.dealers) {
    let pages = 1;
    for (let page = 1; page <= pages; page++) {
      let data;
      try { data = await (await fetch(`${dealer}/en/new-inventory/api/listing?page=${page}`, { headers: HDRS })).json(); }
      catch { break; }
      pages = data?.pagination?.numberOfPages || pages;
      for (const v of (data.vehicles || [])) {
        if (!(v.make?.name || "").toUpperCase().startsWith(wantMake.slice(0, 6))) continue;
        const year = Number(v.year);
        const model = (v.model?.name || "").trim();
        const trim = (v.trim?.name || "").trim() || null;
        const msrp = Number(v.listPrice);
        if (!year || !model || !(msrp > 0)) continue;
        if (args.year && year !== Number(args.year)) continue;

        const key = `${year}|${model}|${trim}`;
        const prev = byTrim.get(key);
        if (!prev || msrp < prev.msrp) byTrim.set(key, { year, make: cfg.make, model, trim, msrp, fuel_type: fuelFor(model, trim), fetched_at: new Date().toISOString() });

        const fin = v.paymentOptions?.finance?.term;
        if (fin && Number(fin.apr) > 0) { const k = `${model}|${fin.term}`; if (!finSeen.has(k)) { finSeen.add(k); financeRows.push({ make: cfg.make, model, apr: Number(fin.apr), term_months: Number(fin.term), promo: false, effective_date: today }); } }
        const le = v.paymentOptions?.lease?.term;
        if (le && Number(le.apr) > 0) { const k = `${model}|${le.term}`; if (!leaseSeen.has(k)) { leaseSeen.add(k); leaseRows.push({ make: cfg.make, model, apr: Number(le.apr), term_months: Number(le.term), annual_km: Number(v.paymentOptions?.lease?.kmPerYearPlan) || null, effective_date: today }); } }
      }
      await sleep(120);
    }
  }
  const msrpRows = [...byTrim.values()];
  console.log(`[${cfg.make}] ${msrpRows.length} MSRP, ${financeRows.length} finance, ${leaseRows.length} lease rows across ${new Set(msrpRows.map(r => r.model)).size} models (SM360 dealer feed${cfg.ratesOnly ? ", rates-only" : ""}).`);
  await writeCatalogs(cfg.make, { msrpRows, financeRows, leaseRows }, { ratesOnly: cfg.ratesOnly });
}
