// Publishes public/data/alberta-price-index.json from city_dealer_index —
// the ONE step that makes real price-vs-MSRP numbers visible on the public
// /alberta page. Everything upstream of this (the crawl, the trim-match, the
// aggregation, the publishable gate) can run and be inspected without this
// ever being called.
//
// NOT WIRED INTO ANY WORKFLOW ON PURPOSE. crawl-inventory.yml rebuilds
// city_dealer_index (a private table) after every real crawl, but nothing
// calls this script automatically. alberta-scope.md's own launch-gate
// checklist (defamation-lawyer sign-off on authored MSRP-deviation content)
// is not yet satisfied, so going from "computed, gated, private" to "on the
// public site" stays a deliberate, separate action — same "build it, ship it
// dormant, flip it when cleared" posture as the crawl cron itself.
//
// ONLY is_publishable=true rows are written. A city that doesn't clear the
// gate is simply ABSENT from the file, never present with a number — missing
// beats wrong. public/alberta.html already treats an absent city as "not
// enough data" once this file exists; see the price-index fetch there.
//
// Run (Node 24+, from repo root):
//   node scripts/publish-price-index-json.mjs --dry-run   # print, write nothing
//   node scripts/publish-price-index-json.mjs              # writes the JSON file; needs SUPABASE_* env
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DRY = process.argv.includes("--dry-run");
const OUT = "public/data/alberta-price-index.json";

async function main() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"); process.exit(1); }
  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  const res = await fetch(`${url}/rest/v1/city_dealer_index?select=city,province,n_dealers,n_listings,index_pct,p25_pct,p75_pct,avg_deviation_dollars,max_updated_at,computed_at&is_publishable=eq.true&order=n_listings.desc`, { headers });
  if (!res.ok) throw new Error(`read city_dealer_index -> HTTP ${res.status}: ${await res.text()}`);
  const rows = await res.json();

  const generatedAt = new Date().toISOString().slice(0, 10);
  const out = {
    source: "LotCheck — dealers' own advertised prices, trim-matched to msrp_catalog",
    generatedAt,
    cities: rows.map((r) => ({
      name: r.city,
      province: r.province,
      n_dealers: r.n_dealers,
      n_listings: r.n_listings,
      index_pct: r.index_pct,
      p25_pct: r.p25_pct,
      p75_pct: r.p75_pct,
      avg_deviation_dollars: r.avg_deviation_dollars,
      as_of: (r.max_updated_at || r.computed_at || "").slice(0, 10),
    })),
  };

  console.log(`${rows.length} publishable cities:`);
  for (const c of out.cities) console.log(`  ${c.name}: ${c.index_pct > 0 ? "+" : ""}${c.index_pct?.toFixed(1)}% (n=${c.n_dealers} dealers, ${c.n_listings} listings, as of ${c.as_of})`);

  if (DRY) { console.log("\nDRY RUN — nothing written."); return; }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nWrote ${OUT}`);
}

await main();
