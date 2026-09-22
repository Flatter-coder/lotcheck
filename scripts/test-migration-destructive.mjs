// GATE: re-running a historical seed migration must be REFUSED, not applied.
//
// WHY THIS EXISTS. 22 migrations in this repo open by clearing the catalogue
// they are about to seed — `delete from msrp_catalog where make in (...)`, then
// a block of hand-typed INSERTs. Every one was correct on the day it ran.
// Re-running one today is not "idempotent": the scrapers have since replaced
// that make's rows with sourced, trim-pinned, basis-bearing data, and the DELETE
// throws all of it away and puts August's base models back — NULL trim, NULL
// price_basis, no source_url.
//
// Measured on 2026-09-22 against the live catalogue: those 22 files target
// 1,506 of the 1,512 live rows. `--all-since 20260808` would have done it in a
// single call, and naming one file by hand looks identical to the legitimate
// call that applied the legal register the same afternoon. The run would print
// a green tick, because the statements execute perfectly well.
//
// One is worse than destructive: 20260808_euro_british_msrp_catalog.sql
// reinstates the Jaguar and Land Rover rows that 20260912b_purge_unsourced_jlr
// deliberately removed for producing false accusations against dealers.
//
// THE GUARD IS KEYED ON LIVE DAMAGE, NOT ON FILENAME. It counts the rows the
// statement would actually remove from the database right now. So a purge that
// has already run matches nothing and passes, while a seed re-run refuses — and
// no list of "dangerous files" has to be maintained or can fall out of date.
//
// Run: node scripts/test-migration-destructive.mjs
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = "supabase/migrations";
const SRC = "scripts/apply-migrations.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`ok    ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "\n       " + detail : ""}`); }
};

const src = readFileSync(new URL(`../${SRC}`, import.meta.url), "utf8");

function lift(source, decl) {
  const start = source.indexOf(decl);
  if (start < 0) throw new Error(`cannot find ${decl}`);
  let i = source.indexOf("{", start), depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces after ${decl}`);
}

const PROTECTED = JSON.parse("[" + /const PROTECTED = \[([\s\S]*?)\];/.exec(src)[1]
  .replace(/\/\/.*$/gm, "").replace(/,\s*$/, "") + "]");
const { destructiveStatements, deleteBudget } = new Function("PROTECTED",
  `${lift(src, "function destructiveStatements")}\n${lift(src, "function deleteBudget")}\n`
  + "; return { destructiveStatements, deleteBudget };")(PROTECTED);

// ---- wired into the apply path, and BEFORE anything executes -------------
check("the runner defines the detector", /function destructiveStatements/.test(src));
check("the runner defines the budget reader", /function deleteBudget/.test(src));
check("the runner counts against the LIVE database", /async function liveDeleteCount/.test(src));
check("the apply loop runs the pre-flight", /const destructive = destructiveStatements\(sql\)/.test(src));
check("the pre-flight happens BEFORE the migration executes",
  src.indexOf("const destructive = destructiveStatements(sql)") < src.indexOf("await runSql(sql)"),
  "a count taken afterwards is an autopsy");
// The refusal must SKIP the migration, not merely print. A warning above a
// green tick is how the catalogue gets emptied by someone reading the last line.
const refusal = lift(src.slice(src.indexOf("if (total > budget)") - 3), "if (total > budget)");
check("exceeding the budget REFUSES rather than warns",
  /\bcontinue;/.test(refusal),
  "the refusal block must `continue` past the migration — it does not:\n" + refusal);
check("the refusal never reaches runSql",
  !/runSql/.test(refusal));
check("a refusal counts as a failure", /failed\+\+/.test(refusal));
check("the refusal tells the operator how to declare the intent",
  /@deletes-at-most/.test(refusal),
  "a refusal with no route forward gets worked around rather than understood");

// ---- the protected list covers what is actually earned -------------------
for (const t of ["msrp_catalog", "vehicle_listing", "listing_price_history"]) {
  check(`protects ${t}`, PROTECTED.includes(t));
}

// ---- detection: the real files ------------------------------------------
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const flagged = files.filter((f) => destructiveStatements(readFileSync(join(DIR, f), "utf8")).length);
check("the 22 known destructive migrations are all detected", flagged.length >= 22, `${flagged.length} flagged`);
for (const f of [
  "20260808_euro_british_msrp_catalog.sql",
  "20260808_toyota_full_msrp_catalog.sql",
  "20260808_gm_msrp_catalog.sql",
  "20260808_korean_msrp_catalog.sql",
  "20260912b_purge_unsourced_jlr.sql",
]) check(`detects ${f}`, flagged.includes(f));

check("clean migrations are NOT flagged",
  !flagged.includes("20260810_legal_register.sql")
  && !flagged.includes("20260922f_standing_crawl_clearance.sql"),
  "the two applied today must stay applicable");
check("the overwhelming majority of migrations are untouched",
  files.length - flagged.length > 100, `${files.length - flagged.length} clean of ${files.length}`);

// ---- the WHERE clause is kept, so the count can be scoped ---------------
const euro = destructiveStatements(readFileSync(join(DIR, "20260808_euro_british_msrp_catalog.sql"), "utf8"));
check("the predicate is captured, not discarded", euro[0] && /make/i.test(euro[0].where || ""), JSON.stringify(euro[0]));
check("an unscoped delete is reported with a null predicate, so it counts the whole table",
  destructiveStatements("delete from msrp_catalog;")[0].where === null);

// ---- it must not be fooled ----------------------------------------------
check("a COMMENTED-OUT delete is not a delete",
  destructiveStatements("-- delete from msrp_catalog where make = 'Toyota';\nselect 1;").length === 0,
  "a guard bound to spelling rather than substance");
check("a block-commented delete is not a delete",
  destructiveStatements("/* delete from msrp_catalog; */ select 1;").length === 0);
check("schema-qualified is caught",
  destructiveStatements("delete from public.msrp_catalog where id = 1;").length === 1);
check("odd whitespace and case are caught",
  destructiveStatements("DELETE\n  FROM   MSRP_CATALOG\n WHERE make='X';").length === 1);
check("truncate is caught",
  destructiveStatements("truncate table public.msrp_catalog;").length === 1);
check("truncate is reported as taking everything",
  destructiveStatements("truncate msrp_catalog;")[0].where === null);
check("a delete on an UNprotected table is ignored",
  destructiveStatements("delete from scratch_table where id = 1;").length === 0,
  "the guard must not become a blanket ban on DELETE");
check("several deletes in one file are all reported",
  destructiveStatements("delete from msrp_catalog where a;\ndelete from msrp_catalog where b;").length === 2);

// ---- the budget declaration ---------------------------------------------
check("no declaration means a budget of zero", deleteBudget("delete from msrp_catalog;") === 0);
check("a declaration is read", deleteBudget("-- @deletes-at-most: 8\ndelete from msrp_catalog;") === 8);
check("the declaration tolerates spacing", deleteBudget("--@deletes-at-most:12") === 12);
check("a budget cannot be negative or non-numeric",
  deleteBudget("-- @deletes-at-most: -5") === 0 && deleteBudget("-- @deletes-at-most: all") === 0,
  "an unparseable budget must fall back to refusing, never to allowing");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
