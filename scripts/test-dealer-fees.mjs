// The dealer-fee catalogue (Vic 2026-09-25: "catalog for dealers fees"). Pins
// that a fee is only ever what a dealer's own sentence states, and that the
// per-dealer rows count cars, not sentences.
//
// Run: node --experimental-strip-types scripts/test-dealer-fees.mjs
import { parseSm360FeesDisclaimer, sm360VehicleFees } from "../supabase/functions/_shared/sm360-fees.js";
import { feeRows } from "./crawl-alberta-inventory.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`ok    ${name}`); } else { fail++; console.log(`FAIL  ${name}${detail ? " -- " + detail : ""}`); } };

// Real sentences, Taza Park Volkswagen's SM360 feed, 2026-09-25.
const CASH = "Cash purchase selling price ($49,990.00) includes: Doc Fee ($899.00), AMVIC Levies ($10.00) Plus (GST) & Licensing.";
const FIN = "Finance selling price ($50,015.50) includes: Doc Fee ($899.00), PPSA Finance ($25.50), AMVIC Levies ($10.00) (GST) are extra.";
const c = parseSm360FeesDisclaimer(CASH), f = parseSm360FeesDisclaimer(FIN);
check("cash: the selling price and each fee, in the dealer's own names",
  c.basis === "cash" && c.sellingPrice === 49990 && c.fees.map((x) => `${x.name}=${x.amount}`).join() === "Doc Fee=899,AMVIC Levies=10", JSON.stringify(c));
check("finance: the finance-only charge is kept, and cents survive", f.basis === "finance" && f.fees.some((x) => x.name === "PPSA Finance" && x.amount === 25.5));
check("labels come from the shared vocabulary", c.fees[0].feeLabel === "documentation" && c.fees[1].feeLabel === "regulatory");
check("'(GST)' is not a fee -- it carries no dollar figure", !c.fees.some((x) => /GST/.test(x.name)));
check("a sentence of any other shape is not read at all", parseSm360FeesDisclaimer("Price plus $899 doc fee") === null && parseSm360FeesDisclaimer("") === null);
check("both statements off one feed vehicle",
  sm360VehicleFees({ paymentOptions: { cashPurchase: { feesDisclaimer: CASH }, finance: { feesDisclaimer: FIN } } }).length === 2);

const rows = feeRows(7, [c, c, f, parseSm360FeesDisclaimer(CASH.replace("$899.00", "$499.00"))], "2026-09-25");
const doc899 = rows.find((r) => r.basis === "cash" && r.fee_name === "Doc Fee" && r.amount === 899);
const doc499 = rows.find((r) => r.basis === "cash" && r.fee_name === "Doc Fee" && r.amount === 499);
check("rows count cars per amount, so $899 on 2 and $499 on 1 stay different facts", doc899?.vehicles === 2 && doc499?.vehicles === 1, JSON.stringify(rows));
check("every row names its dealer, day and source", rows.every((r) => r.dealer_id === 7 && r.observed_on === "2026-09-25" && r.source === "sm360_feed"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
