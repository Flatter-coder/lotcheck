// Regression suite for Convertus vmsData vehicle extraction.
// Run: node scripts/test-convertus-vms.mjs
//
// Fixture 1 is trimmed straight from a real page (southtrailkia.com,
// 2026-08-13): a report on this exact listing showed "Price vs MSRP: Not
// shown" and fell back to a generic $28,495 base-trim MSRP, while the page's
// own vmsData.vehicle carried msrp:43780, asking_price:47509 (a real
// $3,729-over-MSRP unit) plus VIN and full identity the whole time --
// unreadable because Nimble's markdown and this file's own direct-fetch text
// view both drop <script> content, so nothing upstream ever looked here.

import { extractConvertusVmsVehicle, fillFromConvertusVms } from "../supabase/functions/_shared/convertus-vms.js";

const page = (vmsDataJson, extra = "") => `<!doctype html><html><head></head><body>
<script>
  // The real page mentions vmsData dozens of times in unrelated template
  // strings BEFORE the actual declaration -- confirmed live: the naive "find
  // the first 'vmsData' substring" approach grabbed one of these instead and
  // silently returned null. Every fixture below reproduces that ordering.
  var errorTemplate = \`Sorry, \${vmsData.vehicle.year} \${vmsData.vehicle.make} \${vmsData.vehicle.model} is unavailable.\`;
  var vmsData = ${JSON.stringify(vmsDataJson)};
</script>
${extra}
</body></html>`;

// 1. Real shape, trimmed to the fields the extractor reads (southtrailkia.com).
const REAL = {
  vehicle: {
    vehicle_id: 10882406,
    vin: "KNDEECD79V7043640",
    ad_id: "70665878",
    stock_number: "N043640",
    sale_class: "New",
    year: 2027,
    make: "Kia",
    model: "Seltos",
    trim: "X-Line Limited AWD",
    search_trim: "X-Line Limited",
    odometer: 6,
    msrp: 43780,
    asking_price: 47509,
    internet_price: 47509,
    company_data: {
      company_name: "South Trail Kia",
      company_city: "Calgary",
      company_province: "AB",
      company_sales_phone: "(888)622-5154",
    },
  },
};

// 2. Used vehicle -- sale_class differs, no trim field (search_trim only).
const USED = {
  vehicle: {
    vin: "1FTEW1EP0KKD12345",
    sale_class: "Used",
    year: 2022,
    make: "Ford",
    model: "F-150",
    search_trim: "Lariat",
    odometer: 42000,
    msrp: 0,
    asking_price: 38995,
    internet_price: 38995,
    company_data: { company_name: "Example Motors", company_city: "Red Deer", company_province: "AB" },
  },
};

// 3. No vehicle key at all (a non-VDP page that still loads the same script).
const NO_VEHICLE = { settings: {}, translation: {} };

// 4. asking_price and internet_price DIVERGE (albertahonda.com, 2026-08-13):
// asking_price duplicated msrp exactly (the pre-discount sticker) while
// internet_price carried the dealer's own stated "$2500 Manager Discount"
// price -- matching what the page actually displayed to a buyer. Picking
// asking_price first (the original assumption, based only on a page where
// the two fields happened to be equal) silently reported the buyer's own
// MSRP back to them as the asking price, hiding the real discount.
const DISCOUNTED = {
  vehicle: {
    vin: "1HGCY2F83SA802118",
    stock_number: "5AC2118",
    sale_class: "New",
    year: 2025,
    make: "Honda",
    model: "Accord Hybrid",
    trim: "Touring eCVT",
    odometer: 15,
    msrp: 51422,
    asking_price: 51422,
    sale_price: 0,
    internet_price: 48922,
    retail_price: 47197, // must NOT win -- reference figure, not an ask
    company_data: { company_name: "Alberta Honda", company_city: "EDMONTON", company_province: "AB", company_sales_phone: "(780) 474-8595" },
  },
};

// 5. Financing rate + pricing fine print (albertahonda.com, 2026-08-14): a
// report showed "Financing APR: Not shown" and no disclaimer captured, while
// the page headlined "6.69% for 96 Months" and carried a full Alberta Winter
// Package fine-print paragraph -- both in vmsData.vehicle.finance[]/
// description, neither visible to the scrape/Claude pass, same root cause as
// price/VIN. finance[] has no "default" marker; the longest term (lowest
// biweekly payment) is what the page's own widget features, confirmed
// against the real page.
const WITH_FINANCE = {
  vehicle: {
    vin: "2HGFE4F83TH013665",
    stock_number: "6CI3665",
    sale_class: "New",
    year: 2026,
    make: "Honda",
    model: "Civic Sedan",
    trim: "Sport eCVT",
    odometer: 5,
    msrp: 36605,
    asking_price: 36605,
    internet_price: 36605,
    finance: [
      { finance_term: "12", finance_rate: "2.99" },
      { finance_term: "60", finance_rate: "4.49" },
      { finance_term: "96", finance_rate: "6.69" }, // longest -> the one to report
    ],
    description: "<p>New Vehicles come with Alberta Winter Package which may contain any/all of the following: Lifetime Oil Change, Rust + Undercoat, Block Heater, Mud Flaps, Locking Nuts, and Paint Protection.</p>",
    company_data: { company_name: "Alberta Honda", company_city: "EDMONTON", company_province: "AB", company_sales_phone: "(780) 474-8595" },
  },
};

const CASES = [
  ["real southtrailkia.com shape",
    page(REAL),
    { year: 2027, make: "Kia", model: "Seltos", trim: "X-Line Limited AWD", vin: "KNDEECD79V7043640", odometerKm: 6, condition: "new", msrp: 43780, quotedPrice: 47509, dealerName: "South Trail Kia", dealerCity: "Calgary, AB" }],
  ["used vehicle, msrp 0 -> null, falls back to search_trim",
    page(USED),
    { year: 2022, make: "Ford", model: "F-150", trim: "Lariat", condition: "used", msrp: null, quotedPrice: 38995, odometerKm: 42000 }],
  ["real albertahonda.com shape -- asking_price=msrp (sticker), internet_price is the real discounted ask",
    page(DISCOUNTED),
    { year: 2025, make: "Honda", model: "Accord Hybrid", trim: "Touring eCVT", vin: "1HGCY2F83SA802118", msrp: 51422, quotedPrice: 48922, dealerName: "Alberta Honda", dealerCity: "EDMONTON, AB" }],
  ["financing rate picks the longest term, fine print captured verbatim",
    page(WITH_FINANCE),
    { financeApr: 6.69, financeTermMonths: 96, finePrint: "New Vehicles come with Alberta Winter Package which may contain any/all of the following: Lifetime Oil Change, Rust + Undercoat, Block Heater, Mud Flaps, Locking Nuts, and Paint Protection." }],
  ["no vehicle key -> null",
    page(NO_VEHICLE),
    null],
  ["no vmsData at all -> null",
    "<html><body>nothing here</body></html>",
    null],
  ["template-literal mentions before the real declaration don't false-positive",
    // Same as case 1 but with several more vmsData.vehicle.* references ahead
    // of the declaration -- the exact shape that broke a naive first-match.
    page(REAL, "<script>console.log(`${vmsData.vehicle.trim} at ${vmsData.vehicle.company_data.company_name}`);</script>"),
    { vin: "KNDEECD79V7043640", quotedPrice: 47509 }],
  ["malformed JSON after the marker doesn't throw",
    "<script>var vmsData = {oops not json</script>",
    null],
];

let pass = 0, fail = 0;
for (const [label, html, want] of CASES) {
  let got;
  try { got = extractConvertusVmsVehicle(html); } catch (e) { got = "THREW: " + e.message; }
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

// fillFromConvertusVms: the scrapfly.ts vision-rescue merge. Exists for a
// Convertus page with NO schema.org JSON-LD at all -- confirmed live,
// 2026-08-14 (albertahonda.com Civic Sedan): the rescue's own vision/text
// pass came back with nothing usable, and there was no JSON-LD to fall back
// on either, so vmsData had to carry the whole rescue.
const cvReal = extractConvertusVmsVehicle(page(WITH_FINANCE));
const FILL_CASES = [
  ["vision returned nothing -> vmsData carries the whole rescue",
    {}, cvReal,
    { quotedPrice: 36605, msrp: 36605, vin: "2HGFE4F83TH013665", year: 2026, make: "Honda", model: "Civic Sedan", trim: "Sport eCVT", vehicle: "2026 Honda Civic Sedan Sport eCVT" }],
  // Confirmed live 2026-08-21 (albertahonda.com, 2026 Civic Sedan LX CVT): a
  // correctly-extracted $31,595 asking price never reached the report,
  // because (a) the MAIN scan path's own gap-fill loop in
  // analyze-listing-url/index.ts never included "quotedPrice" in its key
  // list at all, and (b) even here, filling quotedPrice never tagged a
  // source -- so priceVerified's already-existing `src === "convertus_vms"`
  // check could never fire for a price this function filled. (a) isn't
  // reachable from this file (it's inline in the edge function, not
  // exported); this pins (b), the shared half of the same bug class.
  ["quotedPrice fill also tags quotedPriceSource as convertus_vms",
    {}, cvReal,
    { quotedPrice: 36605, quotedPriceSource: "convertus_vms" }],
  ["a real parsed price is never clobbered by a differing vmsData price, nor does it inherit a source tag it didn't earn",
    { quotedPrice: 41000 }, cvReal,
    { quotedPrice: 41000, quotedPriceSource: undefined }],
  ["a zero/falsy parsed price IS replaced (bad vision read, not a real $0 listing)",
    { quotedPrice: 0 }, cvReal,
    { quotedPrice: 36605 }],
  ["financing rate fills in when parsed has none",
    {}, cvReal,
    { financing: { rate: 6.69, termMonths: 96, source: "convertus_vms" } }],
  ["a page-stated financing rate is never overwritten",
    { financing: { rate: 3.99, termMonths: 48 } }, cvReal,
    { financing: { rate: 3.99, termMonths: 48 } }],
  ["existing fields are left alone, only blanks fill in",
    { vin: "1FTEW1EP0KKD00000", vehicle: "Real Vehicle String" }, cvReal,
    { vin: "1FTEW1EP0KKD00000", vehicle: "Real Vehicle String" }],
  ["null cv is a no-op", { quotedPrice: 41000 }, null, { quotedPrice: 41000 }],
];
for (const [label, parsed, cv, want] of FILL_CASES) {
  let got;
  try { got = fillFromConvertusVms(parsed, cv); } catch (e) { got = "THREW: " + e.message; }
  let ok, detail = "";
  if (!got || typeof got !== "object") { ok = false; detail = ` got ${JSON.stringify(got)}`; }
  else {
    const bad = Object.entries(want).filter(([k, v]) => JSON.stringify(got[k]) !== JSON.stringify(v));
    ok = bad.length === 0;
    detail = ok ? "" : ` mismatched: ${bad.map(([k, v]) => `${k} want ${JSON.stringify(v)} got ${JSON.stringify(got[k])}`).join("; ")}`;
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail}`);
  ok ? pass++ : fail++;
}

console.log(`\n${pass}/${pass + fail} passed${fail ? "  -- FAILING" : "  all green"}`);
process.exit(fail ? 1 : 0);
