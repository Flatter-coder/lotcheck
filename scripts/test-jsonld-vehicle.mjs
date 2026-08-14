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

console.log(`\n${pass}/${pass + fail} passed${fail ? "  -- FAILING" : "  all green"}`);
process.exit(fail ? 1 : 0);
