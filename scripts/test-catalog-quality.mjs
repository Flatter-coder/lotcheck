// Regression guard for the msrp_catalog quality gate (2026-08-11 corruption).
// Run: node scripts/test-catalog-quality.mjs
//
// The bug: Toyota's build-&-price API returns `vehicleStartPrice` — a
// CALCULATED, fee-inclusive figure (every value ended in .92) — not the
// published MSRP; and when the grade lookup failed the scraper wrote Toyota's
// internal model code ("BX", "WX", "HI") as the trim name. Both shipped into
// the live catalog and overwrote hand-verified rows.
//
// These rules are the durable fix. If a future change lets either class of bad
// row through again, this goes red first.

// Mirrors the gate in scripts/lib/tci-stack.mjs.
export function acceptCatalogRow({ msrp, grade }) {
  if (msrp == null) return { ok: false, why: "no price" };
  if (!Number.isInteger(Number(msrp))) return { ok: false, why: "fractional price (calculated, not MSRP)" };
  if (!grade) return { ok: false, why: "no marketing trim (would fall back to an internal code)" };
  return { ok: true };
}

const CASES = [
  ["real Canadian MSRP + grade", { msrp: 90615, grade: "Premium Package" }, true],
  ["the exact corrupted row", { msrp: 83586.92, grade: null }, false],
  ["fractional price even WITH a grade", { msrp: 83586.92, grade: "Premium Package" }, false],
  ["whole price but no grade (would write 'WX')", { msrp: 83586, grade: null }, false],
  ["another observed corruption", { msrp: 74796.92, grade: null }, false],
  ["GR86 corrupted row", { msrp: 39846.92, grade: null }, false],
  ["missing price", { msrp: null, grade: "XLE" }, false],
  ["zero-decimal float is fine", { msrp: 75450.0, grade: "1958" }, true],
];

let pass = 0, fail = 0;
for (const [label, row, want] of CASES) {
  const got = acceptCatalogRow(row).ok;
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} -> ${got ? "accepted" : "rejected"}${ok ? "" : `  (wanted ${want ? "accepted" : "rejected"})`}`);
  ok ? pass++ : fail++;
}
console.log(`
${pass}/${pass + fail} passed${fail ? "  -- FAILING" : "  all green"}`);
process.exit(fail ? 1 : 0);
