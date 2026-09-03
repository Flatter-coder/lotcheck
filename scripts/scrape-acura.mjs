// Acura Canada MSRP + finance/lease-rate scraper.
// Acura is Honda's identical twin platform (see scripts/HONDA-NOTES.md):
// same dmmapi + api.honda.ca worksheets, brand letter A, its own apikey/site.
// MSRP comes from .../website/price-calculator (ex-freight, per trim); the
// finance/lease rates from .../website/calculator/payment, which the gateway
// has refused since 2026-08-21 -- rates simply stay untouched until it clears.
//
// Usage:
//   node scripts/scrape-acura.mjs                # all models, dry-run if no key
//   node scripts/scrape-acura.mjs --model=integra
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/scrape-acura.mjs

import { run } from "./lib/honda-stack.mjs";

run({
  make: "Acura",
  host: "https://www.acura.ca",
  page: "https://www.acura.ca/en/buildyouracura",
  apiBase: "https://api.honda.ca/financials-worksheets/A/Live/website",
  apikey: "4AB8BBA7-4E98-4732-9789-FE5970B415A6",
  site: "Acura",
}).catch(e => { console.error(e); process.exit(1); });
