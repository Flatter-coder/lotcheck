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
//
// Every row leaves here with EVERY carry column present, explicitly null when
// there is nothing to carry. PostgREST bulk INSERT requires all objects in a
// batch to share one key set (PGRST102 "All object keys must match");
// enriching only the rows that had a predecessor made the batch heterogeneous,
// the INSERT 400'd after the DELETE had already run, and eleven makes left
// msrp_catalog on 2026-08-13. A carried key must never decide whether its
// neighbours insert.
export function mergeCarryForward(rows, prevRows, cols = CARRY_FORWARD) {
  const prev = new Map();
  for (const r of prevRows || []) prev.set(catKey(r), r);
  let carried = 0;
  const out = (rows || []).map((r) => {
    const old = prev.get(catKey(r));
    const merged = { ...r };
    for (const c of cols) {
      if (merged[c] == null) {
        // Only fill what the scraper left empty — a fresh scrape always wins.
        const v = old && old[c] != null ? old[c] : null;
        if (v != null) carried++;
        merged[c] = v;
      }
    }
    return merged;
  });
  return { rows: out, carried };
}

async function carryForward(table, rows, make, headers, url) {
  if (table !== "msrp_catalog") return rows;
  const q = `${url}/rest/v1/${table}?make=ilike.${encodeURIComponent(make)}` +
            `&select=year,model,trim,${CARRY_FORWARD.join(",")}&limit=5000`;
  const res = await fetch(q, { headers });
  if (!res.ok) { console.warn(`  ⚠️ carry-forward read failed (HTTP ${res.status}); enrichment may be lost.`); return rows; }
  const { rows: out, carried } = mergeCarryForward(rows, await res.json());
  if (carried) console.log(`  carried forward ${carried} enrichment value(s) for ${make}.`);
  return out;
}

async function replaceRows(table, rows, make, { fatal = true, upsert = false } = {}) {
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
    rows = await carryForward(table, rows, make, headers, url);
    const guard = table === "msrp_catalog" ? "&source_url=is.null" : "";
    const del = await fetch(`${url}/rest/v1/${table}?make=ilike.${encodeURIComponent(make)}${guard}`, { method: "DELETE", headers });
    if (!del.ok && del.status !== 404) throw new Error(`DELETE ${table} -> HTTP ${del.status}: ${await del.text()}`);

    // The DELETE above deliberately SPARES hand-verified rows (source_url set).
    // Those survivors still occupy their slot in UNIQUE(year,make,model,trim),
    // so a scraped row for the same trim collides -- and one collision fails
    // the whole INSERT, after the delete has already run. That is not a lost
    // row, it is a lost lineup: on 2026-08-12 a Ford refresh deleted 78 rows,
    // hit a duplicate "2026 Bronco Sport Heritage" against a preserved row,
    // and left the catalog with 7 Ford rows in production.
    if (table === "msrp_catalog") {
      const keyOf = (r) => `${r.year}|${String(r.model ?? "")}|${String(r.trim ?? "")}`;

      // Two configurations can resolve to one grade name; keep the first.
      const seen = new Set();
      const beforeBatch = rows.length;
      rows = rows.filter((r) => (seen.has(keyOf(r)) ? false : (seen.add(keyOf(r)), true)));
      if (beforeBatch !== rows.length) {
        console.log(`  ${table} (${make}): collapsed ${beforeBatch - rows.length} duplicate key(s) within the batch.`);
      }

      // The source_url protection is meant for keys the scraper CANNOT produce
      // — it was never meant to freeze a price the manufacturer has since
      // changed. A 2026 Mustang Mach-E Premium sat at a hand-entered $47,638
      // while ford.ca published $49,990, and because the verified row survived
      // every refresh it kept winning the lookup and was reported as an EXACT
      // trim MSRP: a stale figure wearing the badge of the most authoritative
      // one we have.
      //
      // So: where this run carries a manufacturer figure for the same key, the
      // live number supersedes and the stale row is removed. Where it does not,
      // the verified row is left exactly as protected as before.
      try {
        const res = await fetch(`${url}/rest/v1/${table}?select=id,year,model,trim,msrp&make=ilike.${encodeURIComponent(make)}`, { headers });
        if (res.ok) {
          const wanted = new Set(rows.map(keyOf));
          // A trim-less row is a "starting at" summary for the model-year. Once
          // this run republishes that model-year's real trim ladder the summary
          // is stale by construction — Ford's own base moved $45,778 -> $47,990
          // while the old floor sat underneath it — so it goes too.
          const republished = new Set(rows.map((r) => `${r.year}|${String(r.model ?? "")}`));
          const stale = (await res.json()).filter((r) =>
            wanted.has(keyOf(r)) ||
            (r.trim == null && republished.has(`${r.year}|${String(r.model ?? "")}`)));
          for (const r of stale) {
            const d = await fetch(`${url}/rest/v1/${table}?id=eq.${r.id}`, { method: "DELETE", headers });
            if (!d.ok && d.status !== 404) console.warn(`  ⚠️ could not supersede ${keyOf(r)} (HTTP ${d.status}).`);
          }
          if (stale.length) {
            console.log(`  ${table} (${make}): superseded ${stale.length} preserved row(s) with this run's manufacturer figures — e.g. ${stale.slice(0, 3).map((r) => `${r.model} ${r.trim ?? ""} was $${r.msrp}`).join("; ")}.`);
          }
        }
      } catch { /* best-effort: a failed probe must not block the refresh */ }
    }

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
  if (!ratesOnly) await replaceRows("msrp_catalog", msrpRows, make, { upsert: !!opts.upsert });
  else console.log(`  (rates-only: msrp_catalog left unchanged for ${make})`);
  await replaceRows("finance_rate_catalog", financeRows, make);
  await replaceRows("lease_rate_catalog", leaseRows, make, { fatal: false });
  console.log("Done.");
}

export function parseArgs() {
  return Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true]; }));
}
