// MEASURE WHAT YOU DRAW -- a gate, not a habit.
//
// Every drawing helper in buildReportPdf() passes its string through pdfSafe(),
// which rewrites characters the embedded fonts cannot set. Some of those
// rewrites CHANGE WIDTH:
//
//     "…"  ->  "..."      one glyph becomes three  (WIDER when drawn)
//     "—"  ->  "-"        an em dash becomes a hyphen
//     "•"  ->  "-"
//     "✓"  ->  ""         a check mark disappears entirely
//     anything outside \x20-\x7E and \xA0-\xFF -> ""
//
// So measuring the RAW string and drawing the REWRITTEN one sizes a box for
// text that is not what lands in it. Found on review 2026-09-10: the "also
// checked" pills measured raw, so a value containing an ellipsis would have
// been drawn wider than its own rounded border, and a tone chip measured for an
// em dash drew a hyphen and sat slightly too wide. Neither is visible in a
// screenshot of the one report you happen to render -- it needs the one value
// that carries the character -- which is exactly why it is a gate.
//
// THE RULE. In the PDF generator, every `widthOfTextAtSize(` call must either
//   * go through the `wSafe(font, str, size)` helper, or
//   * pass `pdfSafe(...)` explicitly, or
//   * sit on (or directly under) a line carrying a `pdf-safe:` marker comment
//     that explains why the measured string is already sanitised.
//
// Run: node scripts/check-pdf-measure.mjs
import { readFileSync } from "node:fs";

const FILES = ["supabase/functions/email-quote-report/index.ts"];
const CALL = /widthOfTextAtSize\s*\(/;
const SAFE = /wSafe\s*\(|pdfSafe\s*\(/;
const MARKER = /pdf-safe:/;

let offenders = 0;
for (const file of FILES) {
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    console.error(`❌ pdf-measure: cannot read ${file}`);
    process.exit(1);
  }
  const lines = src.split(/\r?\n/);
  // The helper itself is the one place allowed to hold a bare call.
  const helperRe = /const\s+wSafe\s*=/;
  let sawHelper = false;
  lines.forEach((line, i) => {
    if (helperRe.test(line)) { sawHelper = true; return; }
    if (!CALL.test(line)) return;
    if (SAFE.test(line)) return;
    if (MARKER.test(line) || MARKER.test(lines[i - 1] || "")) return;
    offenders++;
    console.error(`❌ ${file}:${i + 1}  measures a string it does not sanitise`);
    console.error(`      ${line.trim().slice(0, 140)}`);
  });
  if (!sawHelper) {
    console.error(`❌ pdf-measure: ${file} no longer defines the wSafe() helper.`);
    console.error("      Width measurement must go through one sanitising helper, or this gate");
    console.error("      cannot tell a safe measurement from an unsafe one.");
    offenders++;
  }
}

if (offenders) {
  console.error("");
  console.error("Fix: measure through wSafe(font, str, size) so the measured string is the");
  console.error("drawn string. If the value is provably already sanitised, say so with a");
  console.error("`pdf-safe:` comment on or above the line, naming why.");
  process.exit(1);
}
console.log("✅ pdf-measure: every width measurement in the PDF generator is sanitised.");
