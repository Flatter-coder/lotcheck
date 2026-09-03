// Honda Canada MSRP + finance/lease-rate scraper.
// See scripts/lib/honda-stack.mjs and scripts/HONDA-NOTES.md for the platform.
// MSRP comes from .../website/price-calculator (ex-freight, per trim); the
// finance/lease rates from .../website/calculator/payment, which the gateway
// has refused since 2026-08-21 -- rates simply stay untouched until it clears.
//
// Usage:
//   node scripts/scrape-honda.mjs                    # all models, dry-run if no key
//   node scripts/scrape-honda.mjs --model=civic_sedan
//   node scripts/scrape-honda.mjs --year=2026
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/scrape-honda.mjs

import { run } from "./lib/honda-stack.mjs";

run({
  make: "Honda",
  host: "https://www.honda.ca",
  page: "https://www.honda.ca/en/buildyourhonda",
  apiBase: "https://api.honda.ca/financials-worksheets/H/Live/website",
  apikey: "B96772C4-CDA7-4E6F-BD37-7F9A36FF3E18",
  site: "Honda",
}).catch(e => { console.error(e); process.exit(1); });
