// Fresh-write guard for the weekly catalog refresh: GREEN MUST MEAN "WROTE
// FRESH ROWS", not "didn't crash".
//
// Why: every scraper step runs with continue-on-error (fault isolation, after
// Genesis's 2026-08-10 crash took six makes down with it), which means a step
// can crash — or scrape zero rows and no-op — while the run stays green.
// That is exactly how the Genesis endpoint 404'd from 2026-08-11 onward with
// nobody noticing: the site moved to a new API and the catalog quietly froze
// at fetched_at 2026-08-08.
//
// How: `snapshot` records per-make row count + max(id) for each catalog table
// before any scraper runs. `verify --makes=… --msrp=… --finance=…` runs after
// each make's step and compares. The max(id) columns are generated-always
// identities, so ANY insert moves them — a delete-then-insert refresh that
// wrote fresh rows always advances max(id), regardless of what the rows
// contain. No timestamp-column semantics to argue about.
//
// Verdicts per make × table:
//   • no fresh rows written           -> FAIL (required) / WARN (optional)
//   • row count collapsed by half+    -> FAIL / WARN  (the Ford 78 -> 7 class)
//   • table absent from API schema    -> FAIL / WARN  (the lease_rate_catalog
//     class: writes 404 "PGRST205" forever and fatal:false swallows it)
// `optional` exists for makes whose zero-writes are known and accepted (GM:
// no national MSRP is published, the fractional-price gate rejects the
// computed postal-code prices by design — see scripts/COVERAGE.md). Optional
// makes still surface as ::warning annotations and step-summary rows; they
// just don't redden a run that is behaving as documented.
//
// Verify steps carry NO continue-on-error, so one failing make marks the run
// red while `if: !cancelled()` lets every other make keep refreshing.
//
// Usage:
//   node scripts/catalog-refresh-guard.mjs snapshot
//   node scripts/catalog-refresh-guard.mjs verify --step="Genesis" \
//     --makes="Genesis" --msrp=required --finance=required --lease=optional
//
// Without SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY both modes no-op (exit 0),
// matching the scrapers' dry-run behaviour on forks.

import { writeFileSync, readFileSync, existsSync, appendFileSync, statSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const TABLES = { msrp: "msrp_catalog", finance: "finance_rate_catalog", lease: "lease_rate_catalog" };
const SNAP = process.env.GUARD_STATE_FILE ||
  join(process.env.RUNNER_TEMP || os.tmpdir(), "catalog-guard-snapshot.json");
const PAGE = 1000; // Supabase REST caps a single response at 1000 rows

const creds = () => ({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY });

// Whole-table scan (few thousand small rows), aggregated per lower-cased make.
// Paginated with a stable order because unordered offset pages can skip rows.
async function fetchTableState(table, withFetchedAt) {
  const { url, key } = creds();
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const cols = withFetchedAt ? "make,id,fetched_at" : "make,id";
  const byMake = new Map();
  for (let offset = 0, page = 0; page < 40; page++, offset += PAGE) {
    const res = await fetch(`${url}/rest/v1/${table}?select=${cols}&order=id.asc&limit=${PAGE}&offset=${offset}`, { headers });
    if (!res.ok) {
      const body = await res.text();
      if (res.status === 404 || body.includes("PGRST205")) return { missing: true, makes: {} };
      throw new Error(`${table} read failed: HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const rows = await res.json();
    for (const r of rows) {
      const k = String(r.make || "").toLowerCase();
      const m = byMake.get(k) || { make: r.make, count: 0, maxId: 0, maxFetchedAt: null };
      m.count++;
      if (Number(r.id) > m.maxId) m.maxId = Number(r.id);
      if (withFetchedAt && r.fetched_at && (!m.maxFetchedAt || r.fetched_at > m.maxFetchedAt)) m.maxFetchedAt = r.fetched_at;
      byMake.set(k, m);
    }
    if (rows.length < PAGE) break;
  }
  return { missing: false, makes: Object.fromEntries(byMake) };
}

// Pure verdict for one make × table. Exported for scripts/test-catalog-guard.mjs.
//   level: 'required' | 'optional'; pre/post: {count, maxId, maxFetchedAt} | undefined
export function evaluateMake({ level, pre, post, tableMissing }) {
  const escalate = level === "required" ? "fail" : "warn";
  if (tableMissing) {
    return { status: escalate, reasons: ["table does not exist in the API schema — every write to it fails (PGRST205) and fatal:false swallows it"] };
  }
  const p = pre || { count: 0, maxId: 0, maxFetchedAt: null };
  const q = post || { count: 0, maxId: 0, maxFetchedAt: null };
  const reasons = [];
  let status = "ok";
  if (!(q.maxId > p.maxId)) {
    status = escalate;
    reasons.push(`no fresh rows written (max id ${q.maxId} unchanged since snapshot; newest row ${q.maxFetchedAt || "n/a"})`);
  }
  // A halved catalog is a wipe wearing a green checkmark (Ford went 78 -> 7
  // this way). Only meaningful above a floor — 3 -> 2 is model churn.
  if (p.count >= 10 && q.count < Math.ceil(p.count / 2)) {
    status = escalate;
    reasons.push(`row count collapsed ${p.count} -> ${q.count}`);
  }
  return { status, reasons };
}

function summaryLine(cells) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (!f) return;
  let empty = true;
  try { empty = statSync(f).size === 0; } catch { /* treat as empty */ }
  if (empty) {
    appendFileSync(f, "### Catalog fresh-write guard\n\n| Step | Make | Table | Rows pre → post | Fresh write | Verdict |\n|---|---|---|---|---|---|\n");
  }
  appendFileSync(f, `| ${cells.join(" | ")} |\n`);
}

async function snapshot() {
  const tables = {};
  for (const [short, table] of Object.entries(TABLES)) {
    tables[table] = await fetchTableState(table, short === "msrp");
    const st = tables[table];
    if (st.missing) { console.log(`  ${table}: MISSING from API schema`); continue; }
    const makes = Object.values(st.makes).sort((a, b) => a.make.localeCompare(b.make));
    console.log(`  ${table}: ${makes.reduce((n, m) => n + m.count, 0)} rows across ${makes.length} makes`);
    for (const m of makes) console.log(`    ${m.make}: ${m.count} rows, max id ${m.maxId}${m.maxFetchedAt ? `, newest ${m.maxFetchedAt.slice(0, 10)}` : ""}`);
  }
  writeFileSync(SNAP, JSON.stringify({ takenAt: new Date().toISOString(), tables }, null, 1));
  console.log(`Snapshot -> ${SNAP}`);
}

async function verify(args) {
  const makes = String(args.makes || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!makes.length) { console.error("guard verify: --makes is required"); process.exit(1); }
  const step = args.step || makes.join(", ");
  if (!existsSync(SNAP)) {
    console.error(`::error title=Catalog guard::snapshot file missing (${SNAP}) — cannot verify ${step}; a skipped check must not read as a pass`);
    process.exit(1);
  }
  const snap = JSON.parse(readFileSync(SNAP, "utf8"));
  let failed = false;
  for (const [short, table] of Object.entries(TABLES)) {
    const level = args[short];
    if (!level || level === "skip") continue;
    if (level !== "required" && level !== "optional") { console.error(`guard verify: --${short} must be required|optional|skip`); process.exit(1); }
    const post = await fetchTableState(table, short === "msrp");
    const preTable = snap.tables[table] || { missing: false, makes: {} };
    for (const make of makes) {
      const pre = preTable.makes[make.toLowerCase()];
      const cur = post.makes[make.toLowerCase()];
      const v = evaluateMake({ level, pre, post: cur, tableMissing: post.missing });
      const preC = pre ? pre.count : 0, postC = cur ? cur.count : 0;
      const freshTxt = post.missing ? "—" : (cur && (!pre || cur.maxId > pre.maxId) ? "yes" : "NO");
      const icon = v.status === "ok" ? "✅ ok" : v.status === "warn" ? "⚠️ warn" : "❌ FAIL";
      summaryLine([step, make, table, `${preC} → ${postC}`, freshTxt, icon]);
      if (v.status === "ok") {
        console.log(`  ok    ${make} / ${table}: ${preC} -> ${postC} rows, fresh write confirmed`);
      } else {
        const msg = `${make} / ${table}: ${v.reasons.join("; ")}`;
        console.log(`::${v.status === "fail" ? "error" : "warning"} title=Catalog guard — ${step}::${msg}`);
        if (v.status === "fail") failed = true;
      }
    }
  }
  if (failed) {
    console.error(`Guard FAILED for step "${step}" — the step above ran green but did not refresh these rows.`);
    process.exit(1);
  }
}

function parseArgs() {
  return Object.fromEntries(process.argv.slice(3).map(a => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  }));
}

// Entry point. When imported (by the offline test) argv[2] is not a mode and
// nothing runs.
const mode = process.argv[2];
if (mode === "snapshot" || mode === "verify") {
  const { url, key } = creds();
  if (!url || !key) {
    console.log("guard: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping (dry-run parity with the scrapers).");
  } else {
    (mode === "snapshot" ? snapshot() : verify(parseArgs())).catch(e => { console.error(`::error title=Catalog guard::${e.message}`); process.exit(1); });
  }
}
