// GATE: a migration can state its own post-condition, and a failing one must
// fail the run.
//
// WHY THIS EXISTS. "2/2 applied" means the statements parsed. It does not mean
// they did anything. Every migration in this repo is idempotent — that is what
// makes re-running safe, and also what makes a no-op invisible:
//
//   * `insert ... on conflict do nothing` against an existing row
//   * an `update` whose `where` matches nothing
//   * `insert ... select` whose source query returns no rows
//
// all three print the same green tick as real work. 20260916a reported success
// while three of its seven statements matched zero rows; it took a live report
// being wrong to notice. The same shape nearly hid again on 2026-09-22, when
// 20260922f wrote the crawl clearance into a legal_source that did not exist —
// that one only surfaced because a missing TABLE errors, while a missing ROW
// does not.
//
// So: `-- @assert: <sql>` after the statements, evaluated by the database,
// against the state the migration claims to have produced.
//
// Run: node scripts/test-migration-assert.mjs
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

// ---- wired in, not merely present ---------------------------------------
check("the runner defines the parser", /function assertionsIn/.test(src));
check("the runner defines the evaluator", /async function runAssertion/.test(src));
check("the apply loop collects assertions", /const asserts = assertionsIn\(sql\)/.test(src));
check("the apply loop evaluates them", /await runAssertion\(/.test(src));
check("a failed post-condition increments the failure count",
  /if \(bad\) \{[\s\S]{0,80}failed\+\+/.test(src),
  "a post-condition that fails but does not fail the run is decoration");
check("post-conditions run AFTER the migration, not before",
  src.indexOf("await runSql(sql)") < src.indexOf("await runAssertion("));
check("a dry run does not claim post-conditions were checked",
  /not executed`\s*\+\s*\(asserts\.length \? `, \$\{asserts\.length\} post-condition\(s\) not checked/.test(src),
  "dry run must say they were NOT checked");

// ---- the parser ----------------------------------------------------------
const assertionsIn = new Function(
  src.slice(src.indexOf("function assertionsIn"), src.indexOf("async function runAssertion"))
  + "; return assertionsIn;")();

check("finds a plain assertion",
  assertionsIn("-- @assert: select true").length === 1);
check("finds several",
  assertionsIn("-- @assert: a\nselect 1;\n-- @assert: b\n").length === 2);
check("tolerates spacing and case",
  assertionsIn("--@assert:x\n--   @ASSERT:   y  \n").length === 2);
check("ignores an ordinary comment",
  assertionsIn("-- this asserts nothing\n-- assert: not a directive\n").length === 0);
check("a migration with none parses to none",
  assertionsIn("create table if not exists t(id int);").length === 0,
  "migrations predating this must behave exactly as before");
check("captures the expression, not the marker",
  assertionsIn("-- @assert: (select count(*) from t) = 3")[0] === "(select count(*) from t) = 3");

// ---- the evaluator: it must REFUSE anything that is not a true ----------
// An assertion that passes on null, on no rows, or on a non-boolean is an
// assertion that cannot fail — the exact thing this gate exists to prevent.
/** Lift one function out of the source by matching its braces. */
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

const RUN_ASSERTION = lift(src, "async function runAssertion");
// runSql is injected, so nothing here touches the network.
const evalWith = (rows) =>
  new Function("runSql", `${RUN_ASSERTION}\n; return runAssertion;`)(async () => rows);

const cases = [
  ["true passes", [{ ok: true }], true],
  ["false fails", [{ ok: false }], false],
  ["NULL fails", [{ ok: null }], false],
  ["no rows fails", [], false],
  ["null result fails", null, false],
  ["a non-boolean fails", [{ ok: 3 }], false],
  ["a string 'true' fails", [{ ok: "true" }], false],
  ["a row without an ok column fails", [{ count: 1 }], false],
];
for (const [label, rows, want] of cases) {
  const r = await evalWith(rows)("whatever");
  check(`evaluator: ${label}`, r.ok === want, `got ok=${r.ok} (${r.why || ""})`);
}

// ---- the real migration carries real post-conditions ---------------------
// 20260922f is the one that exposed the problem. It must not lose them.
const f = readFileSync(join(DIR, "20260922f_standing_crawl_clearance.sql"), "utf8");
const real = assertionsIn(f);
check("the crawl-clearance migration states post-conditions", real.length >= 6, String(real.length));
check("they assert the rule row exists",
  real.some((a) => /legal_rule/.test(a) && /crawl_scope_dealer_sites_only/.test(a)));
check("they assert all six controls landed",
  real.some((a) => /legal_control/.test(a) && /= 6/.test(a)),
  "six controls are claimed in the file; the database must hold six");
check("they assert the clearance is still recorded as VERBAL",
  real.some((a) => /unverified/.test(a)) && real.some((a) => /draft/.test(a)),
  "if a later edit quietly promoted it to verified, that must fail loudly");
check("they assert the excerpt still quotes Vic, not counsel",
  real.some((a) => /Vic Todorovic/.test(a)),
  "the register requires a verbatim excerpt; this one is Vic's words and is labelled so");
check("every assertion is a single expression, not a statement",
  real.every((a) => !/;\s*$/.test(a) && !/^\s*(insert|update|delete|drop|create|truncate)\b/i.test(a)),
  "a post-condition must not be able to MUTATE anything");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
