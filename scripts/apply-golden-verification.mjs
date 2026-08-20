// Apply adversarial-verification verdicts to the golden-set answer keys.
//
// Input: scripts/fixtures/golden/verification-report.json — one entry per
// listing with per-field verdicts from independent verifier agents that
// re-fetched every page and tried to REFUTE each key value.
//
// Deterministic merge rules (no judgment calls happen here — they happened in
// the verification, with evidence):
//   confirm       on structured/cross → field.verified = true
//   promote       on text             → confidence 'agent' (now gradable)
//   reject        on text             → field removed (logged)
//   wrong         (+actualValue)      → value replaced, confidence 'agent',
//                                       corrected flag + evidence kept
//   unverifiable  field               → confidence downgraded to 'text'
//   unverifiable  whole listing gone  → listing.excluded = true (grader skips)
//   askingPrice(conflict) adjudicated → askingPrice set from actualValue,
//                                       conflict removed; conditionalNote →
//                                       listing.priceConditional
//
// Run: node scripts/apply-golden-verification.mjs

import { readFileSync, writeFileSync } from "node:fs";

const KEYS = "scripts/fixtures/golden/answer-keys.json";
const REPORT = "scripts/fixtures/golden/verification-report.json";
const strip = (s) => s.replace(/^﻿/, "");

const keys = JSON.parse(strip(readFileSync(KEYS, "utf8")));
const report = JSON.parse(strip(readFileSync(REPORT, "utf8")));

const NUMERIC = new Set(["askingPrice", "msrpStated", "odometerKm", "year"]);
const toNum = (v) => {
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

const stats = { confirms: 0, promotions: 0, rejections: 0, corrections: 0, downgrades: 0, excluded: 0, conflictsResolved: 0, unknownField: 0 };
const log = [];

for (const item of report.items) {
  const l = keys.listings[item.index];
  if (!l || l.url !== item.url) {
    log.push(`SKIP index ${item.index}: url mismatch (${item.url})`);
    continue;
  }
  const gone = item.verdicts.filter((v) => v.verdict === "unverifiable" && /gone|404|redirect|removed|sold/i.test(v.evidence || ""));
  if (gone.length && gone.length >= item.verdicts.length - 1) {
    l.excluded = true;
    l.excludedReason = gone[0].evidence?.slice(0, 120) || "listing gone";
    stats.excluded++;
    continue;
  }
  for (const v of item.verdicts) {
    if (v.field === "askingPrice(conflict)") {
      const val = toNum(v.actualValue);
      if (val != null) {
        l.fields.askingPrice = { value: val, source: "agent-adjudication", confidence: "agent", evidence: (v.evidence || "").slice(0, 200) };
        l.conflicts = (l.conflicts || []).filter((c) => c.field !== "askingPrice");
        if (v.conditionalNote) l.priceConditional = v.conditionalNote.slice(0, 240);
        stats.conflictsResolved++;
      } else log.push(`conflict at ${item.index} lacks numeric actualValue: ${v.actualValue}`);
      continue;
    }
    if (v.field === "priceGated") { if (v.verdict === "confirm") { l.priceGatedVerified = true; stats.confirms++; } continue; }
    const f = l.fields?.[v.field];
    if (!f) { stats.unknownField++; continue; }
    if (v.verdict === "confirm") { f.verified = true; stats.confirms++; }
    else if (v.verdict === "promote") { f.confidence = "agent"; f.verified = true; if (v.evidence) f.evidence = v.evidence.slice(0, 200); stats.promotions++; }
    else if (v.verdict === "reject") { delete l.fields[v.field]; stats.rejections++; log.push(`rejected ${v.field} at ${item.index}: ${v.evidence?.slice(0, 100)}`); }
    else if (v.verdict === "wrong") {
      const val = NUMERIC.has(v.field) ? toNum(v.actualValue) : (v.actualValue || "").trim();
      if (val !== null && val !== "") {
        log.push(`corrected ${v.field} at ${item.index}: ${JSON.stringify(f.value)} -> ${JSON.stringify(val)} (${v.evidence?.slice(0, 80)})`);
        l.fields[v.field] = { value: val, source: "agent-correction", confidence: "agent", evidence: (v.evidence || "").slice(0, 200), corrected: true };
        stats.corrections++;
      } else { delete l.fields[v.field]; stats.rejections++; log.push(`wrong-without-actual: dropped ${v.field} at ${item.index}`); }
    } else if (v.verdict === "unverifiable") { f.confidence = "text"; delete f.verified; stats.downgrades++; }
  }
}

keys.meta.verifiedAt = new Date().toISOString();
keys.meta.verification = { ...stats, listingsInReport: report.items.length };
writeFileSync(KEYS, JSON.stringify(keys, null, 1));

console.log("verification applied:", JSON.stringify(stats));
for (const line of log) console.log("  " + line);
const G = new Set(["structured", "cross", "agent"]);
const cov = (f) => keys.listings.filter((l) => !l.excluded && l.fields[f] && G.has(l.fields[f].confidence)).length;
console.log("post-verification gradable coverage:", JSON.stringify({
  activeListings: keys.listings.filter((l) => !l.excluded).length,
  askingPrice: cov("askingPrice"), vin: cov("vin"), odometerKm: cov("odometerKm"),
  msrpStated: cov("msrpStated"), year: cov("year"), make: cov("make"), model: cov("model"), condition: cov("condition"),
}));
