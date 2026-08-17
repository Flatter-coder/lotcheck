// Refreshes public/data/alberta-dealers.json from OpenStreetMap: every car
// dealership (shop=car) in Alberta, binned to its nearest mapped city, giving
// honest per-city counts for the Alberta Dealers Map. Free, no API key.
// Run by .github/workflows/update-alberta-dealers.yml (weekly) or by hand.
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { assertOutputSane } from "./lib/dealer-output-guard.mjs";

const CITIES = [
  ["Calgary",51.05,-114.07],["Edmonton",53.55,-113.49],["Red Deer",52.27,-113.81],
  ["Lethbridge",49.69,-112.84],["Medicine Hat",50.04,-110.68],["Grande Prairie",55.17,-118.80],
  ["Fort McMurray",56.73,-111.38],["Airdrie",51.29,-114.01],["Spruce Grove",53.54,-113.91],
  ["Sherwood Park",53.54,-113.30],["St. Albert",53.63,-113.63],["Leduc",53.26,-113.55],
  ["Camrose",53.02,-112.83],["Lloydminster",53.28,-110.00],["Cochrane",51.19,-114.47],
  ["Okotoks",50.72,-113.98],["Wetaskiwin",52.97,-113.37],["Brooks",50.56,-111.90],
  ["Cold Lake",54.46,-110.18],["Canmore",51.09,-115.36],["Hinton",53.40,-117.57],
  ["Whitecourt",54.14,-115.69],["Peace River",56.23,-117.29],["High River",50.58,-113.87],
  ["Fort Saskatchewan",53.71,-113.21],["Lacombe",52.47,-113.74],["Sylvan Lake",52.31,-114.10],
  ["Drumheller",51.46,-112.72],["Taber",49.79,-112.15],["Bonnyville",54.27,-110.74],
  ["Slave Lake",55.28,-114.77],["Rocky Mountain House",52.37,-114.92],["Strathmore",51.04,-113.40],
];
const MAX_KM = 35;
const OUT = "public/data/alberta-dealers.json";
// Multiple independent Overpass mirrors so one being down / rate-limited (429)
// doesn't fail the refresh. Order = try-first preference.
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
];
const QUERY = '[out:json][timeout:90];area["ISO3166-2"="CA-AB"]->.ab;nwr["shop"="car"](area.ab);out center tags;';
const ROUNDS = 4;               // passes over the whole mirror list before giving up
const REQ_TIMEOUT_MS = 120000;  // per-request cap so a hung mirror can't stall a round
const MIN_ELEMENTS = 50;        // below this the response is a soft-fail, not a small city
// OVERPASS REFUSES ANONYMOUS CLIENTS, AND THAT IS WHY THIS JOB KEPT FAILING.
// Node's fetch sends no descriptive User-Agent, and the Overpass usage policy
// requires one. Measured 2026-08-17 with the exact request this script sends:
//
//   overpass-api.de      no UA -> HTTP 406 in 527ms      with UA -> served
//   lz4.overpass-api.de  no UA -> HTTP 406 in 480ms      with UA -> 200, 466 elements
//   overpass.kumi.systems no UA -> HTTP 429 in 1201ms    with UA -> served
//
// So all four "mirrors" refused us instantly, every round, every week — while
// Overpass itself was perfectly healthy. Retrying harder could never have
// worked; the request shape was the bug. Keep this header, and keep it
// descriptive with a contact URL: that is what the policy asks for.
const USER_AGENT = "LotCheck/1.0 (Alberta dealer map; +https://lotcheck.ca)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function km(aLat, aLon, bLat, bLon) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const s = Math.sin(dLat/2)**2 + Math.cos(aLat*r)*Math.cos(bLat*r)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// EVERY MIRROR'S OUTCOME IS REPORTED, NOT JUST THE LAST ONE.
// This used to keep a single `lastErr`, so the thrown error described whichever
// mirror happened to be tried last. That mirror is overpass.osm.ch, and it fails
// DIFFERENTLY from the others: it answers HTTP 200 with an empty element list,
// where the rest answered 406/429. The log therefore said "only 0 elements" —
// a symptom of one broken mirror — and never once printed the 406 that was the
// actual cause on the other three. Four consecutive failures were read as
// "Overpass is unavailable" when Overpass was up the whole time.
//
// A failure report that names one of four failures is worse than no report: it
// looks like a diagnosis. Collect them all and print them all.
async function fetchOverpass() {
  const outcomes = [];
  const note = (host, what) => { outcomes.push(`${host}: ${what}`); return what; };
  // Up to ROUNDS passes over every mirror, with growing backoff between passes.
  // 429 (rate limit) and 5xx (gateway) are transient, so a later pass often wins.
  for (let round = 0; round < ROUNDS; round++) {
    const roundOutcomes = [];
    for (const base of OVERPASS) {
      const host = new URL(base).host;
      const ctrl = new AbortController();
      const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, REQ_TIMEOUT_MS);
      try {
        const res = await fetch(base, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": USER_AGENT,
          },
          body: "data=" + encodeURIComponent(QUERY),
          signal: ctrl.signal,
        });
        if (!res.ok) { roundOutcomes.push(note(host, `HTTP ${res.status}`)); continue; }
        const els = (await res.json()).elements || [];
        // Some mirrors soft-fail with a 200 + empty body when overloaded. Treat a
        // suspiciously-small result as a miss and keep trying other mirrors/rounds.
        if (els.length < MIN_ELEMENTS) {
          roundOutcomes.push(note(host, `HTTP 200 but only ${els.length} elements`));
          continue;
        }
        return els;
      } catch (e) {
        roundOutcomes.push(note(host, `${e.name}: ${e.message}`));
      } finally { clearTimeout(timer); }
    }
    if (round < ROUNDS - 1) {
      const wait = 8000 * (round + 1);   // 8s, 16s, 24s
      console.warn(
        `Overpass round ${round + 1}/${ROUNDS} failed on all ${OVERPASS.length} mirrors ` +
        `(${roundOutcomes.join("; ")}); retrying in ${wait / 1000}s…`);
      await sleep(wait);
    }
  }
  // Distinct outcomes only — four rounds of the same four failures is noise, and
  // the shape of the failure is what a human needs. A 406/429 across the board
  // means we are being REFUSED (check the User-Agent), not that OSM is down.
  const distinct = [...new Set(outcomes)];
  throw new Error(
    `all ${OVERPASS.length} Overpass mirrors failed across ${ROUNDS} rounds:\n  - ` +
    distinct.join("\n  - ") +
    `\nHTTP 406/429 from every mirror means the request was REFUSED, not that ` +
    `Overpass was down — check the User-Agent header before retrying harder.`);
}

const els = await fetchOverpass();
const dealers = els
  .map(e => ({ name: e.tags?.name, lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon }))
  .filter(d => d.name && Number.isFinite(d.lat) && Number.isFinite(d.lon));
if (dealers.length < 50) throw new Error(`suspiciously few dealers (${dealers.length}) — refusing to overwrite with likely-bad data`);

const counts = Object.fromEntries(CITIES.map(c => [c[0], { count: 0, sample: [] }]));
let assigned = 0;
for (const d of dealers) {
  let best = null, bestKm = Infinity;
  for (const [name, lat, lon] of CITIES) { const dist = km(d.lat, d.lon, lat, lon); if (dist < bestKm) { bestKm = dist; best = name; } }
  if (best && bestKm <= MAX_KM) { counts[best].count++; if (counts[best].sample.length < 20) counts[best].sample.push(d.name); assigned++; }
}

// THE NUMBER WE WRITE IS THE NUMBER WE MUST GUARD. The two floors above check
// the Overpass response and the geocodable subset; `assigned` is neither, and it
// is what reaches the file. See scripts/lib/dealer-output-guard.mjs — the rule
// lives there so test:alberta-dealers can exercise it without the network.
const prevRaw = (() => { try { return JSON.parse(readFileSync(OUT, "utf8")); } catch { return null; } })();
assertOutputSane({
  assigned,
  examined: dealers.length,
  prevTotal: Number.isFinite(prevRaw?.totalDealers) ? prevRaw.totalDealers : null,
  minFloor: MIN_ELEMENTS,
  maxKm: MAX_KM,
  outPath: OUT,
});

// Date passed in by the workflow (Date.* is fine in a plain Node script; kept as
// an arg so runs are reproducible and the workflow controls the stamp).
const generatedAt = process.argv[2] || new Date().toISOString().slice(0, 10);
const out = {
  source: "OpenStreetMap (shop=car), via Overpass",
  generatedAt,
  totalDealers: assigned,
  cities: CITIES.map(([name]) => ({ name, count: counts[name].count, sample: counts[name].sample })),
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(`Wrote ${OUT}: ${assigned} dealers across ${CITIES.length} cities (${dealers.length} OSM POIs, ${dealers.length - assigned} rural/dropped).`);
