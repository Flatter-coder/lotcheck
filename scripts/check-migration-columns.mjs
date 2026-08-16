// Every column a migration INSERTs must exist by the time that migration runs.
//
// WHY THIS EXISTS. Two migrations INSERTed `source_url` into
// finance_rate_catalog, which has no such column. Postgres answered 42703 and
// neither rate ever landed — so the manufacturer-APR half of the report had no
// data behind it while both migration files read as if the work were finished.
// Nothing caught it: the SQL is never executed in CI, and the failure surfaced
// only when a human pasted it into the Supabase editor and read the red text.
//
// That is the shape of every catalog disaster this repo has had: a green signal
// with no check behind it. This is the check.
//
// HOW IT WORKS. Migrations are applied in filename order, so the schema is
// replayed the same way: CREATE TABLE and ALTER TABLE ... ADD COLUMN build up a
// column set per table, and every INSERT is validated against the schema as of
// its own position in the sequence. A column added by a LATER migration does
// not excuse an EARLIER insert.
//
// Tables created before this repo tracked migrations have no CREATE statement
// here. For those, the column set is seeded from every other writer that
// already works — other migrations' inserts and the scrapers' row shapes — so
// a genuinely new column still has to arrive via an explicit ALTER.
//
// Run: node scripts/check-migration-columns.mjs

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "supabase/migrations";
const strip = (s) => s.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
const norm = (t) => t.replace(/^public\./i, "").replace(/"/g, "").toLowerCase();

// Column sets for tables that predate tracked migrations, taken from code that
// demonstrably works against the live database.
const PRE_EXISTING = {
  finance_rate_catalog: ["id", "make", "model", "apr", "term_months", "promo", "effective_date", "created_at"],
  lease_rate_catalog:   ["id", "make", "model", "apr", "term_months", "annual_km", "promo", "effective_date", "created_at"],
  msrp_catalog:         ["id", "year", "make", "model", "trim", "msrp", "fuel_type", "drivetrain", "attrs",
                         "price_basis", "source_url", "fetched_at", "created_at"],
};

// ORDERING FAULTS ARE NOW FIXED, so there is no allowlist.
//
// Three existed when this check was written, and rather than list them forever
// the two files were renamed so filename order matches dependency order:
//
//   20260730_free_check_breaker.sql -> 20260729z_free_check_breaker.sql
//     It CREATES app_config, which 20260730_admin_economics.sql inserts into,
//     but "admin" sorts before "free". It creates and uses only its own two
//     tables, so moving it earlier is safe in every direction.
//
//   20260814_august_backfill.sql -> 20260814z_august_backfill.sql
//     It inserts into founder_ledger and statement_run, both created by
//     later-sorting files. It creates nothing and nothing depends on it — and
//     a backfill belongs after the schema it fills, by definition.
//
// Renaming has NO production effect: apply-migrations.mjs keeps no ledger of
// what has run, and every migration is idempotent. What it buys is a history
// that can rebuild the database from empty — which is exactly when you need it.

const schema = new Map(Object.entries(PRE_EXISTING).map(([t, c]) => [t, new Set(c)]));
const problems = [];

const FILES = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();

// Which migration CREATEs each table, so an insert that runs before its table
// exists can be named precisely. accessory_catalog was inserted into by three
// migrations while the one that creates it had never been run — 42P01, and the
// column check above could not see it because the table was simply absent.
const createdIn = new Map();
for (const f of FILES) {
  for (const m of strip(readFileSync(join(DIR, f), "utf8"))
    .matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([\w".]+)/gi)) {
    if (!createdIn.has(norm(m[1]))) createdIn.set(norm(m[1]), f);
  }
}

for (const file of FILES) {
  const sql = strip(readFileSync(join(DIR, file), "utf8"));

  // CREATE TABLE name ( col type, ... )
  for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([\w".]+)\s*\(([\s\S]*?)\n\s*\)\s*;/gi)) {
    const cols = new Set();
    let depth = 0, buf = "";
    for (const ch of m[2] + ",") {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        const first = buf.trim().split(/\s+/)[0]?.replace(/"/g, "").toLowerCase();
        if (first && !/^(primary|foreign|unique|check|constraint|exclude)$/.test(first)) cols.add(first);
        buf = "";
      } else buf += ch;
    }
    schema.set(norm(m[1]), cols);
  }

  // ALTER TABLE name ADD COLUMN [IF NOT EXISTS] col
  for (const m of sql.matchAll(/alter\s+table\s+([\w".]+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?([\w"]+)/gi)) {
    const t = norm(m[1]);
    if (!schema.has(t)) schema.set(t, new Set());
    schema.get(t).add(m[2].replace(/"/g, "").toLowerCase());
  }

  // INSERT INTO name (cols) — validated against the schema as of RIGHT NOW.
  for (const m of sql.matchAll(/insert\s+into\s+([\w".]+)\s*\(([^)]*)\)/gi)) {
    const t = norm(m[1]);
    const known = schema.get(t);
    if (!known) {
      // The table is not in scope YET. If some migration creates it, this
      // insert runs before its own table exists — a definite ordering fault.
      // If nothing creates it, it predates tracked migrations; not our call.
      if (createdIn.has(t)) {
        const entry = { file, table: t, ordering: createdIn.get(t) };
        problems.push(entry);
      }
      continue;
    }
    for (const raw of m[2].split(",")) {
      const col = raw.trim().replace(/"/g, "").toLowerCase();
      if (!col) continue;
      if (!known.has(col)) {
        problems.push({ file, table: t, col, known: [...known].sort().join(", ") });
      }
    }
  }
}

if (problems.length) {
  console.error(`\n${problems.length} migration column error(s) — these would fail with 42703 in the SQL editor:\n`);
  for (const p of problems) {
    console.error(`  ${p.file}`);
    if (p.ordering) {
      console.error(`    inserts into ${p.table}, but that table is not created until ${p.ordering}`);
      console.error(`    -> 42P01 relation does not exist\n`);
    } else {
      console.error(`    ${p.table} has no column "${p.col}"`);
      console.error(`    columns at that point: ${p.known}\n`);
    }
  }
  console.error(`Add the column with an ALTER TABLE in an EARLIER-SORTING migration, or remove it from the insert.\n`);
  process.exit(1);
}

console.log(`migration columns OK — ${schema.size} tables tracked, every insert validated in filename order.`);
