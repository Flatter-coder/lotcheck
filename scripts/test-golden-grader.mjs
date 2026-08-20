// Gate: golden-set grader semantics + answer-key schema.
//
// Locks the correctness-grading rules in scripts/lib/golden.mjs with synthetic
// cases (each one is a failure class this instrument exists to catch), then
// schema-validates the committed answer keys so a malformed key can never
// manufacture a fake grade. Offline, no network, no dependencies.
//
// Run: node scripts/test-golden-grader.mjs   (npm run test:golden)

import { readFileSync, existsSync } from "node:fs";
import { gradeListing, summarize, vinValid, modelsMatch, normUrl } from "./lib/golden.mjs";

let fails = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ok  ${name}`);
  else { fails++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const key = (over = {}) => ({
  url: "https://www.example-dealer.ca/used/vehicle/2024-honda-civic-lx-id1.htm",
  priceGated: false,
  vinAbsentConfirmed: false,
  fields: {
    year: { value: 2024, source: "url+title", confidence: "cross", evidence: "" },
    make: { value: "Honda", source: "url+title", confidence: "cross", evidence: "" },
    model: { value: "Civic", source: "jsonld", confidence: "structured", evidence: "" },
    condition: { value: "used", source: "url", confidence: "structured", evidence: "" },
    askingPrice: { value: 28999, source: "jsonld", confidence: "structured", evidence: "" },
    vin: { value: "3GNCJPSB7JL290881", source: "page-scan", confidence: "structured", evidence: "" },
    odometerKm: { value: 45210, source: "jsonld", confidence: "structured", evidence: "" },
    msrpStated: { value: 31999, source: "inline-blob:vehicle.msrp", confidence: "structured", evidence: "" },
  },
  ...over,
});

const good = {
  year: 2024, make: "Honda", model: "Civic", vehicleCondition: "used",
  quotedPrice: 28999, vin: "3GNCJPSB7JL290881", odometerKm: 45210,
  msrp: 31999, msrpBasis: "dealer_stated", priceDisclosure: "advertised",
};

console.log("vin check digit:");
check("known-good VIN validates", vinValid("3GNCJPSB7JL290881"));
check("corrupted VIN rejected", !vinValid("3GNCJPSB7JL290882"));
check("short / bad-charset rejected", !vinValid("ABC123") && !vinValid("IOQIOQIOQIOQIOQIO"));

console.log("model identity (powertrain-strict):");
check("wording variants tolerated", modelsMatch("Civic Sedan", "Civic") === true);
check("hybrid never matches its gas sibling", modelsMatch("RAV4", "RAV4 Hybrid") === false);
check("PHEV never matches hybrid", modelsMatch("RAV4 Hybrid", "RAV4 Plug-in Hybrid") === false);

console.log("grader — clean report:");
{
  const g = gradeListing(key(), good);
  check("verdict PASS", g.verdict === "PASS", g.verdict);
  check("all seven points graded correct", ["identity", "condition", "price", "vin", "odometer", "msrp_dealer_stated", "price_gating"].every((p) => g.points[p] === "correct"), JSON.stringify(g.points));
}

console.log("grader — wrong values fail:");
{
  const g = gradeListing(key(), { ...good, quotedPrice: 31999 });
  check("wrong price → FAIL", g.verdict === "FAIL" && g.points.price === "wrong");
}
{
  const g = gradeListing(key(), { ...good, vin: "1GNCJPSB7JL290887" });
  check("wrong VIN → FAIL", g.verdict === "FAIL" && g.points.vin === "wrong");
}
{
  const g = gradeListing(key(), { ...good, model: "Civic Hybrid" });
  check("powertrain-blurred model → FAIL", g.verdict === "FAIL" && g.points.identity === "wrong");
}
{
  const g = gradeListing(key(), { ...good, msrp: 34999 });
  check("dealer-stated MSRP mismatch → FAIL", g.verdict === "FAIL" && g.points.msrp_dealer_stated === "wrong");
}

console.log("grader — the false-accusation class:");
{
  const g = gradeListing(key(), { ...good, quotedPrice: null, priceDisclosure: "hidden_by_dealer" });
  check("gating claim vs advertised price → FAIL_FALSE_ACCUSATION",
    g.verdict === "FAIL_FALSE_ACCUSATION" && g.points.price_gating === "false_accusation", g.verdict);
}

console.log("grader — honest absence vs fabrication on a gated page:");
{
  const k = key({ priceGated: true });
  delete k.fields.askingPrice;
  const gHonest = gradeListing(k, { ...good, quotedPrice: null, priceDisclosure: "hidden_by_dealer" });
  check("no price on gated page → correct_absent", gHonest.points.price === "correct_absent", gHonest.points.price);
  const gFab = gradeListing(k, { ...good, quotedPrice: 27500 });
  check("price invented on gated page → wrong", gFab.verdict === "FAIL" && gFab.points.price === "wrong");
}

console.log("grader — misses are honest, not passes:");
{
  const g = gradeListing(key(), { ...good, vin: null });
  check("page-published VIN undelivered → missed, verdict still PASS", g.points.vin === "missed" && g.verdict === "PASS", JSON.stringify(g.points));
}

console.log("grader — ungradable never passes silently:");
{
  const k = key();
  k.fields.askingPrice.confidence = "text";
  const g = gradeListing(k, { ...good, quotedPrice: 99999 });
  check("text-confidence key field is not graded", g.points.price === "not_gradable", g.points.price);
}
{
  const k = key();
  const g = gradeListing(k, { ...good, msrpBasis: "exact", msrp: 99999 });
  check("basis=exact MSRP is catalog-audit territory, not page-gradable", g.points.msrp_dealer_stated !== "wrong");
}

console.log("summarize:");
{
  const s = summarize([gradeListing(key(), good), gradeListing(key(), { ...good, quotedPrice: 1 })]);
  check("counts pass/fail", s.graded === 2 && s.pass === 1 && s.fail === 1);
  const s0 = summarize([gradeListing(key(), good)]);
  check("rule of three only on zero fails", s0.ruleOfThree95UpperPct != null && s.ruleOfThree95UpperPct == null);
}

console.log("answer-key schema (committed fixture):");
const KEYS = "scripts/fixtures/golden/answer-keys.json";
if (!existsSync(KEYS)) {
  console.log("  (fixture absent — grader-logic checks above still gate)");
} else {
  const j = JSON.parse(readFileSync(KEYS, "utf8").replace(/^﻿/, ""));
  const L = j.listings || [];
  check("meta present with caps declared", !!j.meta && Array.isArray(j.meta.caps) && j.meta.caps.length > 0);
  check("at least 100 keys", L.length >= 100, String(L.length));
  const CONF = new Set(["structured", "cross", "text", "agent"]);
  let bad = null;
  for (const l of L) {
    if (!l.url || !l.host) { bad = `missing url/host on ${l.url}`; break; }
    for (const [fname, f] of Object.entries(l.fields || {})) {
      if (f.value === undefined || !f.source || !CONF.has(f.confidence)) { bad = `${l.url} field ${fname} malformed`; break; }
    }
    const v = l.fields?.vin;
    if (v && ["structured", "cross", "agent"].includes(v.confidence) && !vinValid(v.value)) { bad = `${l.url} gradable VIN fails check digit`; break; }
    if (l.priceGated && !l.gatedCta) { bad = `${l.url} priceGated without CTA evidence`; break; }
    for (const c of l.conflicts || []) {
      if (!c.field || !Array.isArray(c.values) || c.values.length < 2) { bad = `${l.url} malformed conflict`; break; }
    }
    if (bad) break;
  }
  check("every key well-formed (evidence, confidence enum, VIN digits, CTA proof)", !bad, bad || "");
  const urls = new Set(L.map((l) => normUrl(l.url)));
  check("no duplicate listing URLs", urls.size === L.length);
}

if (fails) { console.error(`\n${fails} check(s) failed`); process.exit(1); }
console.log("\nGOLDEN GRADER GATE — clean.");
