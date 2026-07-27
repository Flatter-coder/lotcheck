// Toyota Canada MSRP + finance/lease-rate scraper. See scripts/lib/tci-stack.mjs
// for the shared Toyota/Lexus platform logic and endpoint documentation.
//
// Usage:
//   node scripts/scrape-toyota.mjs                # full lineup, dry-run if no key
//   node scripts/scrape-toyota.mjs --series=PHV   # one series (pilot)
//   node scripts/scrape-toyota.mjs --year=2027    # pin a model year
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/scrape-toyota.mjs

import { run } from "./lib/tci-stack.mjs";

run({
  host: "https://www.toyota.ca",
  brand: "TOY",
  brandFolder: "TOYOTA",
  makeName: "Toyota",
  seriesPageSlug: "prius-plug-in-hybrid",
}).catch(e => { console.error(e); process.exit(1); });
