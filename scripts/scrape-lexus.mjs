// Lexus Canada MSRP + finance/lease-rate scraper. Lexus.ca runs the same Adobe
// AEM ("tcidigital") stack as Toyota.ca, so it reuses scripts/lib/tci-stack.mjs
// unchanged -- only the host, brand code, and vehicle-fragment folder differ.
//
// Usage:
//   node scripts/scrape-lexus.mjs                # full lineup, dry-run if no key
//   node scripts/scrape-lexus.mjs --series=NX    # one series
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/scrape-lexus.mjs

import { run } from "./lib/tci-stack.mjs";

run({
  host: "https://www.lexus.ca",
  brand: "LEX",
  brandFolder: "LEXUS",
  makeName: "Lexus",
  seriesPageSlug: "nx",
}).catch(e => { console.error(e); process.exit(1); });
