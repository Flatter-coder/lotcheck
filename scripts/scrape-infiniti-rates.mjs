// Infiniti finance/lease rates via SM360 dealer feed (infiniti.ca gates rates).
// Layered rates-only on top of the existing Infiniti MSRP source. Multiple
// Dilawri stores for wider model/trim coverage. See scripts/lib/sm360-stack.mjs.
import { run } from "./lib/sm360-stack.mjs";
run({
  make: "Infiniti",
  ratesOnly: true,
  dealers: [
    "https://www.infinitinorthcalgary.ca",
    "https://www.infinitinorthvancouver.ca",
    "https://www.401dixieinfiniti.ca",
  ],
}).catch(e => { console.error(e); process.exit(1); });
