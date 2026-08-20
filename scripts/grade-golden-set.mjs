// Golden-set grader — scores pipeline output for CORRECTNESS, not coverage.
//
// Matches each analysis in a benchmark results file (scripts/benchmark-reports.mjs
// output) to its answer key (scripts/build-golden-set.mjs output) by URL and
// grades every page-provable point: identity, condition, price, price-gating,
// VIN, odometer, dealer-stated MSRP. Grading semantics live in
// scripts/lib/golden.mjs — a point the key cannot prove is `not_gradable`,
// never a silent pass.
//
// Verdicts: PASS / FAIL (any wrong value) / FAIL_FALSE_ACCUSATION (the report
// accused the dealer of gating a price the page advertises — the class that
// gets a report discredited). Exit code 1 if any false accusation.
//
// Run: node scripts/grade-golden-set.mjs [resultsFile] [keysFile]
//   default results: scripts/tmp-benchmark-results.json
//   default keys:    scripts/fixtures/golden/answer-keys.json

import { readFileSync } from "node:fs";
import { gradeListing, summarize, normUrl } from "./lib/golden.mjs";

const resultsFile = process.argv[2] || "scripts/tmp-benchmark-results.json";
const keysFile = process.argv[3] || "scripts/fixtures/golden/answer-keys.json";

const strip = (s) => s.replace(/^﻿/, "");
const results = JSON.parse(strip(readFileSync(resultsFile, "utf8")));
const keys = JSON.parse(strip(readFileSync(keysFile, "utf8")));

// excluded = verification found the listing gone (sold/404); grading against
// a dead key would book drift as defects.
const byUrl = new Map(keys.listings.filter((k) => !k.excluded).map((k) => [normUrl(k.url), k]));
const rows = Array.isArray(results) ? results : results.results || [];

const grades = [];
let unmatched = 0;
for (const r of rows) {
  const a = r.a || r.analysis || r;
  const url = r.url || a?.url;
  const key = byUrl.get(normUrl(url || ""));
  if (!key) { unmatched++; continue; }
  grades.push(gradeListing(key, a));
}

for (const g of grades) {
  const mark = g.verdict === "PASS" ? "ok " : g.verdict === "NOT_GRADABLE" ? "-- " : "XX ";
  console.log(`${mark}${g.verdict.padEnd(22)} ${String(g.url).slice(0, 80)}`);
  for (const r of g.reasons) console.log(`      ${r}`);
}

const s = summarize(grades);
console.log("\n== golden-set correctness summary ==");
const ranAt = Date.parse(results?.summary?.ranAt || "");
const builtAt = Date.parse(keys?.meta?.builtAt || "");
if (Number.isFinite(ranAt) && Number.isFinite(builtAt) && Math.abs(ranAt - builtAt) > 24 * 3600e3) {
  console.log("WARNING: results and answer keys are more than a day apart — dealers change prices, " +
    "so a 'wrong' here may be drift, not a defect. Rebuild keys (npm run golden:build) the same day as the scan.");
}
console.log(`listings in results: ${rows.length}  matched to keys: ${grades.length}  unmatched: ${unmatched}`);
console.log(`graded: ${s.graded}  pass: ${s.pass}  fail: ${s.fail}  false accusations: ${s.false_accusations}`);
if (s.accuracyPct != null) console.log(`report-level accuracy (page-provable points): ${s.accuracyPct}%`);
if (s.ruleOfThree95UpperPct != null) {
  console.log(`zero fails in ${s.graded} → true failure rate < ${s.ruleOfThree95UpperPct}% at 95% confidence (rule of three)`);
}
console.log("\nby point:");
for (const [p, counts] of Object.entries(s.byPoint)) {
  console.log(`  ${p.padEnd(20)} ${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join("  ")}`);
}

if (s.false_accusations > 0) {
  console.error("\nFALSE ACCUSATION detected — this is the report-discrediting class. Failing.");
  process.exit(1);
}
