// Shared catalog output for single-make scrapers: dry-run to scripts/out when
// there's no service key, else delete-then-insert this make's rows in Supabase.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function getJson(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...extraHeaders } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// Powertrain from an explicit name, conservative: assert only what the name says.
export function inferFuelFromName(name) {
  const n = (name || "").toLowerCase();
  if (/plug-?in|4xe|phev|prime/.test(n)) return "PHEV";
  if (/electrified|\bev\b|\bbev\b|ioniq|electric|\be-?tron\b|\bev6\b|recharge|\bgv60\b/.test(n)) return "BEV";
  if (/hybrid/.test(n)) return "Hybrid";
  return null;
}

// Quality gate shared by EVERY make (the Toyota/Lexus stack learned this the
// hard way on 2026-08-11: it stored `vehicleStartPrice`, a calculated
// fee-inclusive figure, as if it were the published MSRP -- every value ended
// in .92 -- and ~17% of the catalog became fiction). A published Canadian MSRP
// is a whole-dollar figure, so a fractional value proves the source handed us a
// computed price. Reject rather than store; a missing row is recoverable, a
// wrong MSRP is a wrong claim in a buyer's report.
function gateMsrpRows(rows, make) {
  const kept = [], rejected = [];
  for (const r of rows) {
    const v = Number(r?.msrp);
    if (!Number.isFinite(v) || v <= 0 || !Number.isInteger(v)) rejected.push(r);
    else kept.push(r);
  }
  if (rejected.length) {
    console.warn(`  quality gate: dropped ${rejected.length}/${rows.length} ${make} MSRP rows with non-integer prices (calculated, not published) -- e.g. ${rejected.slice(0, 3).map(r => `${r.model} ${r.trim ?? ""} ${r.msrp}`).join("; ")}`);
  }
  return kept;
}

async function replaceRows(table, rows, make, { fatal = true } = {}) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  try {
    // Match the make case-INSENSITIVELY: a scraper that changes its MAKE
    // constant casing (Mini -> MINI) otherwise orphans the entire old lineup,
    // which then lives forever as duplicate rows (observed 2026-08-11).
    // Provenance wins: rows carrying a source_url were verified by hand against
    // the manufacturer's own published page (Land Cruiser, Mach-E). A scraper
    // refresh must never wipe them -- exactly what happened on 2026-08-11.
    const guard = table === "msrp_catalog" ? "&source_url=is.null" : "";
    const del = await fetch(`${url}/rest/v1/${table}?make=ilike.${encodeURIComponent(make)}${guard}`, { method: "DELETE", headers });
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

// Collapse rows that would collide on a table's unique key before inserting.
// The pre-existing msrp_catalog has UNIQUE(year,make,model,trim), and some
// source catalogs list a trim twice (two configs resolve to the same grade
// name); keep the lowest price/apr = the advertised "starting" figure, matching
// how the dealer-feed scrapers already dedupe per trim.
export function dedupeBy(rows, keyFn, lowerField) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const prev = m.get(k);
    if (!prev || (Number(r[lowerField]) || Infinity) < (Number(prev[lowerField]) || Infinity)) m.set(k, r);
  }
  return [...m.values()];
}

export async function writeCatalogs(make, { msrpRows = [], financeRows = [], leaseRows = [] }, opts = {}) {
  msrpRows = gateMsrpRows(msrpRows, make);
  // Stamp the freight/PDI convention when the scraper knows it (see
  // supabase/migrations/20260811_msrp_price_basis.sql). Silence is honest:
  // an unstamped row makes the report show the freight caveat rather than
  // imply a precision we don't have.
  if (opts.priceBasis) msrpRows = msrpRows.map(r => ({ price_basis: opts.priceBasis, ...r }));
  msrpRows = dedupeBy(msrpRows, r => `${r.year}|${r.make}|${r.model}|${r.trim ?? ""}`, "msrp");
  financeRows = dedupeBy(financeRows, r => `${r.make}|${r.model}|${r.term_months}`, "apr");
  if (!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)) {
    const outDir = join(__dirname, "..", "out"); mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `${make.toLowerCase()}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify({ msrp_catalog: msrpRows, finance_rate_catalog: financeRows, lease_rate_catalog: leaseRows }, null, 2));
    console.log(`\nDRY RUN [${make}]. ${msrpRows.length} MSRP / ${financeRows.length} finance / ${leaseRows.length} lease -> ${file}`);
    console.table(msrpRows.slice(0, 8));
    return;
  }
  console.log(`\nWriting ${make} to Supabase…`);
  // Rates-only: skip the msrp_catalog write. Set either globally via
  // CATALOG_RATES_ONLY=1 (daily job) or per-scraper via opts.ratesOnly (e.g. a
  // dealer-feed rate source layered on top of another make's MSRP source).
  const ratesOnly = opts.ratesOnly || process.env.CATALOG_RATES_ONLY === "1";
  if (!ratesOnly) await replaceRows("msrp_catalog", msrpRows, make);
  else console.log(`  (rates-only: msrp_catalog left unchanged for ${make})`);
  await replaceRows("finance_rate_catalog", financeRows, make);
  await replaceRows("lease_rate_catalog", leaseRows, make, { fatal: false });
  console.log("Done.");
}

export function parseArgs() {
  return Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true]; }));
}
