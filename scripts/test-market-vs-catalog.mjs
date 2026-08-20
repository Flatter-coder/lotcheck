// Regression suite for the catalog-anchored province market read — the window
// math, the directional calls, the sticker-inflation floor, and the publish
// gate. Pure logic, no network, no DB.
//
// THE CLASS THIS PINS. The public market cards once measured asking price
// against the MSRP the DEALER stated on their own page, so a dealer printing
// MSRP = asking price was invisible to the over-sticker stat (Southpointe
// Toyota Tacoma Hybrid, 2026-08-19: asking $89,130, page MSRP $89,130). The
// replacement anchors to msrp_catalog — and the moment OUR number is the
// reference, a freight-basis mistake becomes a fabricated markup claim. Every
// test here is one of the two failure directions: an unsound "over" call
// (freight gap read as markup), or a sound call refused (data gap hiding a
// real signal).
//
// Run: node scripts/test-market-vs-catalog.mjs
import {
  referenceWindow, classifyVsCatalog, stickerInflationFloor,
  pickExactCatalogRow, effectivePrice, computeProvinceRead,
  FREIGHT_FEES_CEILING, FEES_ONLY_CEILING, AT_TOLERANCE_PCT,
  PROVINCE_MIN_LISTINGS, STALE_DAYS,
} from "./build-city-price-index.mjs";

let pass = 0, fail = 0;
function check(label, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "\n        " + detail}`);
  cond ? pass++ : fail++;
}

// ---- referenceWindow — the bound the whole read stands on ------------------

let w = referenceWindow({ msrp: 50000, all_in_price: 53078 });
check("a manufacturer all-in figure is a point window (exact)",
  w && w.low === 53078 && w.high === 53078 && w.exact === true, JSON.stringify(w));

w = referenceWindow({ msrp: 50000, price_basis: "incl_freight" });
check("incl_freight: freight is in, only the fees ceiling remains",
  w && w.low === 50000 && w.high === 50000 + FEES_ONLY_CEILING && !w.exact, JSON.stringify(w));

w = referenceWindow({ msrp: 50000, price_basis: "excl_freight" });
check("excl_freight gets the full freight+fees ceiling",
  w && w.low === 50000 && w.high === 50000 + FREIGHT_FEES_CEILING && !w.exact, JSON.stringify(w));

w = referenceWindow({ msrp: 50000, price_basis: null });
check("unknown basis is treated as the WIDEST window, never guessed narrower",
  w && w.high === 50000 + FREIGHT_FEES_CEILING && !w.exact, JSON.stringify(w));

check("a row with no usable figure yields no window",
  referenceWindow({ msrp: 0 }) === null && referenceWindow(null) === null, "windowed a rowless input");

// The ceiling must actually clear the largest verified real-world package:
// Land Cruiser $3,780 freight/PDI + Toyota's $1,148 itemised fees = $4,928.
check("freight+fees ceiling clears the largest verified package ($4,928)",
  FREIGHT_FEES_CEILING > 4928, `ceiling ${FREIGHT_FEES_CEILING}`);
check("fees-only ceiling clears Toyota's itemised $1,148",
  FEES_ONLY_CEILING > 1148, `ceiling ${FEES_ONLY_CEILING}`);

// ---- classifyVsCatalog — the three calls and the honest refusal ------------

// THE FAILURE THE WINDOW EXISTS FOR: an all-in advertised price sitting a
// freight's-width above an ex-freight MSRP is NOT a markup. It must land in
// indeterminate, never in over.
let c = classifyVsCatalog(53000, { msrp: 50000, price_basis: "excl_freight" });
check("freight-sized gap over an excl_freight row -> indeterminate, never over",
  c && c.dir === "indeterminate" && c.floorPct === null, JSON.stringify(c));

c = classifyVsCatalog(50000 + FREIGHT_FEES_CEILING + 3000, { msrp: 50000, price_basis: "excl_freight" });
check("above the full window ceiling -> over, whatever the basis",
  c && c.dir === "over" && c.floorPct > 0, JSON.stringify(c));

c = classifyVsCatalog(48000, { msrp: 50000, price_basis: "excl_freight" });
check("below the window floor -> under, whatever the basis (adds only raise the reference)",
  c && c.dir === "under" && c.floorPct < 0, JSON.stringify(c));

c = classifyVsCatalog(50000, { msrp: 50000, price_basis: "excl_freight" });
check("asking exactly the ex-freight MSRP is NOT 'at sticker' — it is inside the window",
  c && c.dir === "indeterminate", JSON.stringify(c));

c = classifyVsCatalog(53078, { msrp: 50000, all_in_price: 53078 });
check("'at sticker' is only callable against a manufacturer all-in figure",
  c && c.dir === "at" && c.exact === true, JSON.stringify(c));

c = classifyVsCatalog(53578, { msrp: 50000, all_in_price: 53078 });
check("all-in row: $500 over the all-in figure is a real over call",
  c && c.dir === "over" && Math.abs(c.floorPct - (500 / 53078) * 100) < 0.01, JSON.stringify(c));

c = classifyVsCatalog(51200, { msrp: 50000, price_basis: "incl_freight" });
check("incl_freight: a fees-sized gap is still indeterminate",
  c && c.dir === "indeterminate", JSON.stringify(c));

c = classifyVsCatalog(50000 + FEES_ONLY_CEILING + 500, { msrp: 50000, price_basis: "incl_freight" });
check("incl_freight: past the fees ceiling -> over",
  c && c.dir === "over", JSON.stringify(c));

check("no price -> no call", classifyVsCatalog(0, { msrp: 50000 }) === null &&
  classifyVsCatalog(null, { msrp: 50000 }) === null, "classified a priceless listing");

// THE FLOOR PROPERTY — the published magnitude never overstates the true one.
// Row stored ex-freight at $100,000; suppose the true all-in is $105,000
// (inside the ceiling, as the ceiling guarantees).
const trueAllIn = 105000, exclRow = { msrp: 100000, price_basis: "excl_freight" };
c = classifyVsCatalog(90000, exclRow);
let truePct = ((90000 - trueAllIn) / trueAllIn) * 100; // -14.29%
check("under floor never overstates the true discount",
  c && c.dir === "under" && Math.abs(c.floorPct) <= Math.abs(truePct), `floor ${c && c.floorPct}, true ${truePct}`);
c = classifyVsCatalog(112000, exclRow);
truePct = ((112000 - trueAllIn) / trueAllIn) * 100; // +6.67%
check("over floor never overstates the true markup",
  c && c.dir === "over" && c.floorPct <= truePct, `floor ${c && c.floorPct}, true ${truePct}`);

// Tolerance shade: the same ±0.05% fn_alberta_msrp_deviation used, so a
// rounding artifact on an all-in row never flips a direction.
c = classifyVsCatalog(53078 * (1 + AT_TOLERANCE_PCT / 100 / 2), { msrp: 50000, all_in_price: 53078 });
check("inside the rounding shade on an all-in row stays 'at'", c && c.dir === "at", JSON.stringify(c));

// ---- stickerInflationFloor — the Tacoma class, made countable ---------------

// Dealer prints an $89,130 sticker on a trim whose catalog MSRP (ex-freight)
// is $80,000. Even granting the full freight+fees allowance, the stated
// sticker clears the ceiling: that is a countable inflation, floored.
let infl = stickerInflationFloor(89130, { msrp: 80000, price_basis: "excl_freight" });
const ceilingRef = 80000 + FREIGHT_FEES_CEILING;
check("a stated sticker above the window ceiling counts, floored against the ceiling",
  infl != null && Math.abs(infl - ((89130 - ceilingRef) / ceilingRef) * 100) < 0.01, `got ${infl}`);

check("a stated sticker INSIDE the window never counts (could be an honest all-in sticker)",
  stickerInflationFloor(83000, { msrp: 80000, price_basis: "excl_freight" }) === null, "flagged a freight-sized sticker gap");

check("no stated sticker -> not in the stat at all",
  stickerInflationFloor(null, { msrp: 80000 }) === null && stickerInflationFloor(0, { msrp: 80000 }) === null,
  "invented a stated sticker");

check("all-in row: a sticker above the manufacturer's own all-in figure counts",
  stickerInflationFloor(54000, { msrp: 50000, all_in_price: 53078 }) != null, "missed a real inflation on a point window");

check("all-in row: a sticker AT the manufacturer's all-in figure is honest",
  stickerInflationFloor(53078, { msrp: 50000, all_in_price: 53078 }) === null, "flagged an exactly-right sticker");

// ---- pickExactCatalogRow — the row travels with its basis columns ----------

const TACOMA_ROWS = [
  { trim: "TRD Sport", msrp: 62000, fuel_type: "Hybrid", drivetrain: "4WD", price_basis: "excl_freight" },
  { trim: "Limited", msrp: 71000, fuel_type: "Hybrid", drivetrain: "4WD", price_basis: "excl_freight" },
];
let picked = pickExactCatalogRow({ trim: "Limited 4WD", sale_price: 74000 }, TACOMA_ROWS);
check("an exact match returns the FULL catalog row, basis columns included",
  picked && picked.row.price_basis === "excl_freight" && picked.row.msrp === 71000 && picked.price === 74000,
  JSON.stringify(picked));

// Twin rows sharing (trim, msrp): the one holding an all-in figure must win,
// because its window is a point and the tighter window is the sounder call.
const TWINS = [
  { trim: "XSE", msrp: 56400, fuel_type: "Hybrid", drivetrain: "AWD", price_basis: "excl_freight" },
  { trim: "XSE", msrp: 56400, fuel_type: "Hybrid", drivetrain: "AWD", price_basis: "excl_freight", all_in_price: 59478 },
];
picked = pickExactCatalogRow({ trim: "XSE AWD Hybrid", sale_price: 59478 }, TWINS);
check("among identical twins the all-in row wins (tightest window)",
  picked && Number(picked.row.all_in_price) === 59478, JSON.stringify(picked));

check("a starting_at guess is excluded from the read entirely",
  pickExactCatalogRow({ trim: "Not A Real Trim", sale_price: 66500 }, TACOMA_ROWS) === null,
  "a low-confidence match reached the province read");

check("sale_price is the effective asking price, list_price the fallback",
  effectivePrice({ sale_price: 51000, list_price: 53000 }) === 51000 &&
  effectivePrice({ list_price: 53000 }) === 53000 && effectivePrice({}) === null,
  "effectivePrice picked the wrong column");

// ---- computeProvinceRead — aggregation + the publish gate -------------------

const NOW = new Date("2026-08-19T12:00:00Z").getTime();
const FRESH = "2026-08-19T00:00:00Z";
const mk = (dir, floorPct, i, extra = {}) => ({
  dealer_id: (i % 5) + 1, dir, floorPct, exact: false, statedMsrp: null, inflFloorPct: null,
  updated_at: FRESH, ...extra,
});

const mix = [
  ...Array.from({ length: 15 }, (_, i) => mk("under", -3 - (i % 4), i)),
  ...Array.from({ length: 8 }, (_, i) => mk("over", 2 + (i % 3), i)),
  ...Array.from({ length: 2 }, (_, i) => mk("at", 0, i, { exact: true })),
  ...Array.from({ length: 10 }, (_, i) => mk("indeterminate", null, i)),
];
let read = computeProvinceRead(mix, { now: NOW });
check("every matched listing lands in exactly one bucket (counts sum)",
  read.under_n + read.at_n + read.over_n + read.indeterminate_n === read.n_matched &&
  read.n_matched === 35, JSON.stringify(read));
check("the k-floor counts DIRECTIONAL calls only, never indeterminates",
  read.n_directional === 25, `got ${read.n_directional}`);
check("25 directional + fresh -> publishable", read.is_publishable === true, JSON.stringify(read));
check("curve is the 21-point shape the page's band math consumes",
  Array.isArray(read.curve) && read.curve.length === 21 &&
  read.curve.every((v, i, a) => i === 0 || v >= a[i - 1]), JSON.stringify(read.curve));
check("median_discount is computed among the UNDER set only",
  read.median_discount_pct < 0, `got ${read.median_discount_pct}`);

// One fewer directional call and the gate closes — 25 matched listings padded
// with indeterminates must NOT buy publication.
read = computeProvinceRead(mix.slice(1), { now: NOW });
check("24 directional never publishes, however many indeterminates pad it",
  read.n_directional === 24 && read.is_publishable === false, JSON.stringify(read));

const staleAt = new Date(NOW - (STALE_DAYS + 1) * 86_400_000).toISOString();
read = computeProvinceRead(mix.map((r) => ({ ...r, updated_at: staleAt })), { now: NOW });
check(`stale data (older than STALE_DAYS=${STALE_DAYS}d) never publishes`,
  read.is_publishable === false, JSON.stringify(read));

check("an empty read fabricates nothing and never publishes",
  (() => { const r = computeProvinceRead([]); return r.n_matched === 0 && r.median_pct === null && r.curve === null && !r.is_publishable; })(),
  JSON.stringify(computeProvinceRead([])));

check(`the default floor is ${PROVINCE_MIN_LISTINGS} (k-anonymity, matching the RPC)`,
  PROVINCE_MIN_LISTINGS >= 25, `floor ${PROVINCE_MIN_LISTINGS}`);

// Sticker stats: the denominator is listings that PRINT a sticker; the
// inflation count is those printing one above the ceiling.
const stickered = [
  ...Array.from({ length: 25 }, (_, i) => mk("under", -2, i)),
  mk("indeterminate", null, 1, { statedMsrp: 91000, inflFloorPct: 4.2 }),
  mk("indeterminate", null, 2, { statedMsrp: 91000, inflFloorPct: 6.0 }),
  mk("under", -1, 3, { statedMsrp: 82000, inflFloorPct: null }), // printed, honest
];
read = computeProvinceRead(stickered, { now: NOW });
check("sticker denominator counts only listings that print one",
  read.sticker_stated_n === 3, `got ${read.sticker_stated_n}`);
check("inflation counts only stickers above the window ceiling",
  read.sticker_inflated_n === 2 && read.sticker_inflated_median_pct > 0,
  JSON.stringify({ n: read.sticker_inflated_n, med: read.sticker_inflated_median_pct }));

check("dealers are counted distinct among the directional calls",
  computeProvinceRead(mix, { now: NOW }).n_dealers === 5, `got ${computeProvinceRead(mix, { now: NOW }).n_dealers}`);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
