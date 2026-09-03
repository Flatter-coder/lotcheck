// Every regulator citation a report line prints must be backed by a DATED
// CAPTURE in docs/, not by our memory of the source.
//
// WHY: the "Insurance before you sign" line names an Alberta statute section, a
// regulation, a bulletin and two page numbers, inside a signed report a buyer
// may hand to a dealer. The first version of its test asserted the citation
// string against itself -- a tautology that would have shipped a wrong section
// number green. Everything else sourced in this product is held to "known
// basis + pinned source + dated capture, or don't publish" (msrp-authority,
// fee-schedule, the Build & Price PDFs). This holds the citations to it too.
//
// Run: node scripts/check-source-citations.mjs
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `\n       ${detail}`}`);
  if (!ok) fail++;
};

const SOURCES = [
  {
    label: "AIRB 2026 Annual Market and Trends Report",
    capture: "docs/airb-2026-capture.md",
    surface: "supabase/functions/_shared/report-lines.js",
    // The block of the surface that carries the citations.
    from: "const AIRB_CITE",
    to: "export function olderYearsLine",
    // Every distinctive claim the line prints. Each must appear VERBATIM in the
    // capture, so changing the card forces re-reading the source.
    claims: [
      "section 555",
      "Take All Comers",
      "AR 227/2025",
      "Bulletin 08-2025",
      "at-fault claim in the past six years",
      "serious traffic conviction within the past four years",
      "deductible such as $2,000 or more",
      "may be required for a leased or financed vehicle",
      "only applies to mandatory coverages",
      "removing these restrictions",
      // "Your premium after this purchase" (printed pages 5 and 16)
      "Good Driver Rate Cap",
      "greater than 3.7% in 2024 and 7.5% in 2025",
      "changed vehicles, or changed their home address",
      "did not mean Alberta drivers did not see increases",
      "typically increases third-party liability premiums by approximately 9.0%",
      "45.6% in the second half of 2024",
    ],
  },
  {
    // The second AIRB card gets its OWN window. It previously fell inside the
    // first entry's slice only because that slice overran to end-of-file, which
    // would have stopped silently the moment the file was reordered.
    label: "AIRB 2026 report — your premium after this purchase",
    capture: "docs/airb-2026-capture.md",
    surface: "supabase/functions/_shared/report-lines.js",
    from: "const AIRB_PREMIUM_CITE",
    to: null,
    claims: [
      "PPV rating program",
      "greater than 3.7% in 2024 and 7.5% in 2025",
      "no longer protected by the 7.5% cap",
      "an increase greater than 0.0% for any individual policyholder",
      "did not mean Alberta drivers did not see increases in their auto insurance premiums in 2023",
      "changed vehicles, or changed their home address",
      "typically increases third-party liability premiums by approximately 9.0%",
      "45.6% in the second half of 2024",
      "to 47.1%",
    ],
  },
];

console.log("source citations");
for (const s of SOURCES) {
  // The capture is a markdown document: quotes carry "> " prefixes and wrap at
  // the margin, so a sentence match must run over the normalised text, not the
  // raw file. Page headings are matched against the raw text separately.
  const capRaw = read(s.capture);
  const cap = capRaw.replace(/^\s*>\s?/gm, " ").replace(/\s+/g, " ");
  const surf = read(s.surface);
  const i = surf.indexOf(s.from);
  const j = s.to ? surf.indexOf(s.to) : -1;
  const block = i >= 0 ? surf.slice(i, j > i ? j : undefined) : "";
  check(i >= 0, `${s.surface} carries ${s.from}`);
  check(/https?:\/\/\S+/.test(cap), `${s.capture} names where the source was read`);
  check(/Read on:\**\s*\d{4}-\d{2}-\d{2}/.test(cap), `${s.capture} carries the date it was read`);
  for (const c of s.claims) {
    check(cap.includes(c), `capture backs "${c}"`, `add the quoted sentence to ${s.capture}`);
  }
  // The reverse direction: any instrument number the SURFACE prints must be in
  // the capture. Catches a citation added to the card and never re-sourced.
  for (const m of block.matchAll(/\b(?:section \d{1,4}|AR \d{1,4}\/\d{4}|Bulletin \d{2}-\d{4})\b/g)) {
    check(cap.includes(m[0]), `card cites "${m[0]}" and the capture backs it`,
      `${m[0]} is printed to buyers but is not in ${s.capture}`);
  }
  // Page numbers the card cites must be pages the capture actually quotes.
  for (const m of block.matchAll(/pages? (\d+)(?: and (\d+))?/g)) {
    for (const pg of [m[1], m[2]].filter(Boolean)) {
      check(new RegExp(`Printed page ${pg}\\b`).test(cap), `capture quotes printed page ${pg}`);
    }
  }
}

console.log(fail === 0 ? "\n\u2705 source citations: every claim is backed by a dated capture"
  : `\n\u274c source citations: ${fail} unbacked`);
process.exit(fail ? 1 : 0);
