// Lincoln Canada MSRP scraper (MSRP only). Same Ford platform, make=Lincoln.
// See scripts/lib/ford-stack.mjs and scripts/FORD-NOTES.md.
// Usage: node scripts/scrape-lincoln.mjs [--model=Nautilus] [--year=2026]
import { run, LINCOLN_MODELS } from "./lib/ford-stack.mjs";
run({ make: "Lincoln", models: LINCOLN_MODELS }).catch(e => { console.error(e); process.exit(1); });
