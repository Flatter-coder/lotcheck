// A DURATION IS DAYS, NOT ROWS.
//
// listing_observation used to be keyed (listing_id, observed_on::date), so one
// row WAS one day and counting rows was counting days. The 20260911 migration
// re-keys it on `observed_at`, because two reads in one day have to be two
// observations or the second silently overwrites the first.
//
// That change sets a trap. Any query that still counts observation ROWS and
// calls the total "days" now DOUBLES at two reads a day — and the number it
// inflates is days-on-lot, the figure most likely to be argued with at a
// dealership. It fails silently and in our favour, which is the worst
// direction: nothing errors, the report just starts overclaiming.
//
// THE RULE. From the re-key migration onward, a count() over the observation
// trail whose own output label says "day" must count DISTINCT observed_on. A
// count of rows is fine — it just may not be labelled as days.
//
// Migrations BEFORE the re-key are exempt, and deliberately so: while the key
// was (listing_id, observed_on::date), one row genuinely was one day and
// count(*) was the correct expression. Those files are history, and their
// function definitions are superseded by the re-key migration's. Flagging them
// would be asking the past to have known about the future — and a gate that
// cries wolf on three files nobody can fix is a gate people learn to ignore.
//
// Run: node scripts/check-observation-math.mjs
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "supabase/migrations";
const strip = (s) => s.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");

// The label a count() result is about to be published under: the nearest
// preceding jsonb key ('observedDays',) or SQL alias (as observed_days).
function labelBefore(src, at) {
  const back = src.slice(Math.max(0, at - 240), at);
  let label = null;
  for (const m of back.matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'\s*,/g)) label = m[1];
  for (const m of back.matchAll(/\bas\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/gi)) label = m[1];
  return label;
}

let bad = 0, checked = 0;
// The migration that re-keyed listing_observation on observed_at. Before this,
// one row was one day by construction.
const REKEY = "20260911_listing_history_observations.sql";

for (const f of readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort()) {
  if (f < REKEY) continue;
  const src = strip(readFileSync(join(DIR, f), "utf8"));
  if (!/listing_observation/.test(src)) continue;
  for (const m of src.matchAll(/count\s*\(([^()]*(?:\([^()]*\))?[^()]*)\)/gi)) {
    const inner = m[1].trim();
    const ctx = src.slice(Math.max(0, m.index - 300), m.index + 200);
    // Only counts over the observation trail are in scope.
    if (!/listing_observation|\bfrom\s+obs\b|\bobs\b\./i.test(ctx)) continue;
    const label = labelBefore(src, m.index);
    if (!label || !/day/i.test(label)) continue;   // not published as days
    checked++;
    if (/\bdistinct\b/i.test(inner) && /observed_on/i.test(inner)) continue;
    bad++;
    console.error(`❌ ${f}: "${label}" is published as days but counts \`${inner}\`.`);
    console.error(`      Two reads in one day are two rows. Use count(distinct observed_on).`);
  }
}

if (bad) {
  console.error("");
  console.error("Fix: count(distinct observed_on) for a number of DAYS. Keep count(*) only for a");
  console.error("raw tally whose label does not say days.");
  process.exitCode = 1;
} else {
  console.log(`✅ observation math: ${checked} day-count(s) over listing_observation all count distinct days.`);
}
