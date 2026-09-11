// GATE: the daily MSRP report must not go blind.
//
// scripts/daily-msrp-report.mjs decides which makes the refresh ATTEMPTS by
// parsing the guard arguments out of .github/workflows/catalog-refresh.yml.
// That is deliberate — a hardcoded list in the report would have been written
// from the same wrong assumption that hid Jaguar, Land Rover and Mitsubishi for
// 34 days, agreed with itself, and reported all clear.
//
// But a parser has its own failure mode, and it is worse than the bug it fixes.
// Reformat that workflow — single quotes instead of double, a line break inside
// a step, a switch to a matrix like catalog-rates-daily.yml already uses — and
// the regex quietly matches nothing. The report then believes ZERO makes are
// wired and prints all 32 under "NEVER REFRESHED", which is a catastrophic
// false alarm: the reader sees the whole catalog condemned, disbelieves it,
// and stops reading the report on the morning it is finally telling the truth.
// A monitor that can fail into total alarm is not safer than no monitor.
//
// This runs offline against the real workflow files. It makes no network call
// and reads no database, so it can sit in the same gate set as everything else.
//
// Run: npm run test:msrp-report

import { readFileSync, readdirSync } from "node:fs";
import { wiredMakes, ratesMakes } from "./daily-msrp-report.mjs";

const WF = ".github/workflows/catalog-refresh.yml";
const RATES_WF = ".github/workflows/catalog-rates-daily.yml";

let failed = 0;
const fail = (msg, detail) => {
  failed++;
  console.error(`FAIL  ${msg}`);
  if (detail) console.error(`      ${detail}`);
};
const pass = (msg) => console.log(`ok    ${msg}`);

// ---- 1. the parser still sees the workflow --------------------------------
// A floor, not an exact count: adding a make must not break the gate, but
// losing most of them must. 20 is well under today's 29 and far above zero.
const FLOOR = 20;
const wired = wiredMakes(WF);
if (!wired) {
  fail(`${WF} could not be read at all`, "the report would exit 1 rather than mislead, but this still needs fixing");
} else if (wired.size < FLOOR) {
  fail(`only ${wired.size} make(s) parsed out of ${WF} — expected at least ${FLOOR}`,
    "the guard-argument format changed and the report now believes almost nothing is wired, " +
    "which makes it print every make as NEVER REFRESHED. Update the parser in daily-msrp-report.mjs.");
} else {
  pass(`${wired.size} makes parsed from ${WF}`);
}

// ---- 2. the makes it finds are plausibly makes ----------------------------
// A regex that starts matching the wrong thing produces entries like "required"
// or "" and they would be silently compared against the catalog and never
// match, turning every real make into "not wired".
if (wired) {
  const junk = [...wired.values()].filter((w) => !/^[A-Za-z][A-Za-z0-9 .&-]{1,24}$/.test(w.make));
  if (junk.length) fail(`parsed ${junk.length} entries that are not make names`, junk.map((j) => JSON.stringify(j.make)).join(", "));
  else pass("every parsed entry looks like a make name");

  // Anchors. These four have had a scraper and a step continuously since the
  // guard was introduced; if the parser stops finding them the format moved.
  const missing = ["toyota", "honda", "ford", "chevrolet"].filter((k) => !wired.has(k));
  if (missing.length) fail(`known-wired makes went missing from the parse: ${missing.join(", ")}`);
  else pass("anchor makes (Toyota, Honda, Ford, Chevrolet) all parsed");

  // The required/optional distinction is load-bearing: GM is msrp=optional by
  // documented design, and a parser that flattens the level would report GM as
  // a hard failure every morning.
  const levels = new Set([...wired.values()].map((w) => w.msrp));
  if (!levels.has("required")) fail("no make parsed as msrp=required", `levels seen: ${[...levels].join(", ")}`);
  else pass(`msrp levels parsed: ${[...levels].filter(Boolean).sort().join(", ")}`);
}

// ---- 3. the rates workflow parser too -------------------------------------
const rates = ratesMakes(RATES_WF);
if (!rates) fail(`${RATES_WF} could not be read`);
else if (rates.size < 10) fail(`only ${rates.size} make(s) parsed out of ${RATES_WF} — expected at least 10`,
  "the matrix format changed; the report's rates footer will understate coverage");
else pass(`${rates.size} makes parsed from ${RATES_WF}`);

// ---- 4. BUILT BUT NEVER WIRED ---------------------------------------------
// The other half of the same defect. Jaguar was never built; the opposite case
// is a scraper that exists in scripts/ and is referenced by no workflow at all,
// so it runs never and nobody notices because nothing failed. Checked against
// every workflow file, since rates and MSRP live in different ones.
const wfDir = ".github/workflows";
const allWorkflows = readdirSync(wfDir)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  .map((f) => readFileSync(`${wfDir}/${f}`, "utf8"))
  .join("\n");

const scrapers = readdirSync("scripts").filter((f) => /^scrape-.*\.mjs$/.test(f));
const orphans = scrapers.filter((f) => !allWorkflows.includes(f));
if (orphans.length) {
  fail(`${orphans.length} scraper(s) exist but are referenced by no workflow`, orphans.join(", ") +
    "\n      A scraper nobody runs is indistinguishable from a make nobody built — which is" +
    "\n      exactly how three makes went 34 days without a read. Wire it or delete it.");
} else {
  pass(`all ${scrapers.length} scrapers are referenced by a workflow`);
}

console.log("");
if (failed) {
  console.error(`${failed} check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("daily MSRP report: parsers intact, no orphaned scrapers.");
}
