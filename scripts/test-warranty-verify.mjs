// GATE: the warranty verifier confirms what is there, and never invents a fix.
//
// manufacturer_warranties is hand-written and had NO refresh job of any kind --
// 35 makes of figures we publish about specific vehicles, none of which had ever
// been re-checked against the page they came from. The Tesla row is what that
// costs: "8-year/160,000 km (battery & drive unit, varies by model)" is the
// Extended Service Agreement ceiling, not the battery term, and on a 2020 Model
// X at 198,909 km we told a buyer the cover was gone when it had 41,091 km left.
//
// Two properties matter more than accuracy here, and both are tested:
//
//   1. A FAILED FETCH IS NOT DRIFT. "We could not read the manufacturer's page"
//      and "the manufacturer no longer says this" are different sentences, and
//      collapsing them is the exact defect class the 2026-09-13 audit was about.
//   2. IT NEVER RETURNS A CORRECTED VALUE. A regex confident enough to overwrite
//      a warranty term is confident enough to invent one.
//
// Offline. No network, no database.
//
// Run: npm run test:warranty-verify

import { parseTerm, pairOnPage, verifyField, verifyRow, normalizePage }
  from "./lib/warranty-verify.mjs";

let failed = 0;
const fail = (m, d) => { failed++; console.error(`FAIL  ${m}`); if (d) console.error(`      ${d}`); };
const ok = (m) => console.log(`ok    ${m}`);
const check = (m, c, d) => c ? ok(m) : fail(m, d);

/* ── 0. the checker bites ────────────────────────────────────────────────── */
console.log("\npart 0 -- the matcher itself");
{
  const yes = pairOnPage({ years: 4, km: 80000 }, "Basic coverage is 4 years or 80,000 km, whichever comes first.");
  const no = pairOnPage({ years: 4, km: 80000 }, "Basic coverage is 3 years or 60,000 km, whichever comes first.");
  if (yes && !no) ok("a real term matches and a changed one does not");
  else { console.error("FATAL the matcher cannot tell a match from a miss."); process.exit(1); }

  // The rule that stops it from confirming everything: two numbers that merely
  // both appear on a long page prove nothing about the coverage.
  const scattered = "Our 4 dealerships serve Alberta. Finance from $80,000 km-free leases available.";
  check("two numbers far apart on a page do NOT confirm a term",
    !pairOnPage({ years: 4, km: 80000 }, "In 4 sections below we cover service. " + "x".repeat(300) + " 80,000 km of towing."),
    "the proximity window is not doing its job");
  check("unrelated copy containing both numbers does not confirm", !pairOnPage({ years: 4, km: 80000 }, scattered), scattered);
}

/* ── 1. every real stored shape parses ───────────────────────────────────── */
console.log("\npart 1 -- our own stored values parse");
{
  const REAL = [
    ["4-year/80,000 km", [{ years: 4, km: 80000 }]],
    ["6-year/110,000 km", [{ years: 6, km: 110000 }]],
    ["6-year/unlimited km", [{ years: 6, km: "unlimited" }]],
    ["12-year/unlimited km", [{ years: 12, km: "unlimited" }]],
    ["10-year/160,000 km", [{ years: 10, km: 160000 }]],
    ["8-year/160,000 km (components), 10-year/240,000 km (battery)",
      [{ years: 8, km: 160000 }, { years: 10, km: 240000 }]],
    ["8-year/160,000 km (battery & drive unit, varies by model)", [{ years: 8, km: 160000 }]],
  ];
  for (const [term, want] of REAL) {
    const got = parseTerm(term).pairs;
    check(`parses ${JSON.stringify(term)}`,
      JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);
  }
}

/* ── 2. manufacturers phrase it many ways; the numbers do not vary ───────── */
console.log("\npart 2 -- phrasing varies, the numbers do not");
{
  const PHRASINGS = [
    "Comprehensive coverage: 4 years or 80,000 km",
    "4-year/80,000 km new vehicle limited warranty",
    "48 months/80,000 km, whichever occurs first",
    "80,000 km / 4 years basic warranty",
    "Basic 4 yrs 80000 km",
  ];
  for (const p of PHRASINGS) {
    check(`matches ${JSON.stringify(p.slice(0, 44))}`, pairOnPage({ years: 4, km: 80000 }, p), p);
  }
  check("unlimited distance is recognised",
    pairOnPage({ years: 12, km: "unlimited" }, "Corrosion perforation: 12 years, unlimited distance."));
}

/* ── 3. THE RULE: a failed fetch is not drift ────────────────────────────── */
console.log("\npart 3 -- we could not look is not they no longer say it");
{
  const row = { make: "Audi", basic_coverage: "4-year/80,000 km", source_url: "https://www.audi.ca/x" };
  const unreachable = verifyRow(row, null);
  check("a null page reports unreachable, never drifted", unreachable.status === "unreachable", unreachable.status);
  check("...and says the stored figures are unchanged",
    /unchanged and unverified/.test(unreachable.note), unreachable.note);

  const gone = verifyRow(row, "Basic coverage is now 3 years or 60,000 km.");
  check("a page that genuinely changed reports drifted", gone.status === "drifted", gone.status);
  check("...and names the field and the stored value",
    /basic_coverage="4-year\/80,000 km"/.test(gone.note), gone.note);

  check("the two states are distinguishable", unreachable.status !== gone.status);
}

/* ── 4. it never returns a correction ────────────────────────────────────── */
console.log("\npart 4 -- drift is reported, never repaired");
{
  const row = { make: "Tesla", powertrain_coverage: "8-year/160,000 km", source_url: "https://tesla.com/x" };
  const r = verifyRow(row, "Battery and Drive Unit Limited Warranty: 8 years or 240,000 km.");
  check("drift detected when the real term differs", r.status === "drifted", r.status);
  const blob = JSON.stringify(r);
  check("the result carries NO replacement figure", !/240000|240,000/.test(blob),
    "a verifier that returns the number it found is one edit away from writing it");
  check("...and says a human must fix it", /human must re-read/.test(r.note), r.note);
}

/* ── 5. the multi-pair trap — the expensive half is the second one ───────── */
console.log("\npart 5 -- every pair is checked, not just the first");
{
  const row = {
    make: "Lexus", source_url: "https://lexus.ca/x",
    hybrid_ev_coverage: "8-year/160,000 km (components), 10-year/240,000 km (battery)",
  };
  const halfRight = verifyRow(row,
    "Hybrid components are covered 8 years or 160,000 km. Battery: 10 years or 200,000 km.");
  check("a term whose SECOND pair moved is drifted, not confirmed",
    halfRight.status === "drifted", halfRight.status);

  const bothRight = verifyRow(row,
    "Hybrid components: 8 years/160,000 km. Hybrid battery: 10 years/240,000 km.");
  check("both pairs present confirms", bothRight.status === "confirmed", JSON.stringify(bothRight.fields));
}

/* ── 6. absent is not failure, and a sourceless row is its own state ─────── */
console.log("\npart 6 -- absent, empty and sourceless");
{
  const nulls = verifyRow(
    { make: "Mitsubishi", basic_coverage: "5-year/100,000 km", corrosion_coverage: null, source_url: "https://x.ca" },
    "Basic: 5 years or 100,000 km.");
  check("a NULL field is absent, not drifted", nulls.status === "confirmed", nulls.status);
  check("...and absent fields are not counted as figures",
    nulls.fields.corrosion_coverage.state === "absent", nulls.fields.corrosion_coverage.state);

  const noSrc = verifyRow({ make: "X", basic_coverage: "4-year/80,000 km" }, "anything");
  check("a row citing nothing is its own status", noSrc.status === "no_source", noSrc.status);
  check("...and says the figure cites nothing", /cites nothing/.test(noSrc.note), noSrc.note);
}

/* ── 6b. a shell page is unreadable, not drift ───────────────────────────── */
console.log("\npart 6b -- a page with no terms at all is unreachable, not drifted");
{
  const row = { make: "Lexus", basic_coverage: "4-year/80,000 km", source_url: "https://lexus.ca/x" };
  // Long enough to look like a page, containing no warranty term whatsoever --
  // exactly what a client-rendered warranty table leaves behind.
  const shell = "Home Models Shopping Tools Offers Dealers Owners Contact Us. " .repeat(20)
    + "Explore the full lineup and book a test drive at your nearest retailer.";
  const r = verifyRow(row, shell);
  check("a shell page reports unreachable, not drifted", r.status === "unreachable", r.status);
  check("...and blames our read, not the manufacturer",
    /we did not really read it/.test(r.note), r.note);

  // But a page that genuinely discusses OTHER terms and not ours IS drift.
  const realPage = "Basic coverage: 3 years or 60,000 km. Corrosion: 5 years, unlimited distance.";
  const d = verifyRow(row, realPage);
  check("a page stating OTHER terms but not ours is drifted", d.status === "drifted", d.status);
  check("the two are distinguishable", r.status !== d.status);
}

/* ── 7. normalisation ────────────────────────────────────────────────────── */
console.log("\npart 7 -- thousands separators and dashes");
{
  check("80,000 and 80000 normalise the same",
    normalizePage("80,000 km").includes("80000"), normalizePage("80,000 km"));
  check("non-breaking space thousands separator normalises",
    normalizePage("80 000 km").includes("80000"), normalizePage("80 000 km"));
  check("an en dash is a hyphen", normalizePage("4–year").includes("4-year"));
}

console.log("");
if (failed) { console.error(`${failed} failure(s)`); process.exit(1); }
console.log("all checks passed");
