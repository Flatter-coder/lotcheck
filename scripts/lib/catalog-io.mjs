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

// Columns a SCRAPER does not produce but that are true about the vehicle and
// expensive to re-establish: drivetrain is verified per trim against the
// manufacturer, attrs records distinctive equipment, price_basis records the
// freight/PDI convention.
//
// They have to be carried across a refresh explicitly. replaceRows deletes
// every row for a make and re-inserts what the scraper produced, so any column
// the scraper is silent about comes back NULL. That is not hypothetical: the
// drivetrain values seeded by hand from official sources (Toyota bZ, Camry,
// Nissan Rogue) were wiped this way, and msrp_catalog.drivetrain was 0/881
// populated by the time anyone looked. Backfilling without this fix just
// queues the same loss for the next refresh.
export const CARRY_FORWARD = ["drivetrain", "attrs", "price_basis", "source_url"];

export const catKey = (r) => `${r.year}|${r.model}|${r.trim ?? ""}`;

// Pure half, exported so it can be tested without a database.
export function mergeCarryForward(rows, prevRows, cols = CARRY_FORWARD) {
  const prev = new Map();
  for (const r of prevRows || []) prev.set(catKey(r), r);
  let carried = 0;
  const out = (rows || []).map((r) => {
    const old = prev.get(catKey(r));
    if (!old) return r;
    const add = {};
    // Only fill what the scraper left empty — a fresh scrape always wins.
    for (const c of cols) if (r[c] == null && old[c] != null) { add[c] = old[c]; carried++; }
    return Object.keys(add).length ? { ...r, ...add } : r;
  });
  return { rows: out, carried };
}

// PostgREST bulk INSERT requires EVERY object in the array to carry an
// identical key set; a batch whose objects disagree is rejected whole with
// HTTP 400 PGRST102 "All object keys must match". mergeCarryForward produces
// exactly that shape -- rows that matched a previous row gain `drivetrain` etc,
// rows that matched nothing do not -- so the moment any enrichment carried
// forward, that make's entire INSERT failed. Because the DELETE had already
// committed, the make was left EMPTY. That is what destroyed 471 rows across
// 12 makes on 2026-08-14 (Kia, Honda, Ford, Mazda, Nissan, Subaru, VW ... all
// went to zero), and the daily/weekly refresh would have done it again.
//
// Normalising to the union of keys is the class fix: it holds for any future
// column any code path adds conditionally, not just the four carried today.
// `id` is never sent -- the database owns it.
const NEVER_SEND = new Set(["id"]);
export function uniformKeys(rows) {
  const all = new Set();
  for (const r of rows || []) for (const k of Object.keys(r)) if (!NEVER_SEND.has(k)) all.add(k);
  const cols = [...all];
  return (rows || []).map((r) => {
    const out = {};
    for (const c of cols) out[c] = r[c] === undefined ? null : r[c];
    return out;
  });
}

// A scrape that returns SOME rows is not proof the source is healthy. Toyota's
// lineup came back as 7 rows on 2026-08-14 (bZ, bZ Woodland, C-HR -- no RAV4,
// Corolla, Camry, Highlander, Tacoma, Tundra, Sienna, Prius), the delete ran on
// the strength of it, and the run reported "replaced with 7 rows" as success.
// The pre-existing guard only fires at EXACTLY zero, so one row armed it.
//
// Refuse instead: a stale catalog is recoverable, a deleted one is not. A
// genuine lineup cut (a make discontinuing half its models) is rare enough to
// be worth a human confirming via CATALOG_ALLOW_COLLAPSE=1.
export const COLLAPSE_FLOOR = 10;   // below this a make is too small to judge
export const COLLAPSE_DROP  = 0.5;  // losing >50% of a make needs a human
export function assessCollapse(prevCount, nextCount, { floor = COLLAPSE_FLOOR, drop = COLLAPSE_DROP } = {}) {
  if (!(prevCount >= floor)) return { collapse: false };
  if (nextCount >= prevCount * (1 - drop)) return { collapse: false };
  return {
    collapse: true,
    reason: `would drop ${prevCount} -> ${nextCount} rows (${Math.round((1 - nextCount / prevCount) * 100)}% loss)`,
  };
}

// Read the make's full current rows ONCE: they feed carry-forward, the collapse
// check, and -- if the insert fails -- the restore.
async function readExisting(table, make, headers, url) {
  const guard = table === "msrp_catalog" ? "&source_url=is.null" : "";
  const q = `${url}/rest/v1/${table}?make=ilike.${encodeURIComponent(make)}${guard}&select=*&limit=5000`;
  const res = await fetch(q, { headers });
  if (!res.ok) return { ok: false, rows: [] };
  return { ok: true, rows: await res.json() };
}

// Exported so the Toyota/Lexus (tci-stack) and FCA (fca-stack) scrapers use
// THIS implementation instead of their own copies. Those copies had neither the
// empty-scrape guard nor carry-forward, which is why Toyota was cut from a full
// lineup to 7 rows on 2026-08-14 with the run still reporting success.
export async function replaceRows(table, rows, make, { fatal = true, upsert = false } = {}) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  // An empty scrape must NEVER wipe good data. Delete-then-insert with zero
  // rows silently emptied a table whenever a source went down or a caller
  // passed only one of the three row sets.
  if (!rows.length) { console.log(`  ${table} (${make}): nothing scraped — existing rows left untouched.`); return; }
  try {
    // Upsert mode: published-price rows are keyed and re-captured weekly, so
    // they merge in place rather than delete-then-insert.
    if (upsert) {
      for (let i = 0; i < rows.length; i += 500) {
        const ins = await fetch(`${url}/rest/v1/${table}?on_conflict=year,make,model,trim`, {
          method: "POST",
          headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(rows.slice(i, i + 500)),
        });
        if (!ins.ok) throw new Error(`UPSERT ${table} -> HTTP ${ins.status}: ${await ins.text()}`);
      }
      console.log(`  ${table} (${make}): upserted ${rows.length} published rows.`);
      return;
    }
    // Match the make case-INSENSITIVELY: a scraper that changes its MAKE
    // constant casing (Mini -> MINI) otherwise orphans the entire old lineup,
    // which then lives forever as duplicate rows (observed 2026-08-11).
    // Provenance wins: rows carrying a source_url were verified by hand against
    // the manufacturer's own published page (Land Cruiser, Mach-E). A scraper
    // refresh must never wipe them -- exactly what happened on 2026-08-11.
    // Read the enrichment BEFORE the delete, or there is nothing left to read.
    // Read the current rows BEFORE anything destructive: they are the
    // enrichment source, the collapse baseline, and the restore copy.
    const prev = await readExisting(table, make, headers, url);
    if (!prev.ok) console.warn(`  ⚠️ could not read existing ${make} rows; enrichment may be lost and no restore is possible.`);
    if (table === "msrp_catalog" && prev.rows.length) {
      const { rows: merged, carried } = mergeCarryForward(rows, prev.rows);
      if (carried) console.log(`  carried forward ${carried} enrichment value(s) for ${make}.`);
      rows = merged;
    }
    // Must run AFTER the merge -- the merge is what makes the keys disagree.
    rows = uniformKeys(rows);

    const verdict = assessCollapse(prev.rows.length, rows.length);
    if (verdict.collapse && process.env.CATALOG_ALLOW_COLLAPSE !== "1") {
      throw new Error(
        `REFUSED: ${table} (${make}) ${verdict.reason}. Existing rows kept untouched. ` +
        `If the lineup really shrank, re-run with CATALOG_ALLOW_COLLAPSE=1.`);
    }

    const guard = table === "msrp_catalog" ? "&source_url=is.null" : "";
    const del = await fetch(`${url}/rest/v1/${table}?make=ilike.${encodeURIComponent(make)}${guard}`, { method: "DELETE", headers });
    if (!del.ok && del.status !== 404) throw new Error(`DELETE ${table} -> HTTP ${del.status}: ${await del.text()}`);
    try {
      for (let i = 0; i < rows.length; i += 500) {
        const ins = await fetch(`${url}/rest/v1/${table}`, { method: "POST", headers: { ...headers, Prefer: "return=minimal" }, body: JSON.stringify(rows.slice(i, i + 500)) });
        if (!ins.ok) throw new Error(`INSERT ${table} -> HTTP ${ins.status}: ${await ins.text()}`);
      }
    } catch (insErr) {
      // DELETE and INSERT are two PostgREST calls with no transaction around
      // them, so a failed insert has already destroyed the make. Put it back.
      // This is a compensating restore, not atomicity -- but it turns silent
      // permanent loss into a loud, recovered failure.
      const back = uniformKeys(prev.rows);
      let restored = 0;
      for (let i = 0; i < back.length; i += 500) {
        const res = await fetch(`${url}/rest/v1/${table}`, { method: "POST", headers: { ...headers, Prefer: "return=minimal" }, body: JSON.stringify(back.slice(i, i + 500)) });
        if (res.ok) restored += back.slice(i, i + 500).length;
      }
      const note = back.length === 0 ? "nothing to restore"
        : restored === back.length ? `restored all ${restored} previous rows`
        : `RESTORE INCOMPLETE — ${restored}/${back.length} rows recovered`;
      throw new Error(`${insErr.message}\n  ↩ ${table} (${make}): ${note}.`);
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
  if (!ratesOnly) await replaceRows("msrp_catalog", msrpRows, make, { upsert: !!opts.upsert });
  else console.log(`  (rates-only: msrp_catalog left unchanged for ${make})`);
  await replaceRows("finance_rate_catalog", financeRows, make);
  await replaceRows("lease_rate_catalog", leaseRows, make, { fatal: false });
  console.log("Done.");
}

export function parseArgs() {
  return Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true]; }));
}
