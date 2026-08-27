// A BUNDLED price line must never be attributed to the dealer.
//
// THE DEFECT THIS LOCKS (verified end to end against the real functions,
// 2026-08-27). On the Convertus page behind report LC-46A4-66F the pricing
// block reads "MSRP 58,675 + Fees & Accessories 3,330 = Sales Price 62,005".
// Decomposed against Lexus Canada's own published Alberta figures, that $3,330
// is freight 2,205 + A/C excise 100 + AMVIC 10 + tire levy 20 + Lexus's own
// published dealer fee 995 — to the cent. So 70% of it is money the dealer
// collects and remits for someone else.
//
// LotCheck attributed the whole row to the dealer in three places, and the
// worst was the counter-script, which the buyer reads ALOUD to a named AMVIC
// licensee:
//
//     "Please take off the $3,330 in dealer add-ons (Fees & Accessories)
//      — I don't want them."
//
// That fired whenever the model returned verdict "flagged" (the likely verdict
// for an unexplained $3,330 bundle) or returned no verdict at all, because
// classifyLine's terminal default is "addon".
//
// Run: npm run test:bundled-fee
import { isBundledFeeCaption, normaliseBundledAddOns, bundledItemisationAsk } from "../supabase/functions/_shared/fee-caption.ts";
import { classifyLine, computeReconciliation, buildCounterScript } from "../supabase/functions/_shared/deal.ts";

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};

// ── which captions denote a mixture ────────────────────────────────────────
console.log("\nwhat counts as a bundled line");
for (const c of ["Fees & Accessories", "Fees and Accessories", "Fees/Accessories",
                 "Taxes, Fees & Levies", "Additional Fees & Charges",
                 "Freight, PDI & Admin", "Fees + Accessories"]) {
  check(`"${c}" is bundled`, isBundledFeeCaption(c));
}
console.log("\nand what does not");
for (const c of ["Dealer Fees", "Administration Fee", "Documentation Fee",
                 "Protection Package", "Paint & Fabric Protection",
                 "Appearance & Protection Package", "Freight & PDI",
                 "Delivery and Destination", "", null, undefined, 12345]) {
  check(`${JSON.stringify(c)} is NOT bundled`, !isBundledFeeCaption(c));
}

// ── the classifier ─────────────────────────────────────────────────────────
console.log("\na bundled line is never classified as a dealer add-on");
for (const verdict of ["flagged", "standard", "good", undefined, null]) {
  check(`verdict=${String(verdict)} still classifies as a pass-through`,
    classifyLine("Fees & Accessories", 3330, verdict) === "fee",
    `got ${classifyLine("Fees & Accessories", 3330, verdict)}`);
}
check("a genuine dealer add-on is still an add-on",
  classifyLine("Protection Package", 1995, "flagged") === "addon");
check("an unknown SINGLE line is still worth questioning",
  classifyLine("Mystery Charge", 900, undefined) === "addon",
  "the terminal default is correct for a single unexplained charge; only a mixture is exempt");

// ── the whole chain, on the real report's numbers ──────────────────────────
const base = {
  year: 2026, make: "Lexus", model: "NX 350h", trim: "350h Premium Hybrid AWD",
  dealerName: "Southpointe Motors", dealerCity: "Edmonton, AB",
  vehicleCondition: "new", quotedPrice: 62005, msrp: 58025,
};
const withBundle = (verdict) => ({
  ...base,
  totalFlaggedCost: verdict === "flagged" ? 3330 : 0,
  addOns: [{ name: "Fees & Accessories", price: 3330, kind: "fee", verdict, reason: "no breakdown given" }],
});

console.log("\nend to end: the accusation must not fire, on any verdict");
for (const verdict of ["flagged", undefined]) {
  const a = withBundle(verdict);
  normaliseBundledAddOns(a);
  a.reconciliation = computeReconciliation(a);
  const cs = buildCounterScript(a);
  const says = (cs?.moves || []).map((m) => m.say);

  check(`verdict=${String(verdict)}: nothing is called a dealer add-on`,
    a.reconciliation.addonsTotal === 0,
    `addonsTotal=${a.reconciliation.addonsTotal}`);
  check(`verdict=${String(verdict)}: the "take off ... dealer add-ons" line is gone`,
    !says.some((s) => /dealer add-?ons/i.test(s)),
    says.find((s) => /dealer add-?ons/i.test(s)) || "");
  check(`verdict=${String(verdict)}: totalFlaggedCost no longer carries the bundle`,
    Number(a.totalFlaggedCost) === 0,
    `got ${a.totalFlaggedCost}`);
  check(`verdict=${String(verdict)}: the buyer is asked to ITEMISE it instead`,
    says.some((s) => /itemise/i.test(s) && /3,330/.test(s)),
    says.join(" | ").slice(0, 160));
  check(`verdict=${String(verdict)}: the money is still shown, not hidden`,
    a.reconciliation.feesTotal === 3330,
    "a line we cannot attribute must still be visible to the buyer");
}

console.log("\nthe ask names no authority and no figure but the dealer's own");
{
  const ask = bundledItemisationAsk("Fees & Accessories", 3330);
  check("it asks for a written itemisation", /itemise/i.test(ask) && /writing/i.test(ask));
  check("it names the three buckets", /freight/i.test(ask) && /administration fee/i.test(ask) && /government/i.test(ask));
  check("it asserts nothing about what the dealer did",
    !/(padding|markup|inflat|overcharg|added by|dealer add)/i.test(ask), ask);
  check("it quotes only the dealer's own number", /\$3,330/.test(ask));
}

// ── a genuine dealer add-on must still be challengeable ───────────────────
console.log("\na real dealer add-on is untouched");
{
  const a = { ...base, totalFlaggedCost: 1995,
    addOns: [{ name: "Protection Package", price: 1995, kind: "fee", verdict: "flagged", reason: "not itemised" }] };
  const n = normaliseBundledAddOns(a);
  check("normalisation does nothing to it", n.changed === false);
  a.reconciliation = computeReconciliation(a);
  check("it is still an add-on", a.reconciliation.addonsTotal === 1995);
  const says = (buildCounterScript(a)?.moves || []).map((m) => m.say);
  check("the buyer can still ask for it to be removed",
    says.some((s) => /take off/i.test(s) && /1,995/.test(s)),
    says.join(" | ").slice(0, 140));
  check("totalFlaggedCost is untouched when nothing was bundled", a.totalFlaggedCost === 1995);
}

// ── mixed: one bundle, one genuine add-on ────────────────────────────────
console.log("\na mixed report keeps them apart");
{
  const a = { ...base, totalFlaggedCost: 5325, addOns: [
    { name: "Fees & Accessories", price: 3330, kind: "fee", verdict: "flagged", reason: "x" },
    { name: "Protection Package", price: 1995, kind: "fee", verdict: "flagged", reason: "y" },
  ] };
  normaliseBundledAddOns(a);
  a.reconciliation = computeReconciliation(a);
  check("only the genuine add-on is attributed", a.reconciliation.addonsTotal === 1995,
    `got ${a.reconciliation.addonsTotal}`);
  check("the bundle sits in the pass-through bucket", a.reconciliation.feesTotal === 3330);
  check("totalFlaggedCost drops to just the add-on", Number(a.totalFlaggedCost) === 1995,
    `got ${a.totalFlaggedCost}`);
  const says = (buildCounterScript(a)?.moves || []).map((m) => m.say);
  check("the removal ask names only the $1,995",
    says.some((s) => /take off/i.test(s) && /1,995/.test(s) && !/3,330/.test(s)),
    says.find((s) => /take off/i.test(s)) || "");
}

// ── normalisation is idempotent and safe on junk ─────────────────────────
console.log("\nsafe to call twice, and on nothing");
{
  const a = withBundle("flagged");
  normaliseBundledAddOns(a);
  const first = JSON.stringify(a.addOns);
  normaliseBundledAddOns(a);
  check("running it twice changes nothing further", JSON.stringify(a.addOns) === first);
  check("no addOns is a no-op", normaliseBundledAddOns({}).changed === false);
  check("junk is a no-op", normaliseBundledAddOns(null).changed === false
    && normaliseBundledAddOns({ addOns: "nope" }).changed === false);
}

// ── both analysis paths must call it ─────────────────────────────────────
console.log("\nboth analysis paths normalise, and BEFORE the consumers");
{
  const { readFileSync } = await import("node:fs");
  for (const f of ["analyze-listing-url", "analyze-quote"]) {
    const src = readFileSync(new URL(`../supabase/functions/${f}/index.ts`, import.meta.url), "utf8");
    check(`${f} calls normaliseBundledAddOns`, /normaliseBundledAddOns\(analysis\)/.test(src),
      "a guard that lands on one path only is the defect 614c399 fixed");
    const norm = src.indexOf("normaliseBundledAddOns(analysis)");
    const recon = src.indexOf("computeReconciliation(analysis)");
    check(`${f} normalises BEFORE computeReconciliation`, norm > 0 && recon > 0 && norm < recon,
      "ordering-vs-derived-value has bitten this repo twice (63fa164, fe57ad4)");
  }
  const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  check("no surface labels a mixed total 'Add-ons total'",
    !/>Add-ons total</.test(app),
    "the heading attributes the money even when every row is a pass-through");
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exit(1);
