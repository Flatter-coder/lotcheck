// BMW Canada MSRP + finance/lease scraper — via a dealer inventory feed.
//
// bmw.ca's own configurator gates all prices behind an identity-authed API
// (see BMW-NOTES.md). BMW dealers on the SM360 platform, however, expose a
// public inventory JSON feed that carries the manufacturer MSRP (listPrice ==
// salePrice for BMW — no discounting) plus the advertised finance/lease APR.
//
// Source: Calgary BMW (Dilawri / SM360). One large store's new inventory covers
// most of the lineup; add more SM360 BMW dealers to `DEALERS` for wider trim
// coverage. Caveats: MSRP is per-configured-VIN, so we keep the LOWEST listPrice
// per (year, model, trim) as the trim's starting MSRP; rates are the default-term
// advertised APR (representative, not the full 24-84 ladder).
//   GET {dealer}/en/new-inventory/api/listing?page=N
//   -> vehicles[].{ year, make.name, model.name, trim.name, listPrice,
//                   paymentOptions.finance.term.{term,apr}, paymentOptions.lease.term.{term,apr,kmPerYearPlan} }
import { inferFuelFromName, sleep, writeCatalogs, parseArgs, UA } from "./lib/catalog-io.mjs";

const MAKE = "BMW";
const DEALERS = ["https://www.calgarybmw.ca"];
const HDRS = { "User-Agent": UA, "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" };

function fuelFor(model, trim) {
  const n = `${model} ${trim || ""}`;
  if (/\bi[4578]\b|\bix\b|\bi[45] |electric/i.test(n)) return "BEV";
  if (/phev|plug-?in|xdrive45e|e-drive/i.test(n)) return "PHEV";
  return inferFuelFromName(n);
}

async function main() {
  const args = parseArgs();
  const today = new Date().toISOString().slice(0, 10);
  const byTrim = new Map();       // year|model|trim -> lowest MSRP row
  const finSeen = new Set(), leaseSeen = new Set();
  const financeRows = [], leaseRows = [];

  for (const dealer of DEALERS) {
    let pages = 1;
    for (let page = 1; page <= pages; page++) {
      let data;
      try { data = await (await fetch(`${dealer}/en/new-inventory/api/listing?page=${page}`, { headers: HDRS })).json(); }
      catch { break; }
      pages = data?.pagination?.numberOfPages || pages;
      for (const v of (data.vehicles || [])) {
        if ((v.make?.name || "").toUpperCase() !== "BMW") continue;
        const year = Number(v.year);
        const model = (v.model?.name || "").trim();
        const trim = (v.trim?.name || "").trim() || null;
        const msrp = Number(v.listPrice);
        if (!year || !model || !(msrp > 0)) continue;
        if (args.year && year !== Number(args.year)) continue;

        const key = `${year}|${model}|${trim}`;
        const prev = byTrim.get(key);
        if (!prev || msrp < prev.msrp) byTrim.set(key, { year, make: MAKE, model, trim, msrp, fuel_type: fuelFor(model, trim), fetched_at: new Date().toISOString() });

        const fin = v.paymentOptions?.finance?.term;
        if (fin && Number(fin.apr) > 0) {
          const k = `${model}|${fin.term}`;
          if (!finSeen.has(k)) { finSeen.add(k); financeRows.push({ make: MAKE, model, apr: Number(fin.apr), term_months: Number(fin.term), promo: false, effective_date: today }); }
        }
        const le = v.paymentOptions?.lease?.term;
        if (le && Number(le.apr) > 0) {
          const k = `${model}|${le.term}`;
          if (!leaseSeen.has(k)) { leaseSeen.add(k); leaseRows.push({ make: MAKE, model, apr: Number(le.apr), term_months: Number(le.term), annual_km: Number(v.paymentOptions?.lease?.kmPerYearPlan) || null, effective_date: today }); }
        }
      }
      await sleep(120);
    }
  }
  const msrpRows = [...byTrim.values()];
  console.log(`[${MAKE}] ${msrpRows.length} MSRP, ${financeRows.length} finance, ${leaseRows.length} lease rows across ${new Set(msrpRows.map(r => r.model)).size} models.`);
  await writeCatalogs(MAKE, { msrpRows, financeRows, leaseRows });
}
main().catch(e => { console.error(e); process.exit(1); });
