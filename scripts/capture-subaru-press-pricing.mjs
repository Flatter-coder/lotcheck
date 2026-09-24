// Subaru launch-pricing capture: read Subaru Canada's own newsroom RSS feed,
// find the releases that announce new-model pricing, and pull the per-trim
// MSRP + all-in figure out of the manufacturer's own <table class="pricing-table">.
//
// WHY THIS EXISTS, AND WHY IT IS SCOPED TO ONE MAKE. See scripts/lib/press-pricing.mjs
// for the full rationale: no Build & Price scraper exists for Subaru, and its
// newsroom's pricing table states BOTH the ex-freight MSRP and Subaru's own
// all-in "EVP" figure in one place, verified against three real releases.
//
// Run: node scripts/capture-subaru-press-pricing.mjs             (writes)
//      node scripts/capture-subaru-press-pricing.mjs --dry-run   (fetch + print, no writes)
//      node scripts/capture-subaru-press-pricing.mjs --since=2026-01-01
//
// No API key needed — subaru.ca serves plain HTML/RSS to a stateless fetch,
// confirmed live 2026-09-23.

import { parseFeedItems, identifyPricingRelease, toCatalogRows } from "./lib/press-pricing.mjs";
import { writeCatalogs } from "./lib/catalog-io.mjs";

const FEED_URL = "https://www.subaru.ca/Content/7907/media/en-ca/rss/subarunewsfeed.xml";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
}));
const DRY = !!args["dry-run"];
const since = args.since ? new Date(args.since) : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function main() {
  const feedXml = await fetchText(FEED_URL);
  const items = parseFeedItems(feedXml);
  if (!items.length) throw new Error("subaru newsfeed: parsed zero items — feed shape may have changed");
  console.log(`${items.length} newsfeed items.`);

  const candidates = items.filter((it) => identifyPricingRelease(it.title));
  console.log(`${candidates.length} look like pricing releases (title matched a known model + year).`);

  const rows = [];
  let fetched = 0, empty = 0, failed = 0;
  for (const item of candidates) {
    if (since && item.pubDate && new Date(item.pubDate) < since) continue;
    try {
      const html = await fetchText(item.link);
      const got = toCatalogRows(item, html);
      if (!got.length) {
        empty++;
        console.warn(`  (no pricing table found) ${item.title}`);
      } else {
        fetched++;
        rows.push(...got);
        console.log(`  ${item.title} -> ${got.map((r) => `${r.trim} $${r.msrp.toLocaleString()}${r.all_in_price ? ` (EVP $${r.all_in_price.toLocaleString()})` : ""}`).join(", ")}`);
      }
    } catch (e) {
      failed++;
      console.warn(`  ${item.title}: ${e.message}`);
    }
    await sleep(400);
  }

  console.log(`\n${fetched} releases captured, ${empty} matched-but-no-table, ${failed} fetch failures. ${rows.length} rows total.`);
  if (DRY) { console.log("--dry-run: no writes."); console.table(rows); return; }
  if (!rows.length) { console.log("Nothing to write."); return; }

  // upsert:true — this is a targeted, keyed capture of specific new trims, the
  // same pattern scrape-published-msrp.mjs uses, never a delete-then-insert of
  // Subaru's whole catalogue. Every row here also carries source_url, which
  // replaceRows' bulk-scraper DELETE already spares on its own (see the
  // "source_url=is.null" guard in catalog-io.mjs) — belt and suspenders, not
  // a substitute for each other.
  await writeCatalogs("Subaru", { msrpRows: rows }, {
    upsert: true,
    priceBasis: "excl_freight",
  });
  console.log("Done.");
}

main().catch((e) => { console.error("capture-subaru-press-pricing failed:", e.message); process.exit(1); });
