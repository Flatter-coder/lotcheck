// Regression suite for published-price extraction.
// Run: node scripts/test-published-price.mjs
//
// The failure this guards against is the one that corrupted the catalog: taking
// a number that is NOT the advertised sticker and storing it as MSRP. So the
// rules under test are (a) only "starting at" figures count, (b) "as
// configured" configurator totals never do, (c) prose never becomes a trim name.

import { extractStartingPrices, toCatalogRows } from "./lib/published-price.mjs";

// Real shape from chevrolet.ca (rendered, 2026-08-11).
const GM = `
<div class="trim-card"><h3>LS</h3><span>Starting at: $40,042*</span><span>As configured: $46,188*</span></div>
<div class="trim-card"><h3>RS</h3><span>Starting at: $44,942*</span><span>As configured: $50,438*</span></div>
<div class="trim-card"><h3>Activ</h3><span>Starting at: $45,438*</span></div>`;

// Real shape from ford.ca models page (Vic's screenshot, 2026-08-11).
const FORD = `
<div><h2>Mustang Mach-E® Select</h2><p>Starting at $45,778<sup>1</sup></p></div>
<div><h2>Mustang Mach-E® Premium</h2><p>Starting at $47,638<sup>1</sup></p></div>
<div><h2>Mustang Mach-E® GT</h2><p>Starting at $62,878<sup>1</sup></p></div>`;

// The REAL noise these pages produced on 2026-08-11: nav chrome and section
// headings landed in trim names ("Price RS", "Learn More Models LT"), and the
// Buick pages cross-linked the rest of the lineup so another model's price was
// nearly stored under this one.
const NOISY = `
<h2>2027 EQUINOX</h2><span>Starting at: $40,042*</span>
<a>Learn More</a> Models <h3>LT</h3><span>Starting at: $40,042*</span>
<div>Price</div><h3>RS</h3><span>Starting at: $44,942*</span>
<div>Vehicle Details 2025</div><h3>Enclave</h3><span>Starting at: $63,942*</span>
<div>Small SUV</div><h3>Encore GX</h3><span>Starting at: $34,192*</span>`;

const CASES = [
  ["GM trim cards", GM, [{ trim: "LS", msrp: 40042 }, { trim: "RS", msrp: 44942 }, { trim: "Activ", msrp: 45438 }]],
  ["Ford models page", FORD, [{ msrp: 45778 }, { msrp: 47638 }, { msrp: 62878 }]],
  ["'As configured' alone is NEVER a price", `<div><h3>LT</h3><span>As configured: $46,188*</span></div>`, []],
  ["a lease payment is not an MSRP", `<div>Lease from $389/month</div>`, []],
  ["implausible figures rejected", `<div>Starting at $9,000</div><div>Starting at $999,999</div>`, []],
  ["no prices at all", `<div>Build &amp; Price</div>`, []],
];



let pass = 0, fail = 0;
for (const [label, html, want] of CASES) {
  let got;
  try { got = extractStartingPrices(html); } catch (e) { got = "THREW: " + e.message; }
  let ok = Array.isArray(got) && got.length === want.length;
  if (ok) {
    for (let i = 0; i < want.length; i++) {
      if (got[i].msrp !== want[i].msrp) ok = false;
      if (want[i].trim !== undefined && got[i].trim !== want[i].trim) ok = false;
    }
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  got ${JSON.stringify(got)}`}`);
  ok ? pass++ : fail++;
}

// Noise handling is checked separately because it needs lineup context.
const noisy = extractStartingPrices(NOISY, { model: "Equinox", otherModels: ["Enclave", "Encore GX", "Envista"] });
const noisyOk =
  noisy.every(r => !r.trim || /^(LT|RS)$/.test(r.trim)) &&      // nav words stripped
  noisy.some(r => r.trim === "LT" && r.msrp === 40042) &&
  noisy.some(r => r.trim === "RS" && r.msrp === 44942) &&
  !noisy.some(r => r.msrp === 63942 || r.msrp === 34192);        // other models dropped
console.log(`${noisyOk ? "PASS" : "FAIL"}  real page noise: headings stripped, other models dropped${noisyOk ? "" : "  got " + JSON.stringify(noisy)}`);
noisyOk ? pass++ : fail++;

// Rows must always carry provenance -- a published price with no page to point
// at is indistinguishable from the API figures that caused the corruption.
const rows = toCatalogRows({ year: 2027, make: "Chevrolet", model: "Equinox", url: "https://www.chevrolet.ca/en/suvs/equinox" }, extractStartingPrices(GM));
const provOk = rows.length === 3 && rows.every(r => r.source_url && Number.isInteger(r.msrp));
console.log(`${provOk ? "PASS" : "FAIL"}  every row carries source_url and a whole-dollar price`);
provOk ? pass++ : fail++;

console.log(`\n${pass}/${pass + fail} passed${fail ? "  -- FAILING" : "  all green"}`);
process.exit(fail ? 1 : 0);
