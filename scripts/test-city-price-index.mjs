// Regression suite for the city price index — matching, aggregation math, and
// the publishable gate. Pure logic, no network, no DB. If a future change
// would let a thin city publish a number, or exclude a confident match, this
// goes red before it reaches /alberta.
//
// Run: node scripts/test-city-price-index.mjs
import { matchListingToMsrp, computeCityStats, gatePublishable, percentile, cityKey, prettyCity, MIN_DEALERS, MIN_LISTINGS, STALE_DAYS } from "./build-city-price-index.mjs";

let pass = 0, fail = 0;
function check(label, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "\n        " + detail}`);
  cond ? pass++ : fail++;
}

// ---- matchListingToMsrp --------------------------------------------------

const CAMRY_2026 = [
  { trim: "SE", msrp: 38792, fuel_type: "Hybrid", drivetrain: "FWD" },
  { trim: "XLE", msrp: 49442, fuel_type: "Hybrid", drivetrain: "AWD" },
  { trim: "XSE", msrp: 49547, fuel_type: "Hybrid", drivetrain: "AWD" },
];

let m = matchListingToMsrp({ trim: "XLE", list_price: 51900 }, CAMRY_2026);
check("confident trim match returns a deviation", m && m.msrp === 49442 && Math.round(m.deviationDollars) === 2458,
  `got ${JSON.stringify(m)}`);

// The IONIQ 9 failure class (2026-08-13, see trim-match.js): a catalog missing
// the higher-package row lets the matcher land on the closest AVAILABLE trim
// at a price nowhere near it. A single-candidate pool priced far above MSRP
// must be excluded, not called exact.
m = matchListingToMsrp({ trim: "Totally Unknown Grade", list_price: 60000 }, [{ trim: "SE", msrp: 38792, fuel_type: "Hybrid" }]);
check("asking price implausibly far above the only candidate's MSRP -> excluded", m === null, `got ${JSON.stringify(m)}`);

// Two candidates, no drivetrain/trim signal, and a price exactly equidistant
// from both -> a genuine tie. pickTrimMsrp resolves ties to the cheaper row
// labelled "starting_at" (an honest guess); the index must not treat a guess
// as a confident match.
m = matchListingToMsrp({ trim: "Not A Real Trim Name", list_price: 50000 }, [
  { trim: "Alpha", msrp: 40000, fuel_type: "Gas" },
  { trim: "Beta", msrp: 60000, fuel_type: "Gas" },
]);
check("genuinely ambiguous tie (starting_at guess) -> excluded, not averaged in", m === null, `got ${JSON.stringify(m)}`);

m = matchListingToMsrp({ trim: "XLE", list_price: 0 }, CAMRY_2026);
check("zero/absent list_price excluded (never a free-car deviation)", m === null, `got ${JSON.stringify(m)}`);

m = matchListingToMsrp({ trim: "XLE", list_price: 51900 }, []);
check("empty candidate pool (no msrp_catalog rows for this year/make/model) -> excluded", m === null, `got ${JSON.stringify(m)}`);

// ---- computeCityStats -----------------------------------------------------

const rows = [
  { dealer_id: 1, deviationPct: 5, deviationDollars: 2000, updated_at: "2026-08-15T00:00:00Z" },
  { dealer_id: 1, deviationPct: 3, deviationDollars: 1200, updated_at: "2026-08-16T00:00:00Z" },
  { dealer_id: 2, deviationPct: 7, deviationDollars: 3000, updated_at: "2026-08-17T00:00:00Z" },
  { dealer_id: 3, deviationPct: 1, deviationDollars: 400, updated_at: "2026-08-10T00:00:00Z" },
];
let stats = computeCityStats(rows);
check("n_dealers counts DISTINCT dealers, not listings", stats.n_dealers === 3, `got ${stats.n_dealers}`);
check("n_listings counts every matched row", stats.n_listings === 4, `got ${stats.n_listings}`);
check("median is a real observed value (percentile, not interpolated)", [1, 3, 5, 7].includes(stats.index_pct), `got ${stats.index_pct}`);
check("max_updated_at is the most recent observation", stats.max_updated_at === "2026-08-17T00:00:00.000Z", `got ${stats.max_updated_at}`);
check("min_updated_at is the oldest observation", stats.min_updated_at === "2026-08-10T00:00:00.000Z", `got ${stats.min_updated_at}`);

check("empty city produces no fabricated stats", computeCityStats([]).n_listings === 0 && computeCityStats([]).index_pct === null,
  `got ${JSON.stringify(computeCityStats([]))}`);

check("percentile([], p) is null, never a guess", percentile([], 0.5) === null, "percentile did not return null for empty input");

// ---- gatePublishable — the accuracy/defamation-avoidance gate -------------

const freshNow = new Date("2026-08-17T12:00:00Z").getTime();
const thin = computeCityStats([
  { dealer_id: 1, deviationPct: 5, deviationDollars: 2000, updated_at: "2026-08-17T00:00:00Z" },
  { dealer_id: 2, deviationPct: 3, deviationDollars: 1000, updated_at: "2026-08-17T00:00:00Z" },
]);
check(`below MIN_DEALERS (${MIN_DEALERS}) never publishable, however fresh`, gatePublishable(thin, { now: freshNow }) === false,
  `stats=${JSON.stringify(thin)}`);

const thinListings = computeCityStats(Array.from({ length: 5 }, (_, i) => ({
  dealer_id: (i % 3) + 1, deviationPct: 4, deviationDollars: 1500, updated_at: "2026-08-17T00:00:00Z",
})));
check(`3 dealers but below MIN_LISTINGS (${MIN_LISTINGS}) never publishable`, gatePublishable(thinListings, { now: freshNow }) === false,
  `n_dealers=${thinListings.n_dealers} n_listings=${thinListings.n_listings}`);

function bigEnoughCity(updatedAt) {
  return computeCityStats(Array.from({ length: MIN_LISTINGS }, (_, i) => ({
    dealer_id: (i % MIN_DEALERS) + 1, deviationPct: 4 + (i % 3), deviationDollars: 1500, updated_at: updatedAt,
  })));
}

check("enough dealers + listings + fresh -> publishable",
  gatePublishable(bigEnoughCity("2026-08-17T00:00:00Z"), { now: freshNow }) === true,
  `stats=${JSON.stringify(bigEnoughCity("2026-08-17T00:00:00Z"))}`);

const staleAt = new Date(freshNow - (STALE_DAYS + 1) * 86_400_000).toISOString();
check(`freshness window respected — data older than STALE_DAYS (${STALE_DAYS}d) never publishable`,
  gatePublishable(bigEnoughCity(staleAt), { now: freshNow }) === false,
  `stale row at ${staleAt}, now ${new Date(freshNow).toISOString()}`);

check("no data at all (null stats) is never publishable", gatePublishable(null) === false, "gate accepted null stats");

check("zero listings city is never publishable", gatePublishable(computeCityStats([]), { now: freshNow }) === false,
  "gate accepted an empty city");


// ---------------------------------------------------------------------------
// City identity. dealer_source.city is free text off two rosters (AMVIC's
// licensee list, OSM's addr:city), so one place arrives under several
// spellings. Grouping on the raw string gave each spelling its own row, split
// the dealers and listings between them, and could push a well-covered city
// below the publish gate in EVERY fragment — invisible for no reason but
// punctuation. Same shape as the RAV4 / RAV4 Hybrid split (9b9ba75).
// ---------------------------------------------------------------------------
const sameCity = [
  ["St. Albert", "ST. ALBERT", "St Albert", "Saint Albert", "  st.  albert "],
  ["Fort McMurray", "FORT MCMURRAY", "fort mcmurray"],
  ["Leduc", "Leduc, AB", "LEDUC", "leduc"],
  ["Grande Prairie", "GRANDE PRAIRIE"],
  ["Lloydminster", "LLOYDMINSTER"],
  ["High River", "HIGH RIVER", "high river"],
  ["Rocky Mountain House", "ROCKY MOUNTAIN HOUSE"],
];
for (const spellings of sameCity) {
  const keys = [...new Set(spellings.map(cityKey))];
  check(`one city, one key: ${spellings[0]}`, keys.length === 1,
    `${spellings.length} spellings produced ${keys.length} keys: ${JSON.stringify(keys)}`);
}

// The opposite failure: over-normalising until two real places collide.
const distinct = ["St. Albert", "Sherwood Park", "Spruce Grove", "High River", "High Prairie",
                  "High Level", "Red Deer", "Lloydminster", "Leduc", "Lacombe"];
check("distinct cities keep distinct keys",
  new Set(distinct.map(cityKey)).size === distinct.length,
  `${distinct.length} cities collapsed to ${new Set(distinct.map(cityKey)).size} keys`);

check("no city at all yields no key", cityKey(null) === null && cityKey("") === null &&
  cityKey("   ") === null && cityKey(", AB") === null, "blank input produced a key");

// The label a person reads must not be mangled by the rule that normalises it.
check("display keeps intercaps a title-caser would destroy",
  prettyCity(["FORT MCMURRAY", "Fort McMurray"]) === "Fort McMurray",
  `got ${JSON.stringify(prettyCity(["FORT MCMURRAY", "Fort McMurray"]))}`);
check("display prettifies when the roster only ever shouted",
  prettyCity(["GRANDE PRAIRIE"]) === "Grande Prairie",
  `got ${JSON.stringify(prettyCity(["GRANDE PRAIRIE"]))}`);
check("display drops a province suffix the roster tacked on",
  prettyCity(["LEDUC, AB"]) === "Leduc", `got ${JSON.stringify(prettyCity(["LEDUC, AB"]))}`);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
