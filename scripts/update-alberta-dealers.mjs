// Refreshes public/data/alberta-dealers.json from OpenStreetMap: every car
// dealership (shop=car) in Alberta, binned to its nearest mapped city, giving
// honest per-city counts for the Alberta Dealers Map. Free, no API key.
// Run by .github/workflows/update-alberta-dealers.yml (weekly) or by hand.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter", // fallback mirror
];
const QUERY = '[out:json][timeout:90];area["ISO3166-2"="CA-AB"]->.ab;nwr["shop"="car"](area.ab);out center tags;';

function km(aLat, aLon, bLat, bLon) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const s = Math.sin(dLat/2)**2 + Math.cos(aLat*r)*Math.cos(bLat*r)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function fetchOverpass() {
  let lastErr;
  for (const base of OVERPASS) {
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(QUERY),
      });
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status} from ${base}`); continue; }
      return (await res.json()).elements || [];
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("all Overpass endpoints failed");
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
  if (best && bestKm <= MAX_KM) { counts[best].count++; if (counts[best].sample.length < 6) counts[best].sample.push(d.name); assigned++; }
}

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
