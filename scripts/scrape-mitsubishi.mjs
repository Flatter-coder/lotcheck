// Mitsubishi Motors Canada MSRP scraper.
// MSRP only -- the model landing pages' trim tables, corroborated against the
// Build & Price configurator's GraphQL. See scripts/lib/mitsubishi-stack.mjs.
//
// Usage:
//   node scripts/scrape-mitsubishi.mjs                   # all models, dry-run if no key
//   node scripts/scrape-mitsubishi.mjs --model=outlander-phev   (slug, code DGE, or name)
//   node scripts/scrape-mitsubishi.mjs --year=2026
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/scrape-mitsubishi.mjs

import { run } from "./lib/mitsubishi-stack.mjs";
run().catch(e => { console.error(e); process.exit(1); });
