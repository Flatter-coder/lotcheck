// Backfill msrp_catalog.drivetrain from NRCan's Fuel Consumption Ratings.
//
// WHY THIS SOURCE. Drivetrain has to come from somewhere that cannot be
// switched off for commercial reasons, and it must not be guessed: a wrong
// drivetrain re-creates the exact defect the trim-match fix just closed (a
// Mach-E Premium AWD matched to the base Premium row and reported as $13,018
// of dealer sticker padding). NRCan's ratings are a Government of Canada open
// dataset covering every vehicle sold here, and its Model field carries the
// drivetrain the manufacturer certified — "MDX SH-AWD", "Forester AWD".
//
// WHY NOT THE TRIM STRING. Parsing "XLE AWD" out of msrp_catalog.trim looks
// like a backfill and is a no-op: _shared/trim-match.js rowDrive() already
// reads drivetrain out of the trim name. Only 75 of 881 rows encode it there
// anyway. Real coverage has to add information the trim string does not have.
//
// THE RULE. For each (make, model) we collect every NRCan entry and read the
// drivetrain tokens off it. We pin a drivetrain ONLY when every entry for that
// model agrees — that means the manufacturer sells the model with exactly one
// driveline, so it is true of every trim. When entries disagree the model is
// sold both ways, the trim genuinely does not pin a configuration, and NULL is
// the honest answer: trim-match will return "starting_at" rather than call a
// figure exact. Silence beats a plausible wrong value.
//
// A model whose NRCan entries carry NO token is also left NULL. NRCan omits
// the token on front-drive cars rather than writing "FWD", so absence is not
// evidence — treating it as FWD would be an assumption, not a reading.
//
// Run: node scripts/backfill-drivetrain.mjs            (dry run, writes nothing)
//      node scripts/backfill-drivetrain.mjs --write    (needs service role key)

const OPEN_CANADA = "https://open.canada.ca/data/dataset/98f1a129-f628-4ce4-b24d-6f16bf24dd64/resource";
const SOURCES = [
  `${OPEN_CANADA}/9df1b18d-d036-4783-a61c-99f1f75b3ac5/download/my2026-fuel-consumption-ratings.csv`,
  `${OPEN_CANADA}/d589f2bc-9a85-4f65-be2f-20f17debfcb1/download/my2025-fuel-consumption-ratings.csv`,
  `${OPEN_CANADA}/026e45b4-eb63-451f-b34f-d9308ea3a3d9/download/my2012-2026-battery-electric-vehicles.csv`,
  `${OPEN_CANADA}/8812228b-a6aa-4303-b3d0-66489225120d/download/my2012-2026-plug-in-hybrid-electric-vehicles.csv`,
];
const SOURCE_NOTE = "NRCan Fuel Consumption Ratings (open.canada.ca)";

const WRITE = process.argv.includes("--write");
const SUPA = process.env.SUPABASE_URL || "https://debigtyjhjamipooajhk.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
if (!KEY) { console.error("Need SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY to dry-run)."); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

// --- CSV (quoted fields appear in some model names) --------------------------
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// --- drivetrain tokens -------------------------------------------------------
// SH-AWD (Acura), 4MATIC (Mercedes), xDrive (BMW), quattro (Audi), 4Motion (VW)
// are manufacturer names for all-wheel drive.
function driveOf(s) {
  const t = ` ${String(s || "").toLowerCase()} `;
  if (/\b(awd|4wd|4x4|sh-awd|4matic|4motion|xdrive|quattro|all.?wheel)\b/.test(t)) return "AWD";
  if (/\b(fwd|front.?wheel)\b/.test(t)) return "FWD";
  if (/\b(rwd|rear.?wheel)\b/.test(t)) return "RWD";
  return null;
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const normMake = (s) => norm(s).replace(/^mercedes benz$/, "mercedes").replace(/^alfa romeo$/, "alfa");

async function main() {
  // 1) NRCan -> per (make, model-base) the set of drivetrains certified.
  const seen = new Map();   // "make|modelbase" -> Set(drivetrain|"none")
  for (const url of SOURCES) {
    // Identify ourselves to open.canada.ca. Not a live break today, but the
    // Alberta dealer map assumed the same of Overpass and drew HTTP 406 from
    // every mirror for four weeks running. See check:jobs.
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "LotCheck/1.0 (NRCan drivetrain backfill; +https://lotcheck.ca)" },
    });
    if (!res.ok) { console.warn(`  skip ${url.split("/").pop()} (HTTP ${res.status})`); continue; }
    const rows = parseCsv(await res.text());
    const head = rows[0].map((h) => h.trim().toLowerCase());
    const iMake = head.findIndex((h) => h === "make");
    const iModel = head.findIndex((h) => h === "model");
    if (iMake < 0 || iModel < 0) { console.warn(`  skip ${url.split("/").pop()} (no make/model column)`); continue; }
    let n = 0;
    for (const r of rows.slice(1)) {
      const make = r[iMake], model = r[iModel];
      if (!make || !model) continue;
      seen.set(`${normMake(make)}|${norm(model)}`, null);   // full string, for base matching
      n++;
    }
    console.log(`  ${url.split("/").pop()}: ${n} entries`);
  }
  // Re-key by make so base matching is cheap.
  const byMake = new Map();
  for (const k of seen.keys()) {
    const [mk, md] = k.split("|");
    if (!byMake.has(mk)) byMake.set(mk, []);
    byMake.get(mk).push(md);
  }

  // 2) The catalog.
  const cat = await (await fetch(
    `${SUPA}/rest/v1/msrp_catalog?select=id,year,make,model,trim,drivetrain&limit=5000`, { headers: H })).json();
  console.log(`\ncatalog rows: ${cat.length}`);

  // 3) Decide per (make, model).
  const decision = new Map();   // "make|model" -> {drive, entries, tokens}
  for (const r of cat) {
    const key = `${normMake(r.make)}|${norm(r.model)}`;
    if (decision.has(key)) continue;
    const base = norm(r.model);
    const pool = (byMake.get(normMake(r.make)) || []).filter(
      (m) => m === base || m.startsWith(base + " "));
    if (!pool.length) { decision.set(key, { drive: null, why: "no NRCan entry", entries: 0 }); continue; }
    const tokens = new Set(pool.map((m) => driveOf(m.slice(base.length))));
    if (tokens.size === 1 && !tokens.has(null)) {
      decision.set(key, { drive: [...tokens][0], why: "every entry agrees", entries: pool.length });
    } else if (tokens.size === 1) {
      decision.set(key, { drive: null, why: "no token on any entry", entries: pool.length });
    } else {
      decision.set(key, { drive: null, why: "model sold both ways", entries: pool.length });
    }
  }

  // 4) Rows we can pin.
  // A model-level fact must never overwrite a trim that names its own
  // driveline. If the catalog says "XLE FWD" and the model-level read says
  // AWD, one of the two is wrong and writing either would be guessing — skip
  // the row and print it, because a conflict is a data-quality signal worth
  // seeing rather than silently resolving.
  const updates = [], conflicts = [];
  for (const r of cat) {
    if (r.drivetrain) continue;
    const d = decision.get(`${normMake(r.make)}|${norm(r.model)}`);
    if (!d || !d.drive) continue;
    const fromTrim = driveOf(r.trim);
    if (fromTrim && fromTrim !== d.drive) {
      conflicts.push(`${r.make} ${r.model} "${r.trim}" trim says ${fromTrim}, NRCan says ${d.drive}`);
      continue;
    }
    updates.push({ id: r.id, drivetrain: d.drive });
  }

  const why = {};
  for (const [k, v] of decision) (why[v.why] = why[v.why] || []).push(k);
  console.log("\nmodel-level decisions:");
  for (const k of Object.keys(why).sort()) console.log(`  ${String(why[k].length).padStart(4)} models  ${k}`);
  console.log(`\nrows that can be pinned: ${updates.length} / ${cat.length} (${(100 * updates.length / cat.length).toFixed(1)}%)`);
  const byDrive = {};
  updates.forEach((u) => byDrive[u.drivetrain] = (byDrive[u.drivetrain] || 0) + 1);
  console.log("  by drivetrain:", JSON.stringify(byDrive));

  if (conflicts.length) {
    console.log(`\n${conflicts.length} row(s) SKIPPED — trim string disagrees with the model-level read:`);
    conflicts.slice(0, 12).forEach((c) => console.log(`  ${c}`));
  } else {
    console.log("\nno trim/model drivetrain conflicts.");
  }

  const pinned = [...decision].filter(([, v]) => v.drive);
  console.log(`\nall ${pinned.length} pinned models:`);
  pinned.forEach(([k, v]) => console.log(`  ${k.padEnd(30)} -> ${v.drive}  (${v.entries} NRCan entries)`));
  const mixed = [...decision].filter(([, v]) => v.why === "model sold both ways").slice(0, 8);
  console.log("\nsample left NULL because the model is sold both ways (correct — trim does not pin it):");
  mixed.forEach(([k, v]) => console.log(`  ${k}  (${v.entries} entries)`));

  if (!WRITE) { console.log(`\nDRY RUN — nothing written. Re-run with --write.`); return; }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) { console.error("\n--write needs SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }

  let done = 0;
  for (const u of updates) {
    const res = await fetch(`${SUPA}/rest/v1/msrp_catalog?id=eq.${u.id}`, {
      method: "PATCH", headers: { ...H, Prefer: "return=minimal" },
      body: JSON.stringify({ drivetrain: u.drivetrain }),
    });
    if (!res.ok) { console.error(`  PATCH ${u.id} -> HTTP ${res.status}: ${await res.text()}`); continue; }
    if (++done % 50 === 0) console.log(`  ${done}/${updates.length}`);
  }
  console.log(`\nwrote drivetrain on ${done} rows. Source: ${SOURCE_NOTE}`);
}

main().catch((e) => { console.error("backfill-drivetrain failed:", e.message); process.exit(1); });
