// GATE: all_in_price holds a figure the MANUFACTURER published, never one we
// assembled.
//
// THE RULE. We never sum components into an all-in price. A basis is declared
// by its source or it is absent. all_in_price is the manufacturer's own all-in
// figure for a configuration — and the report PREFERS it over msrp, because in
// AB/ON/BC/QC an advertised price is all-in by law and that is the only
// like-for-like comparison. A wrong figure in that column is a wrong over/under
// claim against a named dealer.
//
// WHAT HAPPENED. from_prices publishes ONE model code per series — the base
// configuration — and tci-stack added that stack to EVERY sibling trim's MSRP.
// Measured against the live catalogue on 2026-09-22: 39 of 40 multi-row series
// carried a perfectly CONSTANT delta, 136 rows in all.
//
// A constant is the signature of a borrowed stack, and it is arithmetically
// impossible for anything price-dependent:
//
//   Lexus LC 2026   msrp 118,180 / 133,546 / 140,410   all +7,634.62
//   Lexus LX 2026   msrp 124,300 / 143,134 / 148,600   all +8,864.62
//
// The federal luxury surcharge alone is the lesser of 10% of the price or 20%
// of the amount above $100,000. Across that LC ladder it runs about $5,200 to
// $9,600 — a spread of roughly $4,400 held flat by the stored figure. The code
// comment worried that the TIRE LEVY might vary by trim and never noticed the
// surcharge, which is the one that moves by thousands.
//
// Run: node scripts/test-all-in-not-synthesised.mjs
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`ok    ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "\n       " + detail : ""}`); }
};

const stack = readFileSync(new URL("./lib/tci-stack.mjs", import.meta.url), "utf8");

// ---- the write is scoped to the published configuration -----------------
check("the stack is only used for the config it was published for",
  /feeStack\.modelCode === modelCode/.test(stack),
  "without this, the base configuration's fees are added to every sibling trim");
check("the all-in price is gated on that scope",
  /const feeTotal = stackIsForThisConfig \?/.test(stack));
check("the breakdown is gated on the same scope",
  /const breakdown = stackIsForThisConfig \?/.test(stack),
  "a breakdown written beside no price, or vice versa, is a half-claim");
check("all_in_price is still written when the config DOES match",
  /all_in_price: Math\.round\(\(msrp \+ feeTotal\)/.test(stack),
  "the fix must not delete the column outright — the base config's figure is real and published");

// ---- the recorded basis says what is true -------------------------------
const basis = /all_in_basis:\s*"([^"]+)"/.exec(stack);
check("all_in_basis is recorded", !!basis);
check("all_in_basis no longer claims the stack applies across trims",
  !!basis && !/do not vary by trim/.test(basis[1]),
  `found: ${basis ? basis[1] : "(none)"}`);
check("all_in_basis names THIS configuration",
  !!basis && /this configuration/i.test(basis[1]),
  `found: ${basis ? basis[1] : "(none)"}`);

// ---- nothing else may synthesise an all-in price ------------------------
// The hard rule is repo-wide, not file-local.
for (const f of ["lib/tci-stack.mjs", "lib/gm-stack.mjs", "lib/fca-stack.mjs", "lib/mitsubishi-stack.mjs"]) {
  let src;
  try { src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8"); } catch { continue; }
  const body = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
  // `msrp + <anything>` assigned to all_in_price, other than the gated one.
  const writes = [...body.matchAll(/all_in_price:\s*([^,\n}]+)/g)].map((m) => m[1].trim());
  const bad = writes.filter((w) => /\+/.test(w) && !/feeTotal/.test(w));
  check(`${f}: no ad-hoc all-in arithmetic`, bad.length === 0, bad.join("; "));
}

// ---- the arithmetic the old code denied ---------------------------------
// If this ever stops being true, the constant-delta defect is defensible and
// this gate should be revisited rather than worked around.
const luxury = (p) => Math.min(p * 0.10, Math.max(0, p - 100000) * 0.20);
const lcLadder = [118180, 133546, 140410];
const spread = Math.round(luxury(lcLadder[2]) - luxury(lcLadder[0]));
check("a price-dependent charge genuinely varies across a trim ladder",
  spread > 3000,
  `the federal luxury surcharge spans about $${spread} across the 2026 LC ladder; `
  + "a single constant cannot represent it");

// ---- and the shape is detectable in data, so a regression is visible ----
// This is the check that found it. Kept as a function so the daily report or a
// future data gate can run it against the live catalogue.
export function constantDeltaGroups(rows) {
  const g = new Map();
  for (const r of rows || []) {
    if (r.all_in_price == null || r.msrp == null) continue;
    const k = `${r.make}|${r.model}|${r.year}`;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(Math.round((Number(r.all_in_price) - Number(r.msrp)) * 100) / 100);
  }
  const flagged = [];
  for (const [k, deltas] of g) {
    if (deltas.length < 2) continue;
    if (new Set(deltas).size === 1) flagged.push({ key: k, rows: deltas.length, delta: deltas[0] });
  }
  return flagged;
}

const synthetic = [
  { make: "Lexus", model: "LC", year: 2026, msrp: 118180, all_in_price: 125814.62 },
  { make: "Lexus", model: "LC", year: 2026, msrp: 133546, all_in_price: 141180.62 },
  { make: "Lexus", model: "LC", year: 2026, msrp: 140410, all_in_price: 148044.62 },
];
check("the detector finds a borrowed stack", constantDeltaGroups(synthetic).length === 1,
  JSON.stringify(constantDeltaGroups(synthetic)));
check("...and reports the constant it found",
  constantDeltaGroups(synthetic)[0]?.delta === 7634.62);
check("the detector is quiet when each row carries its own figure",
  constantDeltaGroups([
    { make: "Lexus", model: "LC", year: 2026, msrp: 118180, all_in_price: 125814.62 },
    { make: "Lexus", model: "LC", year: 2026, msrp: 140410, all_in_price: 150493.00 },
  ]).length === 0);
check("the detector needs two rows before it says anything",
  constantDeltaGroups([synthetic[0]]).length === 0,
  "one row cannot be a constant");


// ---- carry-forward must not restore an orphaned CLAIM -------------------
// attrs is a CARRY_FORWARD column holding all_in_basis, which states what the
// row's all-in figure IS. When the scraper stops writing a synthesised
// all_in_price for a sibling trim, carry-forward would restore that string,
// leaving a row describing a number it no longer has. The union branch makes it
// worse: "fresh wins per key" cannot remove a key the fresh row omits.
{
  const { mergeCarryForward } = await import("./lib/catalog-io.mjs");
  const prev = [{
    year: 2026, model: "LC", trim: "Performance Package", msrp: 133546,
    all_in_price: 141180.62, drivetrain: "RWD",
    attrs: { province: "AB", all_in_breakdown: { FPD: 2205 }, all_in_basis: "series base configuration; freight and levies do not vary by trim" },
  }];
  const fresh = [{ year: 2026, model: "LC", trim: "Performance Package", msrp: 133546 }];
  const { rows } = mergeCarryForward(fresh, prev);
  const r = rows[0];

  check("a sibling no longer inherits a synthesised all_in_price",
    r.all_in_price == null, String(r.all_in_price));
  // The EVIDENCE is kept: all_in_breakdown is the captured fee itemisation,
  // nothing buyer-facing reads it, and 38 rows carry a hand-seeded one. Only
  // the CLAIM goes. The first version of this fix stripped both and was caught
  // by test:fee-stack, whose fixture is one of those hand-seeded rows.
  check("...but the captured breakdown is KEPT — it is evidence, not a claim",
    !!r.attrs && r.attrs.all_in_breakdown !== undefined, JSON.stringify(r.attrs));
  check("...nor the basis string that described it",
    !r.attrs || r.attrs.all_in_basis === undefined, JSON.stringify(r.attrs));
  check("but the genuinely carried columns still carry",
    r.drivetrain === "RWD", "stripping the all-in keys must not cost drivetrain");
  // The strip is SURGICAL. Nulling the whole attrs object would also discard
  // province, captured_on and anything else a scraper recorded — and would pass
  // every assertion above, which is why this one exists.
  check("...and the unrelated attrs keys survive the strip",
    !!r.attrs && r.attrs.province === "AB",
    `attrs must lose only the all-in keys, not everything: ${JSON.stringify(r.attrs)}`);

  // The base configuration keeps everything — it has a published figure.
  const basePrev = [{ year: 2026, model: "LC", trim: "Standard Package", msrp: 118180,
    attrs: { province: "AB", all_in_breakdown: { FPD: 2205 }, all_in_basis: "x" } }];
  const baseFresh = [{ year: 2026, model: "LC", trim: "Standard Package", msrp: 118180, all_in_price: 125814.62 }];
  const kept = mergeCarryForward(baseFresh, basePrev).rows[0];
  check("a row WITH an all-in price keeps its breakdown",
    !!kept.attrs && kept.attrs.all_in_breakdown !== undefined, JSON.stringify(kept.attrs));
}

// The summary belongs at the END. Three suites today reported green over
// assertions appended below their own process.exit — this one included.
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
