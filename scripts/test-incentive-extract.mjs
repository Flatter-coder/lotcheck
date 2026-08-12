// Unit test for _shared/incentive-extract.js, run against REAL captured pages.
//
// The extractor exists because a live Jack Carter listing advertised a Bolt "at
// $43246" while our report said "no discount disclosed" — the $7,062 gap sat in
// an embedded JSON blob. Synthetic fixtures would not have caught that (the
// blob's shape is the whole problem), so this test runs against page source
// captured from the real listings on 2026-08-11.
//
// Fixtures live in scripts/fixtures/. If a dealer platform changes shape, this
// test is what tells you before a buyer gets a report claiming there is no
// discount on a car with $7,062 on the hood.
//
// Run:  npm run test:incentives
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractCashIncentives, incentivesToAddOns } from "../supabase/functions/_shared/incentive-extract.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "fixtures");

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? " — " + detail : ""}`); }
}

function loadFixture(name) {
  const p = join(FIXTURES, name);
  if (!existsSync(p)) {
    console.error(`\nMissing fixture ${p}. Capture it with a browser-shaped GET of the listing URL.`);
    process.exit(2);
  }
  return readFileSync(p, "utf8");
}

// ── Jack Carter (EDealer family) — the listing that exposed the gap ──────────
console.log("\njackcarterchev.ca — 2027 Chevrolet Bolt RS");
{
  const inc = extractCashIncentives(loadFixture("jackcarter-bolt.html"));
  check("finds a cash-incentive block", !!inc);
  if (inc) {
    check("total incentives = $7,062", inc.totalIncentives === 7062, `got ${inc.totalIncentives}`);
    check("post-incentive price = $43,246", inc.priceAfterIncentives === 43246, `got ${inc.priceAfterIncentives}`);
    check("reads both stacked offers", inc.offers.length === 2, `got ${inc.offers.length}`);

    const evap = inc.offers.find((o) => /EVAP/i.test(o.name));
    check("federal EVAP rebate = $4,762", evap?.value === 4762, `got ${evap?.value}`);
    check("EVAP payee is the customer", evap?.payee === "CUSTOMER", `got ${evap?.payee}`);

    const nscda = inc.offers.find((o) => /NSCDA|Delivery Allowance/i.test(o.name));
    check("delivery allowance = $2,300", nscda?.value === 2300, `got ${nscda?.value}`);
    check("delivery allowance is paid to the DEALER", nscda?.payee === "DEALER", `got ${nscda?.payee}`);

    const rows = incentivesToAddOns(inc);
    check("emits one discount line per offer", rows.length === 2, `got ${rows.length}`);
    check("discount lines are negative-priced", rows.every((r) => r.price < 0));
    check("all lines are kind=discount", rows.every((r) => r.kind === "discount"));
    check(
      "dealer-payee line warns the money isn't the buyer's",
      /not to you/i.test(rows.find((r) => /NSCDA|Delivery Allowance/i.test(r.name))?.reason || ""),
    );
    check(
      "eligibility-gated line is flagged conditional",
      /conditional on eligibility/i.test(rows.find((r) => /EVAP/i.test(r.name))?.reason || ""),
    );
  }
}

// ── Rainbow Ford — the real negative control ─────────────────────────────────
// This page DOES carry embedded pricing ("msrp":46755) and DOES advertise real
// promotions ($6,990 across a Delivery Allowance and Ford Employee Pricing) —
// but it states them in visible prose, which the LLM pass already reads
// correctly. Two things must hold here, and the second one nearly shipped as a
// regression: the extractor must not emit duplicate discount lines, and
// nothing may treat the embedded "msrp" as the advertised price. This car's
// MSRP is $46,755 and it is advertised at $39,765 — deriving an asking price
// from that key would have overwritten a correct number with a $6,990 error on
// a listing that was already right.
console.log("\nrainbowford.ca — 2026 Ford Bronco Sport (negative control)");
{
  const html = loadFixture("rainbowford-bronco.html");
  check("no cash-incentive block is invented", extractCashIncentives(html) === null);
  check(
    "embedded msrp is present but is NOT the advertised price",
    /"msrp"\s*:\s*46755/.test(html) && /39,?765/.test(html),
    "fixture no longer demonstrates the MSRP-vs-advertised gap",
  );
}

// ── Negative control: a page with no cash-incentive block must return null ────
console.log("\nnegative controls");
{
  check("empty string → null", extractCashIncentives("") === null);
  check("non-string → null", extractCashIncentives(null) === null);
  check("unrelated html → null", extractCashIncentives("<html><body>no offers here</body></html>") === null);
  check(
    "key present but truncated JSON → null (no partial guess)",
    extractCashIncentives('<script>var x={"cash_incentives":[{"amount":1') === null,
  );
  check("null input to addOns → []", incentivesToAddOns(null).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
