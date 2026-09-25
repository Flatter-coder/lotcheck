// The daily report's catalogue check marks (Vic, 2026-09-25). Pins that a
// refresh can never be recorded greener than it was, and that the catalogue
// list is the same in the table, the writer and the page.
//
// Run: node scripts/test-catalog-status.mjs
import { readFileSync } from "node:fs";
import { statusRow, CATALOGS } from "./record-catalog-status.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`ok    ${name}`); } else { fail++; console.log(`FAIL  ${name}${detail ? " -- " + detail : ""}`); } };

console.log("the verdict");
check("a job that succeeded, with no summary, is green", statusRow("msrp", "success").state === "green");
check("a job that failed is red", statusRow("msrp", "failure").state === "red");
check("a cancelled or skipped refresh is red, with its own reason",
  statusRow("inventory", "cancelled").state === "red" && /cancelled/.test(statusRow("inventory", "cancelled").note)
  && statusRow("price_compare", "skipped").state === "red" && /did not run/.test(statusRow("price_compare", "skipped").note));
const lifted = statusRow("msrp", "failure", { state: "green", note: "All makes refreshed." });
check("a script's green never survives a failed job", lifted.state === "red" && /not counted as refreshed/.test(lifted.note), JSON.stringify(lifted));
const amber = statusRow("warranty", "success", { state: "amber", covered: 9, of_total: 32, unit: "makes", note: "9 of 32 re-read." });
check("a job's success never lifts a script's amber", amber.state === "amber" && amber.covered === 9 && amber.of_total === 32);
check("an unknown state in a summary is ignored, never trusted", statusRow("msrp", "success", { state: "gold" }).state === "green");
let threw = false; try { statusRow("vibes", "success"); } catch { threw = true; }
check("an unknown catalogue is refused", threw);
check("every row carries a sentence", CATALOGS.every((c) => statusRow(c, "failure").note.length > 0 && statusRow(c, "success").note.length > 0));

console.log("one list, three places");
const sql = readFileSync(new URL("../supabase/migrations/20260925_catalog_status.sql", import.meta.url), "utf8");
const inSql = [...(sql.match(/catalog\s+text\s+not null check \(catalog in \(([^)]*)\)\)/) || [, ""])[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
check("the table accepts exactly the writer's catalogues", inSql.sort().join() === [...CATALOGS].sort().join(), `${inSql} vs ${CATALOGS}`);
const page = readFileSync(new URL("../public/alberta-inventory-daily.html", import.meta.url), "utf8");
const inPage = [...(page.match(/var CATS = \[([\s\S]*?)\n\s*\];/) || [, ""])[1].matchAll(/\["([a-z_]+)",/g)].map((m) => m[1]);
check("the daily report shows every catalogue, and only those", inPage.sort().join() === [...CATALOGS].sort().join(), `${inPage} vs ${CATALOGS}`);
check("the page reads the status through fn_catalog_status", /rpc\("fn_catalog_status"/.test(page));
check("the page downgrades a stale green and never upgrades", /age > 26\)\{ state = "red"/.test(page) && /age > 13 && state === "green"\)\{ state = "amber"/.test(page) && !/state = "green"/.test(page));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
