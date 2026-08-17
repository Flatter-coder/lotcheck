// Locks the Alberta dealer-map refresh against the two ways it could publish a
// number nobody read.
//
// 1. THE OUTPUT FLOOR. update-alberta-dealers.mjs floored the Overpass response
//    and the geocodable subset, then wrote a third number it never checked: the
//    count surviving the bin-to-nearest-city step. A run where every dealer
//    falls outside MAX_KM passes both existing floors and commits
//    `"totalDealers": 0` with exit 0. And an absolute floor of 50 is ~12% of a
//    normal run, so 405 -> 51 clears it — the catalog-refresh collapse again.
//
// 2. THE LIVE BADGE. public/alberta.html shipped `class="pill live"` in static
//    markup, so it read "Live dealers" before the fetch resolved, after it
//    failed, and over the invented counts the failure path used to render. The
//    counts themselves were a frozen snapshot summing to 527 against a real 405,
//    claiming 24 dealerships in Grande Prairie where OpenStreetMap finds 2.
//    A lit dot is a claim; it may only be added by JS after a successful read.
//
// Run: node scripts/test-alberta-dealers.mjs
import { readFileSync } from "node:fs";
import { assertOutputSane } from "./lib/dealer-output-guard.mjs";

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`  ✅ ${name}`); };
const bad = (name, why) => { fail++; console.error(`  ❌ ${name}\n       ${why}`); };

function refuses(name, args) {
  try { assertOutputSane({ minFloor: 50, maxKm: 35, outPath: "public/data/alberta-dealers.json", ...args }); }
  catch { return ok(name); }
  bad(name, "expected a refusal, but the write was allowed");
}
function allows(name, args) {
  try {
    assertOutputSane({ minFloor: 50, maxKm: 35, outPath: "public/data/alberta-dealers.json", ...args });
    return ok(name);
  } catch (e) { bad(name, `expected the write to be allowed, got: ${e.message}`); }
}

console.log("output guard — refusals");
// The motivating case: the fetch worked perfectly, binning threw it all away.
refuses("700 dealers all outside MAX_KM -> 0 assigned is refused",
  { assigned: 0, examined: 700, prevTotal: 405 });
refuses("51 assigned against a previous 405 is refused (clears the absolute floor, is still a collapse)",
  { assigned: 51, examined: 700, prevTotal: 405 });
refuses("a 50%+ drop is refused even well above the floor",
  { assigned: 202, examined: 420, prevTotal: 405 });
refuses("below the absolute floor is refused on a first run too",
  { assigned: 12, examined: 700, prevTotal: null });
refuses("a non-numeric count is refused",
  { assigned: NaN, examined: 700, prevTotal: 405 });

console.log("output guard — allowed");
allows("a normal week (405 vs 404) is allowed",
  { assigned: 405, examined: 443, prevTotal: 404 });
allows("a 48% drop is allowed — the guard refuses collapse, not change",
  { assigned: 211, examined: 420, prevTotal: 405 });
allows("a first run with no previous file is allowed",
  { assigned: 405, examined: 443, prevTotal: null });
allows("growth is allowed",
  { assigned: 900, examined: 950, prevTotal: 405 });

console.log("alberta.html — a lit dot must be earned");
const html = readFileSync("public/alberta.html", "utf8");

// The badge must ship neutral. Any `pill live` in the markup is the old defect.
if (/<span[^>]*class="[^"]*\bpill\b[^"]*\blive\b/.test(html))
  bad("no badge ships with .live in static markup", "found a `pill live` span — it must be added by JS after a successful read");
else ok("no badge ships with .live in static markup");

// The dealer pill must be reachable from JS at all — the old one had no id.
if (/id="dealerPill"/.test(html)) ok("the dealer badge has an id, so JS can gate it");
else bad("the dealer badge has an id, so JS can gate it", "no #dealerPill found");

// The fabricated counts must not come back.
const citiesBlock = html.slice(html.indexOf("var CITIES=["), html.indexOf("].map(function(c,i)"));
if (/\["[^"]+",[-0-9.]+,[-0-9.]+,\s*\d+\]/.test(citiesBlock))
  bad("CITIES carries coordinates only", "a fourth numeric field is back — that is a hardcoded dealer count");
else ok("CITIES carries coordinates only");

// A silent catch is how the invented numbers stayed on screen.
if (/\.catch\(function\(\)\{\}\)/.test(html))
  bad("the dealer fetch has no empty catch", "found `.catch(function(){})` — a failure must reach the UI");
else ok("the dealer fetch has no empty catch");

// Shape validation is what catches vercel.json's SPA rewrite handing back HTML
// with a 200. Without it, a missing data file can never present as a failure.
if (/typeof\s+data\.totalDealers\s*!==\s*"number"/.test(html))
  ok("the response shape is validated, so a 200 carrying app.html is caught");
else bad("the response shape is validated", "no totalDealers type check — an HTML body would pass as data");

console.log(`\n${fail ? "❌" : "✅"} alberta-dealers: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
