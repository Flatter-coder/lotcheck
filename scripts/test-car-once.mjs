// Gate: every aggregate over live inventory counts a car ONCE.
//
// On 2026-09-24, 1,082 live VINs sat on two or three dealers' sites and every
// counter summed rows: the /crawl coverage card, the daily inventory report,
// days-on-lot, the admin lot-leverage table and the MSRP deviation read. PR
// #540 had taught only the comps RPCs that one car is one car. The rule now
// has one author, fn_listing_once (20260924b_count_a_car_once.sql), and this
// gate keeps every reader on it. It reads the definition a fresh apply leaves
// in place (the LAST migration to create each function), so a later migration
// re-creating one of these from an older copy fails here. The runtime proof is
// that migration's @assert lines, which the apply runner checks live.
//
// Run: node scripts/test-car-once.mjs
import { readFileSync } from "node:fs";
import { latestDefinition, codeOnly } from "./lib/migration-defs.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
};

const helper = latestDefinition("fn_listing_once");
check("fn_listing_once is defined", !!helper);
const h = helper ? codeOnly(helper.sql).toLowerCase() : "";
check("fn_listing_once leaves group feeds out", /not\s+ds\.group_feed/.test(h));
check("fn_listing_once keeps one row per VIN", /partition\s+by\s+vin/.test(h) && /pick\s*=\s*1/.test(h));
check("fn_listing_once names a dealer only when there is exactly one", /case\s+when\s+n\s*=\s*1\s+then\s+dealer_id\s+end/.test(h));
// It returns VINs. Anon must never be able to call it.
check("fn_listing_once is revoked from anon", /revoke\s+all\s+on\s+function\s+public\.fn_listing_once[^;]*\banon\b/.test(h));
check("fn_listing_once is granted to nobody public-facing",
  !/grant\s+execute\s+on\s+function\s+public\.fn_listing_once[^;]*\b(anon|authenticated|public)\b/.test(h));

// Each reader's live body reads the helper and not the raw table.
// inventory_daily_counts also counts history (delisted, first seen, price
// moves), so it may read vehicle_listing -- but only with group feeds out.
const READERS = [
  "inventory_daily_counts", "top_days_on_lot", "fn_crawl_coverage",
  "fn_admin_lot_leverage_summary", "fn_alberta_msrp_deviation", "fn_comp_pool",
];
for (const name of READERS) {
  const def = latestDefinition(name);
  const code = def ? codeOnly(def.sql).toLowerCase() : "";
  check(`${name} reads fn_listing_once (${def?.file ?? "undefined"})`, code.includes("fn_listing_once("));
  if (name === "inventory_daily_counts") {
    check(`${name} excludes group feeds wherever it reads rows`, /not\s+ds\.group_feed/.test(code));
  } else {
    check(`${name} does not count raw vehicle_listing rows`, !/\bvehicle_listing\b/.test(code));
  }
}

// The two batch scripts that aggregate listings read the same helper.
for (const file of ["scripts/build-city-price-index.mjs", "scripts/build-alberta-inventory-daily.mjs"]) {
  const src = readFileSync(file, "utf8");
  check(`${file} reads fn_listing_once`, /["'`](rpc\/)?fn_listing_once["'`]/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
