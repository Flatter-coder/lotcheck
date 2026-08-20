// DAILY RECALL CHECK — sweeps Transport Canada's VRDB for every make we cover,
// stores what it finds, and STAGES the newly-appeared recalls.
//
// It does not email anyone. Nothing here delivers. The staged list is written to
// vehicle_recall / recall_sweep and printed into the run's job summary; sending
// is a separate, human-approved act.
//
// Run:  node scripts/check-recalls-daily.mjs
//       node scripts/check-recalls-daily.mjs --dry-run     (no writes, prints only)
//       node scripts/check-recalls-daily.mjs --make Toyota (one make)
//
// ---------------------------------------------------------------------------
// WHAT THIS IS FOR
// ---------------------------------------------------------------------------
// The recall lookup already runs live inside every report. That is right, and
// this does not replace it. What it adds is memory: a recall issued the day
// after a buyer's report is invisible to that buyer, because their report was
// true when it was signed. Detecting "NEW" needs yesterday to still exist.
//
// ---------------------------------------------------------------------------
// EVERY GUARD BELOW IS A BUG THIS REPO HAS ALREADY HAD
// ---------------------------------------------------------------------------
//  * Truncation -> refusal.   The VRDB caps a response and says nothing about
//    it; the default 25-row cap hides 43% of Toyota's recalls. Handled in
//    lib/tc-recalls.mjs; here a truncated make is recorded and skipped.
//  * Empty read -> error.     A make with recalls on file that returns zero is
//    an upstream fault, never "the recalls were withdrawn" (daily APR rule).
//  * Collapse   -> refusal.   >50% drop against what we hold refuses the write
//    (catalog-refresh rule).
//  * A failed make never blocks the others, and never counts as clean.
//  * Exit code is red if ANY make failed. "Didn't resolve" is RED, not neutral.
// ---------------------------------------------------------------------------
import { appendFileSync } from "node:fs";
import { sweepMake, diffRecalls, recallKey, collapseRefusal, SWEEP_LIMIT } from "./lib/tc-recalls.mjs";

// The makes we cover, mirroring CANONICAL_MAKES in
// supabase/functions/_shared/makes.ts. Kept as a literal rather than imported
// because that file is TypeScript for the Deno edge runtime; test-recall-sweep
// asserts the two lists stay identical, so a make added there cannot silently
// go unswept here.
const MAKES = [
  "Toyota", "Honda", "Hyundai", "Kia", "Ford", "Chevrolet", "GMC", "Mazda", "Volkswagen",
  "Nissan", "Subaru", "Lexus", "Acura", "Infiniti", "Genesis", "Mitsubishi", "BMW",
  "Mercedes-Benz", "Audi", "Volvo", "MINI", "Porsche", "Jeep", "Ram", "Dodge", "Chrysler",
  "Fiat", "Alfa Romeo", "Cadillac", "Buick", "Lincoln", "Tesla", "Jaguar", "Land Rover", "Polestar",
];

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const ONE = (() => { const i = args.indexOf("--make"); return i >= 0 ? args[i + 1] : null; })();
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LIVE = Boolean(SUPABASE_URL && SERVICE_KEY) && !DRY;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = () => ({
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
});

async function rest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...H(), ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path} -> HTTP ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// Everything we already know for one make, as a Set of recall keys.
async function knownFor(make) {
  if (!LIVE) return new Set();
  const out = new Set();
  for (let from = 0; ; from += 1000) {
    const page = await rest(
      `vehicle_recall?select=recall_number,make,model,year&make=eq.${encodeURIComponent(make)}` +
      `&order=id.asc&offset=${from}&limit=1000`,
    );
    for (const r of page) out.add(recallKey(r));
    // Paginate to exhaustion rather than trusting one page — the bug that took
    // down the AMVIC candidate list (#240) was exactly a first-page read that
    // looked complete.
    if (page.length < 1000) break;
  }
  return out;
}

async function writeSweep(row) {
  if (!LIVE) return;
  await rest("recall_sweep", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([row]) });
}

// Upsert on the natural key. last_seen_at moves every sweep; first_seen_at is
// set by the column default on insert only, so it keeps meaning "when WE first
// saw this" and a re-sweep can never make an old recall look new.
async function upsertRecalls(rows) {
  if (!LIVE || !rows.length) return;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => ({ ...r, last_seen_at: new Date().toISOString() }));
    await rest("vehicle_recall?on_conflict=recall_number,make,model,year", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(chunk),
    });
  }
}

function summary(line) {
  console.log(line);
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) { try { appendFileSync(f, line + "\n"); } catch { /* summary is a nicety, never fatal */ } }
}

const makes = ONE ? [ONE] : MAKES;
console.log(`Transport Canada recall sweep — ${makes.length} make(s)${LIVE ? "" : DRY ? "  [dry run, no writes]" : "  [no Supabase credentials, no writes]"}`);
console.log(`  limit=${SWEEP_LIMIT} per make; a response that saturates it is treated as truncated, not complete.\n`);

const failures = [];
const allNew = [];
let totalRecalls = 0;
let seeded = 0;

for (const make of makes) {
  const known = await knownFor(make);
  const got = await sweepMake(make);

  if (!got.ok) {
    // The whole point of the tri-state: this make is UNKNOWN today. Its stored
    // rows stay exactly as they were and nothing is inferred from the silence.
    failures.push(`${make}: ${got.reason} — ${got.detail}`);
    console.error(`  ✗ ${make.padEnd(14)} ${got.reason}: ${got.detail}`);
    await writeSweep({ make, status: got.reason, detail: got.detail, wrote: false });
    continue;
  }

  const refusal = collapseRefusal(make, got.rows.length, known.size);
  if (refusal) {
    failures.push(refusal);
    console.error(`  ✗ ${make.padEnd(14)} refused: ${refusal}`);
    await writeSweep({ make, status: "refused", detail: refusal, rows_returned: got.raw_rows, recalls_total: got.rows.length, wrote: false });
    continue;
  }

  // SEEDING IS NOT DETECTING. On the first sweep of a make there is no prior
  // observation, so every recall in TC's history is "not on file" — 40,471 of
  // them across the 35 makes on the cold run. Staging those as new recalls
  // would be false on its face (they were issued over 57 years, not overnight)
  // and would teach the reader that this report is noise. A baseline is
  // recorded silently; only what appears AFTER a baseline exists is news.
  const seeding = known.size === 0;
  const added = seeding ? [] : diffRecalls(got.rows, known);
  totalRecalls += got.rows.length;
  try {
    await upsertRecalls(got.rows);
    await writeSweep({
      make, status: seeding ? "seeded" : "ok", rows_returned: got.raw_rows, recalls_total: got.rows.length,
      recalls_new: added.length, wrote: LIVE,
    });
  } catch (e) {
    failures.push(`${make}: write failed — ${e.message}`);
    console.error(`  ✗ ${make.padEnd(14)} write failed: ${e.message}`);
    await writeSweep({ make, status: "refused", detail: `write failed: ${e.message}`, wrote: false }).catch(() => {});
    continue;
  }

  if (seeding) {
    seeded += got.rows.length;
    console.log(`  ⋯ ${make.padEnd(14)} ${String(got.rows.length).padStart(5)} recorded as the baseline (first sweep — nothing reported as new)`);
  } else if (added.length) {
    allNew.push(...added.map((r) => ({ ...r, make })));
    console.log(`  ● ${make.padEnd(14)} ${String(got.rows.length).padStart(5)} on file, ${added.length} NEW`);
  } else {
    console.log(`  ✓ ${make.padEnd(14)} ${String(got.rows.length).padStart(5)} on file, no change`);
  }
  await sleep(400);   // courteous pacing against a public government endpoint
}

// ---- staged output. Reports ONLY on change, like the daily APR report. ------
console.log("");
if (allNew.length) {
  // Grouped by recall, not by row. One recall covers every affected model year —
  // Ford 2026339 alone spans EXPLORER 2020-2026 — so a row-per-year table turns
  // a handful of real events into a wall nobody reads.
  const byRecall = new Map();
  for (const r of allNew) {
    const g = byRecall.get(r.recall_number) || { number: r.recall_number, date: r.recall_date, make: r.make, models: new Map() };
    const years = g.models.get(r.model) || [];
    years.push(r.year);
    g.models.set(r.model, years);
    if (!g.date && r.recall_date) g.date = r.recall_date;
    byRecall.set(r.recall_number, g);
  }
  const groups = [...byRecall.values()]
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  const span = (years) => {
    const u = [...new Set(years)].sort((a, b) => a - b);
    return u.length > 1 ? `${u[0]}–${u[u.length - 1]}` : String(u[0]);
  };

  summary(`## ${groups.length} new recall${groups.length === 1 ? "" : "s"} — STAGED, not sent`);
  summary("");
  summary(`Covering ${allNew.length} model-year combination${allNew.length === 1 ? "" : "s"}.`);
  summary("");
  summary("| recall | date | make | affected |");
  summary("|---|---|---|---|");
  for (const g of groups.slice(0, 100)) {
    const affected = [...g.models.entries()].map(([m, ys]) => `${m} ${span(ys)}`).join(", ");
    summary(`| ${g.number} | ${g.date || "—"} | ${g.make} | ${affected.length > 300 ? affected.slice(0, 297) + "…" : affected} |`);
  }
  if (groups.length > 100) summary(`| …and ${groups.length - 100} more | | | |`);
  summary("");
  summary("_Staged only. Nothing has been sent to anyone — outbound notification is a separate, approved step._");
} else if (seeded && !failures.length) {
  summary(`Baseline recorded: ${seeded} recall records across ${makes.length} makes. ` +
          `Nothing is reported as new on a first sweep — from tomorrow, only what appears after this baseline counts.`);
} else if (!failures.length) {
  summary("No new recalls today.");
}

if (failures.length) {
  console.error(`\n❌ ${failures.length} make(s) could not be swept — their stored recalls are UNCHANGED, not cleared:`);
  for (const f of failures) console.error(`   - ${f}`);
  summary("");
  summary(`> **${failures.length} make(s) failed to sweep.** Their recall data is unchanged from the last good run, ` +
          `and is *not* being reported as clean. See the run log.`);
}

console.log(`\n${failures.length ? "❌" : "✅"} swept ${makes.length - failures.length}/${makes.length} makes, ` +
            `${totalRecalls} recall records on file, ` +
            (seeded ? `${seeded} recorded as baseline (first sweep).` : `${allNew.length} new.`));
// A partial sweep is a RED run. A make that "didn't resolve" is never neutral.
process.exit(failures.length ? 1 : 0);
