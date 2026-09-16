// A base trim is named by the manufacturer, not by a package stub.
//
// WHAT BROKE. "Standard Package" is Adobe AEM's default label for a base package
// with no distinct name of its own. It is not a Canadian showroom trim -- no
// dealer and no buyer writes it -- and on 2026-09-16 twenty-seven msrp_catalog
// rows across Toyota and Lexus were stored under it.
//
// WHAT IT COST. The trim string is half the identity key that carry-forward and
// supersede run on (catKey in catalog-io.mjs is `year|model|trim`). A base trim
// under a stub name therefore does not match the row it should have replaced, so:
//
//   - supersede never fires and the correctly-named row survives every refresh,
//     frozen at its original capture date. The 2026 Crown Signia "Limited" sat
//     at its 2026-08-16 read for a month while a second row for the same car,
//     same $58,555, same $62,336 all-in, was rewritten beside it daily.
//   - carry-forward finds no predecessor, so drivetrain and source_url come back
//     NULL. Proof from one run: on 2026-09-16 the 4Runner's TRD Sport, TRD Off
//     Road Premium and Limited 7 Passenger rows kept their source_url, and the
//     one row whose name had changed lost it.
//   - both rows live in the table, so which MSRP a listing resolves against is
//     decided by whichever the matcher reaches first.
//
// The fixtures below are not invented. Every grade and package name in
// MEASURED_* was read from the live Toyota/Lexus AEM fragments on 2026-09-16,
// one fetch per model, for all 27 rows that carried the stub.
//
// Run: node scripts/test-trim-identity.mjs

import {
  resolveTrim,
  usableGradeName,
  stripModelPrefix,
  dropStubDuplicates,
  isGenericPackageLabel,
} from "./lib/tci-stack.mjs";

let failures = 0;
const fail = (what, got, want) => {
  failures++;
  console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
};
const eq = (what, got, want) => {
  if (got !== want) fail(what, got, want);
};

// ── 1. grade IS a usable Canadian trim name (16 models, measured) ──────────
// Each entry: [model, grade, expected trim, expected drivetrain]
const MEASURED_USABLE = [
  ["4Runner", "SR5", "SR5", null],
  ["Camry", "SE", "SE", null],
  ["Corolla", "L", "L", null],
  ["Corolla Cross", "L", "L", null],
  ["Grand Highlander", "XLE", "XLE", null],
  ["Highlander", "XLE", "XLE", null],
  ["Mirai", "XLE", "XLE", null],
  ["RAV4", "LE", "LE", null],
  ["RAV4 Plug-in Hybrid", "SE", "SE", null],
  ["Sequoia", "SR5", "SR5", null],
  ["Sienna", "LE", "LE", null],
  ["Tundra", "SR5", "SR5", null],
  ["Prius", "XLE", "XLE", null],
  ["Prius Plug-in Hybrid", "SE", "SE", null],
  // Toyota publishes the 2027 bZ's grade with the drivetrain attached. The
  // drivetrain has its own column and the trim must not carry it.
  ["bZ", "XLE FWD", "XLE", "FWD"],
];

console.log("1. a stub published name falls back to a usable grade");
for (const [model, grade, wantTrim, wantDt] of MEASURED_USABLE) {
  const r = resolveTrim({ publishedName: "Standard Package", grade, model, isBase: true });
  eq(`${model} (grade ${grade}) trim`, r.trim, wantTrim);
  eq(`${model} (grade ${grade}) drivetrain`, r.drivetrain, wantDt);
  if (r.refused) fail(`${model} was refused`, r.reason, "not refused");
}

// ── 2. grade is an internal code or a stub (11 models, measured) ───────────
// The row is KEPT under its stub -- for Crown and GR86 it is the only row that
// model has, and refusing it would remove the model from the catalogue. What it
// must never do is invent a name.
const MEASURED_UNUSABLE = [
  ["Crown Signia", "HI"],
  ["bZ Woodland", "MID"],
  ["C-HR", "MID"],
  ["Corolla Hatchback", "N"],
  ["Crown", "LTD"],
  ["Land Cruiser", "BX"],
  ["GR86", "BASE"],
  ["LC", "NONE"],
  ["LC Convertible", "NONE"],
  ["ES All-Electric", "STD"],
  ["ES Hybrid", "STD"],
];

console.log("2. an unusable grade keeps the stub and is reported, never guessed");
for (const [model, grade] of MEASURED_UNUSABLE) {
  eq(`usableGradeName(${grade})`, usableGradeName(grade), false);
  const r = resolveTrim({ publishedName: "Standard Package", grade, model, isBase: true });
  eq(`${model} (grade ${grade}) keeps the stub`, r.trim, "Standard Package");
  if (r.refused) fail(`${model} was refused`, r.reason, "kept, not refused");
  if (!r.reason.startsWith("unnamed base trim")) {
    fail(`${model} reports the gap`, r.reason, "unnamed base trim: …");
  }
}

// ── 3. THE 2026-08-27 LEXUS NX FIX MUST SURVIVE ───────────────────────────
// NX 350h base package P is `isBase: true, name: "Premium"` while the series
// grade reads "LUXURY". Storing it as LUXURY put a $70,878 ladder against a car
// asking $62,005 -- $12,853 above its true $58,025 MSRP. A real published name
// always wins; the stub rule must not reach it.
console.log("3. a real published name beats the grade (the 2026-08-27 NX fix)");
{
  const r = resolveTrim({ publishedName: "Premium", grade: "LUXURY", model: "NX Hybrid", isBase: true });
  eq("NX 350h base trim", r.trim, "Premium");
  if (r.trim === "LUXURY") fail("NX regressed to the grade", r.trim, "Premium");
}
{
  // The non-base sibling keeps its own published name too.
  const r = resolveTrim({ publishedName: "Luxury", grade: "LUXURY", model: "NX Hybrid", isBase: false });
  eq("NX 350h Luxury package", r.trim, "Luxury");
}
{
  // GR Corolla's base package really is named "Core" -- not a stub, so it stays.
  const r = resolveTrim({ publishedName: "Core", grade: "GR CORE", model: "GR Corolla", isBase: true });
  eq("GR Corolla base trim", r.trim, "Core");
}

// ── 4. a trim must not repeat its own model name ───────────────────────────
console.log("4. a trim does not repeat the model it sits under");
eq("Sienna XLE Mobility Package", stripModelPrefix("Sienna XLE Mobility Package", "Sienna"), "XLE Mobility Package");
eq("Sienna LE Mobility Package", stripModelPrefix("Sienna LE Mobility Package", "Sienna"), "LE Mobility Package");
eq("Sienna XSE Mobility Package", stripModelPrefix("Sienna XSE Mobility Package", "Sienna"), "XSE Mobility Package");
eq("Land Cruiser Premium Package", stripModelPrefix("Land Cruiser Premium Package", "Land Cruiser"), "Premium Package");
// A trim that IS its model name is left alone: stripping it leaves nothing, and
// an empty trim matches no listing and collides with every other trim-less row.
eq("4Runner / 4Runner", stripModelPrefix("4Runner", "4Runner"), "4Runner");
eq("Land Cruiser / Land Cruiser", stripModelPrefix("Land Cruiser", "Land Cruiser"), "Land Cruiser");
// A model whose NAME is a prefix of a longer model must not mangle its siblings.
// These are the real neighbours in the catalogue and the likeliest place for
// this rule to do damage.
eq("RAV4 / LE untouched", stripModelPrefix("LE", "RAV4"), "LE");
eq("RAV4 Plug-in Hybrid / SE untouched", stripModelPrefix("SE", "RAV4 Plug-in Hybrid"), "SE");
eq("Corolla Cross / L untouched", stripModelPrefix("L", "Corolla Cross"), "L");
eq("Corolla Hatchback / SE untouched", stripModelPrefix("SE", "Corolla Hatchback"), "SE");
// Only a WHOLE leading word matches: "Corolla" must not bite "Corolla Cross"'s
// trim, and a trim that merely starts with the same letters is left alone.
eq("partial word not stripped", stripModelPrefix("Crossover Package", "Cross"), "Crossover Package");

// ── 5. a drivetrain token belongs in the drivetrain column ─────────────────
console.log("5. a trailing drivetrain token moves to its own column");
{
  const r = resolveTrim({ publishedName: null, grade: "XLE AWD", model: "RAV4", isBase: true });
  eq("XLE AWD -> trim", r.trim, "XLE");
  eq("XLE AWD -> drivetrain", r.drivetrain, "AWD");
}
{
  // Splitting must never empty the name. "AWD" standing alone is already
  // refused upstream by the pre-existing looksLikeInternalCode -- unchanged by
  // this work -- so what matters here is the invariant, asserted directly
  // below: a row that is NOT refused always carries a non-empty trim.
  const r = resolveTrim({ publishedName: "Limited AWD", grade: "HI", model: "Crown", isBase: true });
  eq("Limited AWD -> trim", r.trim, "Limited");
  eq("Limited AWD -> drivetrain", r.drivetrain, "AWD");
}
{
  // THE INVARIANT. Across every measured fixture plus the drivetrain and
  // model-prefix shapes, a published row never comes out nameless -- an empty
  // trim matches no listing and collides with every other trim-less row for
  // that model.
  const shapes = [
    ...MEASURED_USABLE.map(([model, grade]) => ({ publishedName: "Standard Package", grade, model, isBase: true })),
    ...MEASURED_UNUSABLE.map(([model, grade]) => ({ publishedName: "Standard Package", grade, model, isBase: true })),
    { publishedName: "Premium", grade: "LUXURY", model: "NX Hybrid", isBase: true },
    { publishedName: "Sienna XLE Mobility Package", grade: "LE", model: "Sienna", isBase: false },
    { publishedName: "Land Cruiser Premium Package", grade: "BX", model: "Land Cruiser", isBase: false },
    { publishedName: null, grade: "XLE AWD", model: "RAV4", isBase: true },
    { publishedName: "AWD", grade: "AWD", model: "Prius", isBase: true },
  ];
  let nameless = 0;
  for (const sh of shapes) {
    const r = resolveTrim(sh);
    if (!r.refused && !String(r.trim || "").trim()) {
      nameless++;
      fail(`published with an empty trim: ${JSON.stringify(sh)}`, r, "a non-empty trim or refused");
    }
  }
  eq("no published row is nameless", nameless, 0);
}
{
  // A drivetrain token INSIDE a name is not a suffix and must not be touched.
  const r = resolveTrim({ publishedName: "TRD Off Road Premium", grade: "SR5", model: "4Runner", isBase: false });
  eq("interior tokens untouched", r.trim, "TRD Off Road Premium");
}

// ── 6. the batch rule: a stub never sits beside the same car, better named ──
console.log("6. a stub row is dropped only when the same car is there under a real name");
{
  // GR Corolla, measured: two model codes, one car, $50,295 twice.
  const { rows, dropped } = dropStubDuplicates([
    { year: 2026, model: "GR Corolla", trim: "Standard Package", msrp: 50295 },
    { year: 2026, model: "GR Corolla", trim: "Core", msrp: 50295 },
  ]);
  eq("GR Corolla collapses to one row", rows.length, 1);
  eq("the surviving row is the named one", rows[0].trim, "Core");
  eq("the drop is reported", dropped.length, 1);
}
{
  // Crown and GR86: the stub row is the ONLY row for that model. It must stay,
  // or the model leaves the catalogue.
  const { rows, dropped } = dropStubDuplicates([
    { year: 2027, model: "Crown", trim: "Standard Package", msrp: 55365 },
    { year: 2027, model: "GR86", trim: "Standard Package", msrp: 33400 },
  ]);
  eq("a lone stub row is kept", rows.length, 2);
  eq("nothing reported dropped", dropped.length, 0);
}
{
  // Two genuinely different trims at the same price are common and legitimate --
  // Jeep Gladiator Rubicon and Mojave are both $65,495. Neither is a stub, so
  // this rule must not be able to reach them.
  const { rows, dropped } = dropStubDuplicates([
    { year: 2026, model: "Gladiator", trim: "Rubicon", msrp: 65495 },
    { year: 2026, model: "Gladiator", trim: "Mojave", msrp: 65495 },
  ]);
  eq("real trims colliding on price are untouched", rows.length, 2);
  eq("nothing reported dropped", dropped.length, 0);
}
{
  // A stub at a DIFFERENT price is a different car and must survive.
  const { rows } = dropStubDuplicates([
    { year: 2026, model: "Highlander", trim: "Standard Package", msrp: 51535 },
    { year: 2026, model: "Highlander", trim: "XLE", msrp: 57000 },
  ]);
  eq("a stub at its own price is kept", rows.length, 2);
}

// ── 7. the stub vocabulary itself ─────────────────────────────────────────
console.log("7. the stub vocabulary");
for (const g of ["Standard Package", "standard package", "  Standard  ", "Base", "Base Package"]) {
  if (!isGenericPackageLabel(g)) fail(`isGenericPackageLabel(${JSON.stringify(g)})`, false, true);
}
for (const real of ["Premium", "Core", "XSE Technology Package", "Limited", "SR5", "Nightshade Package"]) {
  if (isGenericPackageLabel(real)) fail(`isGenericPackageLabel(${JSON.stringify(real)})`, true, false);
}

// ── result ────────────────────────────────────────────────────────────────
if (failures) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log(
  `\nOK — ${MEASURED_USABLE.length} measured grades resolve to a real trim, ` +
  `${MEASURED_UNUSABLE.length} unusable grades keep their stub and are reported, ` +
  `the 2026-08-27 NX fix holds, and the batch rule cannot reach a real trim.`
);
