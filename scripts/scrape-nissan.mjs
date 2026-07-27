// Nissan Canada MSRP scraper. See scripts/lib/nissan-stack.mjs. MSRP only.
import { run } from "./lib/nissan-stack.mjs";
run({ make: "Nissan", host: "https://www.nissan.ca" }).catch(e => { console.error(e); process.exit(1); });
