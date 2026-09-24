// The definition of a function that a fresh apply leaves in place is the one
// in the LAST migration (filename order, the order apply-migrations.mjs runs
// them) that creates it -- not the file named after it. A gate that reads the
// file named after a function keeps passing on a body a later migration has
// already replaced.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "supabase/migrations";

// { file, sql } or null. sql runs from `create or replace function
// public.<name>(` to the next `create or replace function`, so it carries the
// function's own revoke/grant lines and nothing of its neighbours'.
export function latestDefinition(name) {
  const head = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`, "i");
  const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort().reverse();
  for (const file of files) {
    const text = readFileSync(join(DIR, file), "utf8");
    const m = head.exec(text);
    if (!m) continue;
    const rest = text.slice(m.index);
    const next = rest.slice(1).search(/create\s+or\s+replace\s+function/i);
    return { file, sql: next === -1 ? rest : rest.slice(0, next + 1) };
  }
  return null;
}

// Executable SQL only: a commented-out line must read as removed.
export const codeOnly = (sql) => sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
