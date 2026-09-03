// GM Canada (Chevrolet, GMC, Buick, Cadillac) MSRP scraper.
// MSRP only — GM's finance/lease rates are session-gated (see scripts/COVERAGE.md).
// See scripts/lib/gm-stack.mjs for the source, its basis (excl_freight) and
// why the trim-matrix price is never stored.
//
// Usage:
//   node scripts/scrape-gm.mjs                  # all 4 brands, dry-run if no key
//   node scripts/scrape-gm.mjs --brand=buick
//   node scripts/scrape-gm.mjs --year=2026
//   node scripts/scrape-gm.mjs --brand=chevrolet --model=equinox   # one carline/body slug
//
// Budget: one fully-configured call (~0.5 s, 100-270 KB) per style; the four
// brands exposed 596 styles on 2026-09-02, so a full run is roughly 7 minutes.

import { run } from "./lib/gm-stack.mjs";
run().catch(e => { console.error(e); process.exit(1); });
