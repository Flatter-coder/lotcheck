// Freight on the report: what this listing charges to deliver the car, against
// what the manufacturer publishes for the same model.
//
// WHY. Vic, 2026-09-17, holding two pages for the same 2026 BMW X3 30 xDrive at
// the same $60,400 MSRP:
//
//   BMW Canada's configurator, Province = Alberta   Freight & PDI   $3,470
//   BMW Royal Oak, Calgary, the listing a buyer reads               $4,395
//
// $925 more, plus an admin line of $989.75 against BMW's own published $595
// maximum. Freight is the best place in the stack to load, because a buyer who
// would argue about a $989 admin fee will not argue about freight -- it reads as
// a fact of the car rather than a number someone chose.
//
// THE FAILURE THIS GUARDS IS THE OPPOSITE ONE. We have already told a buyer to
// demand removal of a $3,330 "Fees & Accessories" line that was mostly NOT the
// dealer's money -- $2,205 of Lexus freight, $100 federal A/C, $30 of provincial
// levies. We printed the manufacturer's own freight as dealer markup. So the
// rules under test are: state two published figures and the arithmetic between
// them, name the manufacturer's page, never assert who added what, and refuse
// rather than guess when either figure is missing.
//
// Run: node --experimental-strip-types scripts/test-freight-line.mjs

import { freightLine, listingFreight } from "../supabase/functions/_shared/freight-line.ts";
import { reportBands } from "../supabase/functions/_shared/report-bands.js";

let failures = 0;
const fail = (what, got, want) => {
  failures++;
  console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
};
const eq = (what, got, want) => { if (got !== want) fail(what, got, want); };

// The real listing, as captured.
const BMW = {
  make: "BMW", model: "X3",
  addOns: [{ name: "Freight and PDI", price: 4395 }, { name: "Other Fees", price: 989.75 }],
};

console.log("1. the measured case: BMW Royal Oak against BMW Canada's Alberta page");
{
  const r = freightLine(BMW);
  eq("state", r.state, "above");
  eq("listing figure", r.listing, 4395);
  eq("published figure", r.published, 3470);
  eq("difference", r.delta, 925);
  if (!r.explain.includes("$3,470") || !r.explain.includes("$4,395") || !r.explain.includes("$925")) {
    fail("all three figures are stated", r.explain, "3,470 / 4,395 / 925");
  }
}

console.log("2. it never says the dealer added anything");
{
  // THE 2026-08-27 DEFECT, INVERTED. The counter-script told a buyer to read
  // aloud "please take off the $3,330 in dealer add-ons" over a line that was
  // 70% manufacturer freight and government levies. This copy states figures and
  // asks a question; it must never assert an act by the dealer.
  const r = freightLine(BMW);
  const accusing = /(marked? ?up|markup|overcharg|inflat|padd(ed|ing)|added by the dealer|dealer added|gouge|rip)/i;
  if (accusing.test(r.explain)) fail("no accusation in the explain", r.explain, "figures and a question only");
  if (accusing.test(r.headline)) fail("no accusation in the headline", r.headline, "figures only");
  if (!/ask/i.test(r.explain)) fail("it tells the buyer what to do", r.explain, "an ask");
}

console.log("3. it refuses rather than guesses");
{
  eq("no published figure -> listing only",
    freightLine({ make: "Ford", model: "F-150", addOns: [{ name: "Freight and PDI", price: 2695 }] }).state, "listing_only");
  eq("no listing figure -> published only",
    freightLine({ make: "BMW", model: "X3", addOns: [] }).state, "published_only");
  eq("neither -> not read",
    freightLine({ make: "Kia", model: "Telluride", addOns: [] }).state, "not_read");
  // A comparison must never be drawn from one number.
  for (const st of ["listing_only", "published_only", "not_read"]) {
    const a = st === "listing_only" ? { make: "Ford", model: "F-150", addOns: [{ name: "Freight", price: 2695 }] }
      : st === "published_only" ? { make: "BMW", model: "X3", addOns: [] }
        : { make: "Kia", model: "Telluride", addOns: [] };
    const r = freightLine(a);
    if (r.delta !== null) fail(`${st} draws no difference`, r.delta, null);
  }
}

console.log("4. reading the listing's own freight line");
{
  eq("Freight and PDI", listingFreight({ addOns: [{ name: "Freight and PDI", price: 4395 }] }), 4395);
  eq("Freight & PDI", listingFreight({ addOns: [{ name: "Freight & PDI", price: 2185 }] }), 2185);
  eq("Delivery and Destination", listingFreight({ addOns: [{ name: "Delivery and Destination Charge", price: 1930 }] }), 1930);
  eq("from the dealer's own breakdown", listingFreight({ dealerLineItems: { fees: [{ label: "Freight/PDI", amount: 2200 }] } }), 2200);
  // NOT freight: a small levy, a vehicle price, and a delivery SERVICE.
  eq("the A/C levy is not freight", listingFreight({ addOns: [{ name: "Air Conditioning Levy", price: 100 }] }), null);
  eq("a home-delivery charge is not freight", listingFreight({ addOns: [{ name: "Home Delivery", price: 1200 }] }), null);
  eq("a delivery credit is not freight", listingFreight({ addOns: [{ name: "Delivery Credit", price: 1500 }] }), null);
  eq("a vehicle price near the word is not freight", listingFreight({ addOns: [{ name: "Destination vehicle price", price: 64595 }] }), null);
}

// ── 5. THE POINT MUST NOT READ "TRANSPARENT" OVER A GAP ───────────────────
// CLEAR is a verification claim: it says we checked and there is nothing to
// question. A freight line $925 above the manufacturer's own published figure is
// exactly something to question, so it raises the point even when no add-on was
// flagged.
console.log("5. a gap raises the fees point, it never renders TRANSPARENT");
{
  const b = reportBands(BMW).find((x) => x.key === "fees");
  eq("state", b.state, "raise");
  if (/transparent/i.test(String(b.value))) fail("the value is not TRANSPARENT", b.value, "the freight reading");
  if (!b.freight) fail("the reading is attached for every surface", b.freight, "a freight object");
  eq("and it carries the difference", b.freight.delta, 925);
}
{
  // At or below the published figure, the point stays clear and SAYS so.
  const ok = { make: "Toyota", model: "RAV4", addOns: [{ name: "Freight & PDI", price: 1930 }] };
  const b = reportBands(ok).find((x) => x.key === "fees");
  eq("at published stays clear", b.state, "clear");
  if (!String(b.note).includes("$1,930")) fail("and states the comparison", b.note, "the figure");
  if (!b.source) fail("clear still names its source", b.source, "a source");
}
{
  // A flagged add-on keeps its own headline and gains the freight sentence.
  const both = {
    make: "BMW", model: "X3",
    addOns: [{ name: "Freight and PDI", price: 4395 }, { name: "Paint protection", price: 1899, verdict: "flagged" }],
    totalFlaggedCost: 1899,
  };
  const b = reportBands(both).find((x) => x.key === "fees");
  eq("flagged still leads", b.state, "raise");
  if (!String(b.value).includes("flagged")) fail("the flagged headline survives", b.value, "flagged");
  if (!String(b.note).includes("$925")) fail("and the freight gap is still told", b.note, "$925");
}

// ── 6. the canonical ten is untouched ─────────────────────────────────────
// Freight rides inside point 03. reportBands throws on any other count, and a
// silent eleventh point would change every surface at once.
console.log("6. freight rides inside the fees point, it is not an eleventh");
{
  const n = reportBands(BMW).length;
  eq("still ten points", n, 10);
  const empty = reportBands({});
  eq("and ten on an empty analysis", empty.length, 10);
}

if (failures) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log(
  "\nOK — the measured BMW case reads $925 above published, the copy states figures " +
  "without asserting an act, a missing figure refuses instead of guessing, a gap never " +
  "renders TRANSPARENT, and the canonical ten is unchanged.",
);
