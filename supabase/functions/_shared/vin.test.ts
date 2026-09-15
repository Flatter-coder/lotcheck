// Truth table for the VIN shape rule — pinned, because fourteen copies of it
// disagreed and nothing recorded which disagreement was intended.
//
// Run: node --experimental-strip-types supabase/functions/_shared/vin.test.ts
import { normalizeVin, isVinShape, isPlausibleVin, plausibleVinOrNull, vinShapeOrNull } from "./vin.ts";

let pass = 0;
const fails: string[] = [];
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return; }
  fails.push(`${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);
};

// Real VINs seen in the corpus.
const REAL = ["YV4ED3UR3M2605626", "KL77LGE20TC164566", "JTM7ERAV1TD018440", "2GNAXUEV0N6110676"];

// ── normalise ───────────────────────────────────────────────────────────────
eq("trims and upper-cases", normalizeVin("  yv4ed3ur3m2605626 "), "YV4ED3UR3M2605626");
eq("strips internal whitespace", normalizeVin("YV4ED3UR3M 2605626"), "YV4ED3UR3M2605626");
eq("empty is null", normalizeVin("   "), null);
eq("non-string is null", normalizeVin(12345), null);
eq("null is null", normalizeVin(null), null);

// ── shape ───────────────────────────────────────────────────────────────────
for (const v of REAL) {
  eq(`shape accepts ${v}`, isVinShape(v), true);
  // THE CASE BUG THIS CLOSES: twelve of the fourteen sites were
  // case-SENSITIVE, so the same VIN was a VIN at two sites and not at the rest.
  eq(`shape accepts ${v} lower-cased`, isVinShape(v.toLowerCase()), true);
  eq(`shapeOrNull normalises ${v}`, vinShapeOrNull(v.toLowerCase()), v);
}
eq("16 chars is not a VIN", isVinShape("YV4ED3UR3M260562"), false);
eq("18 chars is not a VIN", isVinShape("YV4ED3UR3M26056266"), false);
eq("contains I", isVinShape("IV4ED3UR3M2605626"), false);
eq("contains O", isVinShape("OV4ED3UR3M2605626"), false);
eq("contains Q", isVinShape("QV4ED3UR3M2605626"), false);
eq("contains a dash", isVinShape("YV4ED3UR3M-605626"), false);
eq("empty", isVinShape(""), false);

// ── plausibility ────────────────────────────────────────────────────────────
// Only three of the fourteen sites rejected a placeholder run; the rest would
// have stored it as this vehicle's VIN.
eq("seventeen 1s is shaped", isVinShape("11111111111111111"), true);
eq("seventeen 1s is NOT plausible", isPlausibleVin("11111111111111111"), false);
eq("seventeen As is NOT plausible", isPlausibleVin("AAAAAAAAAAAAAAAAA"), false);
eq("plausibleVinOrNull rejects the placeholder", plausibleVinOrNull("11111111111111111"), null);
for (const v of REAL) {
  eq(`plausible accepts ${v}`, isPlausibleVin(v), true);
  eq(`plausibleVinOrNull returns ${v}`, plausibleVinOrNull(v.toLowerCase()), v);
}

// ── every predicate refuses junk rather than throwing ───────────────────────
for (const junk of [null, undefined, 0, {}, [], "call for pricing"]) {
  eq(`isVinShape(${JSON.stringify(junk)})`, isVinShape(junk), false);
  eq(`isPlausibleVin(${JSON.stringify(junk)})`, isPlausibleVin(junk), false);
  eq(`plausibleVinOrNull(${JSON.stringify(junk)})`, plausibleVinOrNull(junk), null);
  eq(`vinShapeOrNull(${JSON.stringify(junk)})`, vinShapeOrNull(junk), null);
}

// ── the gap this does NOT close, pinned so it stays visible ────────────────
// A VIN can be shaped, plausible, stored and published while failing its own
// ISO 3779 check digit. This one is YV4ED3UR3M2605626 with position 9 changed.
eq("a bad check digit is still VIN-SHAPED", isVinShape("YV4ED3UR3X2605626"), true);
eq("a bad check digit is still PLAUSIBLE", isPlausibleVin("YV4ED3UR3X2605626"), true);

if (fails.length) {
  console.error(`vin: ${fails.length} FAILED, ${pass} passed\n`);
  for (const f of fails) console.error(`  ${f}\n`);
  process.exit(1);
}
console.log(`vin: ${pass}/${pass} pass — one shape rule, truth table pinned.`);
