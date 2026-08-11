// Weekly AMVIC licensee snapshot (check #11).
//
// Pulls AMVIC's public Online Search Portal dataset (Thentia Cloud JSON API —
// the same endpoint the regulator's own consumer search UI calls) and upserts
// it into Supabase via the Management API, so no extra secret is needed beyond
// the SUPABASE_ACCESS_TOKEN the deploy workflow already uses.
//
// Run: node scripts/amvic-refresh.mjs            (needs SUPABASE_ACCESS_TOKEN)
//      node scripts/amvic-refresh.mjs --dry-run  (fetch + report, no writes)
//
// Polite by design: one page at a time, 400ms apart, single weekly run.

const PROJECT_REF = "debigtyjhjamipooajhk";
const BASE = "https://amvic.ca.thentiacloud.net/rest/public/facility/search/";
const PAGE = 250;
const PAUSE_MS = 400;
const DRY = process.argv.includes("--dry-run");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The portal rejects header-less clients with 405; these are the ordinary
// headers a browser sends when the regulator's own search page calls this API.
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-CA,en;q=0.9",
  "Referer": "https://amvic.ca.thentiacloud.net/webs/amvic/register/",
};

// Normalizer shared in spirit with _shared/amvic-match.js — strip corporate
// suffixes and punctuation so "CROWFOOT DODGE CHRYSLER INC." matches
// "Crowfoot Dodge Chrysler".
export function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.,'"()]/g, " ")
    .replace(/\b(inc|incorporated|ltd|limited|llc|llp|corp|corporation|co|company|holdings|enterprises|group|the)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

async function fetchAll() {
  const out = [];
  let total = null;
  for (let skip = 0; total === null || skip < total; skip += PAGE) {
    const url = `${BASE}?keyword=&skip=${skip}&take=${PAGE}&lang=en`;
    let res, json;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        res = await fetch(url, { headers: HEADERS });
        if (!res.ok) throw new Error("HTTP " + res.status);
        json = await res.json();
        break;
      } catch (e) {
        if (attempt === 3) throw new Error(`Fetch failed at skip=${skip}: ${e.message}`);
        await sleep(1500 * attempt);
      }
    }
    if (total === null) {
      total = Number(json.resultCount) || 0;
      console.log(`AMVIC registry: ${total} facilities to sync.`);
    }
    const rows = json.result || [];
    if (!rows.length) break;
    out.push(...rows);
    process.stdout.write(`\r  fetched ${out.length}/${total}`);
    await sleep(PAUSE_MS);
  }
  process.stdout.write("\n");
  return out;
}

const q = (v) => (v == null || v === "" ? "null" : `'${String(v).replace(/'/g, "''")}'`);

async function runSql(sql) {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN is not set");
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) throw new Error(`Management API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json().catch(() => null);
}

function statusBreakdown(rows) {
  const c = {};
  for (const r of rows) c[r.facilityStatus || "unknown"] = (c[r.facilityStatus || "unknown"] || 0) + 1;
  return c;
}

async function main() {
  const rows = await fetchAll();
  if (rows.length < 1000) throw new Error(`Refusing to publish a suspiciously small snapshot (${rows.length} rows) — the live table keeps its previous data.`);

  const counts = statusBreakdown(rows);
  const issued = Object.entries(counts).filter(([k]) => /issued/i.test(k)).reduce((s, [, v]) => s + v, 0);
  console.log("Status breakdown:", counts);
  console.log(`Valid ("Issued"): ${issued} of ${rows.length} (${((issued / rows.length) * 100).toFixed(1)}%)`);

  if (DRY) { console.log("--dry-run: no writes."); return; }

  // Self-provisioning: apply the table DDL every run (idempotent) so the job
  // never depends on someone having pasted a migration by hand.
  const fs = await import("node:fs/promises");
  const ddl = await fs.readFile(new URL("../supabase/migrations/20260810_amvic_licensees.sql", import.meta.url), "utf8");
  await runSql(ddl);

  // Stage into a temp table, then swap in one transaction — the live table is
  // never empty mid-refresh (a report mid-sync must never see "not found").
  await runSql(`drop table if exists amvic_licensees_stage;
    create table amvic_licensees_stage (like amvic_licensees including all);`);

  const BATCH = 400;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const values = chunk.map((f) => `(${[
      q(f.id), q(f.name), q(f.tradeName), q(f.registrationNumber), q(f.facilityStatus), q(f.facilityType),
      q(f.initialDate), q(f.effectiveDate), q(f.expiryDate), q(f.street1), q(f.city), q(f.state), q(f.zip),
      q(f.telephone), q(f.website), q(JSON.stringify(f.activities || [])),
      q(normName(f.name)), q(normName(f.tradeName && f.tradeName !== "N/A" ? f.tradeName : "")), q(normName(f.city)),
    ].join(",")})`).join(",\n");
    await runSql(`insert into amvic_licensees_stage
      (id,name,trade_name,registration_number,facility_status,facility_type,initial_date,effective_date,expiry_date,
       street1,city,province,postal_code,telephone,website,activities,name_key,trade_key,city_key)
      values ${values}
      on conflict (id) do nothing;`);
    process.stdout.write(`\r  staged ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }
  process.stdout.write("\n");

  await runSql(`begin;
    delete from amvic_licensees;
    insert into amvic_licensees select * from amvic_licensees_stage;
    drop table amvic_licensees_stage;
    commit;`);

  const check = await runSql(`select count(*) as n, count(*) filter (where facility_status ilike 'issued%') as issued from amvic_licensees;`);
  console.log("Live table now:", JSON.stringify(check));
}

main().catch((e) => { console.error("AMVIC refresh failed:", e.message); process.exit(1); });
