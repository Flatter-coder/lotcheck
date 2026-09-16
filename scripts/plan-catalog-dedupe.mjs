// DRY RUN for 20260916a + 20260916b. Reads the live catalogue, replays what the
// two migrations would do, and prints the before/after WITHOUT writing anything.
//
// It does not parse the SQL loosely -- it pulls the ids out of the files and
// checks each one against the row that is actually there, so a migration that
// has drifted from the table fails here instead of at apply time.
//
// Run:  node scripts/plan-catalog-dedupe.mjs <SUPABASE_ANON_KEY>
import { readFileSync } from "node:fs";

const KEY = process.argv[2];
if (!KEY) { console.error("usage: node scripts/plan-catalog-dedupe.mjs <anon-key>"); process.exit(2); }
const U = "https://debigtyjhjamipooajhk.supabase.co/rest/v1";
const h = { apikey: KEY, Authorization: "Bearer " + KEY };
const N = (s) => String(s ?? "").trim();

const A = readFileSync("supabase/migrations/20260916a_catalog_backfill_and_rename.sql", "utf8");
const B = readFileSync("supabase/migrations/20260916b_catalog_delete_duplicates.sql", "utf8");

const updates = [...A.matchAll(/update public\.msrp_catalog set ([\s\S]*?)\s+where id = (\d+)/g)]
  .map((m) => ({ id: Number(m[2]), set: m[1].replace(/\s+/g, " ").trim() }));
const deletes = [...B.matchAll(/delete from public\.msrp_catalog where id = (\d+);\s*--([^\n]*)/g)]
  .map((m) => ({ id: Number(m[1]), why: m[2].trim() }));

let rows = [], off = 0;
while (true) {
  const r = await fetch(`${U}/msrp_catalog?select=id,year,make,model,trim,fuel_type,msrp,all_in_price&order=id.asc&limit=1000&offset=${off}`, { headers: h });
  const b = await r.json(); if (!Array.isArray(b) || !b.length) break;
  rows = rows.concat(b); off += 1000; if (b.length < 1000) break;
}
const byId = new Map(rows.map((r) => [r.id, r]));
const show = (r) => r ? `${r.year} ${N(r.make)} ${N(r.model)} / ${N(r.trim) || "(blank)"}  $${r.msrp}  all_in=${r.all_in_price ?? "NULL"}  fuel=${N(r.fuel_type) || "-"}` : "(row not found)";

let missing = 0;
console.log(`live rows: ${rows.length}\n`);
console.log(`=== A: ${updates.length} updates, 0 deletes ===`);
for (const u of updates) {
  const r = byId.get(u.id);
  if (!r) { missing++; console.log(`  id ${u.id}  MISSING FROM THE TABLE`); continue; }
  console.log(`  id ${String(u.id).padStart(5)}  ${show(r)}`);
  console.log(`            -> ${u.set}`);
}
console.log(`\n=== B: ${deletes.length} deletes ===`);
for (const d of deletes) {
  const r = byId.get(d.id);
  if (!r) { missing++; console.log(`  id ${d.id}  MISSING FROM THE TABLE`); continue; }
  console.log(`  id ${String(d.id).padStart(5)}  ${show(r)}`);
  console.log(`            ${d.why}`);
}

// Nothing may be deleted unless the car survives under another row.
console.log(`\n=== survivor check: every deleted car must remain in the table ===`);
let orphan = 0;
for (const d of deletes) {
  const r = byId.get(d.id); if (!r) continue;
  const survivors = rows.filter((x) => x.id !== d.id && x.year === r.year && N(x.make) === N(r.make) &&
    N(x.model) === N(r.model) && Number(x.msrp) === Number(r.msrp));
  if (!survivors.length) { orphan++; console.log(`  id ${d.id}  NO SURVIVOR -- this delete would lose the car entirely`); }
  else console.log(`  id ${String(d.id).padStart(5)} -> survives as ${survivors.map((s) => `id ${s.id} "${N(s.trim) || "(blank)"}"`).join(", ")}`);
}

console.log(`\n=== net ===`);
console.log(`  rows before        ${rows.length}`);
console.log(`  rows after A+B     ${rows.length - deletes.length}`);
const nullsBefore = rows.filter((r) => r.all_in_price == null).length;
const fixed = updates.filter((u) => /all_in_price/.test(u.set) && byId.get(u.id)?.all_in_price == null).length;
console.log(`  rows with NULL all_in_price  ${nullsBefore} -> ${nullsBefore - fixed - deletes.filter((d) => byId.get(d.id)?.all_in_price == null).length}`);
if (missing || orphan) { console.error(`\nREFUSING: ${missing} id(s) not in the table, ${orphan} delete(s) with no survivor.`); process.exit(1); }
console.log(`\nplan is consistent with the live table.`);
