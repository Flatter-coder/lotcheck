// Regression suite for advertised-APR extraction.
// Run: node scripts/test-apr-extract.mjs
//
// A wrong APR in a report is worse than a missing one -- the buyer would walk
// in and argue a number the dealer never advertised. So most of these cases are
// things we must REFUSE to read as a purchase-finance rate.

import { extractAdvertisedApr } from "../supabase/functions/_shared/apr-extract.js";

const CASES = [
  // --- must find ---
  ["plain APR", "Finance from 5.99% APR for 60 months", 5.99],
  ["APR after the number", "6.29% APR financing available O.A.C.", 6.29],
  ["annual percentage rate spelled out", "Purchase financing at an annual percentage rate of 4.49%", 4.49],
  ["zero-percent promo is real", "0% purchase financing for up to 36 months", 0],
  ["markup in the wild (Harwood Escape)", "Finance this vehicle from 6.29% APR O.A.C. Payments from $249 bi-weekly", 6.29],
  ["lowest of several finance terms wins", "Financing: 3.99% APR for 36 months, 4.99% APR for 60 months", 3.99],

  // --- must REFUSE (each of these would put a false number in a report) ---
  ["a lease rate is not a finance rate", "Lease from 2.99% for 48 months", null],
  ["a rate range is not this car's rate", "Purchase financing from 3.99% to 9.99% APR", null],
  ["a bare percentage with no context", "Save 15% on winter tires", null],
  ["cash back is not a rate", "Get 5% cash back on select models", null],
  ["credit card copy", "Apply for our credit card at 19.99% annual interest", null],
  ["tax percentages", "GST of 5% applies to the purchase price", null],
  ["implausible rate", "Financing at 99% APR", null],
  ["nothing at all", "2026 Ford Escape. Call for details.", null],
];

let pass = 0, fail = 0;
for (const [label, text, want] of CASES) {
  let got;
  try { const r = extractAdvertisedApr(text); got = r ? r.apr : null; }
  catch (e) { got = "THREW: " + e.message; }
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  (want ${want}, got ${got})`}`);
  ok ? pass++ : fail++;
}
console.log(`\n${pass}/${pass + fail} passed${fail ? "  -- FAILING" : "  all green"}`);
process.exit(fail ? 1 : 0);
