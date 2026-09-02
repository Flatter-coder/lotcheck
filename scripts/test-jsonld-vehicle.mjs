// Regression suite for schema.org vehicle extraction.
// Run: node scripts/test-jsonld-vehicle.mjs
//
// This parser is the safety net that runs alongside every scrape, so a dealer
// platform shape it can't read = a buyer who gets a dead end while the page is
// publishing the price in plain sight (advantageford.ca, 2026-08-11).
// Every fixture below is a real page shape.

import { extractJsonLdVehicle, fillFromJsonLd } from "../supabase/functions/_shared/jsonld-vehicle.js";

const wrap = (obj) => `<html><head><script type="application/ld+json">${JSON.stringify(obj)}</script></head><body>x${"y".repeat(600)}</body></html>`;

// 1. EDealer (advantageford.ca) — @graph + @type ARRAY ["Product","Car"].
const EDEALER = {
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "BreadcrumbList", itemListElement: [] },
    { "@type": "AutomotiveBusiness", name: "Advantage Ford" },
    {
      "@type": ["Product", "Car"],
      brand: { "@type": "Brand", name: "Ford" },
      itemCondition: "https://schema.org/NewCondition",
      model: "Mustang Mach-E",
      offers: { "@type": "Offer", priceCurrency: "CAD", price: 60992, seller: { "@type": "Organization", name: "Advantage Ford" } },
      vehicleIdentificationNumber: "3FMTK3SUXTMA17863",
      vehicleModelDate: 2026,
      mileageFromOdometer: { "@type": "QuantitativeValue", unitCode: "KMT", value: 37 },
      fuelType: "Electric",
    },
  ],
};

// 2. Plain top-level Vehicle node.
const SIMPLE = {
  "@context": "https://schema.org",
  "@type": "Vehicle",
  name: "2025 Toyota RAV4 XLE",
  brand: "Toyota",
  model: "RAV4",
  vehicleModelDate: "2025",
  vehicleIdentificationNumber: "2T3W1RFV8MW123456",
  mileageFromOdometer: { value: 41000, unitCode: "KMT" },
  offers: { "@type": "Offer", price: "38995", priceCurrency: "CAD" },
};

// 3. Miles must convert to km.
const MILES = { ...SIMPLE, mileageFromOdometer: { value: 10000, unitCode: "SMI" } };

// 4. Array of nodes at the top level.
const ARRAY_TOP = [{ "@type": "WebSite" }, SIMPLE];

// 5. Offer array rather than a single offer.
const OFFER_ARRAY = { ...SIMPLE, offers: [{ "@type": "Offer", price: 38995, priceCurrency: "CAD" }] };

// 6. No vehicle node at all — must return null, never a half-built guess.
const NO_VEHICLE = { "@context": "https://schema.org", "@type": "WebPage", name: "About us" };

const CASES = [
  ["EDealer @graph + @type array", wrap(EDEALER), { year: 2026, make: "Ford", model: "Mustang Mach-E", price: 60992, vin: "3FMTK3SUXTMA17863", odometerKm: 37, condition: "new", dealerName: "Advantage Ford" }],
  ["plain top-level Vehicle", wrap(SIMPLE), { year: 2025, make: "Toyota", model: "RAV4", price: 38995, vin: "2T3W1RFV8MW123456", odometerKm: 41000 }],
  ["miles converted to km", wrap(MILES), { odometerKm: 16093 }],
  ["array at top level", wrap(ARRAY_TOP), { year: 2025, price: 38995 }],
  ["offers as an array", wrap(OFFER_ARRAY), { price: 38995 }],
  ["malformed block doesn't sink a good one", `<script type="application/ld+json">{oops</script>${wrap(SIMPLE)}`, { price: 38995 }],
  ["no vehicle node -> null", wrap(NO_VEHICLE), null],
  ["no json-ld at all -> null", "<html><body>nothing here</body></html>", null],
];

// ── Fuel type is identity ────────────────────────────────────────────────────
// A gasoline 2026 Lexus RX 350 (lexusofroyaloak.com, 2026-09-02) declared
// "Gasoline" in its JSON-LD while the report showed the buyer the RX Hybrid /
// Plug-in ladder: nothing was reading the field. The ladder and the trim matcher
// both partition on fuel, so the page's own declaration must come through, in
// the pipeline's vocabulary (Gas | Hybrid | PHEV | BEV | Diesel).
const rxGas = (fuel, shape) => wrap({
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "AutomotiveBusiness", name: "Lexus of Royal Oak" },
    {
      "@type": ["Product", "Car"],
      brand: { "@type": "Brand", name: "Lexus" },
      itemCondition: "https://schema.org/UsedCondition",
      model: "RX 350",
      offers: { "@type": "Offer", priceCurrency: "CAD", price: 69898, seller: { "@type": "Organization", name: "Lexus of Royal Oak" } },
      vehicleIdentificationNumber: "2T2BAMCA0TC124633",
      vehicleModelDate: 2026,
      mileageFromOdometer: { "@type": "QuantitativeValue", unitCode: "KMT", value: 12270 },
      ...(shape === "node" ? { fuelType: fuel } : { vehicleEngine: { "@type": "EngineSpecification", name: "2.4L 4Cyl", fuelType: fuel } }),
    },
  ],
});
CASES.push(
  ["EDealer RX 350: fuelType on the Car node, 'Gasoline' -> Gas", rxGas("Gasoline", "node"), { make: "Lexus", model: "RX 350", price: 69898, fuelType: "Gas" }],
  ["EDealer RX 350: fuelType inside vehicleEngine (EngineSpecification) -> Gas", rxGas("Gasoline", "engine"), { fuelType: "Gas" }],
  ["Hybrid declared on the page -> Hybrid", rxGas("Hybrid", "node"), { fuelType: "Hybrid" }],
  ["Plug-in declared on the page -> PHEV, never Hybrid", rxGas("Plug-in Hybrid", "node"), { fuelType: "PHEV" }],
  ["Electric declared on the page -> BEV", rxGas("Electric", "node"), { fuelType: "BEV" }],
);

let pass = 0, fail = 0;
for (const [label, html, want] of CASES) {
  let got;
  try { got = extractJsonLdVehicle(html); } catch (e) { got = "THREW: " + e.message; }
  let ok, detail = "";
  if (want === null) { ok = got === null; detail = ok ? "" : ` got ${JSON.stringify(got)}`; }
  else if (!got || typeof got !== "object") { ok = false; detail = ` got ${JSON.stringify(got)}`; }
  else {
    const bad = Object.entries(want).filter(([k, v]) => got[k] !== v);
    ok = bad.length === 0;
    detail = ok ? "" : ` mismatched: ${bad.map(([k, v]) => `${k} want ${v} got ${got[k]}`).join("; ")}`;
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail}`);
  ok ? pass++ : fail++;
}

// fillFromJsonLd: the scrapfly.ts vision-rescue merge. The case this exists
// for -- capitalchev.ca, 2026-08-13 -- is a 17,729px page whose screenshot
// blows Claude's vision size ceiling, so the vision/text pass returns nothing
// at all and the page's own JSON-LD has to carry the whole rescue alone.
const FILL_CASES = [
  ["vision returned nothing -> jsonLd carries the whole rescue",
    {}, { year: 2025, make: "Toyota", model: "RAV4", trim: "XLE", price: 38995, vin: "2T3W1RFV8MW123456", odometerKm: 41000, condition: "used", dealerCity: "Calgary, AB" },
    { quotedPrice: 38995, vin: "2T3W1RFV8MW123456", year: 2025, make: "Toyota", model: "RAV4", trim: "XLE", vehicleCondition: "used", dealerCity: "Calgary, AB", odometerKm: 41000, vehicle: "2025 Toyota RAV4 XLE" }],
  ["a real parsed price is never clobbered by a differing jsonLd price",
    { quotedPrice: 41000 }, { price: 38995 },
    { quotedPrice: 41000 }],
  ["a zero/falsy parsed price IS replaced (bad vision read, not a real $0 listing)",
    { quotedPrice: 0 }, { price: 38995 },
    { quotedPrice: 38995 }],
  ["odometerKm 0 (new car) is a real reading, not \"missing\" -> not overwritten",
    { odometerKm: 0 }, { odometerKm: 41000 },
    { odometerKm: 0 }],
  ["existing fields are left alone, only blanks fill in",
    { vin: "1FTEW1EP0KKD00000", vehicle: "Real Vehicle String" }, { vin: "2T3W1RFV8MW123456", year: 2025, make: "Toyota", model: "RAV4" },
    { vin: "1FTEW1EP0KKD00000", vehicle: "Real Vehicle String" }],
  ["null jsonLd is a no-op", { quotedPrice: 41000 }, null, { quotedPrice: 41000 }],
];
for (const [label, parsed, jsonLd, want] of FILL_CASES) {
  let got;
  try { got = fillFromJsonLd(parsed, jsonLd); } catch (e) { got = "THREW: " + e.message; }
  let ok, detail = "";
  if (!got || typeof got !== "object") { ok = false; detail = ` got ${JSON.stringify(got)}`; }
  else {
    const bad = Object.entries(want).filter(([k, v]) => got[k] !== v);
    ok = bad.length === 0;
    detail = ok ? "" : ` mismatched: ${bad.map(([k, v]) => `${k} want ${v} got ${got[k]}`).join("; ")}`;
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail}`);
  ok ? pass++ : fail++;
}

// ---------------------------------------------------------------------------
// DAYS ON LOT, from the listing's own inventory date.
//
// The Advantage Ford Acadia was reported to a buyer as "Days on lot: Not
// published - ask the dealer" while its JSON-LD carried
// "purchaseDate":"2026-07-30T11:27:42.000". schema.org purchaseDate is the date
// the CURRENT OWNER acquired the item, and on a dealer's listing that owner is
// the dealer -- so it is the inventory date, in a blob the scan already parsed.
//
// Dates are computed from now, never hardcoded: a fixture date would quietly
// drift past the 3650-day guard and start passing for the wrong reason.
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const isoDay = (n) => daysAgo(n).slice(0, 10);

const DOL_CASES = [
  ["purchaseDate 32 days ago -> 32 days on lot", { purchaseDate: daysAgo(32) }, 32, isoDay(32)],
  ["availabilityStarts is accepted as a fallback", { offers: { "@type": "Offer", price: 1, availabilityStarts: daysAgo(9) } }, 9, isoDay(9)],
  // 0 days is TRUE but gives a buyer nothing, and is what a mis-stamped date
  // looks like. Report from one full day.
  // The DATE is legitimately known here -- it is the CLAIM that is withheld.
  // Extracting listedSince and declining to publish "0 days" are different
  // decisions, and conflating them in the expectation would have hidden which
  // one was under test.
  ["listed today -> date known, but no days-on-lot claim", { purchaseDate: daysAgo(0) }, null, isoDay(0)],
  ["a future date is a data error, not a prediction", { purchaseDate: new Date(Date.now() + 86400000).toISOString() }, null, null],
  ["older than ten years is a data error too", { purchaseDate: daysAgo(4000) }, null, null],
  ["no date at all -> no claim, and no invented one", {}, null, null],
  ["unparseable date -> no claim", { purchaseDate: "not a date" }, null, null],
];

for (const [label, extra, wantDays, wantSince] of DOL_CASES) {
  const node = { ...SIMPLE, ...extra };
  const got = extractJsonLdVehicle(wrap(node));
  const parsed = fillFromJsonLd({}, got);
  const gotDays = parsed?.daysOnLot?.days ?? null;
  const gotSince = got?.listedSince ?? null;
  const ok = gotDays === wantDays && gotSince === wantSince;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` want ${wantDays}/${wantSince} got ${gotDays}/${gotSince}`}`);
  ok ? pass++ : fail++;
}

{
  // The platform feeds are the dealer's operational record and outrank a
  // schema.org field. A scan that already has an answer must keep it.
  const got = extractJsonLdVehicle(wrap({ ...SIMPLE, purchaseDate: daysAgo(32) }));
  const already = { daysOnLot: { days: 7, since: isoDay(7), source: "dealer_platform_page" } };
  fillFromJsonLd(already, got);
  const ok = already.daysOnLot.days === 7 && already.daysOnLot.source === "dealer_platform_page";
  console.log(`${ok ? "PASS" : "FAIL"}  a platform feed's days-on-lot is not overwritten${ok ? "" : ` got ${JSON.stringify(already.daysOnLot)}`}`);
  ok ? pass++ : fail++;
}

{
  // And it says where it came from, because a figure with no stated source is
  // the thing this report exists to replace.
  const got = extractJsonLdVehicle(wrap({ ...SIMPLE, purchaseDate: daysAgo(32) }));
  const parsed = fillFromJsonLd({}, got);
  const ok = parsed.daysOnLot.source === "listing_structured_data"
    && /inventory date/i.test(parsed.daysOnLot.sourceLabel || "");
  console.log(`${ok ? "PASS" : "FAIL"}  the claim names its own source${ok ? "" : ` got ${JSON.stringify(parsed.daysOnLot)}`}`);
  ok ? pass++ : fail++;
}

console.log(`\n${pass}/${pass + fail} passed${fail ? "  -- FAILING" : "  all green"}`);
process.exit(fail ? 1 : 0);
