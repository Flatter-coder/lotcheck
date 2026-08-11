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
  { name: "FISH CREEK NISSAN LTD.", trade_name: "N/A", city: "Calgary", facility_status: "Issued", registration_number: "B1003333" },
  { name: "KRAMER MAZDA LTD.", trade_name: "N/A", city: "Calgary", facility_status: "Issued", registration_number: "B1004444" },
  // Deliberate near-duplicates: the ambiguity guard must refuse to choose.
  { name: "CALGARY AUTO SALES INC.", trade_name: "N/A", city: "Calgary", facility_status: "Issued" },
  { name: "CALGARY AUTO SALES LTD.", trade_name: "N/A", city: "Calgary", facility_status: "Cancelled by Registrar" },
];

const CASES = [
  // --- must match (confident) ---
  ["Exact-ish legal name + city", { dealerName: "Okotoks Toyota", dealerCity: "Okotoks, AB" }, "OKOTOKS TOYOTA LTD."],
  ["Word-order flip", { dealerName: "Toyota of Okotoks", dealerCity: "Okotoks" }, "OKOTOKS TOYOTA LTD."],
  ["Corporate suffix in the query", { dealerName: "Fish Creek Nissan Ltd.", dealerCity: "Calgary" }, "FISH CREEK NISSAN LTD."],
  ["Closed dealer still matches (status is the point)", { dealerName: "Crowfoot Dodge Chrysler", dealerCity: "Calgary" }, "CROWFOOT DODGE CHRYSLER INC."],
  ["Expired dealer with live website", { dealerName: "North American EV", dealerCity: "Mountain View County" }, "North American EV Inc"],
  ["Website host clinches it", { dealerName: "Okotoks Toyota", website: "https://www.okotokstoyota.ca/new/inventory/x.html" }, "OKOTOKS TOYOTA LTD."],
  ["Punctuation + ampersand noise", { dealerName: "Kramer Mazda", dealerCity: "Calgary" }, "KRAMER MAZDA LTD."],

  // --- must NOT match (these are the defamation guards) ---
  ["Single generic token", { dealerName: "Auto", dealerCity: "Calgary" }, null],
  ["Unknown dealer", { dealerName: "Sunridge Hyundai", dealerCity: "Calgary" }, null],
  ["Near-duplicate names = ambiguous", { dealerName: "Calgary Auto Sales", dealerCity: "Calgary" }, null],
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
