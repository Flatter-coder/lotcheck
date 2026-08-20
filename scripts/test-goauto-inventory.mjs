#!/usr/bin/env node
// ============================================================================
// Go Auto inventory reader.
//
// Go Auto is 70+ dealerships across Alberta and BC and every one was invisible
// to us: the feed probe guesses /new/, /new-inventory/ and /vehicles/new/,
// while Go Auto serves /vehicles behind an Algolia search. So all of them —
// St. Albert Honda included, the single largest gap in the province — landed
// in the 1,608 hosts recorded as "no feed detected".
//
// The fixture is REAL captured markup, kept at full size on purpose. Each card
// carries an image carousel worth ~45KB, and that bulk is not incidental: the
// first version of this parser windowed the last card at a fixed 12,000 chars,
// fell short of its price, and silently dropped one vehicle from every page.
// A trimmed fixture would not reproduce that, so it is not trimmed.
// ============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractGoAutoVehicles } from "./lib/goauto-inventory.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(root, "fixtures", "goauto-vehicles.html"), "utf8");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "\n      " + detail : ""}`); }
};

const v = extractGoAutoVehicles(html);
check("every card in the fixture is read", v.length === 4, `got ${v.length}`);

const byModel = (s) => v.find((x) => x.model_trim.includes(s));

// --- a withheld price is a finding, not a gap -------------------------------
const gated = byModel("Tucson Hybrid Ultimate");
check("a withheld price is flagged, not silently null",
  gated && gated.priceGated === true && gated.list_price === null,
  JSON.stringify(gated));
check("a gated card still yields its dealer and city",
  gated && gated.dealer === "Southtown Hyundai" && gated.city === "Edmonton",
  `dealer=${gated?.dealer} city=${gated?.city}`);

// --- the dealer name must not absorb the card's own chrome ------------------
// On a priced card the number separates label from dealer; on a gated one it
// does not, and the first version produced "Price Call for price Southtown
// Hyundai" as a dealer name.
check("no dealer name contains card chrome",
  v.every((x) => x.dealer && !/^\d|cash price|call for|finance|lease/i.test(x.dealer)),
  JSON.stringify(v.map((x) => x.dealer)));

// --- price sits AFTER the tab labels, not beside the heading ----------------
const plain = byModel("K4 LX FWD");
check("price is read past the Cash Price / Finance / Lease tabs",
  plain && plain.list_price === 26645, `got ${plain?.list_price}`);

const discounted = byModel("QX60");
check("a discount keeps both figures", 
  discounted && discounted.list_price === 68061 && discounted.was_price === 74561,
  `price=${discounted?.list_price} was=${discounted?.was_price}`);
check("the was-figure is never mistaken for the price",
  discounted && discounted.list_price < discounted.was_price,
  `${discounted?.list_price} !< ${discounted?.was_price}`);

// --- the boundary case that dropped a vehicle from every page ---------------
const last = byModel("CR-V Hybrid Sport");
check("the LAST card on a page is read (no following anchor to bound it)",
  last && last.list_price === 49584 && last.dealer === "T&T Honda" && last.city === "Calgary",
  JSON.stringify(last));

// --- city attribution is the whole point -----------------------------------
check("every vehicle carries a dealer and a city",
  v.every((x) => x.dealer && x.city), JSON.stringify(v.map((x) => [x.dealer, x.city])));
check("every vehicle is accounted for: priced or explicitly gated",
  v.every((x) => x.list_price !== null || x.priceGated),
  JSON.stringify(v.map((x) => [x.model_trim, x.list_price, x.priceGated])));
check("condition is read from the card", v.every((x) => x.condition === "new"),
  JSON.stringify(v.map((x) => x.condition)));

// --- an ampersand in a dealer name survives entity decoding -----------------
check("T&T Honda decodes from T&amp;T", last && last.dealer === "T&T Honda", `got ${last?.dealer}`);

// --- degenerate input -------------------------------------------------------
check("empty input yields no vehicles and does not throw",
  extractGoAutoVehicles("").length === 0 && extractGoAutoVehicles(null).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
