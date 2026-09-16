// A data migration addresses rows by their natural key, and cannot no-op.
//
// WHAT BROKE. On 2026-09-16 migration 20260916a_catalog_backfill_and_rename.sql
// was applied and reported "✅ 1/1 applied". Three of its seven statements
// matched ZERO rows and changed nothing:
//
//     update public.msrp_catalog set trim = 'XLE Mobility Package'
//      where id = 47978 and trim = 'Sienna XLE Mobility Package';
//
// Those ids had been correct when the PR was written. The daily catalog refresh
// ran 53 minutes after it merged, and replaceRows() deletes a make's rows and
// re-inserts them, so every id in that range was reassigned — 47978 became
// 49444. An UPDATE that matches no rows is not an error in Postgres, so the run
// went green over work that never happened, and the Sienna trims it was written
// to fix are still wrong.
//
// Its sibling 20260916b_catalog_delete_duplicates.sql was never applied. Six of
// its EIGHT delete targets no longer existed by the time anyone ran it; applying
// it would have deleted two rows, silently missed six, and reported success.
//
// TWO RULES, and neither has an allowlist.
//
//   RULE 1 — no surrogate-id predicates against a table a scraper rewrites.
//     msrp_catalog, finance_rate_catalog and lease_rate_catalog are rebuilt by
//     replaceRows() on every refresh, so their ids are not stable for the life
//     of a pull request. The stable address is the natural key: for
//     msrp_catalog that is (year, make, model, trim), which is also its UNIQUE
//     constraint and the key carry-forward and supersede both run on.
//     Measured when this check was written: all 143 migrations in the repo
//     contained exactly 15 id-pinned statements against those tables, and all
//     15 were in the two files above. The convention was always the natural
//     key; those two broke it. That is why there is no allowlist — there is
//     nothing legitimate to exempt.
//
//   RULE 2 — a data migration must prove it changed something.
//     An UPDATE or DELETE has to sit inside a block that reads ROW_COUNT and
//     RAISEs when nothing matched, so a no-op fails loudly instead of passing
//     quietly:
//
//         do $$
//         declare n int;
//         begin
//           delete from public.msrp_catalog where ...;
//           get diagnostics n = row_count;
//           if n = 0 then raise exception 'matched no rows'; end if;
//         end $$;
//
//     RULE 2 APPLIES FROM 2026-09-16 ONWARD, and that date is a rule-effective
//     date, not an exemption list. The 51 UPDATE/DELETE statements in earlier
//     migrations have ALREADY BEEN APPLIED to production; rewriting applied SQL
//     to satisfy a new convention changes nothing in the database and risks
//     breaking a file whose behaviour is now load-bearing. The job of this check
//     is to stop the NEXT one, and every migration written from the day the
//     defect was found is in scope.
//
// Run: node scripts/check-migration-row-identity.mjs

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "supabase/migrations";

// Tables a scraper rebuilds via replaceRows() (scripts/lib/catalog-io.mjs):
// delete-then-insert, so ids are reassigned on every refresh.
const REFRESH_OWNED = new Set(["msrp_catalog", "finance_rate_catalog", "lease_rate_catalog"]);

// The day the defect was found. See RULE 2 above for why this is a start date
// rather than a list of exceptions.
const ASSERT_REQUIRED_FROM = "20260916";

// STRIP COMMENTS BEFORE ASSERTING ANYTHING. These migration files are mostly
// prose: 20260916b is 30 lines of explanation around 8 lines of SQL, and it
// QUOTES its own delete statements inside those comments. A check that matched
// raw text would find violations in the explanation of a fix and miss them in
// the fix. This repo has shipped that exact false pass before — check:parity
// was anchored on a substring that appeared in a comment.
function stripComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

// Spans of `do $$ ... $$` that actually assert on ROW_COUNT. A DO block that
// merely wraps a statement proves nothing, so the block must contain all three:
// GET DIAGNOSTICS, ROW_COUNT, and a RAISE.
function assertingBlocks(sql) {
  const spans = [];
  const re = /\bdo\s*\$\$([\s\S]*?)\$\$/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const body = m[1];
    const asserts =
      /\bget\s+diagnostics\b/i.test(body) &&
      /\brow_count\b/i.test(body) &&
      /\braise\b/i.test(body);
    if (asserts) spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

// `id = 47978` or `id in (2744, 2773)`. The lookbehind is what keeps it off
// `dealer_id`, `listing_id` and `place_id`, which are natural keys elsewhere in
// these files and are not what this rule is about.
const ID_PREDICATE = /(?<![\w.])id\s*(?:=\s*\d|in\s*\(\s*\d)/i;

const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const violations = [];
let checked = 0;

for (const f of files) {
  // newline:"" has no analogue here, but readFileSync + utf8 keeps CRLF intact,
  // and every regex below is newline-agnostic. A previous check in this repo
  // silently mis-detected line endings and passed on files it never read.
  const raw = readFileSync(join(DIR, f), "utf8");
  const sql = stripComments(raw);
  const blocks = assertingBlocks(sql);
  const insideAssertingBlock = (i) => blocks.some(([a, b]) => i >= a && i < b);
  const datePrefix = (f.match(/^(\d{8})/) || [])[1] || "";
  const assertRequired = datePrefix >= ASSERT_REQUIRED_FROM;

  const re = /\b(update|delete\s+from)\s+(?:public\.)?(\w+)([\s\S]*?);/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const verb = m[1].toLowerCase().startsWith("update") ? "UPDATE" : "DELETE";
    const table = m[2].toLowerCase();
    if (!REFRESH_OWNED.has(table)) continue;
    checked++;
    const rest = m[3];
    const stmt = `${verb} ${table} ${rest.replace(/\s+/g, " ").trim()}`.slice(0, 110);

    if (ID_PREDICATE.test(rest)) {
      violations.push({
        file: f,
        rule: 1,
        why: `addresses ${table} by surrogate id; that id is reassigned by every catalog refresh`,
        stmt,
      });
    }
    if (assertRequired && !insideAssertingBlock(m.index)) {
      violations.push({
        file: f,
        rule: 2,
        why: `not inside a block that raises on ROW_COUNT = 0; a no-op would report success`,
        stmt,
      });
    }
  }
}

if (violations.length) {
  console.error(
    `\n${violations.length} violation(s) across ${files.length} migration(s).\n`
  );
  let last = "";
  for (const v of violations) {
    if (v.file !== last) { console.error(`  ${v.file}`); last = v.file; }
    console.error(`    RULE ${v.rule}: ${v.why}`);
    console.error(`      ${v.stmt}…`);
  }
  console.error(
    `\nRule 1: address rows by natural key — for msrp_catalog that is\n` +
    `        (year, make, model, trim), which is also its UNIQUE constraint.\n` +
    `Rule 2: wrap the statement so a zero match raises:\n` +
    `        do $$ declare n int; begin\n` +
    `          <statement>;\n` +
    `          get diagnostics n = row_count;\n` +
    `          if n = 0 then raise exception '…matched no rows'; end if;\n` +
    `        end $$;\n`
  );
  process.exit(1);
}

console.log(
  `OK — ${checked} UPDATE/DELETE statement(s) against refresh-owned tables across ` +
  `${files.length} migration(s): none addressed by surrogate id, and every one written ` +
  `on or after ${ASSERT_REQUIRED_FROM} raises when it matches nothing.`
);
