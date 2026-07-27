// Mercedes-Benz finance/lease rates via the SM360 dealer feed (mercedes-benz.ca
// hides rates behind the payment-estimator). MSRP comes from scrape-mercedes.mjs
// (nafta-service, broader coverage), so this writes RATES ONLY — it never
// touches msrp_catalog. See scripts/lib/sm360-stack.mjs.
import { run } from "./lib/sm360-stack.mjs";
run({ make: "Mercedes-Benz", dealers: ["https://www.mercedes-benz-countryhills.ca"], ratesOnly: true })
  .catch(e => { console.error(e); process.exit(1); });
