// Gate for the inventory_daily_counts RPC.
//
// The function is the only path by which the public client learns anything at
// all about vehicle_listing, so two properties have to hold for as long as it
// exists: it may leak nothing about a specific car, and it may never describe a
// disappearance as a sale. Both are properties of the SQL text, so both are
// checked against the SQL text rather than against a description of it.
//
// The text checked is the LAST migration to define the function (see
// lib/migration-defs.mjs). Until 2026-09-24 this read the file NAMED after it,
// which a redefinition in 20260924b_count_a_car_once.sql would have left
// passing on a body that no longer runs.
import { latestDefinition } from "./lib/migration-defs.mjs";

const DEF = latestDefinition("inventory_daily_counts");
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
};

check("the migration exists", !!DEF, "no migration defines inventory_daily_counts");
if (!DEF) { console.log("\n0 passed, 1 failed"); process.exit(1); }
console.log(`(checking ${DEF.file})`);
const sql = DEF.sql;
const lower = sql.toLowerCase();
// Comments are prose, not behaviour. Every structural check below runs against
// the executable SQL only — commenting a line out must read as removing it.
const codeOnly = sql.split("\n").filter(l => !l.trim().startsWith("--")).join("\n");
const code = codeOnly.toLowerCase();

// Without SECURITY DEFINER the function runs as the caller and returns 42501 to
// anon — it would be built, granted, and useless.
check("runs as definer", code.includes("security definer"));
// An unpinned search_path on a definer function is the standard privilege
// escalation: the caller chooses which vehicle_listing it reads.
check("search_path is pinned", code.includes("set search_path"));
check("execute is granted to anon", /grant\s+execute[\s\S]{0,120}\banon\b/i.test(sql));
check("the broad default grant is revoked first",
  code.indexOf("revoke all on function") !== -1 &&
  code.indexOf("revoke all on function") < code.indexOf("grant execute"));

// AGGREGATE ONLY. The returns clause is the whole contract: if a per-vehicle
// column can be named here, a caller can read it. Checked on the returns block
// alone, because "vin" legitimately appears in prose above it.
const returns = sql.slice(lower.indexOf("returns table"), lower.indexOf("language sql"));
for (const col of ["vin", "stock_no", "dealer_id", "list_price", "sale_price", "msrp", "model", "odometer"]) {
  check(`the returns clause exposes no ${col}`, !returns.toLowerCase().includes(col));
}
check("every returned column is a count or a date",
  returns.split("\n").filter(l => l.trim() && !l.trim().startsWith("--") && l.includes(" "))
    .every(l => /\b(bigint|date|integer|numeric)\b/i.test(l) || /returns table|\)/.test(l)));

// A DELISTING IS NOT A SALE. The rule is the reason this column is named the
// way it is, and the name is the only thing a reader of the report sees.
// The word may appear in the prose that explains the rule — it MUST NOT appear
// as a returned column or an alias, because that is what a caller reads back.
check("no returned column is called sold", !returns.toLowerCase().includes("sold"));
check("nothing in the executable SQL aliases anything as sold",
  !/\bas\s+sold\b/i.test(codeOnly) && !/\bsold_\w+/i.test(codeOnly));
check("the delisting column says delisted", /delisted_24h/.test(sql));
check("the file states the delisting rule in words",
  /not a sale|never sold|NOT sold/i.test(sql));

// If the crawl stops, the counts freeze and still look like counts. The report
// needs the observation date beside them to tell the difference.
check("the caller is given the newest observation date", /newest_observation/.test(sql));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
