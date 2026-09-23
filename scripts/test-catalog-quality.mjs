// Regression guard for the msrp_catalog quality gate (2026-08-11 corruption).
// Run: node scripts/test-catalog-quality.mjs
//
// THE INCIDENT. Toyota's build-&-price API returns `vehicleStartPrice` — a
// CALCULATED, fee-inclusive figure (every value ended in .92) — not the
// published MSRP; and when the grade lookup failed the scraper wrote Toyota's
// internal model code ("BX", "WX", "HI") as the trim name. Both shipped into
// the live catalog and overwrote hand-verified rows. ~17% of the catalogue
// became fiction.
//
// WHAT WAS WRONG WITH THIS FILE. It declared its own `acceptCatalogRow` and
// imported nothing. Measured 2026-09-22: replacing the production rejection in
// gateMsrpRows with `if (false)` — deleting the quality gate that every make's
// write path runs through — left this file reporting 8/8 all green, and all
// 136 gates declared in gates.yml green with it. Nothing caught it.
//
// Its comment said "Mirrors the gate in scripts/lib/tci-stack.mjs". The rule is
// not in tci-stack.mjs and the price half never was; it is gateMsrpRows in
// catalog-io.mjs, called from writeCatalogs for every make.
//
// And the replica was not a faithful mirror, it was WEAKER: it accepted msrp 0
// and negative prices, which gateMsrpRows has always rejected. A copy does not
// merely fail to catch a regression — it quietly documents the wrong rule, and
// a reader checking "what does the catalogue refuse?" gets the wrong answer
// from the file whose whole job is to answer that.
//
// So this file imports the production functions. Delete either one and it
// throws on load rather than passing.
import { readFileSync } from "node:fs";
import { gateMsrpRows } from "./lib/catalog-io.mjs";
import { usableGradeName, resolveTrim } from "./lib/tci-stack.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`ok    ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "\n       " + detail : ""}`); }
};

// gateMsrpRows warns to the console for every dropped row; that is right in a
// refresh log and noise here.
function accepts(row) {
  const warn = console.warn;
  console.warn = () => {};
  try { return gateMsrpRows([row], "TestMake").length === 1; }
  finally { console.warn = warn; }
}

// ---- the price half: what the live write path actually refuses -------------
// A published Canadian MSRP is a whole-dollar figure, so a fractional value
// proves the source handed us a computed price.
{
  const CASES = [
    ["a real Canadian MSRP", { msrp: 90615 }, true],
    ["the exact corrupted row", { msrp: 83586.92 }, false],
    ["another observed corruption", { msrp: 74796.92 }, false],
    ["the GR86 corrupted row", { msrp: 39846.92 }, false],
    ["a zero-decimal float is a whole dollar", { msrp: 75450.0 }, true],
    ["no price at all", { msrp: null }, false],
    // The four the replica got WRONG. It accepted all of them.
    ["zero is not a price", { msrp: 0 }, false],
    ["a negative price", { msrp: -4500 }, false],
    ["a non-numeric price", { msrp: "ask us" }, false],
    ["an undefined price", { msrp: undefined }, false],
  ];
  for (const [label, row, want] of CASES) {
    const got = accepts(row);
    check(`${label} -> ${want ? "kept" : "dropped"}`, got === want,
      got ? "the write path kept it" : "the write path dropped it");
  }

  // Dropping is per-row, not all-or-nothing: one bad row must not take a
  // make's whole refresh with it, and must not be silently rounded either.
  const warn = console.warn; console.warn = () => {};
  const kept = gateMsrpRows(
    [{ msrp: 45000, model: "RAV4" }, { msrp: 83586.92, model: "Land Cruiser" }, { msrp: 62150, model: "Highlander" }],
    "Toyota");
  console.warn = warn;
  check("a mixed batch keeps the good rows and drops only the computed one",
    kept.length === 2 && kept.every((r) => Number.isInteger(r.msrp)),
    `kept ${kept.length}: ${kept.map((r) => `${r.model} ${r.msrp}`).join(", ")}`);
}

// ---- the trim half: an internal code never reaches a window sticker --------
// The replica's rule was "no grade -> reject the row". That is not what
// production does and never was: where a grade cannot name the car the stub is
// KEPT, because for Crown and GR86 the stub row is the only row those models
// have and refusing it would drop the model from the catalogue entirely.
//
// The real guarantee is narrower and stronger — the internal code does not
// become the trim.
{
  for (const code of ["BX", "WX", "HI"]) {
    check(`the internal code ${code} is not a trim name`, usableGradeName(code) === false);
  }
  // A SECOND list, and it needed its own cases. BX/WX/HI are caught by
  // looksLikeInternalCode; these are caught by GRADE_STUBS, a separate set that
  // exists because looksLikeInternalCode deliberately lets LTD and BASE through
  // (they are genuine trims on other makes) and its regex cannot see a single
  // character, so "N" passes it. Emptying that set broke production while this
  // suite stayed green, because every case here happened to exercise the other
  // list. Measured in this suite's own mutation run.
  for (const stub of ["NONE", "STD", "BASE", "LTD", "N", "TBD", "N/A"]) {
    check(`the stub grade ${stub} is not a trim name`, usableGradeName(stub) === false,
      "Crown's grade is LTD, GR86's is BASE, Corolla Hatchback's is N — publishing any of them puts a code on a window sticker");
  }
  for (const real of ["XLE", "SR5", "Premium Package", "XLE FWD"]) {
    check(`the published trim ${real} is usable`, usableGradeName(real) === true);
  }

  const r = resolveTrim({ publishedName: "Standard Package", grade: "WX", model: "Land Cruiser", isBase: true });
  check("a failed grade lookup never writes the internal code as the trim",
    r.trim !== "WX" && !/^[A-Z]{2}$/.test(String(r.trim || "")),
    JSON.stringify(r));
  check("...and says so, rather than looking like a published name",
    /grade is not a trim name/.test(r.reason || ""), r.reason);

  const good = resolveTrim({ publishedName: "Premium Package", grade: "XLE", model: "RAV4", isBase: false });
  check("a real published name still comes through untouched",
    good.trim === "Premium Package" && good.refused !== true, JSON.stringify(good));
}

// ---- the rule must still be REACHED ---------------------------------------
// A quality gate nobody calls is the built-but-unwired shape, and it fails
// exactly the way a replica does: silently, with everything green.
//
// Searching the source for the call is not enough: commenting the line out
// leaves the text in the file and a substring match still passes. That was a
// real miss in this suite's own mutation run — a guard bound to spelling inside
// the gate written about a replica. The line has to be LIVE.
{
  const io = readFileSync(new URL("./lib/catalog-io.mjs", import.meta.url), "utf8");
  const live = io.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => !l.startsWith("//") && !l.startsWith("*"))
    .some((l) => /^msrpRows\s*=\s*gateMsrpRows\(msrpRows, make\)\s*;?$/.test(l));
  check("writeCatalogs runs every make's MSRP rows through the gate",
    live, "the gate exists but nothing on the write path calls it");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
