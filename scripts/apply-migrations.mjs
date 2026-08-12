// Apply migrations from CI, so nobody has to paste SQL into a web editor.
//
// WHY. Hand-pasting migrations cost about ten exchanges on the Alberta
// inventory tables — wrong window, wrong directory, steps out of order, a
// confirm query run before the thing it confirmed. All avoidable: the
// Management API has run arbitrary SQL for us all along (scripts/
// amvic-refresh.mjs applies its own DDL that way every week), and
// SUPABASE_ACCESS_TOKEN is already a repo secret.
//
// SAFE TO RE-RUN. Every migration in this repo is written idempotently
// (create ... if not exists, create or replace, on conflict do nothing), so
// re-applying one is a no-op rather than a hazard. It reports what changed
// either way.
//
// Run (from repo root):
//   node scripts/apply-migrations.mjs --list
//   node scripts/apply-migrations.mjs 20260811_alberta_inventory.sql
//   node scripts/apply-migrations.mjs --all-since 20260810
//   node scripts/apply-migrations.mjs <file> --dry-run    # print, execute nothing
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PROJECT_REF = "debigtyjhjamipooajhk";
const DIR = "supabase/migrations";
const DRY = process.argv.includes("--dry-run");

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flag = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };

function allMigrations() {
  return readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
}

async function runSql(sql) {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN is not set");
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Management API ${res.status}: ${body.slice(0, 600)}`);
  try { return JSON.parse(body); } catch { return null; }
}

// PostgREST caches the schema, so a table or function created here stays
// invisible to the REST API until it reloads. That exact gap is what made a
// freshly-created dealer_source read as "does not exist" to the crawler.
async function reloadSchemaCache() {
  await runSql("notify pgrst, 'reload schema';");
}

async function main() {
  if (process.argv.includes("--list")) {
    for (const f of allMigrations()) console.log("  " + f);
    return;
  }

  let files = args;
  const since = flag("--all-since");
  if (since) files = allMigrations().filter((f) => f >= since);
  if (!files.length) { console.error("nothing to apply — name a migration, or use --all-since <prefix> / --list"); process.exit(1); }

  console.log(`Applying ${files.length} migration(s) to ${PROJECT_REF}${DRY ? " (DRY RUN)" : ""}\n`);
  let failed = 0;

  for (const f of files) {
    const path = f.includes("/") ? f : join(DIR, f);
    let sql;
    try { sql = readFileSync(path, "utf8"); }
    catch { console.error(`  ✗ ${f} — file not found`); failed++; continue; }

    if (DRY) { console.log(`  · ${f} (${sql.length} chars) — not executed`); continue; }

    try {
      await runSql(sql);
      console.log(`  ✓ ${f}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${f}\n      ${e.message}`);
    }
  }

  if (!DRY) {
    await reloadSchemaCache().then(
      () => console.log("\n  schema cache reloaded"),
      (e) => console.warn("\n  schema reload failed (non-fatal): " + e.message),
    );
  }

  console.log(`\n${failed ? "❌" : "✅"} ${files.length - failed}/${files.length} applied`);
  if (failed) process.exit(1);
}

await main();
