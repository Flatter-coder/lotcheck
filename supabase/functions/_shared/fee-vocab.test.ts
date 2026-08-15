// Quote-Data Flywheel regression harness. Run BEFORE any change to fee-vocab.ts.
// It exercises the EXACT code that ships — normalizeFeeLabel(), dealerId() and
// buildFeeObservations() are imported, not copied — so a regression fails here
// instead of silently poisoning the moat's benchmarks or leaking an identifier.
//
// Why this file is load-bearing (see quote-data-flywheel-scope.md):
//   • fee_label values are the JOIN KEYS for every downstream benchmark. If the
//     normalizer misclassifies a real dealer fee, every percentile built on it is
//     wrong — a correctness failure that must stay LOUD, never silent
//     (no-single-point-of-failure).
//   • buildFeeObservations() is the one place the "nothing identifying is stored"
//     promise is enforced in code. Part C asserts the projection can ONLY ever
//     emit the seven de-identified fields — so if a future edit to the analysis
//     object (a VIN, an odometer, a buyer name, a trim) ever flows through, this
//     test fails instead of the leak reaching prod (make-it-dispute-proof,
//     always-check-legally-clear).
//
// Run (Node 24+, from repo root):
//   node --experimental-strip-types supabase/functions/_shared/fee-vocab.test.ts
// Exit 0 = all pass; 1 = a failure (wire into gates.yml before edge deploys).
import { normalizeFeeLabel, dealerId, buildFeeObservations } from "./fee-vocab.ts";

let pass = 0, fail = 0;
const fails: string[] = [];
const ok = (cond: boolean, label: string) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; fails.push(label); console.log(`  ✗ ${label}`); }
};

// ── Part A: fee vocabulary — real Canadian dealer fee names → controlled label ─
// Every label here is a JOIN KEY. Keep these stable; add rows as new fee names
// are seen in the FLYWHEEL_LOG output. Left = raw as it appears on a quote.
console.log("\n── normalizeFeeLabel (controlled vocabulary / join keys) ──");
const VOCAB: Array<[string, string]> = [
  // documentation
  ["Documentation Fee", "documentation"],
  ["Doc Fee", "documentation"],
  ["DOC", "documentation"],
  ["Dealer Documentation Charge", "documentation"],
  // admin
  ["Administration Fee", "admin"],
  ["Admin Fee", "admin"],
  ["Dealer Administration", "admin"],
  // freight / PDI
  ["Freight", "freight_pdi"],
  ["PDI", "freight_pdi"],
  ["Pre-Delivery Inspection", "freight_pdi"],
  ["Freight & PDI", "freight_pdi"],
  ["Destination Charge", "freight_pdi"],
  ["Transport", "freight_pdi"],
  // levies / taxes
  ["Tire Levy", "levy_tax"],
  ["Tire Recycling Fee", "levy_tax"],
  ["Environmental Fee", "levy_tax"],
  ["Green Levy", "levy_tax"],
  ["Luxury Tax", "levy_tax"],
  ["Excise Tax", "levy_tax"],
  ["A/C Tax", "levy_tax"],
  ["AC Tax", "levy_tax"],
  ["Air Conditioning Tax", "levy_tax"],       // blind spot candidate
  // nitrogen
  ["Nitrogen", "nitrogen"],
  ["N2 Fill", "nitrogen"],
  ["Nitrogen Tire Fill", "nitrogen"],
  // market adjustment
  ["Market Adjustment", "market_adjustment"],
  ["Additional Dealer Markup", "market_adjustment"],
  ["ADM", "market_adjustment"],
  ["Dealer Mark-up", "market_adjustment"],
  ["Market Value Adjustment", "market_adjustment"],  // blind spot candidate
  // reconditioning
  ["Reconditioning", "reconditioning"],
  ["Recon Fee", "reconditioning"],
  // protection package
  ["Paint Protection", "protection_pkg"],
  ["Fabric Protection", "protection_pkg"],
  ["Ceramic Coating", "protection_pkg"],
  ["Appearance Package", "protection_pkg"],
  // rustproofing
  ["Rustproofing", "rustproofing"],
  ["Undercoating", "rustproofing"],
  ["Corrosion Protection", "rustproofing"],
  // tire & wheel
  ["Tire & Wheel Protection", "tire_wheel"],
  ["Road Hazard", "tire_wheel"],
  ["Wheel and Tire", "tire_wheel"],
  // theft
  ["Theft Protection", "theft_protection"],
  ["VIN Etch", "theft_protection"],
  ["Window Etching", "theft_protection"],
  ["Anti-Theft", "theft_protection"],
  // gap
  ["GAP Insurance", "gap"],
  ["Guaranteed Asset Protection", "gap"],
  // extended warranty
  ["Extended Warranty", "extended_warranty"],
  ["Service Contract", "extended_warranty"],
  ["Protection Plan", "extended_warranty"],
  ["Mechanical Breakdown Insurance", "extended_warranty"],
  // regulatory
  ["AMVIC Fee", "regulatory"],
  ["OMVIC", "regulatory"],
  ["Registration", "regulatory"],
  ["Licence Fee", "regulatory"],
  ["Licensing", "regulatory"],                // blind spot candidate
  // accessories
  ["Block Heater", "accessories"],
  ["Wheel Locks", "accessories"],
  ["Floor Mats", "accessories"],
  // delivery / prep
  ["Dealer Prep", "delivery_prep"],
  ["Dealer Preparation", "delivery_prep"],
];
for (const [raw, expect] of VOCAB) {
  const got = normalizeFeeLabel(raw);
  ok(got === expect, `"${raw}" -> ${JSON.stringify(got)}${got === expect ? "" : ` (expected ${JSON.stringify(expect)})`}`);
}

// Empty / junk handling.
console.log("\n── normalizeFeeLabel (edge inputs) ──");
ok(normalizeFeeLabel("") === "unlabeled", `"" -> unlabeled`);
ok(normalizeFeeLabel(null) === "unlabeled", `null -> unlabeled`);
ok(normalizeFeeLabel(undefined) === "unlabeled", `undefined -> unlabeled`);
ok(normalizeFeeLabel("Zorblax Surcharge") === "other", `unknown -> other`);

// ── Part B: dealerId — stable, case-insensitive, non-reversible, business-only ─
console.log("\n── dealerId (opaque, stable, non-reversible) ──");
const a1 = dealerId("Calgary Hyundai", "Calgary");
const a2 = dealerId("  calgary hyundai ", "  CALGARY ");
ok(a1 === a2, `same name+city (any case/space) -> same id`);
ok(a1 !== dealerId("Calgary Hyundai", "Edmonton"), `different city -> different id`);
ok(a1 !== dealerId("Calgary Kia", "Calgary"), `different name -> different id`);
ok(/^d_[0-9a-f]{8}$/.test(a1), `id is opaque hash form (${a1})`);
ok(!a1.toLowerCase().includes("hyundai") && !a1.toLowerCase().includes("calgary"), `id does not embed the source string`);
ok(dealerId("", "") === "unknown", `empty -> "unknown"`);

// ── Part C: buildFeeObservations — DE-IDENTIFICATION INVARIANT (the moat guard) ─
// The projection is handed a realistic analysis object that INCLUDES identifying
// fields it must NEVER emit. We assert the output keys are EXACTLY the seven
// allowed de-identified fields — nothing else can ever ride along.
console.log("\n── buildFeeObservations (de-identification invariant) ──");
const ALLOWED = ["dealer_id", "region", "make_segment", "fee_label", "amount", "verdict", "observed_at"].sort();
const FORBIDDEN = ["vin", "odometer", "buyerName", "buyerEmail", "trim", "stockNumber", "rawText", "report", "price", "name", "email", "ip"];
const analysis = {
  // identifying fields that MUST NOT leak into any observation:
  vin: "KM8...redacted", odometer: 34120, buyerName: "Jane Doe",
  buyerEmail: "jane@example.com", trim: "Preferred AWD", stockNumber: "H12345",
  rawText: "full quote text...", report: { signed: true }, ip: "1.2.3.4",
  // legitimate market fields:
  dealerName: "Calgary Hyundai", dealerCity: "Calgary", make: "Hyundai",
  fuelType: "BEV", issuedAt: "2026-08-05T14:33:00Z",
  addOns: [
    { name: "Documentation Fee", price: 699, verdict: "standard" },
    { name: "Nitrogen Tire Fill", price: 399, verdict: "flagged" },
    { name: "Market Value Adjustment", price: 2500, verdict: "flagged" },
    { name: "", price: 0 },              // dropped: non-positive amount
    { name: "Freight", price: "abc" },   // dropped: non-numeric amount
  ],
};
const obs = buildFeeObservations(analysis);
ok(obs.length === 3, `emits one row per positive-amount fee (got ${obs.length}, expected 3)`);
let keysClean = true, noForbidden = true, dateOnly = true, segClean = true;
for (const o of obs) {
  const keys = Object.keys(o).sort();
  if (JSON.stringify(keys) !== JSON.stringify(ALLOWED)) keysClean = false;
  for (const f of FORBIDDEN) if (f in (o as any)) noForbidden = false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.observed_at)) dateOnly = false;          // date only, no time
  if (o.make_segment && /Preferred|AWD|KM8|H12345/i.test(o.make_segment)) segClean = false; // no trim/VIN/stock in segment
}
ok(keysClean, `every row has EXACTLY the 7 de-identified fields, nothing else`);
ok(noForbidden, `no forbidden/identifying field ever present (vin, odometer, buyer*, trim, stock, raw, report, ip...)`);
ok(dateOnly, `observed_at is DATE ONLY (no time-of-day)`);
ok(segClean, `make_segment carries no trim / VIN / stock number`);
ok(obs[0].dealer_id === dealerId("Calgary Hyundai", "Calgary"), `dealer_id matches the opaque hash`);
ok(obs.every(o => o.dealer_id.startsWith("d_")), `dealer_id is always the hashed business id`);
ok(buildFeeObservations(null).length === 0 && buildFeeObservations({}).length === 0, `no addOns -> empty (never throws)`);

// ── Part D: coverage report (surfaces blind spots — reports, does not fail) ────
// Anything landing in "other"/"unlabeled" is a normalizer gap = benchmark noise.
// This is a visibility aid for hardening the vocabulary from real FLYWHEEL_LOG
// data; it never fails the run so a new fee name can't block a deploy.
console.log("\n── vocabulary coverage (blind-spot report) ──");
const gaps = VOCAB.filter(([raw]) => { const g = normalizeFeeLabel(raw); return g === "other" || g === "unlabeled"; });
if (gaps.length === 0) console.log("  ✓ no fixture fee names fall through to other/unlabeled");
else for (const [raw] of gaps) console.log(`  … coverage gap: "${raw}" -> other (add a rule if this is a real fee)`);

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? "✅" : "❌"} fee-vocab: ${pass} passed, ${fail} failed`);
if (fail) { console.log("\nFailures:"); for (const f of fails) console.log(`  - ${f}`); process.exit(1); }
