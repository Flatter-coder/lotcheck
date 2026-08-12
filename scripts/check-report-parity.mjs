// REPORT PARITY GATE — a deterministic check that a report card can't render
// from a field nothing populates.
//
// WHY THIS EXISTS. On 2026-08-11 a 10-URL accuracy run found the "EV / PHEV
// rebate" card rendering a dead "—" on all three BEV listings in the sample.
// The cause was not a bad rebate calculation: the rebate is derived on the
// CLIENT (from the EVAP list plus the analysis), and two surfaces derived it
// inline while two others read `analysis.evapRebate` — a field the server has
// never sent. The scroll view and the emailed report showed the real number;
// the deck/heatmap/sidebar panel and its plain-language explainer showed
// nothing. One of the listings was openly advertising a $4,762 federal rebate
// at the time.
//
// That is a CLASS of bug, not one card: any client-derived report feature can
// drift between the surfaces that render it. The fix was one shared resolver
// (`resolveEvap` in src/App.jsx); this gate is what stops the inline
// re-derivation from growing back. Same move as scripts/check-copy-compliance.mjs
// and _shared/invariants.ts — fix the class, then lock it.
//
// Serves the standing rule: every report feature ships to ALL views in the same
// change (scroll + deck/scorecard/HUD/heatmap/sidebar + PDF + email HTML).
//
// Run (from repo root):  npm run check:parity
// Exit 0 = clean; 1 = a violation.
import { readFileSync } from "node:fs";

const FILE = "src/App.jsx";
const src = readFileSync(FILE, "utf8");
const failures = [];

// Comment-masked copy for the pattern scans: a doc comment that *describes* the
// bug (like the one above resolveEvap) must not read as the bug itself. Only
// whole-line comments are masked, and each is replaced by spaces of the same
// length so every match index still maps to the real line number.
const code = src
  .split("\n")
  .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? " ".repeat(line.length) : line))
  .join("\n");

// Line number for a match index, so a failure points at the code not a regex.
function lineOf(index) {
  return code.slice(0, index).split("\n").length;
}

// ── Rule 1 (required): the shared resolver must exist ────────────────────────
// Without it there is no single source of truth to funnel the surfaces through.
if (!/function\s+resolveEvap\s*\(/.test(code)) {
  failures.push(
    `${FILE}: resolveEvap() is missing. The EVAP rebate is derived client-side; ` +
    `every surface must read it from one resolver or the views silently diverge.`,
  );
}

// ── Rule 2 (forbidden): no surface may READ analysis.evapRebate ──────────────
// The server never sets this field. Writing it is allowed in exactly one place
// (the emailed-report payload, which hands the computed rebate to the email
// function); reading it back in a render path is always the bug we shipped.
// A read looks like `.evapRebate?` / `.evapRebate.` / `.evapRebate)` — a write
// looks like `evapRebate:`.
const reads = [...code.matchAll(/\.evapRebate\s*(?![:\s]*[:=])/g)];
for (const m of reads) {
  failures.push(
    `${FILE}:${lineOf(m.index)}: reads .evapRebate — the server never sets it, so this ` +
    `renders empty. Use resolveEvap(analysis) instead.`,
  );
}

// ── Rule 3 (guarded, count-pinned): every resolver call site is accounted for ─
// Pinned at 3: (1) ReportViews — the hoisted `evap`, feeding both the 10-point
// card and its "what this means" explainer; (2) the emailed-report payload;
// (3) the scroll view. A new report surface that renders the rebate SHOULD add
// a fourth — this gate failing is the prompt to confirm you wired every view,
// then bump EXPECTED_CALL_SITES with the new surface named below.
const EXPECTED_CALL_SITES = 3;
const calls = [...code.matchAll(/(?<!function\s)\bresolveEvap\s*\(/g)];
if (calls.length !== EXPECTED_CALL_SITES) {
  failures.push(
    `${FILE}: found ${calls.length} resolveEvap() call sites, expected ${EXPECTED_CALL_SITES} ` +
    `(lines ${calls.map((m) => lineOf(m.index)).join(", ") || "none"}). ` +
    `If you added a report surface, confirm the rebate renders on EVERY view ` +
    `(scroll + deck/heatmap/sidebar + PDF + email), then update EXPECTED_CALL_SITES.`,
  );
}

if (failures.length) {
  console.error("REPORT PARITY GATE — FAILED\n");
  for (const f of failures) console.error("  ✗ " + f);
  console.error(`\n${failures.length} violation(s).`);
  process.exit(1);
}

console.log(`REPORT PARITY GATE — clean (${calls.length} resolveEvap call sites, 0 stale field reads).`);
