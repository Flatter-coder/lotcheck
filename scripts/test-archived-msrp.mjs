#!/usr/bin/env node
// THE ARCHIVED-MSRP PARSER, PINNED TO LADDERS THAT WERE READ BY HAND.
//
// An archived MSRP is the denominator of every price comparison we make about a
// used car, and unlike a live scrape there is nothing to cross-check it against
// tomorrow: the page will say the same thing forever, right or wrong. So the
// parser is pinned here against three real Toyota releases whose full grade
// ladders were read off the page independently before this code existed.
//
// The fixtures are the TEXT of those releases, committed, so this runs offline
// and cannot go green because a network call quietly returned nothing.
//
// Run: node scripts/test-archived-msrp.mjs
import { parseGrades, modelFromTitle } from "./scrape-archived-toyota.mjs";
import { readPrice, readModelYear, archivedRow, plausibleVehiclePrice, BASIS } from "./lib/archived-msrp.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (detail ? "\n       " + detail : "")); }
};

console.log("-- the model year comes from the vehicle's name, never the folder --");
// media.toyota.ca files the MY2020 RAV4 launch under /releases/2019/. Reading
// the folder would put every archived price a year out.
ok("MY2020 read from the headline", readModelYear("Ignite your desire to explore in the 2020 Toyota RAV4") === 2020);
ok("MY2018 read from the headline", readModelYear("The 2018 Toyota Highlander: what road trips were meant to be") === 2018);
ok("a headline with no year yields null", readModelYear("Toyota Canada announces pricing") === null);
ok("model parsed off the headline", modelFromTitle("Ignite your desire to explore in the 2020 Toyota RAV4") === "RAV4");
ok("model stops before prose", modelFromTitle("The 2018 Toyota Highlander is here") === "Highlander");

console.log("-- a price is a price, and nothing else is --");
ok("reads a comma price", readPrice("(starting MSRP: $28,090)") === 28090);
ok("refuses a freight figure", readPrice("$1,770") === null);
ok("refuses a bare year", readPrice("in 2020") === null);
ok("refuses nothing at all", readPrice("no price here") === null);
ok("a plausible vehicle price band", plausibleVehiclePrice(28090) && !plausibleVehiclePrice(1770) && !plausibleVehiclePrice(900000));

console.log("-- MY2020 RAV4: the drivetrain split is one grade, two prices --");
{
  // Verbatim from https://media.toyota.ca/en/releases/2019/ignite-your-desire-to-explore-in-the-2020-toyota-rav4.html
  const text = [
    "The 2020 Toyota RAV4 LE is offered in a choice of FWD (starting MSRP: $28,090), and AWD (starting MSRP: $30,190) drivetrain configurations.",
    "The 2020 Toyota RAV4 XLE is offered in a choice of FWD (starting MSRP: $31,690, and AWD (starting MSRP: $33,790) drivetrain configurations.",
    "The AWD version of this model may be further enhanced as the 2020 Toyota RAV4 XLE Premium (starting MSRP: $36,590).",
    "The 2020 Toyota RAV4 TRAIL (starting MSRP: $38,890) is an AWD model designed for life off the beaten track.",
    "This model may be further enhanced as the 2020 Toyota RAV4 TRD Off-Road (starting MSRP: $41,790).",
    "The 2020 Toyota RAV4 Limited (starting MSRP: $41,250) is an AWD model.",
    "The 2020 Toyota RAV4 Hybrid LE (starting MSRP: $32,350) brings the advanced power of Hybrid Synergy Drive.",
  ].join("\n");
  const got = new Map(parseGrades(text, "RAV4").map((g) => [g.trim, g.msrp]));
  ok("LE splits into FWD and AWD, not a bare 'AWD'", got.get("LE FWD") === 28090 && got.get("LE AWD") === 30190,
     JSON.stringify([...got]));
  // The source itself has an unclosed bracket on the XLE line. A parser that
  // needed well-formed punctuation would drop a whole grade over a typo.
  ok("a missing bracket in the source does not lose the grade", got.get("XLE FWD") === 31690 && got.get("XLE AWD") === 33790);
  ok("XLE Premium is its own grade", got.get("XLE Premium") === 36590);
  ok("TRAIL and TRD Off-Road are read", got.get("TRAIL") === 38890 && got.get("TRD Off-Road") === 41790);
  ok("Limited is read", got.get("Limited") === 41250);
  ok("the hybrid grade keeps its Hybrid prefix", got.get("Hybrid LE") === 32350);
  ok("the model name is never repeated into the trim", ![...got.keys()].some((t) => /^RAV4\b/i.test(t)), [...got.keys()].join(" | "));
}

console.log("-- MY2018 Highlander: the OTHER way Toyota writes a split --");
{
  // Verbatim from the 2018 Highlander release. Spelled-out drivetrains, and
  // "available in both" rather than "offered in a choice of". Matching only the
  // MY2020 phrasing silently lost the base grade of every older release.
  const text = [
    "The 2018 Toyota Highlander LE is available in both front-wheel-drive (Starting MSRP: $36,150) and all-wheel-drive (Starting MSRP: $38,645) configurations.",
    "The 2018 Toyota Highlander XLE AWD (Starting MSRP: $44,645) features the Engine Stop and Start System.",
    "The 2018 Toyota Highlander Hybrid XLE (Starting MSRP: $50,635) features a display audio system.",
  ].join("\n");
  const got = new Map(parseGrades(text, "Highlander").map((g) => [g.trim, g.msrp]));
  ok("spelled-out front-wheel-drive becomes FWD", got.get("LE FWD") === 36150, JSON.stringify([...got]));
  ok("spelled-out all-wheel-drive becomes AWD", got.get("LE AWD") === 38645);
  ok("a grade that already names its drivetrain is left alone", got.get("XLE AWD") === 44645);
  ok("Hybrid XLE is read", got.get("Hybrid XLE") === 50635);
}

console.log("-- a row is refused unless every part of it is established --");
{
  const base = { year: 2020, make: "Toyota", model: "RAV4", trim: "LE FWD", msrp: 28090,
                 basis: BASIS.EXCL_FREIGHT, sourceUrl: "https://media.toyota.ca/en/releases/2019/x.html", capturedOn: "2026-09-03" };
  ok("a complete row is built", archivedRow(base) !== null);
  ok("no model year, no row", archivedRow({ ...base, year: null }) === null);
  ok("no trim, no row", archivedRow({ ...base, trim: "" }) === null);
  ok("a freight-sized number is not an MSRP", archivedRow({ ...base, msrp: 1770 }) === null);
  // The rule that decides whether we may publish at all: a price whose basis we
  // cannot name would be wrong by roughly freight+PDI, in the dealer's favour.
  ok("a price with no nameable basis is refused", archivedRow({ ...base, basis: "unknown" }) === null);
  ok("a row with no source URL is refused", archivedRow({ ...base, sourceUrl: null }) === null);
  ok("a row with no capture date is refused", archivedRow({ ...base, capturedOn: null }) === null);
  ok("the basis stored is ex-freight", archivedRow(base).price_basis === "excl_freight");
  ok("the source URL rides with the row", archivedRow(base).source_url === base.sourceUrl);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
