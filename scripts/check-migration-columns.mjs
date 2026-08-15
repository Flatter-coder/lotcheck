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

const schema = new Map(Object.entries(PRE_EXISTING).map(([t, c]) => [t, new Set(c)]));
const problems = [];

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort()) {
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
    if (!known) continue; // table we cannot see; not this check's job to guess
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
    console.error(`    ${p.table} has no column "${p.col}"`);
    console.error(`    columns at that point: ${p.known}\n`);
  }
  console.error(`Add the column with an ALTER TABLE in an EARLIER-SORTING migration, or remove it from the insert.\n`);
  process.exit(1);
}

console.log(`migration columns OK — ${schema.size} tables tracked, every insert validated in filename order.`);
