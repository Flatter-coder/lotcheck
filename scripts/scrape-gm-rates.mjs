// GM finance/lease rates via the SM360 dealer feed. A single City GM store
// (Chevrolet/Buick/GMC) carries all three makes' advertised APR, so we fetch
// its inventory ONCE and bucket rows by make, writing each make's rows
// rates-only on top of that make's existing MSRP source (GM byo-vc).
// gm's own sites (chevrolet.ca etc.) gate the payment APR behind the IPE.
import { sleep, writeCatalogs, parseArgs, UA } from "./lib/catalog-io.mjs";

const DEALERS = ["https://www.citygm.com"]; // City Buick Chevrolet GMC, Toronto
// GM makes we can attribute from make.name. Cadillac isn't stocked here — needs
// its own Cadillac dealer; left MSRP-only for now.
const GM_MAKES = { CHEVROLET: "Chevrolet", GMC: "GMC", BUICK: "Buick", CADILLAC: "Cadillac" };
const HDRS = { "User-Agent": UA, Accept: "application/json", "X-Requested-With": "XMLHttpRequest" };

const today = new Date().toISOString().slice(0, 10);
const args = parseArgs();
// per-make { financeRows, leaseRows, finSeen, leaseSeen }
const buckets = Object.fromEntries(Object.values(GM_MAKES).map(m => [m, { finance: [], lease: [], fs: new Set(), ls: new Set() }]));

for (const dealer of DEALERS) {
  let pages = 1;
  for (let page = 1; page <= pages; page++) {
    let data;
    try { data = await (await fetch(`${dealer}/en/new-inventory/api/listing?page=${page}`, { headers: HDRS })).json(); }
    catch { break; }
    pages = data?.pagination?.numberOfPages || pages;
    for (const v of (data.vehicles || [])) {
      const mk = GM_MAKES[(v.make?.name || "").toUpperCase()];
      if (!mk) continue;
      const model = (v.model?.name || "").trim();
      if (!model) continue;
      const b = buckets[mk];
      const fin = v.paymentOptions?.finance?.term;
      if (fin && Number(fin.apr) > 0) { const k = `${model}|${fin.term}`; if (!b.fs.has(k)) { b.fs.add(k); b.finance.push({ make: mk, model, apr: Number(fin.apr), term_months: Number(fin.term), promo: false, effective_date: today }); } }
      const le = v.paymentOptions?.lease?.term;
      if (le && Number(le.apr) > 0) { const k = `${model}|${le.term}`; if (!b.ls.has(k)) { b.ls.add(k); b.lease.push({ make: mk, model, apr: Number(le.apr), term_months: Number(le.term), annual_km: Number(v.paymentOptions?.lease?.kmPerYearPlan) || null, effective_date: today }); } }
    }
    await sleep(120);
    if (args.maxpages && page >= Number(args.maxpages)) break;
  }
}

for (const [make, b] of Object.entries(buckets)) {
  console.log(`[${make}] ${b.finance.length} finance, ${b.lease.length} lease rows across ${new Set([...b.finance, ...b.lease].map(r => r.model)).size} models (SM360 City GM, rates-only).`);
  if (b.finance.length || b.lease.length) await writeCatalogs(make, { msrpRows: [], financeRows: b.finance, leaseRows: b.lease }, { ratesOnly: true });
}
