// EDGE FUNCTION SYNTAX + SCOPE GATE — the gate that would have caught the
// 2026-08-19 recall-consolidation corruption (fixed cc31680/e91e5e8) before
// it ever merged.
//
// WHY THIS EXISTS. Nothing in this repo's 47 CI gates parses
// supabase/functions/**/*.ts at all -- check:syntax covers scripts/*.mjs,
// check:undef covers a fixed list of src/ files, and the build only compiles
// src/. A recall-lookup consolidation truncated several deleted lines down
// to their bare first character ("c", "f", "a> {") instead of removing them.
// It shipped through every gate.
//
// NODE'S OWN `node --check` MISSED THIS LIVE. `a> {` parses under V8 as a
// comparison expression `a > {}` followed by ordinary statements -- accepted
// with no complaint, confirmed against the real corrupted file during the
// incident. Babel's parser is stricter: the same construct is a genuine
// syntax error under Babel (the `const` immediately following `a > {}` has
// no valid continuation), which is why this gate's PARSE half alone catches
// that shape. A milder real variant -- a stray letter glued onto the FRONT
// of the next comment line ("c// Two-word makes...", found in
// search-recalls/index.ts) -- parses cleanly under EITHER parser, since `c`
// is a syntactically ordinary expression statement. That shape is caught
// only by scope resolution: `c` is referenced with no binding anywhere,
// exactly the class check:undef already catches for src/App.jsx (the
// 2026-08-12 msrpExactScroll crash) -- so this gate adds that same
// technique, real Babel scope resolution via @babel/traverse, pointed at
// supabase/functions/**/*.ts. Between the two checks, both real corrupted
// shapes are caught; see scripts/test-edge-function-syntax.mjs for the
// reconstructed proof of each.
//
// Two independent checks, either one failing is a red gate:
//   1. PARSE   -- the file must parse as valid TypeScript at all (the fca-
//                 stack.mjs class: a genuinely malformed file, e.g. a stray
//                 unclosed brace or a literal newline inside a template
//                 literal -- and, per above, the "a> {" corruption shape).
//   2. SCOPE   -- every referenced identifier must resolve to a real
//                 binding: a local declaration, an import, or a recognised
//                 Deno/web-standard/Node global. An identifier with none of
//                 those is either a typo or -- as happened for real --
//                 orphaned corruption from a botched edit that still parses.
//
// The actual check logic lives in scripts/lib/edge-syntax-check.mjs so
// scripts/test-edge-function-syntax.mjs can exercise the exact code that
// ships against synthetic cases, including the real corruption pattern.
//
// Run (from repo root):  npm run check:edge-syntax
// Exit 0 = clean; 1 = at least one file fails to parse or contains an
// identifier that will throw ReferenceError at Deno load time.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkSource } from "./lib/edge-syntax-check.mjs";

const ROOT = "supabase/functions";

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
const parseFailures = [];
const scopeFailures = [];

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const { parseError, scopeErrors } = checkSource(src);
  if (parseError) { parseFailures.push({ file, err: parseError }); continue; }
  for (const s of scopeErrors) scopeFailures.push({ file, ...s });
}

if (!parseFailures.length && !scopeFailures.length) {
  console.log(`✅ edge-function-syntax: all ${files.length} file(s) under ${ROOT} parse, every identifier resolves.`);
  process.exit(0);
}

if (parseFailures.length) {
  console.error(`❌ ${parseFailures.length} file(s) do not parse as valid TypeScript:\n`);
  for (const f of parseFailures) console.error(`  ${f.file}\n       ${f.err}\n`);
}
if (scopeFailures.length) {
  console.error(`❌ ${scopeFailures.length} identifier(s) reference no binding -- ReferenceError at Deno load time:\n`);
  for (const f of scopeFailures) console.error(`  ${f.file}:${f.line}  "${f.name}"\n       ${f.snippet}\n`);
}
console.error(`A file that cannot parse, or an identifier with no binding, throws the`);
console.error(`moment Deno loads the module -- this is what shipped undetected as the`);
console.error(`2026-08-19 recall-consolidation corruption (cc31680). Neither failure`);
console.error(`mode was visible to any other gate in this repo.`);
process.exit(1);
