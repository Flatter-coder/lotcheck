#!/usr/bin/env node
// THE ABSENCE HAS TO SURVIVE THE READ.
//
// Every case below is a real defect this repo shipped, reduced to the one
// expression that caused it. They are here as a set, not one per fix, because
// the pattern came back nine times as nine different-looking bugs: patching the
// instance never closed the class.
//
// Run: node scripts/test-read-num.mjs
import { readNum, readNumOrValue, odometerReading } from "../supabase/functions/_shared/read-num.js";
import { fillFromJsonLd, extractJsonLdVehicle } from "../supabase/functions/_shared/jsonld-vehicle.js";
import { financingMathNote } from "../supabase/functions/_shared/report-lines.js";

let pass = 0, fail = 0;
function check(label, ok) {
  if (ok) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}
function eq(label, got, want) {
  const ok = got === want;
  if (!ok) console.log("       got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
  check(label, ok);
}

console.log("-- readNum: an absence is not a number --");
eq("null is null", readNum(null), null);
eq("undefined is null", readNum(undefined), null);
eq("empty string is null", readNum(""), null);
eq("whitespace is null", readNum("   "), null);
eq("empty array is null (Number([]) is 0)", readNum([]), null);
eq("true is null (Number(true) is 1)", readNum(true), null);
eq("false is null (Number(false) is 0)", readNum(false), null);
eq("unparseable text is null", readNum("call us"), null);
eq("a real zero survives", readNum(0), 0);
eq("a real zero as text survives", readNum("0"), 0);
eq("a real reading survives", readNum("41000"), 41000);
eq("a negative survives the read (the caller decides)", readNum(-5), -5);

console.log("-- readNumOrValue: the container is not the value --");
eq("a bare number", readNumOrValue(41000), 41000);
eq("a QuantitativeValue", readNumOrValue({ value: 41000, unitCode: "KMT" }), 41000);
// The exact shape dealer templates emit when the field is blank. The old guard
// tested the CONTAINER for null and then coerced the null INSIDE it.
eq("a QuantitativeValue with no value is an absence", readNumOrValue({ value: null, unitCode: "KMT" }), null);
eq("an empty QuantitativeValue is an absence", readNumOrValue({}), null);
eq("a real 0 km inside a container survives", readNumOrValue({ value: 0 }), 0);

console.log("-- odometerReading: what the report is allowed to print --");
eq("no odometer field at all", odometerReading({}), null);
eq("a null odometer", odometerReading({ odometerKm: null }), null);
eq("a blank odometer", odometerReading({ odometerKm: "" }), null);
eq("a real delivery reading", odometerReading({ odometerKm: 8 }), 8);
eq("a real zero", odometerReading({ odometerKm: 0 }), 0);
eq("a negative is refused", odometerReading({ odometerKm: -1 }), null);

console.log("-- jsonld-vehicle: the defect that reached a customer --");
const wrap = (obj) => "<html><head><script type=\"application/ld+json\">" + JSON.stringify(obj) + "</script></head><body>x" + "y".repeat(600) + "</body></html>";
{
  // LC-FE77-C58: the page published no odometer; the report printed
  // "Odometer 0 km -- consistent with a new vehicle (delivery distance)".
  // `{ value: null }` is what dealer templates emit for a blank field.
  const blank = extractJsonLdVehicle(wrap({
    "@context": "https://schema.org", "@type": "Car",
    name: "2026 Lexus RX 350 AWD Luxury Package",
    mileageFromOdometer: { "@type": "QuantitativeValue", value: null, unitCode: "KMT" },
    offers: { "@type": "Offer", price: 82995, priceCurrency: "CAD" },
  }));
  check("a blank QuantitativeValue reads as no odometer", !!blank && blank.odometerKm === null);
  const real = extractJsonLdVehicle(wrap({
    "@context": "https://schema.org", "@type": "Car", name: "2019 Honda Odyssey EX-L",
    mileageFromOdometer: { "@type": "QuantitativeValue", value: 118400, unitCode: "KMT" },
  }));
  check("a real reading still arrives", !!real && real.odometerKm === 118400);
  const miles = extractJsonLdVehicle(wrap({
    "@context": "https://schema.org", "@type": "Car", name: "2019 Honda Odyssey EX-L",
    mileageFromOdometer: { "@type": "QuantitativeValue", value: 60000, unitCode: "SMI" },
  }));
  check("miles are still converted", !!miles && miles.odometerKm === 96560);
}
{
  // The one-line stamp. Without it isVerifiedPriceSource says no and five
  // separate statements degrade on a price the page published in its own
  // markup -- which is what happened on the RX report.
  const filled = fillFromJsonLd({}, { price: 82995 });
  eq("a price from the dealer's own markup carries its source", filled.quotedPriceSource, "structured_data");
  const kept = fillFromJsonLd({ quotedPrice: 41000, quotedPriceSource: "convertus_vms" }, { price: 38995 });
  eq("a price that was already read keeps its own source", kept.quotedPriceSource, "convertus_vms");
  eq("and keeps its own value", kept.quotedPrice, 41000);
  // The fill direction: an ABSENT parsed odometer must accept the structured
  // reading; a REAL parsed 0 must not be overwritten.
  const odoFilled = fillFromJsonLd({ odometerKm: null }, { odometerKm: 41000 });
  eq("an absent parsed odometer is filled from structured data", odoFilled.odometerKm, 41000);
  const odoKept = fillFromJsonLd({ odometerKm: 0 }, { odometerKm: 41000 });
  eq("a real parsed 0 km is not clobbered", odoKept.odometerKm, 0);
}

console.log("-- financingMathNote: the sentence names what the check reads --");
{
  const consistent = financingMathNote({ financingCheck: { checked: true, consistent: true, paymentsCounted: 260, computedFromPayments: 61880, disclosedTotalObligation: 61900 } });
  check("names the comparison it actually made", /multiplied the advertised payment/.test(consistent));
  check("names the payment count from the check's own field", /260 payments/.test(consistent));
  check("says what it did NOT check", /does not check the interest rate/.test(consistent));
  // The defect: the old sentence claimed the rate and the price had been used.
  check("never claims the price was recomputed", !/from the price/.test(consistent));
  const off = financingMathNote({ financingCheck: { checked: true, consistent: false, paymentsCounted: 208 } });
  check("a mismatch is stated without accusing", /do not agree/.test(off) && !/hidden|padded|inflat/i.test(off));
  const none = financingMathNote({});
  check("nothing checked says so", /publish enough financing detail/.test(none));
  const ref = financingMathNote({ referenceFinancing: { note: "Honda Canada publishes 4.99% for 60 months." } });
  eq("the manufacturer reference wins when nothing was checked", ref, "Honda Canada publishes 4.99% for 60 months.");
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
