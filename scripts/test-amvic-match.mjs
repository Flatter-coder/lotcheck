// Regression suite for the AMVIC licensee matcher (check #11).
// Run: node scripts/test-amvic-match.mjs
//
// The defamation-safe contract is what these tests actually protect: a wrong
// or over-confident match would attach a real regulator status to the wrong
// business. Every "expect null" case below is a claim we must NOT make.

import { matchLicensee, classifyStatus, nameScore } from "../supabase/functions/_shared/amvic-match.js";

// Real shapes from AMVIC's registry (values observed live 2026-08-10).
const ROWS = [
  { name: "OKOTOKS TOYOTA LTD.", trade_name: "N/A", city: "Okotoks", facility_status: "Issued", registration_number: "B1001234", website: "www.okotokstoyota.ca" },
  { name: "CROWFOOT DODGE CHRYSLER INC.", trade_name: "N/A", city: "Calgary", facility_status: "Closed - Voluntarily", registration_number: "B1002222" },
  { name: "North American EV Inc", trade_name: "N/A", city: "Mountain View County", facility_status: "Expired - Required to Reapply", registration_number: "B2035585", website: "www.northamericanev.com", expiry_date: "Jun-30-2022" },
  { name: "ADVANCED AUTOMOTIVE REPAIR INC.", trade_name: "N/A", city: "Calgary", facility_status: "Expired - Required to Reapply", registration_number: "B1012209" },
  { name: "KRAMER MAZDA LTD.", trade_name: "N/A", city: "Calgary", facility_status: "Issued", registration_number: "B1004444" },
  // Deliberate near-duplicates: the ambiguity guard must refuse to choose.
  { name: "CALGARY AUTO SALES INC.", trade_name: "N/A", city: "Calgary", facility_status: "Issued" },
  { name: "CALGARY AUTO SALES LTD.", trade_name: "N/A", city: "Calgary", facility_status: "Cancelled by Registrar" },
  // Real shape (2026-08-11): ONE business, TWO registry records, same status.
  // Refusing these meant real dealers silently got no licence card.
  { name: "ADVANTAGE FORD SALES LTD.", trade_name: "N/A", city: "CALGARY", facility_status: "Issued", registration_number: "B2037619", expiry_date: "Feb-28-2027" },
  { name: "ADVANTAGE FORD SALES LTD.", trade_name: "N/A", city: "CALGARY", facility_status: "Issued", registration_number: "B2037619", expiry_date: "Feb-28-2027" },
  // THE SUPERSEDED-RECORD CASE (real, 2026-08-11). Fish Creek Nissan has three
  // records: the previous operator's dead ones, and the current operator's live
  // licence filed under a COMBINED trade name. Name-only scoring picks the dead
  // 2014 record -- an exact match -- and calls an operating dealer "closed".
  { name: "969642 ALBERTA LTD.", trade_name: "FISH CREEK NISSAN", city: "CALGARY", facility_status: "Closed - Voluntarily", registration_number: "B1013803", expiry_date: "Dec-31-2014" },
  { name: "CALGARY N MOTORS GP INC.", trade_name: "CALGARY N MOTORS LP/FISH CREEK NISSAN", city: "Calgary", facility_status: "Closed - Voluntarily", registration_number: "B1045312", expiry_date: "Jun-30-2019" },
  { name: "CALGARY N MOTORS GP INC.", trade_name: "FISH CREEK NISSAN/CALGARY N MOTORS LP", city: "Calgary", facility_status: "Issued", registration_number: "B2026510", expiry_date: "Mar-31-2027" },
  // A storefront whose ONLY records are dead -- report the most recent, not the oldest.
  { name: "OLDTOWN MOTORS LTD.", trade_name: "OLDTOWN MOTORS", city: "Red Deer", facility_status: "Closed - Voluntarily", registration_number: "B1000001", expiry_date: "Jan-31-2012" },
  { name: "OLDTOWN MOTORS LTD.", trade_name: "OLDTOWN MOTORS", city: "Red Deer", facility_status: "Expired - Required to Reapply", registration_number: "B1000002", expiry_date: "Aug-31-2024" },
];

const CASES = [
  // --- must match (confident) ---
  ["Exact-ish legal name + city", { dealerName: "Okotoks Toyota", dealerCity: "Okotoks, AB" }, "OKOTOKS TOYOTA LTD."],
  ["Word-order flip", { dealerName: "Toyota of Okotoks", dealerCity: "Okotoks" }, "OKOTOKS TOYOTA LTD."],
  ["Corporate suffix in the query", { dealerName: "Kramer Mazda Ltd.", dealerCity: "Calgary" }, "KRAMER MAZDA LTD."],
  ["Closed dealer still matches (status is the point)", { dealerName: "Crowfoot Dodge Chrysler", dealerCity: "Calgary" }, "CROWFOOT DODGE CHRYSLER INC."],
  ["Expired dealer with live website", { dealerName: "North American EV", dealerCity: "Mountain View County" }, "North American EV Inc"],
  ["Website host clinches it", { dealerName: "Okotoks Toyota", website: "https://www.okotokstoyota.ca/new/inventory/x.html" }, "OKOTOKS TOYOTA LTD."],
  ["Punctuation + ampersand noise", { dealerName: "Kramer Mazda", dealerCity: "Calgary" }, "KRAMER MAZDA LTD."],
  ["Duplicate records, same status -> still matches", { dealerName: "Advantage Ford", dealerCity: "Calgary, AB" }, "ADVANTAGE FORD SALES LTD."],
  // The regression that mattered: never report a superseded "Closed" record for
  // a dealer that currently holds a licence.
  ["Fish Creek Nissan -> the CURRENT operator's licence, not the 2014 closure", { dealerName: "Fish Creek Nissan", dealerCity: "Calgary" }, "CALGARY N MOTORS GP INC."],
  ["Only-dead records -> the most recent one, not the oldest", { dealerName: "Oldtown Motors", dealerCity: "Red Deer" }, "OLDTOWN MOTORS LTD."],

  // --- must NOT match (these are the defamation guards) ---
  ["Single generic token", { dealerName: "Auto", dealerCity: "Calgary" }, null],
  ["Unknown dealer", { dealerName: "Sunridge Hyundai", dealerCity: "Calgary" }, null],
  // Same storefront name across two entities, one live: report the LIVE one.
  // The card prints the legal name + licence number, so the buyer can see whose
  // record it is; the opposite error (calling a licensed dealer cancelled) is
  // the one that must never happen.
  ["Same name, one live -> report the live licence", { dealerName: "Calgary Auto Sales", dealerCity: "Calgary" }, "CALGARY AUTO SALES INC."],
  ["Empty name", { dealerName: "", dealerCity: "Calgary" }, null],
  ["City alone is not identity", { dealerName: "Calgary", dealerCity: "Calgary" }, null],
  ["Brand alone is not a dealer", { dealerName: "Toyota", dealerCity: "Okotoks" }, null],
];

let pass = 0, fail = 0;
for (const [label, sig, expected] of CASES) {
  let got = null;
  try { const m = matchLicensee(ROWS, sig); got = m ? m.row.name : null; }
  catch (e) { got = "THREW: " + e.message; }
  const ok = got === expected;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}\n        expected ${expected === null ? "no match" : expected}, got ${got === null ? "no match" : got}`);
  ok ? pass++ : fail++;
}

// Status classification — the regulator's wording drives the report tone.
const STATUS = [
  ["Issued", "valid"],
  ["Expired - Required to Reapply", "expired"],
  ["Expired", "expired"],
  ["Closed - Voluntarily", "closed"],
  ["Cancelled by Registrar", "action"],
  ["Suspended by Registrar", "action"],
  ["N/A", "unknown"],
  ["Active", "valid"],        // rare but present in the live registry
  ["Deceased", "closed"],     // sole-proprietor records
  ["", "unknown"],
];
for (const [s, want] of STATUS) {
  const got = classifyStatus(s);
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  status "${s}" -> ${got}`);
  ok ? pass++ : fail++;
}

console.log(`\n${pass}/${pass + fail} passed${fail ? "  -- FAILING" : "  all green"}`);
process.exit(fail ? 1 : 0);
