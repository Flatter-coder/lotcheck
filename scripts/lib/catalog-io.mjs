// Shared catalog output for single-make scrapers: dry-run to scripts/out when
// there's no service key, else delete-then-insert this make's rows in Supabase.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function getJson(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...extraHeaders } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// Powertrain from an explicit name, conservative: assert only what the name says.
export function inferFuelFromName(name) {
  const n = (name || "").toLowerCase();
  if (/plug-?in|4xe|phev|prime/.test(n)) return "PHEV";
  if (/electrified|\bev\b|\bbev\b|ioniq|electric|\be-?tron\b|\bev6\b|recharge|\bgv60\b/.test(n)) return "BEV";
  if (/hybrid/.test(n)) return "Hybrid";
  return null;
}

// Quality gate shared by EVERY make (the Toyota/Lexus stack learned this the
// hard way on 2026-08-11: it stored `vehicleStartPrice`, a calculated
// fee-inclusive figure, as if it were the published MSRP -- every value ended
// in .92 -- and ~17% of the catalog became fiction). A published Canadian MSRP
// is a whole-dollar figure, so a fractional value proves the source handed us a
// computed price. Reject rather than store; a missing row is recoverable, a
// wrong MSRP is a wrong claim in a buyer's report.
export function gateMsrpRows(rows, make) {
  const kept = [], rejected = [];
  for (const r of rows) {
    const v = Number(r?.msrp);
    if (!Number.isFinite(v) || v <= 0 || !Number.isInteger(v)) rejected.push(r);
    else kept.push(r);
  }
  if (rejected.length) {
    console.warn(`  quality gate: dropped ${rejected.length}/${rows.length} ${make} MSRP rows with non-integer prices (calculated, not published) -- e.g. ${rejected.slice(0, 3).map(r => `${r.model} ${r.trim ?? ""} ${r.msrp}`).join("; ")}`);
  }
  return kept;
}

// Columns a SCRAPER does not produce but that are true about the vehicle and
// expensive to re-establish: drivetrain is verified per trim against the
// manufacturer, attrs records distinctive equipment, price_basis records the
// freight/PDI convention.
//
// They have to be carried across a refresh explicitly. replaceRows deletes
// every row for a make and re-inserts what the scraper produced, so any column
// the scraper is silent about comes back NULL. That is not hypothetical: the
// drivetrain values seeded by hand from official sources (Toyota bZ, Camry,
// Nissan Rogue) were wiped this way, and msrp_catalog.drivetrain was 0/881
// populated by the time anyone looked. Backfilling without this fix just
// queues the same loss for the next refresh.
// fuel_type joined this list on 2026-08-19. It is not something most scrapers
// can state: inferFuelFromName() reads the trim string, which only ever says
// "hybrid"/"plug-in"/"EV", so a plain gas or hybrid nameplate returns null and
// 613 of 1,000 rows carried no powertrain at all. Anything backfilled from an
// authoritative source (NRCan) would then be deleted by the very next refresh,
// exactly as the hand-seeded drivetrain values were before this list existed.
export const CARRY_FORWARD = ["drivetrain", "attrs", "price_basis", "source_url", "fuel_type"];

// Case and spacing are not identity: the feed writes "LIMITED" where our
// capture wrote "Limited", and a case-sensitive key kept both -- the captured
// 2026 RAV4 Limited at $52,350 (it carried $350 of paint) beside the feed's
// $52,000, never superseded (2026-09-26).
const keyPart = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
export const catKey = (r) => `${r.year}|${keyPart(r.model)}|${keyPart(r.trim)}`;

// Pure half, exported so it can be tested without a database.
//
// Every row leaves here with EVERY carry column present, explicitly null when
// there is nothing to carry. PostgREST bulk INSERT requires all objects in a
// batch to share one key set (PGRST102 "All object keys must match");
// enriching only the rows that had a predecessor made the batch heterogeneous,
// the INSERT 400'd after the DELETE had already run, and eleven makes left
// msrp_catalog on 2026-08-13. A carried key must never decide whether its
// neighbours insert.
// `attrs` is a BAG OF KEYS, not a single value, so "a fresh scrape always wins"
// is the wrong rule for it. 38 rows carry hand-verified attrs captured from
// Build & Price summaries by a person -- seats, package_line, base_msrp,
// block_heater_included -- and once the scraper began supplying its own attrs
// (the published fee stack), whole-column replacement would have silently
// deleted every one of those keys on the next refresh. Both sets are true; a
// fresh key wins over a stale one of the SAME name, and everything else is
// kept. This is the same "carry what the scrape does not know" intent the
// column-level rule expresses, applied at the right granularity.
const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

export function mergeCarryForward(rows, prevRows, cols = CARRY_FORWARD) {
  const prev = new Map();
  for (const r of prevRows || []) prev.set(catKey(r), r);
  let carried = 0;
  const out = (rows || []).map((r) => {
    const old = prev.get(catKey(r));
    const merged = { ...r };
    for (const c of cols) {
      if (merged[c] == null) {
        // Only fill what the scraper left empty — a fresh scrape always wins.
        const v = old && old[c] != null ? old[c] : null;
        if (v != null) carried++;
        merged[c] = v;
      } else if (isPlainObject(merged[c]) && old && isPlainObject(old[c])) {
        // Both sides have keys: union them, fresh wins per key.
        const before = Object.keys(merged[c]).length;
        const union = { ...old[c], ...merged[c] };
        if (Object.keys(union).length > before) carried++;
        merged[c] = union;
      }
    }
    // A CLAIM ABOUT AN ALL-IN PRICE DOES NOT OUTLIVE THE PRICE.
    //
    // attrs is carried forward, and `all_in_basis` states what the row's all-in
    // figure IS ("the manufacturer's published all-in price for THIS
    // configuration"). When tci-stack stopped writing a synthesised
    // all_in_price for sibling trims, those rows arrived without it — and
    // carry-forward would have restored the previous run's basis string,
    // leaving a row that describes a number it no longer has. The union branch
    // above makes that worse, not better: "fresh wins per key" cannot remove a
    // key the fresh row omits.
    //
    // ONLY THE CLAIM IS STRIPPED, NEVER THE EVIDENCE. `all_in_breakdown` is the
    // captured fee itemisation — nothing buyer-facing reads it, 38 rows carry a
    // HAND-SEEDED one (tci-fees.mjs), and deleting captured provenance because
    // a derived figure went away would cost real data to fix a wording problem.
    // The first version of this stripped both and was caught by test:fee-stack,
    // whose fixture is one of those hand-seeded rows.
    if (merged.all_in_price == null && isPlainObject(merged.attrs)
        && merged.attrs.all_in_basis !== undefined) {
      const { all_in_basis, ...rest } = merged.attrs;
      merged.attrs = Object.keys(rest).length ? rest : null;
    }
    return merged;
  });
  return { rows: out, carried };
}

// PostgREST bulk INSERT requires EVERY object in the array to carry an
// identical key set; a batch whose objects disagree is rejected whole with
// HTTP 400 PGRST102 "All object keys must match". mergeCarryForward produces
// exactly that shape -- rows that matched a previous row gain `drivetrain` etc,
// rows that matched nothing do not -- so the moment any enrichment carried
// forward, that make's entire INSERT failed. Because the DELETE had already
// committed, the make was left EMPTY. That is what destroyed 471 rows across
// 12 makes on 2026-08-14 (Kia, Honda, Ford, Mazda, Nissan, Subaru, VW ... all
// went to zero), and the daily/weekly refresh would have done it again.
//
// Normalising to the union of keys is the class fix: it holds for any future
// column any code path adds conditionally, not just the four carried today.
// `id` is never sent -- the database owns it.
const NEVER_SEND = new Set(["id"]);
export function uniformKeys(rows) {
  const all = new Set();
  for (const r of rows || []) for (const k of Object.keys(r)) if (!NEVER_SEND.has(k)) all.add(k);
  const cols = [...all];
  return (rows || []).map((r) => {
    const out = {};
    for (const c of cols) out[c] = r[c] === undefined ? null : r[c];
    return out;
  });
}

// A scrape that returns SOME rows is not proof the source is healthy. Toyota's
// lineup came back as 7 rows on 2026-08-14 (bZ, bZ Woodland, C-HR -- no RAV4,
// Corolla, Camry, Highlander, Tacoma, Tundra, Sienna, Prius), the delete ran on
// the strength of it, and the run reported "replaced with 7 rows" as success.
// The pre-existing guard only fires at EXACTLY zero, so one row armed it.
//
// Refuse instead: a stale catalog is recoverable, a deleted one is not. A
// genuine lineup cut (a make discontinuing half its models) is rare enough to
// be worth a human confirming via CATALOG_ALLOW_COLLAPSE=1.
export const COLLAPSE_FLOOR = 10;   // below this a make is too small to judge
export const COLLAPSE_DROP  = 0.5;  // losing >50% of a make needs a human
export function assessCollapse(prevCount, nextCount, { floor = COLLAPSE_FLOOR, drop = COLLAPSE_DROP } = {}) {
  if (!(prevCount >= floor)) return { collapse: false };
  if (nextCount >= prevCount * (1 - drop)) return { collapse: false };
  return {
    collapse: true,
    reason: `would drop ${prevCount} -> ${nextCount} rows (${Math.round((1 - nextCount / prevCount) * 100)}% loss)`,
  };
}

// Read the make's full current rows ONCE: they feed carry-forward, the collapse
// check, and -- if the insert fails -- the restore.
// READ EVERY ROW, INCLUDING THE HAND-VERIFIED ONES. This used to carry
// "&source_url=is.null", which was safe only while nothing ever deleted a
// hand-verified row: the DELETE spared them, so not reading them cost nothing.
// The supersede step below DOES delete them, and a filtered read means their
// drivetrain / attrs / price_basis / source_url are never carried onto the
// replacement — so superseding a row silently blanked exactly the columns
// carry-forward exists to protect (drivetrain was 0/881 populated the last time
// this went unnoticed). It also left them outside the restore set, so a failed
// insert reported "restored all N previous rows" while they were gone for good.
//
// The source_url protection belongs on the DELETE, which still has it. A read
// is not destructive and must see everything.
export async function readExisting(table, make, headers, url) {
  const q = `${url}/rest/v1/${table}?make=ilike.${encodeURIComponent(make)}&select=*&limit=5000`;
  const res = await fetch(q, { headers });
  if (!res.ok) return { ok: false, rows: [] };
  return { ok: true, rows: await res.json() };
}

// Exported so the Toyota/Lexus (tci-stack) and FCA (fca-stack) scrapers use
// THIS implementation instead of their own copies. Those copies had neither the
// empty-scrape guard nor carry-forward, which is why Toyota was cut from a full
// lineup to 7 rows on 2026-08-14 with the run still reporting success.
export async function replaceRows(table, rows, make, { fatal = true, upsert = false } = {}) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  // An empty scrape must NEVER wipe good data. Delete-then-insert with zero
  // rows silently emptied a table whenever a source went down or a caller
  // passed only one of the three row sets.
  if (!rows.length) { console.log(`  ${table} (${make}): nothing scraped — existing rows left untouched.`); return; }
  try {
    // Upsert mode: published-price rows are keyed and re-captured weekly, so
    // they merge in place rather than delete-then-insert.
    if (upsert) {
      for (let i = 0; i < rows.length; i += 500) {
        const ins = await fetch(`${url}/rest/v1/${table}?on_conflict=year,make,model,trim`, {
          method: "POST",
          headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(rows.slice(i, i + 500)),
        });
        if (!ins.ok) throw new Error(`UPSERT ${table} -> HTTP ${ins.status}: ${await ins.text()}`);
      }
      console.log(`  ${table} (${make}): upserted ${rows.length} published rows.`);
      return;
    }
    // Match the make case-INSENSITIVELY: a scraper that changes its MAKE
    // constant casing (Mini -> MINI) otherwise orphans the entire old lineup,
    // which then lives forever as duplicate rows (observed 2026-08-11).
    // Provenance wins: rows carrying a source_url were verified by hand against
    // the manufacturer's own published page (Land Cruiser, Mach-E). A scraper
    // refresh must never wipe them -- exactly what happened on 2026-08-11.
    // Read the enrichment BEFORE the delete, or there is nothing left to read.
    // Read the current rows BEFORE anything destructive: they are the
    // enrichment source, the collapse baseline, and the restore copy.
    const prev = await readExisting(table, make, headers, url);
    if (!prev.ok) console.warn(`  ⚠️ could not read existing ${make} rows; enrichment may be lost and no restore is possible.`);
    if (table === "msrp_catalog" && prev.rows.length) {
      const { rows: merged, carried } = mergeCarryForward(rows, prev.rows);
      if (carried) console.log(`  carried forward ${carried} enrichment value(s) for ${make}.`);
      rows = merged;
    }
    // Must run AFTER the merge -- the merge is what makes the keys disagree.
    rows = uniformKeys(rows);

    // Two configurations can resolve to one grade name. Deduplicate BEFORE the
    // collapse check so the guard measures what will actually be inserted, and
    // before the DELETE so a colliding batch never destroys the lineup: on
    // 2026-08-12 a Ford refresh deleted 78 rows, hit a duplicate "2026 Bronco
    // Sport Heritage" against a preserved row, and left 7 Ford rows in prod.
    if (table === "msrp_catalog") {
      const seen = new Set();
      const beforeBatch = rows.length;
      rows = rows.filter((r) => (seen.has(catKey(r)) ? false : (seen.add(catKey(r)), true)));
      if (beforeBatch !== rows.length) {
        console.log(`  ${table} (${make}): collapsed ${beforeBatch - rows.length} duplicate key(s) within the batch.`);
      }
    }

    const verdict = assessCollapse(prev.rows.length, rows.length);
    if (verdict.collapse && process.env.CATALOG_ALLOW_COLLAPSE !== "1") {
      throw new Error(
        `REFUSED: ${table} (${make}) ${verdict.reason}. Existing rows kept untouched. ` +
        `If the lineup really shrank, re-run with CATALOG_ALLOW_COLLAPSE=1.`);
    }

    const guard = table === "msrp_catalog" ? "&source_url=is.null" : "";
    const del = await fetch(`${url}/rest/v1/${table}?make=ilike.${encodeURIComponent(make)}${guard}`, { method: "DELETE", headers });
    if (!del.ok && del.status !== 404) throw new Error(`DELETE ${table} -> HTTP ${del.status}: ${await del.text()}`);

    // The DELETE above deliberately SPARES hand-verified rows (source_url set).
    // That protection is for keys the scraper CANNOT produce — it was never
    // meant to freeze a price the manufacturer has since changed. A 2026
    // Mustang Mach-E Premium sat at a hand-entered $47,638 while ford.ca
    // published $49,990, and because the verified row survived every refresh it
    // kept winning the lookup and was reported as an EXACT trim MSRP: a stale
    // figure wearing the badge of the most authoritative one we have.
    //
    // So where this run carries a manufacturer figure for the same key, the
    // live number supersedes and the stale row goes. Where it does not, the
    // verified row stays exactly as protected as before.
    const supersededKeys = new Set();
    if (table === "msrp_catalog") {
      try {
        const res = await fetch(`${url}/rest/v1/${table}?select=id,year,model,trim,msrp&make=ilike.${encodeURIComponent(make)}`, { headers });
        if (res.ok) {
          const wanted = new Set(rows.map(catKey));
          // A trim-less row is a "starting at" summary for the model-year. Once
          // this run republishes that model-year's real trim ladder the summary
          // is stale by construction — Ford's own base moved $45,778 -> $47,990
          // while the old floor sat underneath it — so it goes too.
          const republished = new Set(rows.map((r) => `${r.year}|${String(r.model ?? "")}`));
          const stale = (await res.json()).filter((r) =>
            wanted.has(catKey(r)) ||
            (r.trim == null && republished.has(`${r.year}|${String(r.model ?? "")}`)));
          for (const r of stale) {
            const d = await fetch(`${url}/rest/v1/${table}?id=eq.${r.id}`, { method: "DELETE", headers });
            if (!d.ok && d.status !== 404) console.warn(`  ⚠️ could not supersede ${catKey(r)} (HTTP ${d.status}).`);
            // Remember what we destroyed, so the restore below can put it back.
            else supersededKeys.add(catKey(r));
          }
          if (stale.length) {
            console.log(`  ${table} (${make}): superseded ${stale.length} preserved row(s) with this run's manufacturer figures — e.g. ${stale.slice(0, 3).map((r) => `${r.model} ${r.trim ?? ""} was $${r.msrp}`).join("; ")}.`);
          }
        }
      } catch { /* best-effort: a failed probe must not block the refresh */ }
    }
    try {
      for (let i = 0; i < rows.length; i += 500) {
        const ins = await fetch(`${url}/rest/v1/${table}`, { method: "POST", headers: { ...headers, Prefer: "return=minimal" }, body: JSON.stringify(rows.slice(i, i + 500)) });
        if (!ins.ok) throw new Error(`INSERT ${table} -> HTTP ${ins.status}: ${await ins.text()}`);
      }
    } catch (insErr) {
      // DELETE and INSERT are two PostgREST calls with no transaction around
      // them, so a failed insert has already destroyed the make. Put it back.
      // This is a compensating restore, not atomicity -- but it turns silent
      // permanent loss into a loud, recovered failure.
      // Restore exactly what was destroyed, and nothing else. Two things were:
      // the rows the DELETE took (source_url null) and the rows supersede took.
      // A hand-verified row that was neither is STILL IN THE TABLE — re-posting
      // it would collide on UNIQUE(year,make,model,trim) and fail the batch,
      // under-restoring the rows that actually needed recovery.
      const destroyed = table === "msrp_catalog"
        ? prev.rows.filter((r) => r.source_url == null || supersededKeys.has(catKey(r)))
        : prev.rows;
      const back = uniformKeys(destroyed);
      let restored = 0;
      for (let i = 0; i < back.length; i += 500) {
        const res = await fetch(`${url}/rest/v1/${table}`, { method: "POST", headers: { ...headers, Prefer: "return=minimal" }, body: JSON.stringify(back.slice(i, i + 500)) });
        if (res.ok) restored += back.slice(i, i + 500).length;
      }
      const note = back.length === 0 ? "nothing to restore"
        : restored === back.length ? `restored all ${restored} previous rows`
        : `RESTORE INCOMPLETE — ${restored}/${back.length} rows recovered`;
      throw new Error(`${insErr.message}\n  ↩ ${table} (${make}): ${note}.`);
    }
    console.log(`  ${table} (${make}): ${rows.length} rows.`);
  } catch (e) {
    if (fatal) throw e;
    console.warn(`  ⚠️ ${table} skipped (${e.message.split("\n")[0]}).`);
  }
}

// Collapse rows that would collide on a table's unique key before inserting.
// The pre-existing msrp_catalog has UNIQUE(year,make,model,trim), and some
// source catalogs list a trim twice (two configs resolve to the same grade
// name); keep the lowest price/apr = the advertised "starting" figure, matching
// how the dealer-feed scrapers already dedupe per trim.
export function dedupeBy(rows, keyFn, lowerField) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const prev = m.get(k);
    if (!prev || (Number(r[lowerField]) || Infinity) < (Number(prev[lowerField]) || Infinity)) m.set(k, r);
  }
  return [...m.values()];
}

export async function writeCatalogs(make, { msrpRows = [], financeRows = [], leaseRows = [] }, opts = {}) {
  msrpRows = gateMsrpRows(msrpRows, make);
  // THE BASIS IS NOT OPTIONAL ANY MORE. It is a required DECISION.
  //
  // This used to read: stamp price_basis when the scraper passes one, and the
  // comment below it said silence was honest because an unstamped row makes
  // the report show a freight caveat instead. Two things were wrong with that.
  //
  // First, no caveat existed - nothing that subtracted ever read price_basis,
  // so an unstamped row was subtracted from exactly like a stamped one. Fixed
  // on 2026-09-17 in _shared/msrp-basis.js, which now refuses.
  //
  // Second, silence is not a decision anyone MADE. 5 of 31 sources passed a
  // basis and 26 did not, and nothing anywhere recorded whether that was
  // considered and unknown or simply never thought about. The result was 854
  // of 1,497 live rows with no basis, written FRESH every day by 17 makes.
  //
  // So a caller must now say one of two things, and saying nothing throws:
  //
  //   priceBasis: "excl_freight" | "incl_freight"
  //       Verified against the maker's OWN published wording or payload. Kia,
  //       for instance, returns msrp and dnd (delivery and destination) as
  //       separate fields and its page says the price excludes them - that is
  //       evidence, not inference.
  //
  //   priceBasisUnknown: "<why>"
  //       We have not established it. The rows write with a null basis exactly
  //       as before and the report declines to subtract - but the reason is in
  //       the source, in a string somebody had to type, instead of being the
  //       absence of an argument.
  //
  // A WRONG BASIS IS WORSE THAN NONE: it re-enables the subtraction on a false
  // premise, and the subtraction is what accuses a dealer. Never guess one to
  // clear this check. [[msrp-100-percent-accuracy]] [[no-accusation-language]]
  const BASES = ["excl_freight", "incl_freight"];
  if (msrpRows.length && !opts.ratesOnly && process.env.CATALOG_RATES_ONLY !== "1") {
    if (opts.priceBasis && !BASES.includes(opts.priceBasis)) {
      throw new Error(`writeCatalogs(${make}): priceBasis must be one of ${BASES.join(" | ")}, got ${JSON.stringify(opts.priceBasis)}`);
    }
    if (!opts.priceBasis && !opts.priceBasisUnknown) {
      throw new Error(`writeCatalogs(${make}): pass priceBasis ("excl_freight"/"incl_freight", verified against the maker's own wording) or priceBasisUnknown: "<why>". A missing basis is why 854 of 1,497 catalogue rows cannot be compared against.`);
    }
  }
  if (opts.priceBasis) msrpRows = msrpRows.map(r => ({ price_basis: opts.priceBasis, ...r }));
  msrpRows = dedupeBy(msrpRows, r => `${r.year}|${r.make}|${r.model}|${r.trim ?? ""}`, "msrp");
  financeRows = dedupeBy(financeRows, r => `${r.make}|${r.model}|${r.term_months}`, "apr");
  // AN ABSENT CREDENTIAL IS NOT A REQUEST FOR A DRY RUN.
  //
  // This branch exists for the local dev loop: run a scraper with no secrets
  // and read the rows it would have written. That is useful, and it stays.
  //
  // What it must never do is answer for a CI job that meant to write. On
  // 2026-09-23 the "Capture archived Toyota MSRP" step in archived-msrp.yml was
  // found carrying no env: block at all -- the Hyundai step directly below it
  // gets all three secrets -- so the step would parse Toyota's newsroom, print a
  // plausible row count, dump the result to a file on a runner about to be
  // destroyed, and exit 0. Green, monthly, forever, having written nothing.
  //
  // That workflow exists BECAUSE scrape-archived-toyota "merged on 2026-09-03,
  // passed its tests, and could never run". It shipped built-but-unwired in the
  // file written to stop built-but-unwired. [[repeat-fix-pattern]]
  //
  // So under GitHub Actions the absence is a bug, not a mode, and it is loud.
  // A caller that genuinely means "exercise this without writing" says so with
  // allowNoWrite, and one place does: the price-basis suite, which calls this
  // function to prove the basis rule is enforced rather than merely spelled.
  if (!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)) {
    if (process.env.GITHUB_ACTIONS === "true" && !opts.allowNoWrite) {
      throw new Error(
        `writeCatalogs(${make}): running under GitHub Actions with no SUPABASE_URL / ` +
        `SUPABASE_SERVICE_ROLE_KEY. This would have dumped ${msrpRows.length} MSRP / ` +
        `${financeRows.length} finance / ${leaseRows.length} lease row(s) to a file on a ` +
        `runner that is about to be destroyed, and exited 0. Add the secrets to this ` +
        `step's env: block, or pass allowNoWrite if the caller really means not to write.`);
    }
    const outDir = join(__dirname, "..", "out"); mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `${make.toLowerCase()}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify({ msrp_catalog: msrpRows, finance_rate_catalog: financeRows, lease_rate_catalog: leaseRows }, null, 2));
    console.log(`\nDRY RUN [${make}]. ${msrpRows.length} MSRP / ${financeRows.length} finance / ${leaseRows.length} lease -> ${file}`);
    console.table(msrpRows.slice(0, 8));
    return;
  }
  console.log(`\nWriting ${make} to Supabase…`);
  // Rates-only: skip the msrp_catalog write. Set either globally via
  // CATALOG_RATES_ONLY=1 (daily job) or per-scraper via opts.ratesOnly (e.g. a
  // dealer-feed rate source layered on top of another make's MSRP source).
  const ratesOnly = opts.ratesOnly || process.env.CATALOG_RATES_ONLY === "1";
  // THE THREE TABLES ARE INDEPENDENT DATA AND ARE WRITTEN INDEPENDENTLY.
  //
  // These used to be three bare awaits, so a throw on the FIRST one skipped the
  // other two. On 2026-08-16 Toyota's MSRP scrape collapsed 44 -> 7 rows, the
  // guard correctly REFUSED it, and that refusal threw -- taking down a finance
  // write of 123 rows and a lease write of 120 rows that were both perfectly
  // good and already in hand:
  //
  //     msrp_catalog          44 -> 44   FAIL   (refused, correctly)
  //     finance_rate_catalog 125 -> 125  FAIL   (123 rows ready, never ran)
  //     lease_rate_catalog   120 -> 120  warn   (120 rows ready, never ran)
  //
  // A collapsed MSRP lineup says nothing about the rates. And the rates are half
  // the product -- the daily APR check is the other side of the reference-point
  // model, so letting an MSRP failure freeze it means the APR half goes stale
  // every day the MSRP half is broken, silently, for a reason unrelated to it.
  //
  // Each write is attempted; failures are collected and rethrown together, so
  // the step still fails loudly and the fresh-write guard still reports it.
  const failures = [];
  const attempt = async (label, fn) => {
    try { await fn(); } catch (e) { failures.push(`${label}: ${e.message}`); }
  };

  if (!ratesOnly) await attempt("msrp_catalog", () => replaceRows("msrp_catalog", msrpRows, make, { upsert: !!opts.upsert }));
  else console.log(`  (rates-only: msrp_catalog left unchanged for ${make})`);
  await attempt("finance_rate_catalog", () => replaceRows("finance_rate_catalog", financeRows, make));
  // lease is already fatal:false — it never threw and never blocked anything.
  await replaceRows("lease_rate_catalog", leaseRows, make, { fatal: false });

  if (failures.length) {
    throw new Error(
      `${make}: ${failures.length} of the catalog writes failed (the others still ran)\n  - ` +
      failures.join("\n  - "));
  }
  console.log("Done.");
}

export function parseArgs() {
  return Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true]; }));
}

/**
 * What the catalogue ALREADY knows about a make's powertrains, for the guards
 * that need our own history rather than the incoming batch.
 *
 * WHY. flagAllOnePowertrain proved a series-level fuel mis-tag by looking for a
 * powertrain-marked sibling nameplate — in the SAME scrape batch. On 2026-09-22
 * Toyota's feed returned "4Runner" without "4Runner Hybrid" (the hybrid rows
 * survive only as carry-forward, which the guard cannot see), so the proof
 * evaporated, the refusal degraded to a warning, and four gas trims went in
 * tagged Hybrid — including an SR5 at $55,520, the identical price the same
 * catalogue had stored as Gas five weeks earlier.
 *
 * A guard whose evidence is whatever the source happened to send this morning
 * is a guard the source can switch off.
 *
 * Returns { nameplates, fuels } — `make|year|model` (model lower-cased) for the
 * sibling proof, and `make|model|year` -> Set(fuel_type) for the flip proof.
 * On a failed read it returns empty collections, which makes both proofs fall
 * back to batch-only behaviour rather than refusing everything.
 */
export async function readPowertrainHistory(make) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const empty = { nameplates: [], fuels: new Map() };
  if (!url || !key) return empty;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const { ok, rows } = await readExisting("msrp_catalog", make, headers, url);
  if (!ok) return empty;
  const nameplates = new Set(), fuels = new Map();
  for (const r of rows) {
    // An alias row ("RAV4 Hybrid", alias_of "RAV4") is our own second name for
    // the same line, not a separate maker nameplate, so it proves no sibling.
    if (!r.attrs?.alias_of) nameplates.add(`${r.make}|${r.year}|${String(r.model || "").toLowerCase()}`);
    const k = `${r.make}|${r.model}|${r.year}`;
    if (!fuels.has(k)) fuels.set(k, new Set());
    if (r.fuel_type) fuels.get(k).add(r.fuel_type);
  }
  return { nameplates: [...nameplates], fuels };
}
