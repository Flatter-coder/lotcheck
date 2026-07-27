// Ford finance/lease rates via the Convertus dealer feed (Ford's own rates live
// in the gated estimate-payment app). MSRP comes from scrape-ford.mjs, so this
// is rates-only. See scripts/lib/convertus-stack.mjs.
import { run } from "./lib/convertus-stack.mjs";
run({ make: "Ford", dealers: [{ host: "https://www.denhamford.ca", cp: 1285 }], ratesOnly: true })
  .catch(e => { console.error(e); process.exit(1); });
