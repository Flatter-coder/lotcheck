// Infiniti Canada MSRP scraper (same platform as Nissan). MSRP only.
import { run } from "./lib/nissan-stack.mjs";
run({ make: "Infiniti", host: "https://www.infiniti.ca" }).catch(e => { console.error(e); process.exit(1); });
