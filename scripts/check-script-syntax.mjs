// Every script must at least PARSE.
//
// On 2026-08-17 a patch to fca-stack.mjs wrote a literal newline inside a
// template literal, so the file could not be parsed at all. Nothing caught it:
// `npm run build` only compiles src/, and the gate suite RUNS a dozen scripts
// but not this one. It shipped, and the daily catalog refresh discovered it the
// next morning by taking down Jeep, Ram, Dodge and Chrysler with
// "SyntaxError: Invalid or unexpected token".
//
// A syntax error is the cheapest possible thing to detect and one of the most
// expensive to discover in production, so every .mjs under scripts/ is parsed
// here. This does not execute anything -- no network, no writes, no secrets.
//
// Run: node scripts/check-script-syntax.mjs
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const roots = ["scripts", "scripts/lib"];
const files = [];
for (const dir of roots) {
  let entries;
  try { entries = readdirSync(dir); } catch { continue; }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isFile() && (name.endsWith(".mjs") || name.endsWith(".js"))) files.push(p);
  }
}

const broken = [];
for (const f of files) {
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    broken.push({ file: f, err: String(e.stderr || e.message).split("\n").slice(0, 4).join("\n       ") });
  }
}

if (!broken.length) {
  console.log(`✅ script-syntax: all ${files.length} script(s) parse.`);
  process.exit(0);
}
console.error(`❌ script-syntax: ${broken.length} of ${files.length} script(s) do not parse.\n`);
for (const b of broken) console.error(`  ${b.file}\n       ${b.err}\n`);
console.error(`A script that cannot be parsed fails at RUN time, in a scheduled job,`);
console.error(`hours after it merged — the build does not cover scripts/ and the gate`);
console.error(`suite only runs some of them.`);
process.exit(1);
