// Invariant regression harness. Run BEFORE any change to invariants.ts, and any
// time you touch price-disclosure, MSRP-basis, or VIN handling in either edge
// function. It exercises the EXACT code that ships -- assertInvariants() and
// validateVin() are imported, not copied -- so a regression fails here instead
// of in a buyer's report. See no-regressions-durable-fixes.
//
// Every case below is a bug that actually happened or a rule we promised.
// Adding a case is how a fixed bug stays fixed: name it, pin the expected
// repair, and it can never quietly come back.
//
// Pure and offline -- no network, no clock, no Claude. It should run in
// milliseconds and never SKIP.
//
// Run (Node 24+, from repo root):
//   node --experimental-strip-types supabase/functions/_shared/invariants.test.ts
// Deno also works:
//   deno run supabase/functions/_shared/invariants.test.ts
//
// Exit code 0 = all pass; 1 = a failure.
import { assertInvariants, validateVin, INVARIANTS } from "./invariants.ts";
import type { InvariantCtx } from "./invariants.ts";

interface Case {
  name: string;
  analysis: Record<string, unknown>;
  ctx?: InvariantCtx;
  repaired?: string[];
  flagged?: string[];
  after?: Record<string, unknown>;
}

// A VIN whose check digit genuinely reconciles (position 9 = "X").
const GOOD_VIN = "1HGCM82633A004352";

const CASES: Case[] = [
  // ── Price disclosure ───────────────────────────────────────────────────────
  {
    name: "Okotoks family: a captured price kills a 'contact for price' claim",
    analysis: { quotedPrice: 112995, priceDisclosure: "contact_for_price" },
    repaired: ["PRICE_DISCLOSURE_MATCHES_PRICE"],
    after: { priceDisclosure: "advertised" },
  },
  {
    name: "a genuinely advertised price is left alone",
    analysis: { quotedPrice: 54990, priceDisclosure: "advertised" },
    repaired: [],
  },
  {
    name: "gating stands when the rendered page confirmed it",
    analysis: { priceDisclosure: "contact_for_price" },
    ctx: { priceRenderChecked: true, renderConfirmed: true },
    repaired: [],
    after: { priceDisclosure: "contact_for_price" },
  },
  {
    name: "unconfirmed gating downgrades -- we never accuse on ambiguity",
    analysis: { priceDisclosure: "contact_for_price" },
    ctx: { priceRenderChecked: true, renderConfirmed: false },
    repaired: ["PRICE_NOT_ACCUSED_UNCONFIRMED"],
    after: { priceDisclosure: "not_shown" },
  },
  {
    name: "mid-pipeline, gating survives -- a later rescue may still confirm it",
    analysis: { priceDisclosure: "contact_for_price" },
    ctx: {},
    repaired: [],
    after: { priceDisclosure: "contact_for_price" },
  },
  {
    name: "price plus unconfirmed gating resolves to advertised, not not_shown",
    analysis: { quotedPrice: 61545, priceDisclosure: "contact_for_price" },
    ctx: { priceRenderChecked: true, renderConfirmed: false },
    repaired: ["PRICE_DISCLOSURE_MATCHES_PRICE"],
    after: { priceDisclosure: "advertised" },
  },

  // ── Summary vs verified price (read facts first, THEN write) ──────────────
  {
    name: "HR-V family: a summary denying pricing beside a verified price is rebuilt from the figures",
    analysis: { quotedPrice: 43481, vehicle: "2027 Honda HR-V EX-L AWD", summary: "This listing for a 2027 Honda HR-V (currently in transit to the dealer) contains no pricing information at all -- no MSRP, no advertised selling price, and no financing or lease terms are disclosed anywhere in the extracted page content." },
    repaired: ["SUMMARY_MATCHES_PRICE"],
    after: { summary: "2027 Honda HR-V EX-L AWD is advertised at $43,481 on the dealer's own listing page. The figures on this report were read from the page's own data and rendered view. Confirm the out-the-door total, any add-on fees, and financing details directly with the dealer before signing anything." },
  },
  {
    name: "'no advertised price' phrasing is caught too",
    analysis: { quotedPrice: 37381, summary: "There is no advertised selling price on this page." },
    repaired: ["SUMMARY_MATCHES_PRICE"],
  },
  {
    name: "a truthful summary with a price is left alone",
    analysis: { quotedPrice: 43481, summary: "This vehicle is advertised at $43,481; confirm fees with the dealer." },
    repaired: [],
  },
  {
    name: "'no price-gating' phrasing is NOT a denial -- summary untouched",
    analysis: { quotedPrice: 43481, summary: "There is no price-gating on this listing; the figure is published plainly." },
    repaired: [],
  },
  {
    name: "a denial with NO recovered price stands -- nothing to contradict",
    analysis: { summary: "No advertised selling price is disclosed on this page." },
    repaired: [],
  },

  // ── VIN ────────────────────────────────────────────────────────────────────
  {
    name: "a VIN with no vinCheck is repaired, never shipped bare",
    analysis: { vin: GOOD_VIN },
    repaired: ["VIN_CHECK_MATCHES_VIN"],
  },
  {
    name: "a vinCheck left over from a different VIN is recomputed",
    analysis: { vin: GOOD_VIN, vinCheck: { present: true, valid: true, vin: "5YJ3E1EA7KF000316" } },
    repaired: ["VIN_CHECK_MATCHES_VIN"],
  },
  {
    name: "a matching vinCheck is left alone",
    analysis: { vin: GOOD_VIN, vinCheck: validateVin(GOOD_VIN) },
    repaired: [],
  },
  {
    name: "no VIN on the listing is not a violation",
    analysis: { vin: null },
    repaired: [],
    flagged: [],
  },

  // ── MSRP ───────────────────────────────────────────────────────────────────
  {
    name: "an unlabelled catalog MSRP is flagged -- a floor can't pose as exact",
    analysis: { msrp: 59900, msrpSource: "catalog" },
    flagged: ["CATALOG_MSRP_BASIS_LABELLED"],
  },
  {
    name: "a labelled 'starting at' floor is fine",
    analysis: { msrp: 59900, msrpSource: "catalog", msrpBasis: "starting_at" },
    flagged: [],
  },
  {
    name: "dealer-stated MSRP with no source is flagged for provenance",
    analysis: { msrp: 66140 },
    flagged: ["MSRP_HAS_PROVENANCE"],
  },
  {
    name: "the real inflation case reconciles: $66,140 stated vs $59,900 true",
    analysis: {
      msrp: 59900, msrpSource: "catalog", msrpBasis: "exact", dealerStatedMsrp: 66140,
      msrpInflation: { dealerStated: 66140, manufacturer: 59900, overBy: 6240 },
    },
    flagged: [],
  },
  {
    name: "inflation anchored to the dealer's number instead of the true MSRP is flagged",
    analysis: {
      msrp: 66140, msrpSource: "catalog", msrpBasis: "exact",
      msrpInflation: { dealerStated: 66140, manufacturer: 59900, overBy: 6240 },
    },
    flagged: ["MSRP_INFLATION_ANCHORED"],
  },
  {
    name: "inflation arithmetic that doesn't add up is flagged",
    analysis: {
      msrp: 59900, msrpSource: "catalog", msrpBasis: "exact",
      msrpInflation: { dealerStated: 66140, manufacturer: 59900, overBy: 1000 },
    },
    flagged: ["MSRP_INFLATION_ANCHORED"],
  },

  // ── Days on lot ────────────────────────────────────────────────────────────
  {
    name: "days-on-lot without provenance is flagged",
    analysis: { daysOnLot: { days: 94 } },
    flagged: ["DAYS_ON_LOT_HAS_PROVENANCE"],
  },
  {
    name: "days-on-lot with source and label is fine",
    analysis: {
      daysOnLot: { days: 94, source: "dealer_platform_page", sourceLabel: "the dealer's own inventory data" },
    },
    flagged: [],
  },

  // ── Safety: a gate must never take a report down ───────────────────────────
  {
    name: "a malformed inflation object is flagged, not thrown",
    analysis: { msrpInflation: "not an object" },
    flagged: ["MSRP_INFLATION_ANCHORED"],
  },
  // ── Sale condition vs MSRP basis ───────────────────────────────────────────
  // THE ADVANTAGE FORD SHAPE. A used listing whose page stated an MSRP came back
  // with basis "exact", and the report told the buyer a years-old vehicle was
  // thousands "under MSRP" -- a fabricated bargain claim that flatters the
  // dealer. The guard existed in two of the three MSRP branches and was missing
  // from the one that runs when the page supplies a figure.
  {
    name: "a used car's catalog MSRP may not carry a present-tense basis",
    analysis: {
      msrp: 68400, quotedPrice: 49995, msrpSource: "catalog", msrpBasis: "exact",
      vehicleCondition: "used", odometerKm: 31000,
    },
    repaired: ["MSRP_BASIS_MATCHES_CONDITION"],
    after: { msrpBasis: "original_when_new" },
  },
  {
    name: "a demo IS measured against its own sticker, so 'exact' stands",
    analysis: {
      msrp: 61000, quotedPrice: 52000, msrpSource: "catalog", msrpBasis: "exact",
      vehicleCondition: "new", saleCondition: "demo", odometerKm: 9000,
    },
    repaired: [],
  },
  {
    name: "an empty analysis passes cleanly",
    analysis: {},
    repaired: [],
    flagged: [],
  },
  // -- report lines (2026-09-02): counts and defaults must name their basis ----
  {
    name: "a confirmed market count without province, dates or identity is demoted to unchecked -- a count must name what it is of",
    analysis: { marketCount: { state: "confirmed", n: 12, below: 0, price: 39714 } },
    repaired: ["MARKET_COUNT_HAS_PROVENANCE"],
  },
  {
    name: "a confirmed market count with identity, province, dates and price is fine",
    analysis: { quotedPrice: 39713.7, marketCount: { state: "confirmed", scope: "trim", trimLabel: "Sport", n: 12, below: 0, same: 0, dealers: 3, province: "AB", seenMin: "2026-08-18", seenMax: "2026-08-18", year: 2027, make: "Honda", model: "HR-V", price: 39713.7 } },
    repaired: [], flagged: [],
  },
  {
    name: "a market count whose dealer count is 0 or exceeds n cannot be confirmed",
    analysis: { marketCount: { state: "confirmed", scope: "model", n: 12, below: 0, same: 0, dealers: 0, province: "AB", seenMax: "2026-08-18", year: 2027, make: "Honda", model: "HR-V", price: 39714 } },
    repaired: ["MARKET_COUNT_HAS_PROVENANCE"],
  },
  {
    name: "a market count whose below + same exceeds n cannot be confirmed",
    analysis: { marketCount: { state: "confirmed", scope: "model", n: 12, below: 10, same: 5, dealers: null, province: "AB", seenMax: "2026-08-18", year: 2027, make: "Honda", model: "HR-V", price: 39714 } },
    repaired: ["MARKET_COUNT_HAS_PROVENANCE"],
  },
  {
    name: "a trim-scoped count with no trim label cannot be confirmed",
    analysis: { marketCount: { state: "confirmed", scope: "trim", trimLabel: null, n: 12, below: 0, same: 0, dealers: null, province: "AB", seenMax: "2026-08-18", year: 2027, make: "Honda", model: "HR-V", price: 39714 } },
    repaired: ["MARKET_COUNT_HAS_PROVENANCE"],
  },
  {
    name: "a count sealed against a price that no longer matches the report's asking price is demoted",
    analysis: { quotedPrice: 41000, marketCount: { state: "confirmed", scope: "model", n: 12, below: 0, same: 0, dealers: null, province: "AB", seenMax: "2026-08-18", year: 2027, make: "Honda", model: "HR-V", price: 39714 } },
    repaired: ["MARKET_COUNT_HAS_PROVENANCE"],
  },
  {
    name: "an absent or unchecked market count is never flagged (no claim is being made)",
    analysis: { marketCount: { state: "absent", n: 0 } },
    flagged: [],
  },
  {
    name: "a page default sourced from the model is demoted to unchecked, never shown as read from the page",
    analysis: { pageDefault: { checked: true, state: "confirmed", termMonths: 84, paymentFrequency: "biweekly", apr: 6.99, source: "llm" } },
    repaired: ["PAGE_DEFAULT_READ_FROM_PAGE"],
  },
  {
    name: "a page default that was never checked cannot be confirmed",
    analysis: { pageDefault: { checked: false, state: "confirmed", termMonths: 84, apr: 5.99, source: "page_text" } },
    repaired: ["PAGE_DEFAULT_READ_FROM_PAGE"],
  },
  {
    name: "a page default read from the page's own text is fine",
    analysis: { pageDefault: { checked: true, state: "confirmed", termMonths: 84, paymentFrequency: "biweekly", apr: 5.99, downPayment: 0, paymentAmount: 267, source: "page_text", readAt: "2026-09-02" } },
    repaired: [], flagged: [],
  },
  {
    name: "a confirmed page default with neither a term nor a rate is not a reading",
    analysis: { pageDefault: { checked: true, state: "confirmed", termMonths: null, apr: null, paymentFrequency: "weekly", source: "sm360_feed", readAt: "2026-09-02" } },
    repaired: ["PAGE_DEFAULT_READ_FROM_PAGE"],
  },
];

let pass = 0, fail = 0;
const fails: string[] = [];

function same(got: string[], want: string[]): boolean {
  const g = [...got].sort().join("|");
  const w = [...want].sort().join("|");
  return g === w;
}

function record(ok: boolean, label: string, detail: string) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; const line = `${label} — ${detail}`; fails.push(line); console.log(`  ✗ ${line}`); }
}

// ── Part A: every invariant is exercised by at least one case ────────────────
// Guards the harness itself: adding an invariant without a case would otherwise
// grow the surface area while the suite still reports all-green.
console.log("\n── coverage (every invariant has a case) ──");
{
  const named = new Set<string>();
  for (const c of CASES) {
    for (const id of c.repaired ?? []) named.add(id);
    for (const id of c.flagged ?? []) named.add(id.split(" ")[0]);
  }
  for (const inv of INVARIANTS) {
    record(named.has(inv.id), inv.id, "no case asserts this invariant fires");
  }
}

// ── Part B: behaviour ────────────────────────────────────────────────────────
console.log("\n── assertInvariants (pure, deterministic) ──");
for (const c of CASES) {
  const a: any = structuredClone(c.analysis);
  let res;
  try { res = assertInvariants(a, c.ctx ?? {}); }
  catch (e) { record(false, c.name, `threw: ${(e as Error)?.message}`); continue; }

  if (c.repaired !== undefined && !same(res.repaired, c.repaired)) {
    record(false, c.name, `repaired ${JSON.stringify(res.repaired)}, expected ${JSON.stringify(c.repaired)}`);
    continue;
  }
  if (c.flagged !== undefined && !same(res.flagged, c.flagged)) {
    record(false, c.name, `flagged ${JSON.stringify(res.flagged)}, expected ${JSON.stringify(c.flagged)}`);
    continue;
  }
  let mismatch = "";
  for (const [k, v] of Object.entries(c.after ?? {})) {
    if (a[k] !== v) mismatch = `${k} = ${JSON.stringify(a[k])}, expected ${JSON.stringify(v)}`;
  }
  record(mismatch === "", c.name, mismatch);
}

// ── Part C: validateVin (moved out of two duplicate copies) ──────────────────
console.log("\n── validateVin (ISO 3779 check digit) ──");
{
  const vinCases: Array<[unknown, Partial<{ present: boolean; valid: boolean }>, string]> = [
    [GOOD_VIN, { present: true, valid: true }, "a real VIN validates"],
    [` ${GOOD_VIN.toLowerCase()} `, { present: true, valid: true }, "case and whitespace are normalized"],
    ["1HGCM82633A004353", { present: true, valid: false }, "a transposed check digit is caught"],
    ["1HGCM82633A00435", { present: true, valid: false }, "16 characters is rejected"],
    ["1HGCM82633A0O4352", { present: true, valid: false }, "the letter O is rejected"],
    [null, { present: false }, "a missing VIN reports absent, not invalid"],
    ["   ", { present: false }, "whitespace-only reports absent"],
  ];
  for (const [input, want, label] of vinCases) {
    const got = validateVin(input);
    const ok = Object.entries(want).every(([k, v]) => (got as any)[k] === v);
    record(ok, label, `got ${JSON.stringify(got)}`);
  }
}

console.log(`\n${fail === 0 ? "✅" : "❌"} invariants: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log("\nFailures:"); for (const l of fails) console.log("  - " + l); }
const code = fail > 0 ? 1 : 0;
// @ts-ignore - runtime-dependent globals
(globalThis.Deno?.exit ?? globalThis.process?.exit)?.(code);
