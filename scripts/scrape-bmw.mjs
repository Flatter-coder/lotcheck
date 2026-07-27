// BMW MSRP + finance/lease via the SM360 dealer inventory feed (bmw.ca gates all
// prices). See scripts/lib/sm360-stack.mjs and scripts/BMW-NOTES.md.
import { run } from "./lib/sm360-stack.mjs";
run({ make: "BMW", dealers: ["https://www.calgarybmw.ca"] }).catch(e => { console.error(e); process.exit(1); });
