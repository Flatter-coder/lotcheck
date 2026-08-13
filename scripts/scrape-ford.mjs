// Ford Canada MSRP scraper (MSRP only — rates in the separate estimate-payment
// app). See scripts/lib/ford-stack.mjs and scripts/FORD-NOTES.md.
// Usage: node scripts/scrape-ford.mjs [--model=Explorer] [--year=2026]
import { run, FORD_MODELS, FORD_MODEL_ALIASES } from "./lib/ford-stack.mjs";
run({ make: "Ford", models: FORD_MODELS, aliases: FORD_MODEL_ALIASES }).catch(e => { console.error(e); process.exit(1); });
