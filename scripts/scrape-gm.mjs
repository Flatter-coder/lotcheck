// GM Canada (Chevrolet, GMC, Buick, Cadillac) MSRP scraper.
// MSRP only — GM's finance/lease rates are session-gated (see scripts/COVERAGE.md).
// See scripts/lib/gm-stack.mjs.
//
// Usage:
//   node scripts/scrape-gm.mjs                  # all 4 brands, dry-run if no key
//   node scripts/scrape-gm.mjs --brand=buick
//   node scripts/scrape-gm.mjs --year=2026

import { run } from "./lib/gm-stack.mjs";
run().catch(e => { console.error(e); process.exit(1); });
