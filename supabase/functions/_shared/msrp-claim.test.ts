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
import { qualifyMsrpClaim } from "./msrp-claim.ts";

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

console.log(`\n${fail === 0 ? "✅" : "❌"} msrp claim gate: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log("\nFailures:"); for (const l of fails) console.log("  - " + l); }
// @ts-ignore - runtime-dependent globals
(globalThis.Deno?.exit ?? globalThis.process?.exit)?.(fail > 0 ? 1 : 0);
