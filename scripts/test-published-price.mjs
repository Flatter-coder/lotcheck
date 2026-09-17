// Regression suite for published-price extraction.
// Run: node scripts/test-published-price.mjs
//
// The failure this guards against is the one that corrupted the catalog: taking
// a number that is NOT the advertised sticker and storing it as MSRP. So the
// rules under test are (a) only "starting at" figures count, (b) "as
// configured" configurator totals never do, (c) prose never becomes a trim name.

import { extractStartingPrices, toCatalogRows, cleanTrim } from "./lib/published-price.mjs";

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

// ── A FAILED COMPUTATION ON THE MANUFACTURER'S OWN PAGE ────────────────
//
// On 2026-09-16 msrp_catalog held a 2026 Cadillac LYRIQ whose TRIM read
// "NaN 2026 LYRIQ". Nobody typed that: cadillaccanada.ca rendered a literal
// "NaN" where its own script failed to format a number, and this extractor took
// the nearest preceding text as the name. It shipped with a source_url, which
// means the refresh DELETE spared it -- it would have sat there indefinitely
// under a name no dealer and no buyer will ever write.
//
// THIS FILE ALREADY EXISTED AND WAS GREEN 8/8 WHEN THAT SHIPPED, because it was
// wired into nothing and never ran in CI. It is in gates.yml now.
const NAN_PAGE = `
<h2>2026 LYRIQ</h2><div>NaN</div><span>Starting at: $74,042*</span>
<h3>Sport</h3><span>Starting at: $79,042*</span>`;
const nanRows = extractStartingPrices(NAN_PAGE, { model: "LYRIQ" });
// The artifact card is dropped ENTIRELY -- price included. A null trim would not
// do: this file writes through an upsert keyed on (year, make, model, trim), and
// a NULL never conflicts, so an untrimmed row inserts a fresh copy every run.
// That is how the 2027 Chevrolet Trax reached three identical rows.
const nanOk = !nanRows.some((r) => String(r.trim || "").toLowerCase().includes("nan"))
  && !nanRows.some((r) => r.msrp === 74042)
  && nanRows.some((r) => r.trim === "Sport" && r.msrp === 79042);
console.log(`${nanOk ? "PASS" : "FAIL"}  a NaN card is dropped, the sound card beside it survives${nanOk ? "" : "  got " + JSON.stringify(nanRows)}`);
nanOk ? pass++ : fail++;

// Every artifact shape, and the sound readings that must NOT be mistaken for one.
const artifactOk = ["NaN", "undefined", "null", "N/A", "TBD", "Infinity"]
    .every((a) => cleanTrim(`${a} 2026 LYRIQ`, "LYRIQ").artifact === true)
  && ["Luxury", "Sport", "LT", "RS"].every((t) => cleanTrim(t, "LYRIQ").artifact === false);
console.log(`${artifactOk ? "PASS" : "FAIL"}  artifact words refuse, real trim names do not`);
artifactOk ? pass++ : fail++;

// NOISE IS STRIPPED FROM ANYWHERE, NOT JUST THE ENDS. The old code shift()ed from
// the front and pop()ed from the back, so a noise word with real words on both
// sides survived -- which is why "2026" stayed in the middle of the stored LYRIQ
// name. A model year is never part of a trim wherever it sits, and the model is
// not a trim of itself.
const midOk = cleanTrim("Luxury 2026 LYRIQ", "LYRIQ").trim === "Luxury"
  && cleanTrim("2026 LYRIQ", "LYRIQ").trim === null
  && cleanTrim("Sport", "LYRIQ").trim === "Sport";
console.log(`${midOk ? "PASS" : "FAIL"}  a model year and the model name are stripped from anywhere in the name`);
midOk ? pass++ : fail++;

console.log(`\n${pass}/${pass + fail} passed${fail ? "  -- FAILING" : "  all green"}`);
process.exit(fail ? 1 : 0);
