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

/**
 * A missing relation is almost always a migration that was never applied, not
 * a fault in the one being run. The Management API can only say the relation
 * is absent; it cannot know which file would create it. We can — so name it.
 *
 * This cost a diagnosis round-trip the day the standing crawl went on:
 * 20260922f wrote the clearance into legal_source, and legal_source had sat
 * unapplied since 20260810. The error was accurate and told you nothing about
 * what to do next.
 */
/**
 * A migration that ran without error has not necessarily DONE anything.
 *
 * Every migration here is idempotent, which is what makes re-running safe — and
 * also what makes a no-op invisible. `on conflict do nothing` against a row that
 * already exists, an UPDATE whose WHERE matches nothing, an INSERT ... SELECT
 * whose source is empty: all three print the same green tick as real work. That
 * is not hypothetical. 20260916a reported success while three of its seven
 * statements matched zero rows, and it took a live report being wrong to notice.
 *
 * So a migration may state its own post-condition, as a trailing comment:
 *
 *   -- @assert: select count(*) = 6 from legal_control where rule_id = ...
 *
 * The runner executes each assertion AFTER the migration and fails the run if
 * one does not come back true. The assertion is SQL, evaluated by the database,
 * against the state the migration claims to have produced — not a re-reading of
 * the file that just ran.
 *
 * Assertions are optional. A migration with none behaves exactly as before, so
 * this cannot retroactively break anything already applied.
 */
function assertionsIn(sql) {
  return [...sql.matchAll(/^\s*--\s*@assert:\s*(.+?)\s*$/gim)].map((m) => m[1]);
}

/**
 * Run one post-condition. It must return a single row whose single column is
 * true; anything else — false, no rows, an error — fails the migration.
 *
 * A post-condition that cannot fail is worse than none, so an assertion that
 * does not evaluate to a boolean is itself an error rather than a pass.
 */
async function runAssertion(expr) {
  const rows = await runSql(`select (${expr}) as ok;`);
  const first = Array.isArray(rows) ? rows[0] : null;
  if (!first || !("ok" in first)) {
    return { ok: false, why: "returned no 'ok' column — an assertion must be a single boolean expression" };
  }
  if (first.ok === null) return { ok: false, why: "evaluated to NULL, which is not a passing post-condition" };
  if (first.ok !== true) return { ok: false, why: `evaluated to ${JSON.stringify(first.ok)}` };
  return { ok: true };
}

function blameMissingRelation(message) {
  // The body arrives UNPARSED, so the quotes around the name are escaped:
  //   ...ERROR:  42P01: relation \"public.legal_source\" does not exist
  // A pattern expecting bare quotes matches the message you would write by
  // hand in a test and never the one the API actually sends.
  const m = /relation \\?"(?:public\.)?([a-z0-9_]+)\\?" does not exist/i.exec(message || "");
  if (!m) return null;
  const rel = m[1];
  const creates = new RegExp(
    "create\\s+(?:or\\s+replace\\s+)?(?:table|view|materialized\\s+view)\\s+" +
    "(?:if\\s+not\\s+exists\\s+)?(?:public\\.)?" + rel + "\\b", "i");
  const creator = allMigrations().find(
    (f) => creates.test(readFileSync(join(DIR, f), "utf8")));
  return creator
    ? `"${rel}" is created by ${creator}, which has not been applied. Apply that first — the migrations are idempotent, so naming both in order is safe.`
    : `"${rel}" is not created by any migration in ${DIR}/ — check the name.`;
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

    const asserts = assertionsIn(sql);
    if (DRY) {
      console.log(`  · ${f} (${sql.length} chars) — not executed`
        + (asserts.length ? `, ${asserts.length} post-condition(s) not checked` : ""));
      continue;
    }

    try {
      await runSql(sql);
      // A green tick must mean the migration DID something, not merely that it
      // parsed. Post-conditions run against the database, after the fact.
      let bad = 0;
      for (const a of asserts) {
        const r = await runAssertion(a).catch((e) => ({ ok: false, why: e.message }));
        if (r.ok) console.log(`      ✓ ${a}`);
        else { bad++; console.error(`      ✗ ${a}\n        ${r.why}`); }
      }
      if (bad) {
        failed++;
        console.error(`  ✗ ${f} — applied, but ${bad} post-condition(s) FAILED. `
          + `The statements ran; they did not do what the migration claims.`);
      } else {
        console.log(`  ✓ ${f}${asserts.length ? ` (${asserts.length} post-condition(s) held)` : ""}`);
      }
    } catch (e) {
      failed++;
      console.error(`  ✗ ${f}\n      ${e.message}`);
      const blame = blameMissingRelation(e.message);
      if (blame) console.error(`      → ${blame}`);
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
