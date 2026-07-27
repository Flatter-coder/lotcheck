// MINI Canada MSRP + finance/lease scraper (full data, one API).
// The buildandprice pages embed build codes (CACodes like 26YD); one POST to
// GetMultipleVehicleData returns MSRP + finance + lease rate ladders for all.
import { sleep, inferFuelFromName, writeCatalogs, parseArgs, UA } from "./lib/catalog-io.mjs";

const MAKE = "Mini";
const MODELS = ["F65", "F66", "F67", "U25", "U25-E"];
const HDRS = { "User-Agent": UA };

async function main() {
  const args = parseArgs();
  const today = new Date().toISOString().slice(0, 10);

  // Collect build codes from each model's buildandprice page.
  const codes = new Set();
  for (const m of MODELS) {
    try {
      const html = await (await fetch(`https://www.mini.ca/en/shopping/buildandprice?model=${m}`, { headers: HDRS })).text();
      for (const c of html.match(/"[0-9]{2}[A-Z]{2}"/g) || []) codes.add(c.replace(/"/g, ""));
    } catch { /* skip */ }
    await sleep(120);
  }
  const caCodes = [...codes];
  console.log(`[${MAKE}] ${caCodes.length} build codes`);
  if (!caCodes.length) { console.log("no codes found"); return; }

  const res = await fetch("https://www.mini.ca/en/CalculatorAPI/GetMultipleVehicleData", {
    method: "POST",
    headers: { ...HDRS, "Content-Type": "application/x-www-form-urlencoded", "Referer": "https://www.mini.ca/en/shopping/buildandprice" },
    body: `CACodes=${caCodes.join(";")}`,
  });
  if (!res.ok) throw new Error(`GetMultipleVehicleData HTTP ${res.status}`);
  const data = await res.json();
  const arr = Array.isArray(data) ? data : [data];

  const msrpRows = [], financeRows = [], leaseRows = [];
  const finSeen = new Set(), leaseSeen = new Set();
  for (const e of arr) {
    const v = e.Vehicle || {};
    const msrp = Number(v.MSRP);
    if (!(msrp > 0)) continue;
    const year = Number(v.Year) || null;
    // "2026 MINI Countryman S ALL4" -> model "Countryman S ALL4"
    const model = String(v.Name || v.VariantName || "").replace(/^\d{4}\s+MINI\s+/i, "").trim() || null;
    if (!model || !year) continue;
    msrpRows.push({ year, make: MAKE, model, trim: null, msrp, fuel_type: inferFuelFromName(model) || (/-E$/.test(v.ECode || "") ? "BEV" : null), fetched_at: new Date().toISOString() });
    for (const r of (e.Rates || [])) {
      const term = Number(r.Term), apr = Math.round(Number(r.InterestRate) * 10000) / 100; // fraction -> percent
      if (!term || !Number.isFinite(apr)) continue;
      if (r.Type === "Finance") { const k = `${model}|${term}`; if (!finSeen.has(k)) { finSeen.add(k); financeRows.push({ make: MAKE, model, apr, term_months: term, promo: false, effective_date: today }); } }
      else if (r.Type === "Lease") { const k = `${model}|${term}`; if (!leaseSeen.has(k)) { leaseSeen.add(k); leaseRows.push({ make: MAKE, model, apr, term_months: term, annual_km: null, effective_date: today }); } }
    }
  }
  console.log(`[${MAKE}] ${msrpRows.length} MSRP, ${financeRows.length} finance, ${leaseRows.length} lease rows.`);
  await writeCatalogs(MAKE, { msrpRows, financeRows, leaseRows });
}
main().catch(e => { console.error(e); process.exit(1); });
