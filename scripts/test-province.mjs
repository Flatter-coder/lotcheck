// GATE: a scraper asks Alberta, or it says why it asks something else.
//
// WHY. LotCheck serves Alberta buyers and every maker's build-and-price answers
// PER PROVINCE. Mazda returns AMVIC 10 for Alberta and OMVIC 22 for Ontario.
// Hyundai returns ppsaFees 86 for Alberta and 104 for Ontario. Genesis returns
// a different fee table entirely. On 2026-09-22 SEVEN scrapers were asking
// Ontario — Hyundai, Genesis, Mazda, VW, Kia, and the shared stacks behind
// Stellantis (six brands), Honda, Acura, Toyota and Lexus. Eleven makes.
//
// It went unnoticed because it is invisible in the output: an Ontario MSRP and
// an Alberta MSRP are usually the same number, so nothing looked wrong until a
// client asked what a 2027 IONIQ 9 costs and the fee components were the wrong
// province's. A defect that produces a plausible number is the kind that lives
// for months.
//
// THE RULE. Any province constant in a scraper must be "AB". A scraper that
// genuinely needs another province says so on the same line with a comment
// containing "province-exempt:" and its reason — a deliberate act with a
// reviewable diff, not a default that drifts back.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIRS = ["scripts", "scripts/lib"];
// const PROV = "ON" / let province = 'BC' / const PROVINCE_CODE = "QC"
const DECL = /^\s*(?:const|let|var)\s+([A-Za-z_]*(?:PROV|PROVINCE)[A-Za-z_]*)\s*=\s*["']([A-Z]{2})["']/;

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`ok    ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
};

const files = [];
for (const d of DIRS) {
  for (const f of readdirSync(d)) {
    if (!f.endsWith(".mjs")) continue;
    if (f.startsWith("test-")) continue;          // fixtures name every province on purpose
    files.push(join(d, f));
  }
}
check("there are scraper files to inspect", files.length > 20, `found ${files.length}`);

let declarations = 0;
const offenders = [];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = line.match(DECL);
    if (!m) return;
    declarations++;
    const [, name, value] = m;
    if (value === "AB") return;
    // An explicit, reviewable exemption on the same line.
    if (/province-exempt:/i.test(line)) return;
    offenders.push(`${file}:${i + 1}  ${name} = "${value}"`);
  });
}

// THE GATE MUST BE ABLE TO FAIL. If the pattern ever stops matching — a rename,
// a refactor to an env var — this would report "no offenders" forever while
// every scraper asked Ontario. Finding nothing is only an answer if we know we
// were still looking.
check("the province pattern still matches real declarations", declarations >= 4, `matched ${declarations}`);

check("every scraper asks Alberta", offenders.length === 0, offenders.join(" | "));
if (offenders.length) {
  console.log("\n  Each of these asks a province LotCheck does not serve:");
  for (const o of offenders) console.log(`    ${o}`);
  console.log("\n  Set it to \"AB\", or add a same-line comment \"province-exempt: <reason>\".");
}

console.log(`\n${pass} passed, ${fail} failed  (${declarations} province declaration(s) across ${files.length} files)`);
if (fail) process.exit(1);
