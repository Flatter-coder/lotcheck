// IMPORT RESOLUTION GATE — a named import that does not exist is a file that
// cannot load, and nothing else here catches it.
//
// WHY THIS EXISTS. On 2026-09-15 night-watch.mjs landed on main importing
// `pageDeclaresItself` and `isInventoryIndex` from scripts/lib/golden.mjs --
// functions that lived only on the branch it came from. The script died on its
// first line:
//
//   SyntaxError: The requested module './lib/golden.mjs' does not provide an
//   export named 'isInventoryIndex'
//
// Every gate was green. check:syntax parses each file ALONE, so a file whose
// own syntax is perfect passes even when the module it imports has nothing by
// that name. check:undef does scope analysis inside a file, not across them.
// And the scripts this breaks -- night-watch, golden:snapshot,
// build-golden-set --from-snapshot -- are not run in CI at all, because they
// need a page corpus or a network. So the only thing standing between a
// broken import and a green build was somebody running the script by hand.
//
// That is the same shape as every entry in FIXING-HISTORY under "green signal,
// no check": the pipeline reported success over a file that could not execute.
//
// WHAT IT DOES. For every local `import { a, b } from "./x.js"`, read the
// target and confirm it exports each name. Deliberately simple and static: no
// execution, no network, milliseconds, and it cannot be fooled by a file that
// happens not to be run today.
//
// Run: npm run check:imports
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";

const ROOTS = ["scripts", "supabase/functions"];
const SKIP = /node_modules|fixtures|\/out\/|\.test\./;

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (SKIP.test(p)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (/\.(mjs|js|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

// Comments are prose, not code. This file's own header shows an example import
// in a sentence, and on its first run the gate reported itself — a scanner that
// reads documentation as code is a scanner nobody will trust.
// TRAILING comments count too, and missing them cost four more false positives:
//
//   export const FEES_ONLY_CEILING = 1500;     // freight is in, fees are not
//
// The statement scanner below looks for a declaration ending in `;`, and with
// the comment still attached the line ends in prose instead. Those four reads
// were real, working imports reported as broken. Quote-aware, so a `//` inside
// a string or a URL is left alone.
function stripComments(src) {
  const out = [];
  for (let line of src.replace(/\/\*[\s\S]*?\*\//g, "").split(/\r?\n/)) {
    if (/^\s*\/\//.test(line)) { out.push(""); continue; }
    let q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === "`") { q = c; continue; }
      if (c === "/" && line[i + 1] === "/") { line = line.slice(0, i); break; }
    }
    out.push(line);
  }
  return out.join("\n");
}

// What a module exports, by name. Static scan — the same shapes this repo uses.
function exportsOf(file) {
  const src = stripComments(readFileSync(file, "utf8"));
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+class\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  // ONE STATEMENT CAN EXPORT SEVERAL NAMES:
  //   export const RAISE = "raise", CLEAR = "clear", NOTED = "noted";
  // Capturing only the first declarator made this gate report three real,
  // working imports in test-report-bands.mjs as broken on its very first run.
  // A gate whose false positives look exactly like its true ones is a gate that
  // gets switched off, so every declarator is read.
  for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+([\s\S]*?);\s*$/gm)) {
    let depth = 0, token = "";
    for (const ch of m[1]) {
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth--;
      if (depth === 0 && (ch === "," || ch === "=")) {
        const n = token.trim().match(/^([A-Za-z_$][\w$]*)/);
        if (n) names.add(n[1]);
        if (ch === "=") { // skip this initialiser up to the next top-level comma
          token = ""; continue;
        }
        token = ""; continue;
      }
      if (depth === 0 && ch !== "=") token += ch;
    }
    const last = token.trim().match(/^([A-Za-z_$][\w$]*)/);
    if (last) names.add(last[1]);
  }
  for (const m of src.matchAll(/^export\s+(?:type|interface)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  // `export { a, b as c }`
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const bits = part.trim().split(/\s+as\s+/);
      const name = (bits[1] || bits[0] || "").trim();
      if (name) names.add(name);
    }
  }
  if (/^export\s+\*/m.test(src)) names.add("*"); // re-export: cannot resolve statically
  return names;
}

const failures = [];
const cache = new Map();

for (const root of ROOTS) {
  if (!existsSync(root)) continue;
  for (const file of walk(root)) {
    // Strip comments first. This file's own header shows an example import in
    // prose, and on the first run the gate reported itself -- a scanner that
    // reads documentation as code is a scanner nobody will trust.
    const src = stripComments(readFileSync(file, "utf8"));
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](\.[^"']+)["']/g)) {
      const spec = m[2];
      let target = resolve(dirname(file), spec);
      if (!existsSync(target)) {
        // A .ts import may resolve to the file as written; try the literal path.
        const alt = [target, `${target}.ts`, `${target}.js`].find((p) => existsSync(p) && statSync(p).isFile());
        if (!alt) { failures.push(`${file}: imports from "${spec}", which does not exist`); continue; }
        target = alt;
      }
      if (!cache.has(target)) cache.set(target, exportsOf(target));
      const has = cache.get(target);
      if (has.has("*")) continue; // star re-export: not statically knowable
      for (const raw of m[1].split(",")) {
        const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
        if (!name) continue;
        if (!has.has(name)) {
          failures.push(`${file}: imports { ${name} } from "${spec}" — that module exports no such name`);
        }
      }
    }
  }
}

if (failures.length) {
  console.error(`check-imports: ${failures.length} import(s) that cannot resolve.\n`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(`\nA file with a bad named import throws on its FIRST LINE. check:syntax parses`);
  console.error(`each file alone and cannot see this; scripts that CI never runs can carry one`);
  console.error(`for as long as nobody runs them by hand.`);
  process.exit(1);
}
console.log(`check-imports: every local named import resolves (${cache.size} modules read).`);
process.exit(0);
