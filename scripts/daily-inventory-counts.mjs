// What moved in the last 24h, for the daily report.
//
// Reads the aggregate-only RPC (supabase/migrations/20260921_inventory_daily_counts.sql)
// rather than the tables, so this runs on the public anon key and never holds
// row data. Prints counts and nothing that identifies a vehicle.
//
// A DELISTING IS NOT A SALE. The line below says "stopped appearing" and must
// keep saying it. We observed a disappearance; we do not know why.
import { readFileSync } from "node:fs";

const url = process.env.SUPABASE_URL || "https://debigtyjhjamipooajhk.supabase.co";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || (() => {
  // The anon key is public and already shipped in the bundle; read it from there
  // rather than asking anyone to paste a secret to run a report.
  const m = readFileSync("src/App.jsx", "utf8").match(/SB_ANON_KEY\s*=\s*["']([^"']+)/);
  return m && m[1];
})();

if (!key) { console.error("no key available (SUPABASE_ANON_KEY, service role, or SB_ANON_KEY in src/App.jsx)"); process.exit(1); }

async function main() {
  const res = await fetch(`${url}/rest/v1/rpc/inventory_daily_counts`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: "{}",
  });
  const text = await res.text();
  if (!res.ok) {
    // The function not being there is a real answer, not a crash: it means the
    // migration has not been applied, and the report must say so rather than
    // print zeros. Zeros and "not deployed" look identical in a table.
    const notDeployed = text.includes("PGRST202") || text.toLowerCase().includes("could not find");
    console.error(notDeployed
      ? "inventory_daily_counts is NOT DEPLOYED — apply supabase/migrations/20260921_inventory_daily_counts.sql via the Apply migrations workflow. Reporting zeros here would be a lie."
      : `RPC failed: HTTP ${res.status}: ${text.slice(0, 200)}`);
    return 1;
  }

  const r = (JSON.parse(text) || [])[0];
  if (!r) { console.error("RPC returned no row — treat as unknown, not as zero."); return 1; }

  const today = new Date().toISOString().slice(0, 10);
  const observed = r.newest_observation;
  // Every figure is CARS (one per VIN, group feeds excluded), not listings:
  // a car on two dealers' sites is one car. 20260924b_count_a_car_once.sql.
  console.log("Inventory, last 24h (cars, each counted once)");
  console.log(`  cars tracked            ${r.listings_total}`);
  console.log(`  live now                ${r.listings_live} cars across ${r.dealers_live} dealers`);
  console.log(`  first seen in 24h       ${r.first_seen_24h}`);
  console.log(`  stopped appearing       ${r.delisted_24h}   (a delisting is not a sale)`);
  console.log(`  price changed in 24h    ${r.price_moves_24h}`);
  console.log(`  newest observation      ${observed || "never"}`);
  if (observed !== today) {
    console.log("");
    console.log(`  WARNING: nothing was observed today (${today}). The crawl did not run,`);
    console.log(`  so every count above describes state as of ${observed || "never"}, not today.`);
  }
  return 0;
}

process.exitCode = await main();
