// Regression suite for D2C Media vdpJSON vehicle extraction.
// Run: node scripts/test-d2c-vdp.mjs
//
// Fixture 1 is trimmed from the real page (Okotoks Toyota, 2026 RAV4 PHEV GR
// Sport AWD, VIN JTM7ERAV1TD018440) -- specified in the gated-price-recovery
// memory 2026-08-15, still unbuilt when Vic hit the identical listing again
// 2026-08-22: the report showed "Not shown" / "we couldn't read an asking
// price" while window.__vdpJSON's own priceWithoutCustomFees held the real
// $85,995 the whole time, and the page's own visible text said "Call for
// pricing" over it -- a real dealer tactic, not a scrape failure.

import { extractD2cVdpVehicle, fillFromD2cVdp } from "../supabase/functions/_shared/d2c-vdp.js";

const page = (vdpJson, extra = "") => `<!doctype html><html><head></head><body>
<script>
window.__vdpJSON = ${JSON.stringify(vdpJson)};
</script>
${extra}
</body></html>`;

// 1. Real shape, trimmed to the fields the extractor reads.
const REAL = {
  id: 14218449, sn: "260416-new", niv: "JTM7ERAV1TD018440",
  make: { basic: "Toyota" }, model: { basic: "RAV4 Plug-In Hybrid" },
  version: { basic: "Phev Gr Sport Awd" }, year: "2026", km: "",
  drivetrain: "Four-wheel drive", isNew: 1, isDemo: 0, isCertified: false,
  addresses: { dealer: "Okotoks Toyota", phone: "403 652-1365" },
  prices: {
    price: "", fullPrice: "", priceInteger: "", fullPriceInteger: "",
    originalPriceWithoutCustomFees: "$85,995", priceWithoutCustomFees: "$85,995",
    messages: { message: "Call for pricing", fullPrice: "", currentPrice: "", rebatePrice: "" },
  },
};

// 2. A discounted unit on the same platform -- original/current DIVERGE, and
// the page is NOT gated (a plain "Call for pricing" phrase never appears).
const DISCOUNTED = {
  niv: "1FTEW1EP0KKD12345", sn: "N001", make: { basic: "Ford" }, model: { basic: "F-150" },
  version: { basic: "Lariat" }, year: "2025", km: "42000", isNew: 0, isDemo: 0, isCertified: true,
  addresses: { dealer: "Example Motors", phone: "" },
  prices: { price: "$52,995", fullPrice: "$52,995", originalPriceWithoutCustomFees: "$54,995", priceWithoutCustomFees: "$52,995",
    messages: { message: "", fullPrice: "", currentPrice: "", rebatePrice: "" } },
};

// 3. Genuinely gated with NOTHING recoverable (the Red Deer Toyota case from
// the same memory) -- every price field truly empty, not just the display
// ones. Must return quotedPrice: null, never fabricate a number.
const TRULY_EMPTY = {
  niv: "5TDZA23C10S123456", make: { basic: "Toyota" }, model: { basic: "RAV4 Plug-In Hybrid" },
  version: { basic: "XSE" }, year: "2026",
  prices: { price: "", fullPrice: "", originalPriceWithoutCustomFees: "", priceWithoutCustomFees: "",
    messages: { message: "Call for pricing", fullPrice: "", currentPrice: "", rebatePrice: "" } },
};

// 4. No vehicle-identifying data at all (a non-VDP page loading the same script).
const NO_VEHICLE = { settings: {} };

// 5. A GATED USED unit. The Google Vehicle Ads corroboration the report copy
// cites is a NEW-vehicle requirement (Google mandates a real, all-in price on
// those). On used/CPO the premise does not hold, so the extractor must NOT
// authorise that sentence -- otherwise the report asserts a corroboration
// nothing checked (claims-must-stay-backed).
const GATED_USED = {
  niv: "2T3H1RFV8LC123456", sn: "U778", make: { basic: "Toyota" }, model: { basic: "RAV4" },
  version: { basic: "XLE AWD" }, year: "2022", km: "61000", isNew: 0, isDemo: 0, isCertified: true,
  addresses: { dealer: "Example Toyota", phone: "" },
  prices: { price: "", fullPrice: "", originalPriceWithoutCustomFees: "$38,995", priceWithoutCustomFees: "$38,995",
    messages: { message: "Call for pricing", fullPrice: "", currentPrice: "", rebatePrice: "" } },
};

const CASES = [
  ["real Okotoks Toyota shape -- gated display, real price recovered",
    page(REAL),
    { year: 2026, make: "Toyota", model: "RAV4 Plug-In Hybrid", trim: "Phev Gr Sport Awd", vin: "JTM7ERAV1TD018440",
      stockNumber: "260416-new", odometerKm: null, condition: "new", quotedPrice: 85995,
      priceGated: true, priceGateMessage: "Call for pricing", drivetrain: "Four-wheel drive",
      dealerName: "Okotoks Toyota", dealerPhone: "403 652-1365" }],
  ["discounted unit, not gated -- current price wins over original, priceGated false",
    page(DISCOUNTED),
    { vin: "1FTEW1EP0KKD12345", quotedPrice: 52995, odometerKm: 42000, condition: "used", priceGated: false }],
  ["genuinely empty price fields -- quotedPrice null, priceGated false (nothing to tag)",
    page(TRULY_EMPTY),
    { quotedPrice: null, priceGated: false }],
  ["gated NEW unit may cite the Google vehicle-ads corroboration",
    page(REAL),
    { priceGated: true, googleAdsCorroborated: true }],
  ["gated USED/CPO unit recovers the price but must NOT cite Google vehicle ads",
    page(GATED_USED),
    { quotedPrice: 38995, priceGated: true, googleAdsCorroborated: false, condition: "used" }],
  ["no vehicle data -> null", page(NO_VEHICLE), null],
  ["no __vdpJSON at all -> null", "<html><body>nothing here</body></html>", null],
  ["malformed JSON after the marker doesn't throw", "<script>window.__vdpJSON = {oops not json</script>", null],
];

let pass = 0, fail = 0;
for (const [label, html, want] of CASES) {
  let got;
  try { got = extractD2cVdpVehicle(html); } catch (e) { got = "THREW: " + e.message; }
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

// fillFromD2cVdp: the scrapfly.ts vision-rescue merge, same fill-only
// contract as fillFromConvertusVms -- never clobbers a real parsed value.
const dvReal = extractD2cVdpVehicle(page(REAL));
const FILL_CASES = [
  ["vision returned nothing -> vdpJSON carries the whole rescue",
    {}, dvReal,
    { quotedPrice: 85995, quotedPriceSource: "d2c_vdp", priceGatedButRecovered: true, priceGateMessage: "Call for pricing",
      vin: "JTM7ERAV1TD018440", year: 2026, make: "Toyota", model: "RAV4 Plug-In Hybrid", trim: "Phev Gr Sport Awd" }],
  ["a real parsed price is never clobbered, nor tagged with a source/gate note it didn't earn",
    { quotedPrice: 41000 }, dvReal,
    { quotedPrice: 41000, quotedPriceSource: undefined, priceGatedButRecovered: undefined }],
  ["a zero/falsy parsed price IS replaced (bad vision read, not a real $0 listing)",
    { quotedPrice: 0 }, dvReal,
    { quotedPrice: 85995 }],
  ["existing fields are left alone, only blanks fill in",
    { vin: "1FTEW1EP0KKD00000", vehicle: "Real Vehicle String" }, dvReal,
    { vin: "1FTEW1EP0KKD00000", vehicle: "Real Vehicle String" }],
  ["a gated NEW unit sets the google-backed flag on the analysis",
    {}, dvReal,
    { priceGatedButRecovered: true, priceGateGoogleAdsBacked: true }],
  ["a gated USED unit fills the price but leaves the google-backed flag FALSE",
    {}, extractD2cVdpVehicle(page(GATED_USED)),
    { quotedPrice: 38995, priceGatedButRecovered: true, priceGateGoogleAdsBacked: false }],
  ["null dv is a no-op", { quotedPrice: 41000 }, null, { quotedPrice: 41000 }],
];
for (const [label, parsed, dv, want] of FILL_CASES) {
  let got;
  try { got = fillFromD2cVdp(parsed, dv); } catch (e) { got = "THREW: " + e.message; }
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
