// Regression suite for the finance-contingent price detector (S11/S18).
// Run: node scripts/test-finance-contingent.mjs
import { detectFinanceContingent } from "../supabase/functions/_shared/finance-contingent.js";

// [label, text, expectContingent]
const CASES = [
  // --- must fire -----------------------------------------------------------
  ["In lieu of special financing",
    "Price includes $3,000 delivery allowance in lieu of special financing rates.", true],
  ["Finance cash",
    "MSRP $52,199. Includes $2,500 Finance Cash. See dealer for details.", true],
  ["Finance assist",
    "Total savings $4,750 including finance assist of $1,000.", true],
  ["When financed with us",
    "Advertised price when financed with us through our lending partners.", true],
  ["Must finance through",
    "To receive this price customer must finance through dealer.", true],
  ["Price only available with financing",
    "This discount is only available with approved dealer financing.", true],
  ["Non-financed price differs",
    "Non-finance price $48,900. Financed price shown above.", true],
  ["Cash price clause",
    "Cash price does not include the financed savings shown; financing required.", true],
  ["OAC to qualify",
    "O.A.C. Credit approval required to qualify for advertised pricing.", true],

  // --- must NOT fire (the expensive kind of mistake) ------------------------
  ["Plain financing offer, no condition",
    "Financing available from 3.99% APR for 84 months. O.A.C.", false],
  ["Finance calculator boilerplate",
    "Use our payment calculator to estimate your monthly finance payment.", false],
  ["Finance department contact",
    "Contact our finance department for more information.", false],
  ["Clean listing",
    "New 2027 Toyota Land Cruiser 1958. $112,995. Call 403-555-0100.", false],
  ["CSS in a style block cannot trigger it",
    '<style>.finance-cash{color:rgba(0,0,0,.09)}</style><p>2025 Ford Bronco $64,335</p>', false],
  ["Script content cannot trigger it",
    '<script>var financeCash = 2500;</script><p>2025 Ford Bronco $64,335</p>', false],
  ["Empty input", "", false],
  ["Null input", null, false],

  // --- cases taken from live pages, not invented -----------------------------
  // Real string on ford.ca/finance (2026-08-12), inside a <script> JSON blob.
  // It conditions the promotional APR, not the price. Every captive-lender
  // promo in Canada reads like this, so flagging it would fire on almost every
  // Ford/GM/Toyota listing and claim something the page never said.
  ["LIVE ford.ca — APR requires captive lender, price NOT conditional",
    '<script>var d = {"id":"26","title":"disclaimerChooseARate","description":"<p>APR - Must finance through Ford Credit Canada Company. Subject to Ford Credit Canada Company lending terms.</p>"};</script>', false],
  // Same page shape, but the PRICE is what hangs on it — must still be caught
  // even though it only exists inside the script blob.
  ["Disclaimer prose inside a script blob IS scanned",
    '<script>var cfg = {"disclaimer":"Advertised price includes $2,000 Finance Cash and is only available with dealer financing on approved credit."};</script>', true],
  ["Script identifiers still cannot trigger it",
    '<script>var financeCash=2500,financeAssist=0;</script>', false],
  // Real nav-menu text from calgaryhyundai.com (2026-08-12). Caught as a false
  // positive by the graded live sweep, not by any fixture I would have written.
  ["LIVE calgaryhyundai.com — nav menu, not a pricing condition",
    "Winter Tires Summer Performance Tires Finance Credit Application Request Current Payout Extended Protection Plan", false],
  ["Finance vocabulary with no money context stays clean",
    "Visit our finance centre. Finance assist available by appointment.", false],
];

let pass = 0, fail = 0;
for (const [label, text, expected] of CASES) {
  const r = detectFinanceContingent(text);
  const got = r !== null;
  // A positive must also carry its evidence, or the claim is not checkable.
  const ok = got === expected && (!got || (r.reasons.length > 0 && r.evidence.length > 0));
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  (expected ${expected}, got ${got}${r ? " :: " + r.reasons.join(", ") : ""})`);
  ok ? pass++ : fail++;
}
console.log(`\n${pass}/${pass + fail} passed${fail ? "  -- FAILING" : "  all green"}`);
process.exit(fail ? 1 : 0);
