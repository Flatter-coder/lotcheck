// ── Stellantis Canada (FCA) build-&-price scraper ──────────────────────────
// Jeep, Ram, Dodge, Chrysler, and Fiat all run the identical FCA Canada
// configurator, and a single unauthenticated endpoint returns MSRP + the full
// finance term ladder + the full lease term ladder together. Verified values
// only — every row is fetched live and tagged with the trim + date.
//
// Endpoints (public GET, only a `brd-province=ON` cookie required):
//   /api/buildandprice/modelYears/prices?provinceCode=ON&brands={brand}
//        -> enumerate every modelYearId for a brand
//   /data/nameplates/{brand}/model-years/model-year-id/{modelYearId}
//        -> { code: "{nameplate}-{year}", isElectricVehicle }
//   /api/buildandprice/trims/prices?provinceCode=ON&modelYearId={id}&brand={brand}&nameplate={np}&modelYear={year}
//        -> [{ modelName, trimDesc, msrp, finance:{terms:[{duration,rate}]},
//              lease:{terms:[{km, terms:[{duration,rate,residual}]}]} }]

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const PROV = "ON";

// brand code (API param + /data path) -> { host, make (catalog make name) }
export const FCA_BRANDS = {
  jeep:     { host: "https://www.jeep.ca",       make: "Jeep" },
  ramtruck: { host: "https://www.ramtruck.ca",   make: "Ram" },
  dodge:    { host: "https://www.dodge.ca",       make: "Dodge" },
  chrysler: { host: "https://www.chrysler.ca",   make: "Chrysler" },
  fiat:     { host: "https://www.fiatcanada.com", make: "Fiat" },
  alfaromeo:{ host: "https://www.alfaromeo.ca",   make: "Alfa Romeo" },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", Cookie: `brd-province=${PROV}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}
const asArray = d => (Array.isArray(d) ? d : (d?.data && Array.isArray(d.data) ? d.data : (Object.values(d || {}).find(Array.isArray) || [])));

// FCA doesn't expose a clean fuel field per trim; infer conservatively from the
// name / the EV flag, and leave null (not "Gas") when unsure so we never assert
// a powertrain we didn't verify.
function inferFuel(model, trim, isEV) {
  const n = `${model || ""} ${trim || ""}`.toLowerCase();
  if (/4xe|plug-?in/.test(n)) return "PHEV";
  if (isEV === true || isEV === "true" || /\bev\b|\bbev\b|electric|recharge/.test(n)) return "BEV";
  return null;
}

async function scrapeBrand(brandCode, { pin } = {}) {
  const { host, make } = FCA_BRANDS[brandCode];
  const today = new Date().toISOString().slice(0, 10);
  const msrpRows = [], financeRows = [], leaseRows = [];
  const finSeen = new Set(), leaseSeen = new Set();

  let modelYears;
  try {
    modelYears = asArray(await getJson(`${host}/api/buildandprice/modelYears/prices?provinceCode=${PROV}&brands=${brandCode}`));
  } catch (e) {
    console.warn(`[${make}] modelYears fetch failed: ${e.message}`); return { msrpRows, financeRows, leaseRows };
  }
  console.log(`[${make}] ${modelYears.length} model-years`);

  for (const my of modelYears) {
    const id = my.modelYearId;
    if (!id) continue;
    let code = null, isEV = false;
    try {
      const np = await getJson(`${host}/data/nameplates/${brandCode}/model-years/model-year-id/${id}`);
      code = np?.code || np?.data?.code || null;
      isEV = np?.isElectricVehicle ?? np?.data?.isElectricVehicle ?? false;
    } catch { /* skip */ }
    const m = code && String(code).match(/^(.+)-(\d{4})$/);
    if (!m) { continue; } // code without a clean nameplate-year (e.g. commercial) — skip
    const nameplate = m[1], year = Number(m[2]);
    if (pin && year !== Number(pin)) continue;

    let trims;
    try {
      trims = asArray(await getJson(`${host}/api/buildandprice/trims/prices?provinceCode=${PROV}&modelYearId=${id}&brand=${brandCode}&nameplate=${nameplate}&modelYear=${year}`));
    } catch { await sleep(80); continue; }

    for (const t of trims) {
      const msrp = Number(t.msrp);
      const model = (t.modelName || nameplate || "").trim();
      if (!(msrp > 0) || !model) continue;
      const trim = (t.trimDesc || t.trimGroup || t.acode || "").trim() || null;
      msrpRows.push({ year, make, model, trim, msrp, fuel_type: inferFuel(model, trim, isEV), fetched_at: new Date().toISOString() });

      for (const ft of (t.finance?.terms || [])) {
        const term = Number(ft.duration), apr = Number(ft.rate);
        const k = `${model}|${term}`;
        if (term && Number.isFinite(apr) && !finSeen.has(k)) { finSeen.add(k); financeRows.push({ make, model, apr, term_months: term, promo: false, effective_date: today }); }
      }
      for (const bucket of (t.lease?.terms || [])) {
        const km = bucket.km != null ? Number(bucket.km) : null;
        for (const lt of (bucket.terms || [])) {
          const term = Number(lt.duration), apr = Number(lt.rate);
          const k = `${model}|${term}|${km}`;
          if (term && Number.isFinite(apr) && !leaseSeen.has(k)) { leaseSeen.add(k); leaseRows.push({ make, model, apr, term_months: term, annual_km: km, effective_date: today }); }
        }
      }
    }
    await sleep(80);
  }
  console.log(`[${make}] ${msrpRows.length} MSRP, ${financeRows.length} finance, ${leaseRows.length} lease rows.`);
  return { msrpRows, financeRows, leaseRows };
}

async function replaceRows(table, rows, make, { fatal = true } = {}) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  try {
    const del = await fetch(`${url}/rest/v1/${table}?make=eq.${encodeURIComponent(make)}`, { method: "DELETE", headers });
    if (!del.ok && del.status !== 404) throw new Error(`DELETE ${table} -> HTTP ${del.status}: ${await del.text()}`);
    for (let i = 0; i < rows.length; i += 500) {
      const ins = await fetch(`${url}/rest/v1/${table}`, { method: "POST", headers: { ...headers, Prefer: "return=minimal" }, body: JSON.stringify(rows.slice(i, i + 500)) });
      if (!ins.ok) throw new Error(`INSERT ${table} -> HTTP ${ins.status}: ${await ins.text()}`);
    }
    console.log(`  ${table} (${make}): ${rows.length} rows.`);
  } catch (e) {
    if (fatal) throw e;
    console.warn(`  ⚠️ ${table} skipped (${e.message.split("\n")[0]}).`);
  }
}

export async function run() {
  const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true]; }));
  const brands = args.brand ? [args.brand] : Object.keys(FCA_BRANDS);
  const all = { msrpRows: [], financeRows: [], leaseRows: [] };
  for (const b of brands) {
    const r = await scrapeBrand(b, { pin: args.year });
    all.msrpRows.push(...r.msrpRows); all.financeRows.push(...r.financeRows); all.leaseRows.push(...r.leaseRows);
  }

  if (!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)) {
    const outDir = join(__dirname, "..", "out"); mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `stellantis-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify({ msrp_catalog: all.msrpRows, finance_rate_catalog: all.financeRows, lease_rate_catalog: all.leaseRows }, null, 2));
    console.log(`\nDRY RUN. ${all.msrpRows.length} MSRP / ${all.financeRows.length} finance / ${all.leaseRows.length} lease rows -> ${file}`);
    console.table(all.msrpRows.slice(0, 8));
    return;
  }
  console.log("\nWriting Stellantis to Supabase…");
  // Group by make so delete-then-insert stays per-make.
  for (const make of [...new Set(all.msrpRows.map(r => r.make))]) {
    await replaceRows("msrp_catalog", all.msrpRows.filter(r => r.make === make), make);
    await replaceRows("finance_rate_catalog", all.financeRows.filter(r => r.make === make), make);
    await replaceRows("lease_rate_catalog", all.leaseRows.filter(r => r.make === make), make, { fatal: false });
  }
  console.log("Done.");
}
