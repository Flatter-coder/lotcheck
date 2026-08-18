// Regression suite for the jsonld_itemlist and edealer inventory sources.
// Fixtures are trimmed real captures (Wolfe Chevrolet f/k/a Westgate Chev,
// Village Honda, Rainbow Ford -- all confirmed live 2026-08-18, read with the
// same honest User-Agent crawl-alberta-inventory.mjs uses), not hand-invented
// shapes, so a real theme/platform change is what would break these, not a
// guess about the format. This file itself makes no network request.
//
// Run: node scripts/test-structured-inventory.mjs
import {
  extractJsonLdVehicles, normalizeJsonLdCar, discoverCategoryPages, findNextPage,
  extractVehicleArrayText, extractEdealerVehicles, normalizeEdealerVehicle,
} from "./lib/structured-inventory.mjs";

let pass = 0, fail = 0;
function check(label, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "\n        " + detail}`);
  cond ? pass++ : fail++;
}

// ---- jsonld_itemlist -------------------------------------------------------

// Real shape from wolfechevrolet.com/inventory/new-chevrolet-silverado_1500/
// (2 of the 20 real entries; numberOfItems left at the page's real total to
// confirm the parser counts itemListElement, not that field).
const WOLFE_PAGE = `<html><body>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
  {"@type":"WebSite","@id":"x"},
  {"@type":"ItemList","url":"https://www.wolfechevrolet.com/inventory/new-chevrolet-silverado_1500/","numberOfItems":20,"itemListElement":[
    {"@type":"ListItem","position":1,"url":"/inventory/New-2026-Chevrolet-Silverado_1500-Custom-3GCPKBEK5TG457434/","item":{"@type":"Car","name":"2026 Chevrolet Silverado 1500 Custom","vehicleIdentificationNumber":"3GCPKBEK5TG457434","brand":{"@type":"Brand","name":"Chevrolet"},"model":"Silverado 1500","modelDate":"2026","offers":{"@type":"Offer","price":55045,"priceCurrency":"CAD"}}},
    {"@type":"ListItem","position":2,"url":"/inventory/Demo-2026-Chevrolet-Silverado_1500-LT-1GCUKDEDXTZ337502/","item":{"@type":"Car","name":"2026 Chevrolet Silverado 1500 LT","vehicleIdentificationNumber":"1GCUKDEDXTZ337502","brand":{"@type":"Brand","name":"Chevrolet"},"model":"Silverado 1500","modelDate":"2026","offers":{"@type":"Offer","price":56869,"priceCurrency":"CAD"}}}
  ]}
]}</script>
<a href="/inventory/new-chevrolet-blazer/">Blazer</a>
<a href="/inventory/new-chevrolet-equinox/">Equinox</a>
<a href="/inventory/new-chevrolet-silverado_1500-page-2/">Page 2</a>
<a href="/inventory/new/">All new</a>
<link rel="next" href="https://www.wolfechevrolet.com/inventory/new-chevrolet-silverado_1500-page-2/" />
</body></html>`;

let rows = extractJsonLdVehicles(WOLFE_PAGE, "new");
check("extracts every Car in the ItemList", rows.length === 2, `got ${rows.length}`);
check("VIN comes through untouched", rows[0].vin === "3GCPKBEK5TG457434", `got ${rows[0].vin}`);
check("year parsed from modelDate", rows[0].year === 2026, `got ${rows[0].year}`);
check("make from brand.name", rows[0].make === "Chevrolet", `got ${rows[0].make}`);
check("trim isolated from the composed name", rows[0].trim === "Custom", `got ${JSON.stringify(rows[0].trim)}`);
check("second row's trim isolates a two-word grade", rows[1].trim === "LT", `got ${JSON.stringify(rows[1].trim)}`);
check("list_price and sale_price both take offers.price (no markdown signal in this shape)",
  rows[0].list_price === 55045 && rows[0].sale_price === 55045, `got ${JSON.stringify(rows[0])}`);
check("msrp stays null -- filled by trim-match, not asserted here", rows[0].msrp === null, `got ${rows[0].msrp}`);
check("condition comes from the page section passed in, not guessed", rows[0].condition === "new", `got ${rows[0].condition}`);

check("category-page discovery finds model links, excludes pagination and the /new/ index",
  (() => {
    const found = discoverCategoryPages(WOLFE_PAGE, "https://www.wolfechevrolet.com");
    return found.includes("https://www.wolfechevrolet.com/inventory/new-chevrolet-blazer/")
      && found.includes("https://www.wolfechevrolet.com/inventory/new-chevrolet-equinox/")
      && !found.some((u) => u.includes("-page-2"))
      && !found.includes("https://www.wolfechevrolet.com/inventory/new/");
  })(), JSON.stringify(discoverCategoryPages(WOLFE_PAGE, "https://www.wolfechevrolet.com")));

check("rel=next pagination link is found", findNextPage(WOLFE_PAGE) === "https://www.wolfechevrolet.com/inventory/new-chevrolet-silverado_1500-page-2/",
  `got ${findNextPage(WOLFE_PAGE)}`);
check("no rel=next on a last/only page returns null", findNextPage("<html><body>no next here</body></html>") === null, "expected null");

// Real shape difference: villagehonda.com's ItemList carries no numberOfItems
// field at all -- the parser must count itemListElement, never read that field.
const VILLAGE_PAGE = `<script type="application/ld+json">{"@type":"ItemList","itemListElement":[
  {"@type":"ListItem","position":1,"item":{"@type":"Car","brand":{"@type":"Brand","name":"Honda"},"model":"Civic Sedan","offers":{"@type":"Offer","price":32793},"vehicleIdentificationNumber":"2HGFE2F22TH115474","vehicleModelDate":2026}}
]}</script>`;
rows = extractJsonLdVehicles(VILLAGE_PAGE, "new");
check("ItemList without numberOfItems still parses (count itemListElement, not that field)",
  rows.length === 1 && rows[0].vin === "2HGFE2F22TH115474", `got ${JSON.stringify(rows)}`);

// Real quirk confirmed live on villagehonda.com 2026-08-18: itemListElement
// is nested one array deeper than the ItemList spec. My first attempt at this
// parser passed every fixture test but returned 0 rows against the real
// captured page -- caught only by testing against the actual HTML, not just
// a hand-trimmed shape of it.
const VILLAGE_DOUBLE_NESTED = `<script type="application/ld+json">{"@type":"ItemList","itemListElement":[[
  {"@type":"ListItem","position":1,"item":{"@type":"Car","brand":{"@type":"Brand","name":"Honda"},"model":"Civic Sedan","offers":{"@type":"Offer","price":32793},"vehicleIdentificationNumber":"2HGFE2F22TH115474","vehicleModelDate":2026}}
]]}</script>`;
rows = extractJsonLdVehicles(VILLAGE_DOUBLE_NESTED, "new");
check("double-nested itemListElement (the site's own quirk) still extracts, not silently 0",
  rows.length === 1 && rows[0].vin === "2HGFE2F22TH115474", `got ${JSON.stringify(rows)}`);

check("malformed ld+json block is skipped, not thrown", (() => {
  try { return extractJsonLdVehicles(`<script type="application/ld+json">{not json</script>`, "new").length === 0; }
  catch { return false; }
})(), "threw instead of returning []");

check("invalid VIN excluded, not just passed through", normalizeJsonLdCar({
  vehicleIdentificationNumber: "TOOSHORT", brand: { name: "Honda" }, model: "Civic", offers: { price: 30000 },
}, "new") === null, "expected null for an invalid VIN");

// ---- edealer ---------------------------------------------------------------

// Real shape from rainbowford.ca (2 of 9 real entries, unrelated fields
// trimmed -- confirms the parser tolerates a real object's full field count,
// not just a minimal hand-built fixture).
const RAINBOW_PAGE = `<html><body><script type="text/javascript">
    var isOldIE = false;
    var edealerWebsiteId = 3084;
    var dealerName = 'Rainbow Ford Sales';
    var vehicleArray = [];
    vehicleArray = {"15093600":{"vehicleId":"15093600","dealerName":"Rainbow Ford Sales","status":"1","vin":"1FMEE7BH3TLA91203","stockNum":"26S025","year":"2026","make":"Ford","model":"Bronco","trim":"Big Bend","trimOptionOriginal":"Big Bend 4dr 4x4","OriginalPrice":44290,"OriginalMSRP":44290,"msrp_total":40355,"mileage":"10","condition":"New","demo":"0","age":"107","description":"a description with a stray brace } and semicolon; inside it"},
    "15318391":{"vehicleId":"15318391","dealerName":"Rainbow Ford Sales","status":"1","vin":"BADVIN","stockNum":"26S030","year":"2026","make":"Ford","model":"Bronco","trim":"Outer Banks","OriginalPrice":51000,"OriginalMSRP":51000,"mileage":"5","condition":"New","demo":"0"}};
    var otherVar = "after the array, should not affect extraction";
</script></body></html>`;

rows = extractEdealerVehicles(RAINBOW_PAGE);
check("extracts vehicles keyed by id, stops at the true closing brace despite a stray } and ; inside a description",
  rows.length === 1, `got ${rows.length}: ${JSON.stringify(rows)}`);
check("real vin/year/make/model/trim fields used directly, no string-splitting", rows[0] && rows[0].trim === "Big Bend" && rows[0].make === "Ford",
  JSON.stringify(rows[0]));
check("second entry's invalid VIN excluded from the batch (one bad vehicle doesn't drop the page)",
  !rows.some((r) => r.stock_no === "26S030"), JSON.stringify(rows));
check("OriginalPrice becomes list_price; msrp stays null (same posture as jsonld_itemlist)",
  rows[0].list_price === 44290 && rows[0].msrp === null, JSON.stringify(rows[0]));
check("odometer parsed from the mileage string", rows[0].odometer_km === 10, `got ${rows[0].odometer_km}`);
check("demo flag normalized from a \"0\"/\"1\" string to boolean", rows[0].demo === false, `got ${rows[0].demo}`);

check("page with no vehicleArray marker returns [] (not this platform, or shape changed) rather than throwing",
  extractEdealerVehicles("<html><body>no vehicleArray here</body></html>").length === 0, "expected []");

check("a truncated fetch (array never closes) returns null text rather than a half-parsed guess",
  extractVehicleArrayText(`<script>var vehicleArray = {"1":{"vin":"X"`) === null, "expected null on unterminated object");

check("normalizeEdealerVehicle rejects an invalid VIN directly",
  normalizeEdealerVehicle({ vin: "SHORT", make: "Ford" }) === null, "expected null");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
