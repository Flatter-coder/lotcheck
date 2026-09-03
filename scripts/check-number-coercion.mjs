#!/usr/bin/env node
// A MISSING NUMBER IS NOT ZERO -- enforced at build time.
//
// `Number(null)` is 0. So is `Number("")` and `Number([])`. For a field where 0
// is a legal reading -- an odometer, an interest rate, a review count -- that
// makes "we read zero" and "we read nothing" the same value, and every guard
// written downstream is correct and unreachable.
//
// Ten defects in this repo have had exactly this cause (2026-08-11 to 09-03),
// each looking like a different bug at the surface: a used car called NEW and
// handed a present-tense MSRP claim; a 0-20,000 km "similar mileage" window
// around a car that might have 150,000; "this page's calculator opens at 0%"
// over a page showing no rate; "4.9* / 0" reviews; "Odometer 0 km -- consistent
// with a new vehicle" printed on a real customer report (LC-FE77-C58) for a
// page that published no odometer; and a share link that encoded that same
// fabricated 0 into every forwarded copy.
//
// Two expression shapes let a null through, and this gate refuses both:
//
//   Number.isFinite(Number(x.odometerKm))   // isFinite(0) is true
//   Number(x.odometerKm) >= 0               // 0 >= 0 is true
//
// Both are fine once the absence is checked FIRST -- `x.odometerKm != null &&
// ...` -- or once the read goes through readNum() / readNumOrValue() /
// odometerReading() from _shared/read-num.js, which keep the absence.
//
// The field list is deliberately short: only names where 0 is a real,
// publishable reading. `Number(rows.length)` or `Number(pageLength)` can never
// be zero-and-meaningful in the same breath, so plain Number() stays fine.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ZERO_MEANS_SOMETHING = [
  "odometerKm", "odometer", "mileage", "mileageFromOdometer",
  "apr", "interestRate",
  "reviewCount", "rating",
];
const ROOTS = ["supabase/functions", "src", "api"];
const EXTS = [".ts", ".js", ".jsx", ".mjs"];
const SKIP_FILES = new Set(["read-num.js", "check-number-coercion.mjs"]);

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === "node_modules" || e === ".git" || e === "dist") continue;
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (EXTS.some((x) => e.endsWith(x)) && !SKIP_FILES.has(e)) out.push(p);
  }
  return out;
}

const FIELDS = ZERO_MEANS_SOMETHING.join("|");
const SHAPES = [
  // Number.isFinite(Number(<expr>.<field>))
  new RegExp("Number[.]isFinite[(]\\s*Number[(]([^()]*[.](?:" + FIELDS + "))\\s*[)]\\s*[)]", "g"),
  // Number(<expr>.<field>) >= 0   /   <= 0   /   < 0
  new RegExp("Number[(]([^()]*[.](?:" + FIELDS + "))\\s*[)]\\s*(?:>=|<=|<)\\s*[-0]", "g"),
];

const violations = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const src = readFileSync(file, "utf8");
    const lines = src.split("\n");
    for (const shape of SHAPES) {
      shape.lastIndex = 0;
      let m;
      while ((m = shape.exec(src)) !== null) {
        const lineNo = src.slice(0, m.index).split("\n").length;
        const field = m[1].trim().split(".").pop();
        // A comment QUOTING the bad shape -- the note above the
        // reference-financing fix, or this file's own header -- is not the bad
        // shape. Only real code counts.
        const self = (lines[lineNo - 1] || "").trim();
        if (self.startsWith("//") || self.startsWith("*")) continue;
        // The absence may already be checked -- on this line or the two above
        // it, naming the SAME field. `x.apr != null && Number.isFinite(...)` is
        // the correct shape and has to stay legal.
        const ctx = lines.slice(Math.max(0, lineNo - 3), lineNo).join("\n");
        const guard = new RegExp(
          "[.]" + field + "\\s*(?:!==?|===?)\\s*(?:null|undefined)" +
          "|[.]" + field + "\\s*[?][?]" +
          "|readNum|odometerReading",
        );
        if (guard.test(ctx)) continue;
        violations.push({ file, lineNo, line: (lines[lineNo - 1] || "").trim().slice(0, 150) });
      }
    }
  }
}

if (violations.length) {
  console.error("❌ number-coercion: " + violations.length + " place(s) read a missing number as 0:\n");
  for (const v of violations) {
    console.error("  " + v.file + ":" + v.lineNo);
    console.error("       " + v.line);
  }
  console.error(`
Number(null) is 0, and 0 is a legal reading for these fields, so nothing
downstream can tell "we read zero" from "we read nothing". Either check the
absence first (x.field != null && ...) or read it through readNum() /
readNumOrValue() / odometerReading() from
supabase/functions/_shared/read-num.js, which keep the absence.`);
  process.exit(1);
}
console.log("✅ number-coercion: no missing number is read as 0 (" + ZERO_MEANS_SOMETHING.length + " field names, " + ROOTS.length + " trees).");
