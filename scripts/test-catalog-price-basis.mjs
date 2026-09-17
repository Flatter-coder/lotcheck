// EVERY CATALOGUE WRITER DECLARES ITS FREIGHT BASIS, OR SAYS WHY IT CANNOT.
// Run: node scripts/test-catalog-price-basis.mjs
//
// msrp_catalog.price_basis records whether a captured MSRP already contains
// freight/PDI. Until 2026-09-17 nothing that subtracted ever read it, and
// writeCatalogs() stamped one only when a scraper happened to pass opts
// .priceBasis -- 5 of 31 sources did. The result, measured live that day:
//
//     1,497 rows    854 with NO price_basis    1,016 with NO source_url
//
// written FRESH every day by 17 makes. None of that was a decision anybody
// made; it was the absence of an argument, and it read identically to a
// considered "we do not know".
//
// So writeCatalogs now REFUSES a write that says neither. This suite pins the
// call sites statically, because the runtime throw only fires for a make whose
// scraper actually runs -- a new scraper added and wired to a workflow that is
// failing for some other reason would slip through. [[run-every-gate-before-done]]
//
// A WRONG BASIS IS WORSE THAN NONE: it re-enables the subtraction on a false
// premise, and the subtraction is what accuses a dealer. This suite deliberately
// does NOT reward stamping a basis -- priceBasisUnknown passes it. What it
// refuses is silence. [[no-accusation-language]]

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const isHarness = (f) => basename(f).startsWith("test-");

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `\n        ${detail}`}`);
  cond ? pass++ : fail++;
};

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SCRIPTS = join(ROOT, "scripts");
const files = [
  ...readdirSync(SCRIPTS).filter((f) => f.endsWith(".mjs")).map((f) => join(SCRIPTS, f)),
  ...readdirSync(join(SCRIPTS, "lib")).filter((f) => f.endsWith(".mjs")).map((f) => join(SCRIPTS, "lib", f)),
];

// Find each writeCatalogs( call and take its full argument text, bracket-matched
// so a nested object cannot truncate it.
function callsIn(src) {
  const out = [];
  const NEEDLE = "writeCatalogs(";
  for (let i = src.indexOf(NEEDLE); i >= 0; i = src.indexOf(NEEDLE, i + 1)) {
    if (/[\w.]/.test(src[i - 1] || "")) continue;            // export function writeCatalogs
    let depth = 0, j = i + NEEDLE.length - 1;
    for (; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")") { depth--; if (depth === 0) break; }
    }
    out.push(src.slice(i, j + 1));
  }
  return out;
}

const RATES_ONLY = /ratesOnly\s*:/;
const DECLARED = /priceBasis\s*:|priceBasisUnknown\s*:/;
const offenders = [];
let calls = 0, declared = 0, verified = 0, unknown = 0;

for (const f of files) {
  const src = readFileSync(f, "utf8");
  // Test harnesses call writeCatalogs to exercise it; they are not sources of
  // catalogue rows and have no maker whose wording could be checked.
  if (f.endsWith("catalog-io.mjs")) continue;                 // the definition itself
  if (isHarness(f)) continue;
  for (const call of callsIn(src)) {
    calls++;
    if (DECLARED.test(call)) {
      declared++;
      if (/priceBasis\s*:/.test(call)) verified++; else unknown++;
    } else if (!RATES_ONLY.test(call)) {
      offenders.push(`${f.split(/[\/]/).slice(-2).join("/")}: ${call.replace(/\s+/g, " ").slice(0, 110)}`);
    }
  }
}

console.log(`\n  ${calls} writeCatalogs call sites — ${verified} verified basis, ${unknown} declared unknown\n`);

check("every catalogue write declares a basis or says why it cannot",
  offenders.length === 0, offenders.join("\n        "));

// The reason must be a reason, not a shrug.
const shrugs = [];
for (const f of files) {
  if (f.endsWith("catalog-io.mjs")) continue;   // its doc comment shows the shape
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/priceBasisUnknown\s*:\s*"([^"]*)"/g)) {
    if (m[1].trim().length < 25) shrugs.push(`${f.split(/[\/]/).slice(-1)[0]}: ${JSON.stringify(m[1])}`);
  }
}
check("...and an unknown basis carries a real reason, not an empty string",
  shrugs.length === 0, shrugs.join("\n        "));

// Only the two real conventions may ever be stamped.
const bad = [];
for (const f of files) {
  // Skip harnesses: this very file carries a deliberate bad-basis fixture.
  if (isHarness(f)) continue;
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/priceBasis\s*:\s*"([^"]*)"/g)) {
    if (!["excl_freight", "incl_freight"].includes(m[1])) bad.push(`${f.split(/[\/]/).slice(-1)[0]}: ${m[1]}`);
  }
}
check("only excl_freight or incl_freight may ever be stamped", bad.length === 0, bad.join(", "));

// THE RUNTIME RULE, EXERCISED RATHER THAN READ.
// The first draft of these two asserted that catalog-io.mjs CONTAINED the
// throw. Mutating `if (!opts.priceBasis && !opts.priceBasisUnknown)` to
// `if (false)` left the message string sitting in the file, so both stayed
// green over a writer that enforced nothing -- a guard bound to spelling, not
// substance, in the very suite written to stop that. Call it instead.
{
  const { writeCatalogs } = await import("../scripts/lib/catalog-io.mjs");
  const rows = [{ year: 2026, make: "Testmake", model: "Testmodel", trim: "Base", msrp: 40000 }];
  const threw = async (opts) => {
    try { await writeCatalogs("Testmake", { msrpRows: rows }, opts); return false; }
    catch { return true; }
  };
  check("writeCatalogs refuses a write that declares neither",
    await threw({}), "a silent caller must not reach the table");
  check("...and refuses a basis that is not one of the two conventions",
    await threw({ priceBasis: "sort_of_freight" }), "a typo would otherwise be stamped verbatim");
  check("...and allows a declared unknown through",
    !(await threw({ priceBasisUnknown: "a reason long enough to be a real one" })),
    "an honest unknown is the whole point; it must still write");
}

// Kia is the one verified today, and it must keep its evidence beside it.
{
  const kia = readFileSync(join(SCRIPTS, "scrape-kia.mjs"), "utf8");
  check("Kia is stamped ex-freight", /priceBasis:\s*"excl_freight"/.test(kia), "");
  check("...with the evidence recorded beside the claim",
    kia.includes("dnd") && /delivery and destination/i.test(kia) && kia.includes("Captured 2026-09-17"),
    "a stamped basis with no cited evidence is a guess that looks like a fact");
  check("...and records the URL it read", /source_url:\s*SOURCE_URL/.test(kia), "");
}

console.log(`\n${pass}/${pass + fail} passed${fail ? `  -- ${fail} FAILING` : "  all green"}`);
process.exit(fail ? 1 : 0);
