// Vic's rule, pinned: no dealer terms -> use the manufacturer's APR and price
// and do the math.
//
// Run: node --experimental-strip-types supabase/functions/_shared/reference-financing.test.ts

import { amortizedPayment, computeReferenceFinancing } from "./reference-financing.ts";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, detail?: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "\n        " + (detail ?? "")}`);
  cond ? pass++ : fail++;
};

// ---------------------------------------------------------------------------
// The arithmetic itself.
// ---------------------------------------------------------------------------
const p = amortizedPayment(90601, 5.69, 72)!;
// Cross-checked against an independent amortization calculation:
// 90,601 @ 5.69% / 72 = $1,488.30/month.
check("standard amortization is right to the cent",
  Math.abs(p.monthly - 1488.30) < 0.01, JSON.stringify(p));

check("interest is the difference, not a second guess",
  Math.abs(p.totalInterest - (p.totalPaid - p.principal)) < 0.02, JSON.stringify(p));

check("a 0% promo is a real rate, handled exactly",
  amortizedPayment(72000, 0, 72)!.monthly === 1000, JSON.stringify(amortizedPayment(72000, 0, 72)));

for (const [label, principal, apr, months] of [
  ["zero principal", 0, 5.69, 72], ["zero term", 50000, 5.69, 0],
  ["negative apr", 50000, -1, 72], ["absurd apr", 50000, 100, 72],
] as [string, number, number, number][]) {
  check(`refuses ${label} rather than returning a number`,
    amortizedPayment(principal, apr, months) === null, `${principal}/${apr}/${months}`);
}

// ---------------------------------------------------------------------------
// THE LAND CRUISER CASE. Stampede quotes no financing; we hold Toyota's
// 5.69%/72 and the Premium Package's $90,601 all-in.
// ---------------------------------------------------------------------------
const landCruiser = {
  make: "Toyota", quotedPrice: 95000, msrp: 86835, msrpAllIn: 90601,
  msrpBasis: "exact", allInPricing: { code: "AB" },
  financeRates: { dealer: null, manufacturer: { apr: 5.69, termMonths: 72, promo: false, effectiveDate: "2026-08-30" } },
};
const ref = computeReferenceFinancing(landCruiser)!;
check("THE FIX: a dealer with no quoted terms still gets the math done",
  !!ref && !!ref.atAsking && !!ref.atManufacturerPrice, JSON.stringify(ref?.note));

check("both payments use the SAME rate and term, so they compare",
  ref.atAsking!.apr === ref.atManufacturerPrice!.apr &&
  ref.atAsking!.termMonths === ref.atManufacturerPrice!.termMonths, JSON.stringify(ref));

check("the gap is expressed monthly — the unit a buyer actually feels",
  ref.monthlyDelta !== null && ref.monthlyDelta > 0 && /every month/.test(ref.note),
  `monthlyDelta=${ref.monthlyDelta}  note=${ref.note}`);

check("...and over the full term",
  ref.lifetimeDelta !== null && ref.lifetimeDelta > ref.monthlyDelta!, JSON.stringify({ m: ref.monthlyDelta, l: ref.lifetimeDelta }));

check("it compares against the ALL-IN price, never the ex-freight MSRP",
  ref.basis === "all_in" && ref.atManufacturerPrice!.principal === 90601,
  `principal=${ref.atManufacturerPrice!.principal} — 86,835 would invent $3,766 of principal`);

check("the note states what it excludes, so it cannot read as a quote",
  /before tax, down payment or trade-in/i.test(ref.note), ref.note);

// ---------------------------------------------------------------------------
// The refusals. A reference must never become a claim it hasn't earned.
// ---------------------------------------------------------------------------
check("NO TERM in the catalog means no payment — an APR alone cannot amortize",
  computeReferenceFinancing({ ...landCruiser, financeRates: { manufacturer: { apr: 5.69 } } }) === null,
  "this is the exact field resolveFinanceRates used to drop");

check("no manufacturer rate at all -> null, never an invented rate",
  computeReferenceFinancing({ ...landCruiser, financeRates: { manufacturer: null } }) === null);

{
  // Basis mismatch: an all-in asking price with only an ex-freight MSRP.
  const mismatch = computeReferenceFinancing({ ...landCruiser, msrpAllIn: null })!;
  check("a basis mismatch shows the DEALER's payment only, and no delta",
    !!mismatch.atAsking && mismatch.atManufacturerPrice === null && mismatch.monthlyDelta === null,
    JSON.stringify({ basis: mismatch.basis, delta: mismatch.monthlyDelta }));
  check("...and that note offers the figure as the number to beat",
    /number to beat/.test(mismatch.note), mismatch.note);
}

check("a non-exact MSRP basis blocks the comparison, same as the price claim",
  computeReferenceFinancing({ ...landCruiser, msrpBasis: "starting_at" })!.atManufacturerPrice === null,
  "starting_at cannot support an over/under claim in dollars or in dollars-per-month");

{
  // A dealer asking BELOW the manufacturer's all-in is a real outcome.
  const under = computeReferenceFinancing({ ...landCruiser, quotedPrice: 88000 })!;
  check("asking under the manufacturer's price reads as such, not as a gotcha",
    under.monthlyDelta! < 0 && /at or below/.test(under.note), under.note);
}

console.log(`\n${pass}/${pass + fail} passed${fail ? `  — ${fail} FAILING` : "  ✓ all green"}`);
if (fail) (globalThis as any).process?.exit?.(1);
