#!/usr/bin/env node
/* Build the reported-faults catalogue from NHTSA's complaint slices.
 *
 * WHAT THIS JOB DOES ON A NORMAL DAY: seven conditional requests, seven 304s,
 * and it exits having downloaded nothing. NHTSA rewrites a slice roughly once a
 * day around 09:2x GMT and not every slice every day -- one was 36 days stale
 * when this was written -- so asking "has it changed?" is almost always the
 * whole job. [[dealer-tos-daily-checks]]
 *
 * WHY NOT TWICE DAILY, like AMVIC and the warranty catalogue: upstream publishes
 * once a day. A midnight run would re-ask a question whose answer cannot have
 * changed, and would double our exposure to an undocumented rate control that
 * answers 403 with an HTML page and takes 600 seconds of silence to clear.
 * The freshness a report may claim comes from each slice's own Last-Modified,
 * never from this job's run time. [[live-data-green-dot]]
 *
 * Usage:
 *   node scripts/build-fault-catalog.mjs --dry-run --out faults.json
 *   node scripts/build-fault-catalog.mjs            (writes the catalogue)
 */
import { createInflateRaw } from "node:zlib";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  SLICES, fetchSlice, parseRow, assertSliceSane, BannedError,
} from "./lib/nhtsa-slices.mjs";
import {
  emptyTally, addTo, rankTally, normSystem,
  RECALL_TYPES, RECALL_WORDS, FAULTS_MIN_FILINGS,
} from "../supabase/functions/_shared/vehicle-faults.js";
import { cellKey } from "../supabase/functions/_shared/fault-model-match.js";

const ARGS = new Set(process.argv.slice(2));
const DRY = ARGS.has("--dry-run");
const OUT = (() => { const i = process.argv.indexOf("--out"); return i > 0 ? process.argv[i + 1] : null; })();
const STATE_FILE = "scripts/data/nhtsa-slice-state.json";

const CACHE = (() => { const i = process.argv.indexOf("--cache"); return i > 0 ? process.argv[i + 1] : null; })();
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};

/* THE CATALOGUE IS REBUILT WHOLE, EVERY RUN.
 *
 * An incremental catalogue drifts: a complaint NHTSA later reclassifies, or a
 * CMPLID they rewrite (their own layout warns the field "IS AN UPDATEABLE FIELD,
 * thus data for a given record potentially could change from one data output
 * file to the next"), would leave a stale count nobody can find. Rebuilding from
 * all seven slices costs 343 MB and about thirty seconds.
 *
 * The conditional request still earns its keep: with --cache, an unchanged slice
 * is read from disk instead of the wire, so the daily run usually moves no bytes
 * at all. Without a cache -- a fresh CI runner -- it downloads, which is the
 * honest cost of a whole rebuild and is still one pass at roughly 1 req/s.
 */
async function loadSlice(slice) {
  const prev = state[slice.name] || {};
  const cached = CACHE ? `${CACHE}/${slice.name}.zip` : null;
  const haveCache = cached && existsSync(cached);

  const probe = await fetchSlice(slice, haveCache ? prev.lastModified : null);
  if (!probe.changed && haveCache) {
    console.log(`  304  ${slice.name}  unchanged since ${prev.lastModified} — read from cache`);
    return { buf: readFileSync(cached), lastModified: prev.lastModified, changed: false };
  }
  console.log(`  200  ${slice.name}  ${(probe.bytes / 1e6).toFixed(1)} MB  upstream ${probe.lastModified}`);
  if (cached) { mkdirSync(CACHE, { recursive: true }); writeFileSync(cached, probe.buf); }
  return probe;
}

/* A single-entry zip, inflated as a stream so a 350 MB member never becomes a
 * 350 MB string. Reads the local file header, skips name+extra, inflates the
 * rest raw. No dependency: this runs in CI on a bare runner.
 */
function* zipLines(buf) {
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error("not a local file header");
  const nameLen = buf.readUInt16LE(26), extraLen = buf.readUInt16LE(28);
  const start = 30 + nameLen + extraLen;
  const method = buf.readUInt16LE(8);
  if (method !== 8) throw new Error(`unexpected compression method ${method}`);
  yield { start };
}

async function* linesOf(buf) {
  const { value: { start } } = zipLines(buf).next();
  const rl = createInterface({
    input: Readable.from([buf.subarray(start)]).pipe(createInflateRaw()),
    crlfDelay: Infinity,
  });
  for await (const line of rl) if (line) yield line;
}

// Keyed by cellKey(), the SAME function the report calls at lookup time.
// A catalogue keyed one way and queried another is two authors for one
// fact, and the failure mode is a silent miss that renders as "nothing
// reported". [[two-authors-per-fact]]
const cells = new Map();               // cellKey -> tally
const cellMeta = new Map();            // cellKey -> { sourceUpdatedAt, spellings:Set }
let nonVehicle = 0, unkeyed = 0;
let totalRows = 0, totalComplaints = 0, changedSlices = 0, skipped = 0;

for (const slice of SLICES) {
  let got;
  try {
    got = await loadSlice(slice);
  } catch (e) {
    if (e instanceof BannedError) {
      // ABORT. Do not try the next slice and do not write a partial catalogue:
      // a half-built catalogue renders as "fewer faults reported", which is our
      // outage printed as a fact about cars.
      console.error("\nFATAL: " + e.message);
      process.exit(2);
    }
    throw e;
  }
  if (got.changed) changedSlices++; else skipped++;

  let rows = 0;
  const perOdino = new Map();          // ODINO is unique to one slice
  for await (const line of linesOf(got.buf)) {
    const r = parseRow(line);
    if (!r || !r.year || !r.make || !r.model) continue;
    // Tyres, equipment and child seats share this file. They are not cars.
    if (r.prodType && r.prodType !== "V") { nonVehicle++; continue; }
    rows++;
    const key = cellKey(r.year, r.make, r.model);
    if (!key) { unkeyed++; continue; }
    let c = perOdino.get(r.odino);
    if (!c) perOdino.set(r.odino, (c = { key, systems: new Set(), spellings: new Set(), harm: false, recall: false }));
    c.spellings.add(`${r.make} ${r.model}`);
    const sys = normSystem(r.system);
    if (sys) c.systems.add(sys);
    if (r.crash || r.fire || r.injured > 0 || r.deaths > 0) c.harm = true;
    if (RECALL_TYPES.has(r.cmplType) || RECALL_WORDS.test(r.descr)) c.recall = true;
  }
  assertSliceSane(slice, rows);
  totalRows += rows;

  for (const c of perOdino.values()) {
    let t = cells.get(c.key);
    if (!t) cells.set(c.key, (t = emptyTally()));
    t.total++;
    totalComplaints++;
    if (!c.systems.size) { t.unknownOnly++; continue; }
    for (const s of c.systems) addTo(t, s, c.harm, c.recall);
  }
  for (const c of perOdino.values()) {
    let m = cellMeta.get(c.key);
    if (!m) cellMeta.set(c.key, (m = { sourceUpdatedAt: null, spellings: new Set() }));
    // Every NHTSA spelling folded into this key is recorded, so the card can
    // say WHICH variants it combined rather than implying an exact match.
    for (const sp of c.spellings) m.spellings.add(sp);
    if ((got.lastModified || "") > (m.sourceUpdatedAt || "")) m.sourceUpdatedAt = got.lastModified;
  }
  state[slice.name] = { lastModified: got.lastModified, rows, sha256: got.sha256 || state[slice.name]?.sha256 || null };
}

console.log(`  skipped ${nonVehicle.toLocaleString()} non-vehicle rows (tyres, equipment, child seats)` +
  `${unkeyed ? `, ${unkeyed.toLocaleString()} rows whose make/model could not be keyed` : ""}`);
console.log(`\nparsed ${totalRows.toLocaleString()} component rows -> ` +
  `${totalComplaints.toLocaleString()} distinct complaints across ${cells.size.toLocaleString()} year|make|model cells`);
console.log(`slices changed: ${changedSlices}, unchanged: ${skipped}`);

// Only cells that could ever be shown are stored. Below the floor the panel says
// so from the total alone and needs no ranking.
const out = [];
for (const [key, tally] of cells) {
  if (tally.total < FAULTS_MIN_FILINGS) continue;
  const [year, make, model] = key.split("|");
  const meta = cellMeta.get(key) || {};
  out.push({
    cell_key: key, year: Number(year), make, model,
    ranking: rankTally(tally),
    nhtsa_spellings: [...(meta.spellings || [])].sort(),
    source_updated_at: meta.sourceUpdatedAt || null,
  });
}
out.sort((a, b) => b.ranking.total - a.ranking.total);
console.log(`catalogue rows (>= ${FAULTS_MIN_FILINGS} filings): ${out.length.toLocaleString()}`);

if (OUT) { writeFileSync(OUT, JSON.stringify(out)); console.log(`wrote ${OUT}`); }
if (DRY) { console.log("dry run: nothing written to the database"); process.exit(0); }

/* REFUSE A COLLAPSE. A refresh that empties the catalogue must fail loudly
 * rather than succeed quietly: every cell it drops renders on a report as
 * "not checked", and a report that quietly stops answering looks identical to
 * a car with nothing reported. The ceiling is deliberately generous -- the
 * corpus grows -- and deliberately not infinite.
 * [[catalog-refresh-can-empty-catalog]]
 */
const { createClient } = await import("@supabase/supabase-js");
const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (or pass --dry-run)");
  process.exit(1);
}
const sb = createClient(SB_URL, SB_KEY);

const { count: before, error: cErr } = await sb
  .from("vehicle_fault_catalog").select("cell_key", { count: "exact", head: true });
if (cErr) throw new Error(`counting existing rows: ${cErr.message}`);

if (before && out.length < before * 0.5) {
  console.error(`REFUSING: the rebuild produced ${out.length.toLocaleString()} rows against ` +
    `${before.toLocaleString()} already stored — a collapse of more than half. ` +
    `Nothing written. Check the slices before re-running.`);
  process.exit(3);
}

const rows = out.map((r) => ({
  cell_key: r.cell_key,
  model_year: r.year,
  make: r.make,
  model: r.model,
  nhtsa_spellings: r.nhtsa_spellings,
  total_filings: r.ranking.total,
  unknown_only: r.ranking.unknownOnly,
  distinct_systems: r.ranking.distinctSystems,
  ranking: r.ranking,
  source_updated_at: r.source_updated_at ? new Date(r.source_updated_at).toISOString() : null,
  refreshed_at: new Date().toISOString(),
}));

for (let i = 0; i < rows.length; i += 500) {
  const chunk = rows.slice(i, i + 500);
  const { error } = await sb.from("vehicle_fault_catalog").upsert(chunk, { onConflict: "cell_key" });
  if (error) throw new Error(`upsert at ${i}: ${error.message}`);
  process.stdout.write(`\r  upserted ${Math.min(i + 500, rows.length).toLocaleString()} / ${rows.length.toLocaleString()}`);
}
console.log("");

// Cells that no longer qualify are removed, so the catalogue cannot accumulate
// rows whose filings NHTSA has since reclassified away.
const keep = new Set(rows.map((r) => r.cell_key));
const { data: existing, error: exErr } = await sb.from("vehicle_fault_catalog").select("cell_key");
if (exErr) throw new Error(`listing rows: ${exErr.message}`);
const stale = (existing || []).map((r) => r.cell_key).filter((k) => !keep.has(k));
if (stale.length) {
  for (let i = 0; i < stale.length; i += 500) {
    const { error } = await sb.from("vehicle_fault_catalog").delete().in("cell_key", stale.slice(i, i + 500));
    if (error) throw new Error(`removing stale rows: ${error.message}`);
  }
  console.log(`removed ${stale.length.toLocaleString()} cells that no longer qualify`);
}

console.log(`catalogue written: ${rows.length.toLocaleString()} rows`);

/* THE SLICE STATE IS A CACHE HINT, NOT A RESULT, AND IT GOES LAST.
 *
 * 2026-09-15: this line failed the run. Every slice had been fetched, 1,587,385
 * complaints parsed, all 6,584 catalogue rows upserted and the stale ones
 * removed -- and then `ENOENT: scripts/data/nhtsa-slice-state.json`, because
 * that directory exists on my machine and has never existed in the repo. The
 * job reported FAILURE over a bookkeeping file, on a run whose actual work had
 * completely succeeded. A red run that means "everything worked" is worse than
 * no signal: it is the one people learn to ignore.
 *
 * So: create the directory, and never let this take the run down. All it buys
 * is a conditional request on the next run, and a fresh CI runner has no cache
 * to conditionally skip anyway. [[no-single-point-of-failure]]
 */
try {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
} catch (e) {
  console.warn(`  (could not record slice state: ${e.message} — the catalogue is written and correct; ` +
    `the next run simply re-downloads instead of asking If-Modified-Since)`);
}
