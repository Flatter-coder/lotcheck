// Record one catalogue refresh in public.catalog_status (20260925_catalog_status.sql),
// the table the daily report reads for its green / amber / red checks.
//
// Called as the LAST step of each refresh workflow, with `if: always()`, so a
// failed run is recorded as red instead of leaving yesterday's green standing:
//
//   node scripts/record-catalog-status.mjs --catalog msrp --outcome ${{ job.status }} \
//        [--summary "$RUNNER_TEMP/catalog-status.json"] [--run-url <url>]
//
// --summary is optional JSON the job's own script wrote:
//   { "state": "green|amber|red", "rows_total": n, "covered": n, "of_total": n,
//     "unit": "makes", "note": "one plain sentence" }
//
// THE WORSE OF THE TWO WINS. A script may call itself green, but if the job
// around it failed the row is red; a job that succeeded cannot lift a script's
// own amber. Nothing here ever upgrades a verdict. [[three-state-check-marks]]
import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const CATALOGS = ["msrp", "apr_new", "apr_used", "warranty", "freight_pdi", "dealer_fees", "inventory", "price_compare", "maker_vs_dealer"];
const RANK = { green: 0, amber: 1, red: 2 };

// The row to write, from the job's outcome and the script's optional summary.
export function statusRow(catalog, outcome, summary = null) {
  if (!CATALOGS.includes(catalog)) throw new Error(`unknown catalogue "${catalog}"`);
  const jobState = outcome === "success" ? "green" : "red";
  const s = summary && typeof summary === "object" ? summary : {};
  const scriptState = RANK[s.state] != null ? s.state : null;
  const state = scriptState && RANK[scriptState] > RANK[jobState] ? scriptState : jobState;
  const int = (v) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Math.round(Number(v)) : null);
  const note = String(s.note || "").trim()
    || (jobState === "green" ? "The refresh finished and passed its own checks."
      : outcome === "cancelled" ? "The refresh was cancelled before it finished; the stored figures are from the last good run."
      : outcome === "skipped" ? "The refresh did not run this time; the stored figures are from the last good run."
      : "The refresh failed its own checks; the stored figures are from the last good run.");
  return {
    catalog, state,
    rows_total: int(s.rows_total), covered: int(s.covered), of_total: int(s.of_total),
    unit: s.unit ? String(s.unit) : null,
    note: jobState === "red" && scriptState === "green" ? `${note} The job around it failed, so this is not counted as refreshed.` : note,
  };
}

async function main() {
  const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
  const catalog = arg("--catalog"), outcome = arg("--outcome") || "failure", sumPath = arg("--summary");
  let summary = null;
  if (sumPath && existsSync(sumPath)) {
    try { summary = JSON.parse(readFileSync(sumPath, "utf8")); } catch (e) { console.warn(`summary unreadable (${e.message}); recording the job outcome alone`); }
  }
  const row = { ...statusRow(catalog, outcome, summary), run_url: arg("--run-url") || null };
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error("Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }
  const res = await fetch(`${url}/rest/v1/catalog_status`, {
    method: "POST",
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", prefer: "return=minimal", "User-Agent": "LotCheckBot/1.0 (+https://lotcheck.ca/about)" },
    body: JSON.stringify(row),
  });
  if (!res.ok) { console.error(`catalog_status write failed: HTTP ${res.status} ${await res.text()}`); process.exit(1); }
  console.log(`catalog_status: ${catalog} -> ${row.state.toUpperCase()} -- ${row.note}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
