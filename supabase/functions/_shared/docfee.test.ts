// Regression suite for docfee.ts — focused on the manufacturer dealer-fee
// CEILING enrichment (the backed leverage flag).
// Run: node --experimental-strip-types supabase/functions/_shared/docfee.test.ts
//
// The ceiling is valid, backed leverage ONLY for a NEW vehicle of a make whose
// ceiling we captured, in that province. Every other case must attach nothing —
// a used car, an uncaptured make, or a fee at/under the ceiling — because a
// wrong fee claim against a named dealer is exactly what we must never emit.

import { assessDocFee } from "./docfee.ts";

let pass = 0, fail = 0;
const check = (label: string, got: any, want: Record<string, unknown>) => {
  const g = got ?? {};
  const ok = Object.entries(want).every(([k, v]) => JSON.stringify(g[k]) === JSON.stringify(v));
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`}`);
  ok ? pass++ : fail++;
};
const isNull = (label: string, got: unknown) => { const ok = got === null; console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); ok ? pass++ : fail++; };

const listing = (over: Record<string, unknown>) => ({
  dealerCity: "Okotoks, AB",
  addOns: [{ name: "Dealer Fees", price: 1295 }],
  vehicleCondition: "new",
  make: "Lexus",
  ...over,
});

// ── The flag fires: new Lexus in AB, $1,295 dealer fee over the $995 max ─────
check("new Lexus AB $1,295 -> ceiling $995, over by $300",
  assessDocFee(listing({})),
  { kind: "allin", docFee: 1295, mfrCeiling: 995, mfrCeilingOverBy: 300, mfrCeilingMake: "Lexus" });

check("new Toyota AB $1,200 -> ceiling $999, over by $201",
  assessDocFee(listing({ make: "Toyota", addOns: [{ name: "Documentation Fee", price: 1200 }] })),
  { kind: "allin", mfrCeiling: 999, mfrCeilingOverBy: 201, mfrCeilingMake: "Toyota" });

// ── The flag must NOT fire — and the base doc-fee finding still stands ───────
check("USED Lexus -> no ceiling (the max governs NEW sales), base finding intact",
  assessDocFee(listing({ vehicleCondition: "used" })),
  { kind: "allin", docFee: 1295, mfrCeiling: undefined, mfrCeilingOverBy: undefined });

check("uncaptured make (Honda) -> no ceiling, never a guess",
  assessDocFee(listing({ make: "Honda" })),
  { kind: "allin", mfrCeiling: undefined });

check("fee at/under the ceiling -> no over-flag ($900 < $995)",
  assessDocFee(listing({ addOns: [{ name: "Dealer Fees", price: 900 }] })),
  { kind: "allin", docFee: 900, mfrCeiling: undefined });

check("missing make -> no ceiling",
  assessDocFee(listing({ make: undefined })),
  { kind: "allin", mfrCeiling: undefined });

// ── Fail-safe: no doc-fee line / no jurisdiction -> no assessment at all ─────
isNull("no doc-fee line item -> null", assessDocFee(listing({ addOns: [{ name: "Cargo Liner", price: 220 }] })));
isNull("no resolvable jurisdiction -> null", assessDocFee(listing({ dealerCity: "" })));

console.log(`\n${pass}/${pass + fail} passed${fail ? "  -- FAILING" : "  all green"}`);
process.exit(fail ? 1 : 0);
