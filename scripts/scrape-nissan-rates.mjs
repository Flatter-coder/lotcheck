// Nissan finance/lease rates via the Convertus dealer feed (Nissan's rates are
// behind the gated GraphQL). MSRP comes from scrape-nissan.mjs; rates-only.
import { run } from "./lib/convertus-stack.mjs";
run({ make: "Nissan", dealers: [{ host: "https://www.fishcreeknissancalgary.ca", cp: 1377 }], ratesOnly: true })
  .catch(e => { console.error(e); process.exit(1); });
