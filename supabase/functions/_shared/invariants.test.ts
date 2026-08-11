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
  {
    name: "an empty analysis passes cleanly",
    analysis: {},
    repaired: [],
    flagged: [],
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
