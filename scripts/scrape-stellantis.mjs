// Stellantis Canada (Jeep, Ram, Dodge, Chrysler, Fiat) MSRP + finance/lease
// scraper. All five share one FCA configurator API — see scripts/lib/fca-stack.mjs.
//
// Usage:
//   node scripts/scrape-stellantis.mjs               # all 5 brands, dry-run if no key
//   node scripts/scrape-stellantis.mjs --brand=jeep  # one brand
//   node scripts/scrape-stellantis.mjs --year=2025   # pin a model year
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/scrape-stellantis.mjs

import { run } from "./lib/fca-stack.mjs";
run().catch(e => { console.error(e); process.exit(1); });
