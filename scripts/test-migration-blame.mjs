// GATE: when a migration fails on a missing relation, the run must name the
// migration that creates it.
//
// WHY THIS EXISTS. Turning the standing crawl on, 20260922f wrote the clearance
// into legal_source — and legal_source had sat unapplied since 20260810. The
// Management API said, accurately, that the relation did not exist, and that
// was the whole message. Working out which of ~90 migration files creates it,
// and that re-running it is safe, was a manual round-trip.
//
// WHY IT IS A GATE AND NOT A ONE-OFF TEST. The first version of the helper did
// not fire on the real error at all. It expected `relation "public.x"`, but the
// Management API body arrives UNPARSED, so what actually lands is
// `relation \"public.x\"`. The pattern matched the message a person would type
// into a test and never the message the API sends — a guard that cannot fail,
// which reads as "no problem found" forever.
//
// So the load-bearing assertion here is the VERBATIM body, escapes and all.
// Do not "tidy" it into a neater string; the escapes are the test.
//
// Run: node scripts/test-migration-blame.mjs
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

// ---- it must be wired in, not merely present -----------------------------
// A blame helper nobody calls is the same defect wearing a different hat.
check("apply-migrations defines the helper", /function blameMissingRelation/.test(src));
check("the failure path calls it", /blameMissingRelation\(e\.message\)/.test(src));
check("the call sits in the catch that prints the failure",
  src.indexOf("blameMissingRelation(e.message)") > src.indexOf("} catch (e) {"),
  "it must run where a migration actually fails");

// ---- load the helper without executing the script's main() ----------------
const body = src.slice(src.indexOf("function blameMissingRelation"), src.indexOf("async function main"));
const allMigrations = () => readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const blame = new Function("readFileSync", "join", "DIR", "allMigrations",
  `${body}; return blameMissingRelation;`)(readFileSync, join, DIR, allMigrations);

// ---- THE VERBATIM BODY. The escapes are the point. -----------------------
const REAL = 'Management API 400: {"message":"Failed to run sql query: ERROR:  42P01: '
  + 'relation \\"public.legal_source\\" does not exist\\nLINE 26: insert into public.legal_source\\n'
  + '                     ^\\n"}';
const onReal = blame(REAL);
check("the verbatim Management API body is recognised", onReal !== null,
  "the helper did not fire on the error it exists for");
check("and it names the migration that creates the relation",
  onReal != null && onReal.includes("20260810_legal_register.sql"), String(onReal));
check("and it says re-running is safe",
  onReal != null && /idempotent/i.test(onReal), String(onReal));

// ---- the shapes either side of it ----------------------------------------
check("a bare-quoted message still works",
  (blame('relation "public.legal_source" does not exist') || "").includes("20260810_legal_register.sql"));
check("a relation no migration creates is reported as such",
  /not created by any migration/.test(blame('relation \\"public.nonesuch_xyz\\" does not exist') || ""));
check("a relation created under a different verb is still found",
  (blame('relation "v_lot_leverage" does not exist') || "").includes(".sql"),
  "views count — 'create or replace view' must be matched too");

// ---- it must stay silent on everything else ------------------------------
// Blaming an unrelated failure on a missing migration sends the next person to
// the wrong file, which is worse than saying nothing.
for (const other of [
  'syntax error at or near "trim"',
  "permission denied for table vehicle_listing",
  "duplicate key value violates unique constraint",
  "Management API 500: upstream timeout",
  "", null, undefined,
]) check(`stays silent on: ${JSON.stringify(other)}`, blame(other) === null, String(blame(other)));

// ---- the claim it makes must be true -------------------------------------
// It tells you to apply the named migration. If that file were not idempotent,
// the advice would be actively dangerous.
const named = readFileSync(join(DIR, "20260810_legal_register.sql"), "utf8");
check("the migration it points at is genuinely re-runnable",
  !/\bdrop\s+table\b/i.test(named) && !/\btruncate\b/i.test(named)
  && /create table if not exists/i.test(named) && /on conflict/i.test(named),
  "it must not contain drop table / truncate, and must guard its inserts");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
