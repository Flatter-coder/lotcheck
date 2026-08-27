// The dealer itemised their price. We must read it, and we must not call it
// money added on top.
//
// THE DEFECT (2026-08-27, sundancemazda.com, a real report). The listing said,
// in the dealer's own words:
//
//     2025 Mazda CX-90 MHEV MSRP starting at   $66,010
//     Admin. Fee                                  $795
//     Dealer bonus:                            - $8,000
//     Your Price:                              $58,805
//
// and the blob carried every line. The report said "Add-ons & fee audit: NONE
// LISTED". Vic: "at least they transparent $795 fees but we miss them
// incredible".
//
// THE SAFETY RULE THIS PINS. The fee is INSIDE the advertised price -- the
// page's own arithmetic proves it three ways to the dollar. Treating it as an
// add-on would inflate the buyer's real pre-tax by $795 and describe a dealer
// who itemised openly as though they had padded the quote, which is the class
// 38274c2 fixed. So the items are read into their OWN field, never into
// addOns, and the copy says "already included in", never "added on top".
import { readFileSync } from "node:fs";
import { extractD2cVdpVehicle } from "../supabase/functions/_shared/d2c-vdp.js";
import { computeReconciliation } from "../supabase/functions/_shared/deal.ts";

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

// A minimal D2C blob carrying the real page's shape and figures.
// FLAT, exactly as the real page publishes it: no `vehicle` wrapper, and the
// VIN lives in `niv`. Every figure is the real one from sundancemazda.com.
const blob = (over = {}) => `<script>window.__vdpJSON = ${JSON.stringify({
  id: 13095631, sn: "G0687", niv: "JM3KKDHD9S1260015", yr: 2025,
  make: { basic: "Mazda" }, model: { basic: "CX-90 MHEV" }, version: { basic: "GT AWD" },
  km: "12", drivetrain: "All-wheel drive",
  prices: {
    priceInteger: "58805", price: "$58,805",
    fullPriceInteger: "66805",
    priceWithoutCustomFees: "$58,010",
    originalPriceWithoutCustomFees: "$66,010",
    customFeesList: [{ amount: 795, descEn: "QWRtaW4uIEZlZQ==" }],
    allIncentivesList: [{ amount: 8000, descEn: "RGVhbGVyIGJvbnVzOg==" }],
    ...over,
  },
})};<\/script>`;

console.log("\nthe dealer's own lines are read");
{
  const v = extractD2cVdpVehicle(blob());
  check("the fee is read, named and priced",
    v.dealerFees?.length === 1 && v.dealerFees[0].name === "Admin. Fee" && v.dealerFees[0].amount === 795,
    JSON.stringify(v.dealerFees));
  check("the base64 label is decoded", v.dealerFees[0].name === "Admin. Fee");
  check("the trailing colon is trimmed off the incentive",
    v.dealerIncentives?.[0]?.name === "Dealer bonus", JSON.stringify(v.dealerIncentives));
  check("the incentive amount is read", v.dealerIncentives?.[0]?.amount === 8000);
  check("the amount is parsed even though it is a NUMBER, not a string",
    v.dealerFees[0].amount === 795, "money() requires a string and silently dropped every row");
}

console.log("\nwhere the fees sit is PROVEN, never assumed");
{
  const v = extractD2cVdpVehicle(blob());
  check("58,805 − 795 = 58,010 proves the fee is inside the advertised price",
    v.feesInsideAdvertised === true);
  check("the dealer's stated MSRP is promoted only when MSRP + fees = fullPrice",
    v.dealerStatedMsrp === 66010, String(v.dealerStatedMsrp));

  // A page whose numbers do not reconcile must yield no claim either way.
  const bent = extractD2cVdpVehicle(blob({ priceWithoutCustomFees: "$41,000" }));
  check("a page that does not reconcile makes NO claim about where fees sit",
    bent.feesInsideAdvertised === false || bent.feesInsideAdvertised === null,
    String(bent.feesInsideAdvertised));
  const noFull = extractD2cVdpVehicle(blob({ fullPriceInteger: "99999" }));
  check("a was-price that is not an MSRP leg is not promoted to MSRP",
    noFull.dealerStatedMsrp === null, String(noFull.dealerStatedMsrp));
}

console.log("\nnothing is guessed");
{
  const noName = extractD2cVdpVehicle(blob({ customFeesList: [{ amount: 795 }] }));
  check("a fee with no label is dropped, not shown as an unnamed charge",
    !noName.dealerFees?.length);
  const noAmt = extractD2cVdpVehicle(blob({ customFeesList: [{ descEn: "QWRtaW4uIEZlZQ==" }] }));
  check("a fee with no amount is dropped", !noAmt.dealerFees?.length);
  const none = extractD2cVdpVehicle(blob({ customFeesList: [], allIncentivesList: [] }));
  check("no fees means no claim at all",
    !none.dealerFees.length && none.feesInsideAdvertised === null);
}

console.log("\nthe fee must NEVER be double-counted as an add-on");
{
  const v = extractD2cVdpVehicle(blob());
  // What the analysis looks like once the gap-fill has attached the items.
  const a = {
    quotedPrice: 58805, addOns: [],
    dealerLineItems: { fees: v.dealerFees, incentives: v.dealerIncentives, insideAdvertisedPrice: v.feesInsideAdvertised },
  };
  const rec = computeReconciliation(a);
  check("the reconciliation does not add the fee on top",
    rec.addedOnTop === 0, `addedOnTop=${rec.addedOnTop}`);
  check("the buyer's real pre-tax stays the advertised price",
    rec.realPreTax === 58805,
    `got ${rec.realPreTax} — 59,600 would mean we billed the buyer for a fee already inside the price`);
  check("nothing is attributed to the dealer as an add-on", rec.addonsTotal === 0);
}

console.log("\nthe wiring: the merge must not drop these fields");
{
  const src = read("supabase/functions/analyze-listing-url/index.ts");
  check("blobFacts carries the itemisation", /dealerFees: \(blob as any\)\.dealerFees/.test(src));
  check("the JSON-LD branch spreads blobFacts instead of enumerating past it",
    /return \{\s*\n\s*\.\.\.blobFacts,\s*\n\s*\.\.\.jl,/.test(src),
    "this branch runs on any page that HAS JSON-LD — which is the page this was built for");
  check("the items are attached to the analysis", /analysis\.dealerLineItems = \{/.test(src));
  check("they are attached in the gap-fill, before anything derived from them",
    src.indexOf("analysis.dealerLineItems = {") < src.indexOf("analysis.priceVerified"),
    "ordering-vs-derived-value has bitten this repo three times");
  check("they are NOT pushed into addOns",
    !/addOns\.push\([^)]*dealerFees/.test(src) && !/addOns\s*=\s*[^;]*dealerFees/.test(src),
    "addOns is added ON TOP of the price by computeReconciliation");
}

console.log("\nevery surface says it, and none of them says 'added on top'");
{
  const app = read("src/App.jsx"), email = read("supabase/functions/email-quote-report/index.ts");
  check("the on-screen point stops reading NONE LISTED", /dliTotal > 0 \? "ITEMIZED"/.test(app));
  check("the on-screen card renders the breakdown", /<DealerLineItems items=\{dli\}/.test(app));
  check("the emailed point stops reading NONE LISTED", /dealerFeeTotal\(a\) > 0\) P\.push\(\{ t: "Add-ons & fee audit", v: "ITEMIZED"/.test(email));
  check("the PDF prints the breakdown", /kicker\("THE DEALER'S OWN PRICE BREAKDOWN"\)/.test(email));
  check("the share link carries it", /dli:a\.dealerLineItems/.test(app) && /dealerLineItems:c\.dli/.test(app));

  for (const [label, src] of [["the on-screen card", app], ["the PDF", email]]) {
    // The on-screen copy bolds "already included", so the phrase is split by
    // markup; the PDF's is plain. Match either.
    check(`${label} says the fees are already included, not added on top`,
      /already included(<\/b>)?\s*(in the )?advertised price/.test(src),
      "the fee is INSIDE the price and the copy must say so");
    check(`${label} never describes an included fee as added on top`,
      !/(dealer add-?ons?|added on top of the price|padding)/i.test(
        src.slice(Math.max(0, src.indexOf("already included in the advertised price") - 900),
                  src.indexOf("already included in the advertised price") + 900)),
      "an itemised fee inside the price is transparency, not padding");
    check(`${label} names whose the fee is`, /the dealer&apos;s own|the dealer's own/.test(src));
  }
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exit(1);
