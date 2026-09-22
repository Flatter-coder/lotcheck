// GATE: reading a price from the archive must be as disciplined as reading one
// from a live page, and in two places it must be MORE so.
//
// WHY THIS EXISTS. msrp_catalog holds 1,509 rows for 2025-2027 and THREE for
// every older model year. Without what a 2016 car cost new, roughly three
// quarters of Alberta's used listings cannot be priced at all. The Internet
// Archive still holds the pages the makers deleted.
//
// The two extra dangers, both guarded below:
//   1. THE ARCHIVE HOLDS EVERYTHING — every marketplace, forum and blog that
//      ever quoted a price. A dealer's archived page is not a manufacturer
//      figure and must never be catalogued as one.
//   2. PUBLICATION YEAR IS NOT MODEL YEAR. scrape-archived-toyota.mjs learned
//      it: a MY2020 launch is filed under /releases/2019/. Reading the year
//      from a folder or a capture date puts every price one year out.
import {
  isManufacturerHost, snapshotUrl, capturedOn, modelYearFromText, isReadablePage,
} from "./lib/wayback.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`ok    ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
};

// ---- 1. the maker's own site, or nothing --------------------------------
for (const host of [
  "hyundaicanada.com", "www.honda.ca", "https://www.toyota.ca/build",
  "mazda.ca", "vw.ca", "kia.ca",
]) check(`accepts manufacturer host ${host}`, isManufacturerHost(host) === true);

for (const host of [
  "autotrader.ca", "www.kijiji.ca", "cargurus.ca", "facebook.com",
  "carfax.ca", "vinaudit.com", "edmunds.com", "kbb.com",
  "reddit.com", "somedealer.blogspot.com", "hondaforum.com", "medium.com",
]) check(`refuses non-manufacturer host ${host}`, isManufacturerHost(host) === false);

check("refuses an empty host", isManufacturerHost("") === false);
check("refuses a bare word with no dot", isManufacturerHost("honda") === false);
check("refuses null and undefined", isManufacturerHost(null) === false && isManufacturerHost(undefined) === false);

// ---- 2. snapshot URLs and the date that must travel with the figure -----
const TS = "20170301120000";
check("builds a snapshot URL",
  snapshotUrl(TS, "https://www.hyundaicanada.com/en/showroom/2016/veloster")
    === "http://web.archive.org/web/20170301120000/https://www.hyundaicanada.com/en/showroom/2016/veloster");
check("raw mode asks for the page as captured",
  String(snapshotUrl(TS, "https://x.ca/a", { raw: true })).includes("20170301120000id_/"));
check("refuses a malformed timestamp",
  snapshotUrl("2017", "https://x.ca/a") === null && snapshotUrl("notatimestamp", "https://x.ca/a") === null);
check("refuses a missing original URL", snapshotUrl(TS, "") === null);

check("the capture date is extracted", capturedOn(TS) === "2017-03-01");
check("a malformed timestamp has no capture date", capturedOn("2017") === null && capturedOn(null) === null);

// ---- 3. publication year is not model year ------------------------------
// The Toyota lesson, generalised: the year must sit beside the vehicle's name.
check("reads the model year beside the model name",
  modelYearFromText("2016 Hyundai Veloster Turbo — Starting MSRP $18,599", "Veloster") === 2016);
check("reads it when the name comes first",
  modelYearFromText("Veloster 2016 overview", "Veloster") === 2016);
check("is not fooled by a copyright line",
  modelYearFromText("Copyright 2024 Hyundai Auto Canada. The Veloster is discontinued.", "Veloster") === null,
  String(modelYearFromText("Copyright 2024 Hyundai Auto Canada. The Veloster is discontinued.", "Veloster")));
check("is not fooled by a far-away year",
  modelYearFromText("2019 press release archive ................................ Veloster", "Veloster") === null);
// 1887 never matched (19|20)\d{2} to begin with, so it exercised nothing. A
// year must be one the PATTERN accepts but the RANGE rejects, or the range
// check can be deleted and every test still passes.
check("refuses a year the pattern matches but no used car can have (1955)",
  modelYearFromText("1955 Veloster", "Veloster") === null,
  String(modelYearFromText("1955 Veloster", "Veloster")));
check("refuses a year beyond any model year (2045)",
  modelYearFromText("2045 Veloster", "Veloster") === null,
  String(modelYearFromText("2045 Veloster", "Veloster")));
check("still accepts a real used-car year at the boundary (1990)",
  modelYearFromText("1990 Veloster", "Veloster") === 1990);
check("returns null with no model hint", modelYearFromText("2016 Veloster", "") === null);
check("returns null on empty text", modelYearFromText("", "Veloster") === null);
check("a model name with regex characters does not throw",
  modelYearFromText("2016 Mazda CX-5 (Grand Touring)", "CX-5 (Grand Touring)") === 2016);

// ---- 3b. a JS shell is not a page we read -------------------------------
// fetchSnapshotText is network-bound, so the DECISION it makes is exported and
// tested here. Without this the floor could be deleted and a shell would be
// catalogued as "the maker published nothing".
check("a full page reads as readable", isReadablePage("x".repeat(600)) === true);
check("the archive's own banner alone does not", isReadablePage("x".repeat(599)) === false);
check("whitespace does not pad a shell into a page", isReadablePage(" ".repeat(5000) + "short") === false);
check("empty, null and non-strings are not readable",
  isReadablePage("") === false && isReadablePage(null) === false && isReadablePage(12345) === false);

// ---- 4. the gate must be able to fail -----------------------------------
// If the refusal list were emptied, every check above that asserts `false`
// would still pass only because the host has a dot. Assert the list bites.
check("the refusal list still bites on a real marketplace",
  isManufacturerHost("www.autotrader.ca") === false && isManufacturerHost("autotrader.ca") === false);
check("a manufacturer host is still accepted after all that",
  isManufacturerHost("hyundaicanada.com") === true);


// ---- 5. the two readers that decide what gets published -----------------
// Both are exported from scrape-archived-hyundai.mjs and both were WRONG on
// the very page they were written from, in ways only a fixture from the real
// page could show:
//   * priceFromText demanded the label run straight into the dollar sign. The
//     page says "Starting from* $18,599" — an asterisk in between — so it
//     matched nothing. Its patterns were also built as template strings, where
//     \d and \$ are not the escapes they look like.
//   * basisFromText anchored on the first occurrence of the price. The price
//     appears twice: once in the hero, once in the legal block. It kept reading
//     the hero, whose next 700 characters are fuel economy and a gallery.
const { priceFromText, basisFromText } = await import("./scrape-archived-hyundai.mjs");

// Verbatim from the 2016 Veloster snapshot, 2017-12-22 capture.
const VELOSTER = "2016 Veloster Error Veloster Turbo Starting from* $18,599 $0 View Current Offers "
  + "Fuel Economy* 8.8/6.7/7.8L per 100km (city/hwy/combined) Overview Exterior Interior Gallery "
  + "Specs Reviews Defy Convention The 2016 Veloster has been designed to stand out. "
  // PADDING IS LOad-BEARING. On the real page the hero and the legal block are
  // tens of thousands of characters apart. With a short fixture the hero's own
  // 700-character window reached the legal text anyway, so the "find the
  // occurrence followed by a disclosure" rule could be deleted and this still
  // passed. The filler puts them far enough apart to make the rule bite.
  + "body copy ".repeat(90)

  + "READ REVIEWS ASK AN OWNER Get Your Local Price Find a Dealer Book a Test Drive Special Offers "
  + "Legal *Price of $18,599 available on all new 2016 Veloster Base Manual models. "
  + "Price excludes Delivery and Destination charges of $1,705, fees, levies and all applicable "
  + "charges (excluding HST, GST/PST). Price also excludes registration, insurance, PPSA, license "
  + "fees and dealer admin. fees of up to $499. Fees may vary by dealer. Delivery and Destination "
  + "charge includes freight, P.D.E. and a full tank of gas.";

const vp = priceFromText(VELOSTER);
check("reads a price with a footnote marker between label and figure",
  vp && vp.price === 18599, JSON.stringify(vp));
check("keeps the label verbatim", vp && vp.label.includes("Starting from*"), vp && vp.label);

const vb = basisFromText(VELOSTER, 18599);
check("reads the basis from the LEGAL block, not the hero",
  vb.basis === "excl_freight", JSON.stringify(vb));
check("keeps the maker's own wording as evidence",
  vb.evidence && vb.evidence.includes("excludes Delivery and Destination"), String(vb.evidence).slice(0, 80));

// The hero alone must not yield a basis — that is the bug this fixture pins.
check("the hero alone states no basis",
  basisFromText("Starting from* $18,599 View Current Offers Fuel Economy", 18599).basis === null);

// A page stating an ALL-IN price must not be read as ex-freight. GMC's archived
// pages do exactly this, so the reader must not assume one direction.
check("an all-in page reads as incl_freight",
  basisFromText("Price of $37,535 includes freight and PDI of $1,800.", 37535).basis === "incl_freight");
// Saying both, or neither, is not plain enough to publish.
check("a page saying both ways publishes neither",
  basisFromText("Price includes freight. Price excludes freight.", 0).basis === null);
check("a silent page publishes no basis", basisFromText("2016 Veloster $18,599", 18599).basis === null);

// A bare figure with no price vocabulary is not a price claim.
check("a bare dollar figure is not read as a price", priceFromText("Save $2,500 this month") === null);
// $389 never matched the pattern at all (it requires a thousands comma), so
// the price RANGE was never exercised by it. $1,200 does match the pattern
// and is below the floor, which is what makes the range check load-bearing.
check("a monthly payment that looks like a price is refused by the range",
  priceFromText("Starting from $1,200 per month") === null,
  JSON.stringify(priceFromText("Starting from $1,200 per month")));
check("a figure above any Canadian new car is refused",
  priceFromText("Starting at $480,000") === null);
check("a real price just inside the floor is accepted",
  (priceFromText("Starting from $9,000") || {}).price === 9000);
check("empty text yields no price", priceFromText("") === null);


// THE SUMMARY MUST BE THE LAST THING IN THIS FILE. It previously sat above a
// later-appended block, so ten assertions ran, one of them FAILED, and the
// process still exited 0 — a gate that cannot fail, appended into existence.
console.log(`
${pass} passed, ${fail} failed`);
if (fail) process.exit(1);