// Re-read every freight figure against the page it cites, daily.
//
// WHY. Vic, 2026-09-17, on a 2026 BMW X3 at BMW Royal Oak:
//
//     MSRP              $60,400.00
//     Freight and PDI    $4,395.00
//
// 7.3% of MSRP, $1,625 above the highest freight charge the catalogue held for
// ANY make and 2.3x the lowest. His read: freight differs drastically between
// makers and nobody watches it. The catalogue held 12 rows for 35 makes and had
// no refresh job of any kind -- not stale, never checked.
//
// WHAT IT COSTS TO BE WRONG HERE. In an all-in-pricing province the advertised
// price INCLUDES freight, so an ex-freight MSRP cannot be compared against it.
// Doing that told a buyer a dealer had marked a 4Runner up by $3,164 when they
// had not: freight, A/C, levies and the retailer admin fee were all inside the
// advertised figure (PR #492). Freight is the largest of those lines.
//
// IT VERIFIES, IT NEVER REWRITES. Drift is reported and recorded; no amount is
// ever auto-corrected. The figures live in fee-schedule.ts as reviewed
// constants, and a regex confident enough to overwrite a freight charge is
// confident enough to invent one.
//
// IT REPORTS, IT DOES NOT SEND. Nothing here emails anyone.
//
// NO WALL-CLOCK GATE. The warranty job re-checks the Edmonton hour and exits 0
// when it does not match, which means eight of its last twelve runs reported
// success while skipping every step -- the defect PR #483 fixed for the key
// check. This job does its work whenever it is invoked. [[repeat-fix-pattern]]
//
// Run:  node --experimental-strip-types scripts/verify-freight-catalog.mjs
//       node --experimental-strip-types scripts/verify-freight-catalog.mjs --dry-run

import { politeFetch, requestLedger } from "./lib/polite-fetch.mjs";
import { verifyRow, assess, NOT_READ } from "./lib/freight-verify.mjs";
import { freightCatalog } from "../supabase/functions/_shared/fee-schedule.ts";

const DRY = process.argv.includes("--dry-run");
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const key = (r) => `${r.make}|${r.model}`;

async function previousStatuses() {
  if (!URL_ || !KEY) return {};
  try {
    const res = await politeFetch(`${URL_}/rest/v1/freight_verification?select=make,model,status`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
      timeoutMs: 15_000,
    });
    if (!res.ok) return {};
    const rows = await res.json();
    return Object.fromEntries((Array.isArray(rows) ? rows : []).map((r) => [key(r), r.status]));
  } catch { return {}; }
}

async function record(results) {
  if (DRY || !URL_ || !KEY) return;
  const body = results.map((r) => ({
    make: r.make, model: r.model, last_verified_at: new Date().toISOString(),
    status: r.status, amount_held: r.amount,
    amounts_seen: r.seen && r.seen.length ? r.seen : null,
    note: r.note, http: r.http ?? null,
  }));
  const res = await politeFetch(`${URL_}/rest/v1/freight_verification?on_conflict=make,model`, {
    method: "POST",
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(body),
    timeoutMs: 20_000,
  });
  if (!res.ok) console.warn(`  could not record verification state: HTTP ${res.status}`);
}

async function main() {
  const rows = freightCatalog();
  console.log(`Freight catalogue: ${rows.length} figure(s) across ${new Set(rows.map((r) => r.make)).size} make(s).\n`);

  const previous = await previousStatuses();
  const results = [];

  for (const row of rows) {
    let page = null;
    let http = null;
    if (row.sourceUrl) {
      try {
        const res = await politeFetch(row.sourceUrl, { timeoutMs: 25_000 });
        http = res.status;
        if (res.ok) page = await res.text();
      } catch (e) {
        console.warn(`  ${row.make} ${row.model}: ${e.message}`);
      }
    }
    const v = verifyRow({ ...row, source_url: row.sourceUrl }, page, http);
    results.push({ ...v, make: row.make, model: row.model, amount: row.amount, key: key(row), http });
  }

  // ── the report ───────────────────────────────────────────────────────────
  const a = assess(results, { previous });

  const byStatus = {};
  for (const r of results) (byStatus[r.status] ||= []).push(r);
  for (const [st, list] of Object.entries(byStatus)) {
    console.log(`${st.toUpperCase()} (${list.length})`);
    for (const r of list) {
      console.log(`  ${r.make} ${r.model}  $${Number(r.amount).toLocaleString("en-CA")}  — ${r.note}`);
    }
    console.log("");
  }

  if (a.noSource) {
    console.warn(
      `${a.noSource} of ${a.total} figure(s) name no re-readable source URL, so nothing can check them. ` +
      `That is our backlog, not a finding about any manufacturer: add sourceUrl to the row in fee-schedule.ts.\n`,
    );
  }

  console.log(requestLedger());
  await record(results);

  console.log(
    `\n${a.confirmed} confirmed · ${a.drifted} drifted · ${a.failedToRead} could not be read ` +
    `· ${a.noSource} have no source URL · ${a.total} total`,
  );

  if (a.regressed.length) {
    console.error(`\n${a.regressed.length} figure(s) WERE confirmed and no longer are:`);
    for (const d of a.regressed) console.error(`  ${d.make} ${d.model}: ${d.note}`);
    console.error("\nRe-read the source and update fee-schedule.ts by hand. This job never rewrites a figure.");
  }
  if (a.mostlyUnread) {
    console.error(
      `\n${a.failedToRead} of ${a.attempted} figures WITH a source URL could not be read. ` +
      `"No drift" here would mean "nothing was examined", and treating that as green is the defect this job exists to prevent.`,
    );
  }

  process.exit(a.red ? 1 : 0);
}

main().catch((e) => { console.error("verify-freight-catalog failed:", e.message); process.exit(1); });
