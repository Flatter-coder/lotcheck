// Reconciliation gate — the "real pre-tax price" must never move in the
// dealer's favour.
//
// WHY THIS EXISTS. Two live listings on 2026-08-11 produced numbers that were
// not just wrong but wrong in the direction that flatters the dealer:
//
//   Rainbow Ford  advertised $39,765 -> we reported realPreTax $46,755.
//                 "Delivery Allowance" ($3,500) and "Ford Employee Pricing
//                 Discount" ($3,490) are discounts already reflected in the
//                 advertised price. classifyLine never saw the `kind` field
//                 the model fills in, so it re-derived from the NAME: FEE_RE
//                 matches "delivery", and the "...Discount" line only counted
//                 as a discount if its price was already negative. Both were
//                 added ON TOP instead of recognised as reductions.
//
//   Jack Carter   advertised $50,308 -> we reported realPreTax $104,053,
//                 because a second whole-vehicle price ($53,745 from the
//                 Finance tab) was written into addOns, where every entry is
//                 summed onto the selling price.
//
// A buyer walks into a dealership with these numbers. Overstating the real
// price hands the dealer an anchor and makes a bad deal look survivable, so
// this is graded as a correctness gate, not a formatting one.
//
// Run:  npm run test:reconciliation
import { classifyLine, computeReconciliation } from "./deal.ts";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? " — " + detail : ""}`); }
}

// ── classifyLine ────────────────────────────────────────────────────────────
console.log("\nclassifyLine");
{
  // The exact pair that shipped wrong, with the kind the model actually sent.
  check("'Delivery Allowance' +3500 kind=discount -> discount",
    classifyLine("Delivery Allowance", 3500, null, "discount") === "discount",
    classifyLine("Delivery Allowance", 3500, null, "discount"));
  check("'Ford Employee Pricing Discount' +3490 kind=discount -> discount",
    classifyLine("Ford Employee Pricing Discount", 3490, null, "discount") === "discount",
    classifyLine("Ford Employee Pricing Discount", 3490, null, "discount"));

  // A negative amount is a reduction regardless of naming or kind.
  check("negative price wins over a fee-shaped name",
    classifyLine("Freight and PDI", -1200, null, "fee") === "discount");

  // kind is only trusted for discounts: 'fee' must not collapse an add-on.
  check("kind=fee does NOT flatten a removable add-on into a fee",
    classifyLine("Paint Protection Package", 1999, null, "fee") === "addon");

  // Behaviour with no kind must be unchanged (older cached analyses).
  check("no kind: real freight still reads as a fee",
    classifyLine("Freight and PDI", 2395, null, undefined) === "fee");
  check("no kind: protection package still reads as an add-on",
    classifyLine("Paint Protection Package", 1999, null, undefined) === "addon");
  check("no kind: negative rebate still reads as a discount",
    classifyLine("Loyalty Rebate", -1000, null, undefined) === "discount");
}

// ── computeReconciliation ───────────────────────────────────────────────────
console.log("\ncomputeReconciliation — rainbowford.ca 2026 Bronco Sport (real)");
{
  const rec = computeReconciliation({
    quotedPrice: 39765,
    addOns: [
      { name: "Delivery Allowance", price: 3500, kind: "discount" },
      { name: "Ford Employee Pricing Discount", price: 3490, kind: "discount" },
    ],
  })!;
  check("realPreTax equals the advertised price", rec.realPreTax === 39765, `got ${rec.realPreTax}`);
  check("nothing is stacked on top", rec.addedOnTop === 0, `got ${rec.addedOnTop}`);
  check("both lines land in discounts", rec.discounts.length === 2, `got ${rec.discounts.length}`);
  check("discountsTotal is negative", rec.discountsTotal === -6990, `got ${rec.discountsTotal}`);
}

console.log("\ncomputeReconciliation — jackcarterchev.ca 2027 Bolt RS (real)");
{
  const rec = computeReconciliation({
    quotedPrice: 50308,
    addOns: [
      { name: "Non-Stackable Cash Delivery Allowance (NSCDA) - CBG", price: -2300, kind: "discount" },
      { name: "Federal EVAP Rebate for eligible customers", price: -4762, kind: "discount" },
    ],
  })!;
  check("realPreTax equals the advertised price", rec.realPreTax === 50308, `got ${rec.realPreTax}`);
  check("already-negative discounts are not double-negated", rec.discountsTotal === -7062, `got ${rec.discountsTotal}`);
}

console.log("\ncomputeReconciliation — genuine fees still stack");
{
  const rec = computeReconciliation({
    quotedPrice: 40000,
    addOns: [
      { name: "Freight and PDI", price: 2395, kind: "fee" },
      { name: "Paint Protection Package", price: 1999, kind: "fee" },
      { name: "Loyalty Rebate", price: 1000, kind: "discount" },
    ],
  })!;
  check("fee is charged on top", rec.feesTotal === 2395, `got ${rec.feesTotal}`);
  check("removable add-on stays separable", rec.addonsTotal === 1999, `got ${rec.addonsTotal}`);
  check("discount does not inflate the price", rec.discountsTotal === -1000, `got ${rec.discountsTotal}`);
  check("realPreTax = price + fees + add-ons", rec.realPreTax === 44394, `got ${rec.realPreTax}`);
}

// ── The invariant, stated once ──────────────────────────────────────────────
console.log("\ninvariant: a discount can never raise the real price");
{
  for (const [name, price, kind] of [
    ["Delivery Allowance", 3500, "discount"],
    ["Cash Purchase Incentive", 2000, "discount"],
    ["Costco Member Rebate", -700, "discount"],
  ] as [string, number, string][]) {
    const base = computeReconciliation({ quotedPrice: 30000, addOns: [] })!;
    const withIt = computeReconciliation({ quotedPrice: 30000, addOns: [{ name, price, kind }] })!;
    check(`'${name}' does not raise realPreTax`,
      (withIt.realPreTax ?? 0) <= (base.realPreTax ?? 0),
      `${base.realPreTax} -> ${withIt.realPreTax}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail) process.exit(1);
