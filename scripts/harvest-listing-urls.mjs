// Harvest real Alberta dealer VDP (vehicle detail page) URLs for the benchmark.
//
// Reads each dealer's own public inventory pages and pulls the listing links out
// of the markup. No vendor, no API, no marketplace -- the same sources a buyer
// browses. Marketplaces stay out by design (aggregator-scraping-tos).
//
// Run: node scripts/harvest-listing-urls.mjs > scripts/tmp-benchmark-urls.json
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Alberta dealers across the four platform families we care about, spread over
// makes and both new and used, so the sample is not one page shape repeated.
const SEEDS = [
  "https://www.westgatechev.com/new/", "https://www.westgatechev.com/used/",
  "https://www.jackcarterchev.ca/new/", "https://www.jackcarterchev.ca/used/",
  "https://www.courtesychrysler.com/new/", "https://www.courtesychrysler.com/used/",
  "https://www.villagehonda.com/new/", "https://www.villagehonda.com/used/",
  "https://www.rainbowford.ca/new/", "https://www.rainbowford.ca/used/",
  "https://www.calgaryhyundai.com/new/", "https://www.calgaryhyundai.com/used/",
  "https://www.silverhillacura.com/new/", "https://www.silverhillacura.com/used/",
  "https://www.airdriechrysler.com/new/", "https://www.airdriechrysler.com/used/",
  "https://www.hyattmitsubishi.com/new/", "https://www.hyattmitsubishi.com/used/",
  "https://www.tsuzukisubaru.com/new/", "https://www.tsuzukisubaru.com/used/",
  "https://www.southtownehyundai.com/new/", "https://www.southtownehyundai.com/used/",
  "https://www.okotokshonda.com/new/", "https://www.okotokshonda.com/used/",
  "https://www.crowfootdodge.com/inventory/", "https://www.royaloaknissan.com/inventory/",
  "https://www.gsldodge.com/inventory/", "https://www.northstarford.ca/inventory/",
  "https://www.stadiumnissan.ca/inventory/", "https://www.metrolexus.ca/inventory/",
];

// Per-platform VDP shapes. Kept loose on purpose -- a URL that turns out not to
// be a VDP just fails its scan and is counted honestly, which is the point.
const VDP = [
  /\/(?:new|used)\/vehicle\/[a-z0-9-]+\.htm/gi,        // D2C / DealerOn
  /\/vehicles?\/(?:new|used)\/[a-z0-9\/-]{18,}/gi,      // Convertus
  /\/en\/(?:new|used)\/[a-z0-9-]{18,}/gi,               // SM360
  /\/inventory\/[a-z0-9-]{18,}/gi,                      // EDealer
];

const get = async (url, ms = 25_000) => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "en-CA" }, signal: c.signal });
    return r.ok ? await r.text() : "";
  } catch { return ""; } finally { clearTimeout(t); }
};

const found = new Map(); // url -> host, deduped

await Promise.all(SEEDS.map(async (seed) => {
  const html = await get(seed);
  if (!html) return;
  const seedHost = new URL(seed).hostname.replace(/^www\./, "");
  const origin = new URL(seed).origin;
  for (const re of VDP) {
    for (const m of html.matchAll(re)) {
      let path = m[0].replace(/&amp;/g, "&").replace(/[),.'"]+$/, "");
      if (/\.(jpg|jpeg|png|webp|gif|svg|css|js|pdf)$/i.test(path)) continue;
      if (/\/(new|used|inventory|vehicles)\/?$/i.test(path)) continue;
      // Model/category landing pages, not units. westgatechev.com emits
      // /inventory/new-chevrolet-corvette alongside real VDPs; scanning those
      // would book a "failure" that is really us feeding it an index page --
      // the exact miscount that made 1 of 10 look like a hard failure in the
      // first baseline.
      if (/\/inventory\/(?:new|used|certified)-[a-z]+(?:-[a-z]+)*$/i.test(path)) continue;
      // Opaque internal ids. okotokshonda.com emits /inventory/BAIIJHDLW5FL...
      // -- base32-looking record keys that 404 for the public. Every one of a
      // 10-url sample returned 404, so including them would have booked ~25
      // fake "hard failures" and made the benchmark look worse than reality.
      if (/\/inventory\/[A-Z0-9]{16,}$/.test(path)) continue;
      let u;
      try { u = new URL(path, origin).href; } catch { continue; }
      // Dealer's OWN site only -- the first run pulled 1,035 "listings" that
      // were all photos on EDealer's image CDN.
      let host;
      try { host = new URL(u).hostname.replace(/^www\./, ""); } catch { continue; }
      if (host !== seedHost) continue;
      found.set(u, host);
    }
  }
}));

// Spread the sample ACROSS dealers rather than taking 90 from whichever site
// paginates the most -- otherwise the failure rate just measures one page shape.
const byHost = new Map();
for (const [url, host] of found) {
  if (!byHost.has(host)) byHost.set(host, []);
  byHost.get(host).push(url);
}
const hosts = [...byHost.keys()];
const out = [];
const PER_HOST_CAP = 25;
for (let i = 0; out.length < 100 && i < PER_HOST_CAP; i++) {
  for (const h of hosts) {
    const list = byHost.get(h);
    if (list[i]) out.push(list[i]);
    if (out.length >= 100) break;
  }
}

console.error(`harvested ${found.size} VDP urls from ${hosts.length} dealers; selected ${out.length}`);
for (const h of hosts) console.error(`  ${h}: ${byHost.get(h).length}`);
console.log(JSON.stringify(out, null, 1));
