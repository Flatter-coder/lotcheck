// Regression harness for the MSRP claim gate.
//
// The bug this pins: the emailed cover rendered "▼ $28,400 under MSRP" for a
// USED vehicle whose MSRP was `original_when_new`, while the PDF inside the
// same email refused to make that claim and the web report refused it too.
// One signed report, three surfaces, two different answers.
//
// Every case below is either a basis that must refuse, or a real incident.
//
// Run (Node 24+, from repo root):
//   node --experimental-strip-types supabase/functions/_shared/msrp-claim.test.ts
import { qualifyMsrpClaim, isManufacturerFigure, qualifyCeilingClaim } from "./msrp-claim.ts";

let pass = 0, fail = 0;
const fails: string[] = [];
function check(ok: boolean, label: string, detail = "") {
  if (ok) pass++; else { fail++; fails.push(label); }
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        ${detail}`}`);
}

// ---- the ONLY basis that may support a comparison -------------------------
{
  const c = qualifyMsrpClaim({
    msrp: 58405, quotedPrice: 85995, msrpBasis: "exact", priceVerified: true,
    make: "Toyota", msrpTrim: "GR SPORT AWD",
  });
  check(c.comparable && c.delta === 27590 && c.over,
    "an EXACT trim MSRP with a verified price supports an over-MSRP claim",
    JSON.stringify(c));
  check(c.refusal === null, "a comparable claim carries no refusal text");
  check(c.label === "MSRP · GR SPORT AWD", "the label names the trim", c.label);
}
{
  const c = qualifyMsrpClaim({ msrp: 45000, quotedPrice: 42000, msrpBasis: "exact", priceVerified: true });
  check(c.comparable && c.delta === -3000 && !c.over, "under-MSRP is a signed delta, not a separate case", JSON.stringify(c));
}
{
  const c = qualifyMsrpClaim({ msrp: 45000, quotedPrice: 45000, msrpBasis: "exact", priceVerified: true });
  check(c.comparable && c.delta === 0 && !c.over, "exactly at MSRP is comparable with a zero delta", JSON.stringify(c));
}

// ---- THE BUG: every other basis must refuse -------------------------------
{
  // The emailed-cover defect, verbatim: a used car under its original sticker.
  const c = qualifyMsrpClaim({
    msrp: 68400, quotedPrice: 40000, msrpBasis: "original_when_new", priceVerified: true, make: "Ford",
  });
  check(!c.comparable && c.delta === null,
    "a USED vehicle's original-when-new MSRP NEVER supports a claim (the emailed-cover bug)",
    JSON.stringify(c));
  check(!!c.refusal && /when new/i.test(c.refusal!),
    "and it explains why, in buyer-facing words", String(c.refusal));
  check(c.msrp === 68400, "the MSRP figure is still shown — refusing the COMPARISON is not hiding the number");
}
{
  // The IONIQ 9 failure mode: quoting the dealer to themselves.
  const c = qualifyMsrpClaim({ msrp: 79000, quotedPrice: 82000, msrpBasis: "dealer_stated", priceVerified: true, make: "Hyundai" });
  check(!c.comparable && c.delta === null,
    "a DEALER-STATED MSRP never supports a claim — this is the IONIQ 9 failure mode",
    JSON.stringify(c));
  check(!!c.refusal && /could not verify/i.test(c.refusal!), "and it says we could not verify it", String(c.refusal));
}
{
  const c = qualifyMsrpClaim({ msrp: 32000, quotedPrice: 41000, msrpBasis: "starting_at", priceVerified: true, msrpYear: 2025, year: 2026 });
  check(!c.comparable && c.delta === null, "a STARTING-AT floor never supports a claim — the options are the gap", JSON.stringify(c));
  check(c.label === "MSRP · starting at (2025 MY)", "and the label discloses the adjacent model year", c.label);
}
{
  // The default-deny case. An unlabelled figure must not inherit authority.
  const c = qualifyMsrpClaim({ msrp: 50000, quotedPrice: 60000, priceVerified: true });
  check(!c.comparable && c.delta === null,
    "an MSRP with NO basis refuses — absence of a basis is absence of verification, never a free pass",
    JSON.stringify(c));
  check(!!c.refusal, "and it still explains itself", String(c.refusal));
}
{
  const c = qualifyMsrpClaim({ msrp: 50000, quotedPrice: 60000, msrpBasis: "made_up_basis", priceVerified: true });
  check(!c.comparable, "an UNKNOWN basis string refuses too — the whitelist is conjunctive, not a blocklist", JSON.stringify(c));
}

// ---- a verified MSRP still needs a verified price -------------------------
{
  const c = qualifyMsrpClaim({ msrp: 58405, quotedPrice: 85995, msrpBasis: "exact", priceVerified: false });
  check(!c.comparable && c.delta === null,
    "an exact MSRP against an UNVERIFIED price is not a verified comparison",
    JSON.stringify(c));
  check(!!c.refusal && /could not be verified/i.test(c.refusal!), "and says the price is the unverified half", String(c.refusal));
}
{
  // Price gated behind "Call for pricing" — nothing to compare, and no refusal
  // text is needed because there is no delta anyone expected.
  const c = qualifyMsrpClaim({ msrp: 58405, msrpBasis: "exact" });
  check(!c.comparable && c.msrp === 58405 && c.refusal === null,
    "a gated price yields no comparison but still surfaces the MSRP", JSON.stringify(c));
}

// ---- absent / malformed data ---------------------------------------------
for (const [input, label] of [
  [{}, "an empty analysis"],
  [null, "a null analysis"],
  [{ msrp: 0, quotedPrice: 40000, msrpBasis: "exact" }, "a zero MSRP"],
  [{ msrp: -5, quotedPrice: 40000, msrpBasis: "exact" }, "a negative MSRP"],
  [{ msrp: "not a number", quotedPrice: 40000, msrpBasis: "exact" }, "a non-numeric MSRP"],
] as Array<[any, string]>) {
  const c = qualifyMsrpClaim(input);
  check(!c.comparable && c.delta === null && !c.over, `${label} never produces a claim`, JSON.stringify(c));
}

// ---- the invariant that matters most --------------------------------------
// If this ever fails, some basis has quietly acquired the right to accuse.
{
  const bases = ["exact", "starting_at", "original_when_new", "dealer_stated", "", "EXACT", "Exact", null, undefined];
  const comparable = bases.filter((b) =>
    qualifyMsrpClaim({ msrp: 50000, quotedPrice: 60000, msrpBasis: b, priceVerified: true }).comparable);
  check(comparable.length === 1 && comparable[0] === "exact",
    `EXACTLY ONE basis may ever support a claim, and it is "exact" (case-sensitive)`,
    `comparable bases: ${JSON.stringify(comparable)}`);
}

// ---- isManufacturerFigure: who gets NAMED in the copy ---------------------
// Separate question from `comparable`. Some copy says "Ford's MSRP for this
// model starts at $X" out loud. Saying that over a dealer-stated number hands
// the buyer THIS DEALER's own figure relabelled as Ford's, to argue against
// this dealer with, inside the report naming their price-gating tactic.
check(isManufacturerFigure("exact"), "an exact MSRP may be attributed to the manufacturer by name");
check(isManufacturerFigure("starting_at"), "a starting-at floor is still a manufacturer figure — 'starts at' is literally true");
check(!isManufacturerFigure("dealer_stated"),
  "a DEALER-STATED figure may NEVER be called the manufacturer's — this is the price-gating own-goal");
check(!isManufacturerFigure("original_when_new"),
  "an original-when-new figure is the manufacturer's, but the car is not new — excluded from 'starts at' phrasing");
for (const b of [null, undefined, "", "EXACT", "unknown"]) {
  check(!isManufacturerFigure(b), `basis ${JSON.stringify(b)} is not attributable to the manufacturer`);
}

// ---------------------------------------------------------------------------
// ALL-IN vs EX-FREIGHT — the "$57,500 is not truth" defect (Okotoks, 2026-08-15).
// An AMVIC all-in advertised price measured against an ex-freight MSRP counts
// ~$3,000 of freight and fees as dealer markup. Toyota publishes BOTH figures,
// so there is nothing to estimate — msrp_catalog.all_in_price holds theirs.
// ---------------------------------------------------------------------------
{
  const okotoks = { msrp: 57500, msrpAllIn: 60564, quotedPrice: 85995, msrpBasis: "exact",
                    allInPricing: { body: "AMVIC" }, priceVerified: true, make: "Toyota", msrpTrim: "GR SPORT" };
  const c = qualifyMsrpClaim(okotoks);
  check(c.comparable && c.comparedAgainst === "all_in" && c.reference === 60564 && c.delta === 25431,
    "an all-in asking price is measured against the manufacturer's ALL-IN figure", JSON.stringify(c));
  check(qualifyMsrpClaim({ ...okotoks, allInPricing: null }).reference === 57500,
    "an ex-freight quote is still measured against the ex-freight MSRP");
}
{
  // The dangerous case: all-in asking, but we hold only the ex-freight MSRP.
  const c = qualifyMsrpClaim({ msrp: 57500, quotedPrice: 85995, msrpBasis: "exact",
                               allInPricing: { body: "AMVIC" }, priceVerified: true, make: "Toyota" });
  check(!c.comparable && /all-in/i.test(String(c.refusal)),
    "all-in asking with NO all-in reference REFUSES rather than counting freight as markup", JSON.stringify(c));
}

// ---------------------------------------------------------------------------
// qualifyMsrpClaim + THE CEILING, TOGETHER — the actual Okotoks report,
// confirmed live 2026-08-21. GR SPORT could not be pinned exact (priceImplausible
// downgraded it to starting_at, correctly — a single row can't rule out a
// missing higher trim), so this line used to say "no over/under-MSRP claim is
// made" while the SAME report's leverage panel (a separate call site,
// computeLeverageScore) said "no pricing red flags" too — both silent on a
// real $23,581 gap the ceiling claim (4 real trims, none of them reach this
// price) can support without needing the exact row at all. One report, two
// surfaces, one true answer now.
// ---------------------------------------------------------------------------
{
  const okotoksStartingAt = {
    msrp: 57500, msrpBasis: "starting_at", quotedPrice: 85995,
    allInPricing: { body: "AMVIC" }, make: "Toyota",
    msrpCeiling: { allIn: 62414, floorAllIn: 51814, trim: "XSE Technology Package", trimsConsidered: 4 },
  };
  const c = qualifyMsrpClaim(okotoksStartingAt);
  check(!c.comparable && /\$23,581/.test(String(c.refusal)) && /XSE Technology Package/.test(String(c.refusal)) && /4/.test(String(c.refusal)),
    "starting_at + an exceeded ceiling enriches the refusal text with the real gap, not a silent 'no claim made'", JSON.stringify(c));
  check(!/no over\/under-MSRP claim is made/.test(String(qualifyMsrpClaim(okotoksStartingAt).refusal)),
    "the plain 'no claim made' text is replaced, not appended alongside a contradictory number");
  // Below the ceiling: the plain starting_at refusal must still stand exactly
  // as before — this is additive, not a replacement of the whole basis.
  const underCeiling = { ...okotoksStartingAt, quotedPrice: 60000 };
  check(/no over\/under-MSRP claim is made/.test(String(qualifyMsrpClaim(underCeiling).refusal)),
    "under the ceiling, the original starting_at refusal is untouched");
  // No ceiling data at all: same, must fall back to the plain refusal, not throw.
  const noCeilingData = { msrp: 57500, msrpBasis: "starting_at", quotedPrice: 85995, allInPricing: { body: "AMVIC" }, make: "Toyota" };
  check(/no over\/under-MSRP claim is made/.test(String(qualifyMsrpClaim(noCeilingData).refusal)),
    "no msrpCeiling on the analysis -> falls back to the plain starting_at refusal");
}

// ---------------------------------------------------------------------------
// THE CEILING CLAIM — the finding that needs no trim pinned.
// ---------------------------------------------------------------------------
const CEIL = { allIn: 62414, trim: "XSE Technology Package", trimsConsidered: 4 };
{
  const c = qualifyCeilingClaim({ quotedPrice: 85995, allInPricing: { body: "AMVIC" }, msrpCeiling: CEIL });
  check(c.exceeds && c.over === 23581 && c.trim === "XSE Technology Package",
    "a listing above the model's top all-in trim is provably marked up", JSON.stringify(c));
}
check(!qualifyCeilingClaim({ quotedPrice: 60000, allInPricing: {}, msrpCeiling: CEIL }).exceeds,
  "a listing UNDER the ceiling makes no claim");
check(!qualifyCeilingClaim({ quotedPrice: 85995, allInPricing: {}, msrpCeiling: { ...CEIL, trimsConsidered: 1 } }).exceeds,
  "one row is not a ladder — a ceiling taken across a single trim is refused");
check(!qualifyCeilingClaim({ quotedPrice: 85995, msrpCeiling: CEIL }).exceeds,
  "an ex-freight quote is never measured against an all-in ceiling");
for (const bad of [{}, null, { quotedPrice: 85995 }, { quotedPrice: 85995, msrpCeiling: {} }] as any[]) {
  check(!qualifyCeilingClaim(bad).exceeds, `no ceiling claim from ${JSON.stringify(bad)}`);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} msrp claim gate: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log("\nFailures:"); for (const l of fails) console.log("  - " + l); }
// @ts-ignore - runtime-dependent globals
(globalThis.Deno?.exit ?? globalThis.process?.exit)?.(fail > 0 ? 1 : 0);
