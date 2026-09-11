// DAILY MSRP REPORT — is the denominator current, and for which makes?
//
// Vic, 2026-09-11: "i need daily report of msrp".
//
// MSRP is the number every price claim in the product divides by. A stale
// catalog does not fail loudly; it quietly answers "how far above list is
// this?" using last month's list. This report exists so that a person can
// answer, in one glance each morning, the only question that matters: WHICH
// MAKES ARE WE STILL ANSWERING FROM STALE DATA.
//
// WHY IT EXISTS AT ALL. Jaguar, Land Rover and Mitsubishi sat at fetched_at
// 2026-08-08 for THIRTY-FOUR DAYS while catalog-refresh.yml ran green every
// night. It ran green honestly: those three makes have no scraper and no step,
// so nothing failed — nothing was attempted. The pre-run snapshot printed their
// row counts each night and nobody read it as an alarm, because a count is not
// a date. Nothing in the system distinguished "refreshed today" from "last
// touched by hand five weeks ago", so nothing could raise its hand.
//
// WHAT IT REFUSES TO DO. [[msrp-daily-6am-nonnegotiable]]
//   * Lead with a green tick. It leads with what is STALE, and prints a date
//     for every make whether fresh or not. "29 of 32 fresh" hides which three.
//   * Conflate "we could not read this make" with "this make has no models".
//     A make we have never read is named as unread, never as small.
//   * Blend MSRP with finance/lease rates. A price is WRONG without MSRP; it is
//     merely less complete without a rate. They are separate sections because
//     they are separate severities, and eight consecutive red runs caused by
//     rates alone taught us that one undifferentiated signal gets ignored.
//   * Judge freshness against "today". It judges against the newest write
//     anywhere in the catalog, so a morning run before the cron lands does not
//     accuse all 32 makes of being stale.
//
// WHERE "WIRED" COMES FROM. The set of makes the refresh actually attempts is
// PARSED OUT OF .github/workflows/catalog-refresh.yml — the same guard
// arguments the runner obeys — never a list maintained here. A hardcoded list
// is how the original gap survived: it would have been written from the same
// wrong assumption, agreed with itself, and reported all clear. Add a Jaguar
// step to that workflow and this report stops flagging Jaguar, with no edit
// here. Delete a step and it starts flagging that make the same morning.
//
// Anon-readable: msrp_catalog and lease_rate_catalog are public reads, the same
// grant public/alberta-inventory-daily.html already uses. No service-role key,
// no writes. finance_rate_catalog is NOT anon-readable and is reported as
// unreadable rather than as empty — an RLS refusal returns [] and would
// otherwise print as "0 rows", which is a false alarm dressed as a finding.
//
// Run:  node scripts/daily-msrp-report.mjs [--json] [--stale-days=2]
// Exit: 1 when a wired make is stale — so CI can carry this, not just a human.

import { readFileSync } from "node:fs";

const SUPA = process.env.SUPABASE_URL || "https://debigtyjhjamipooajhk.supabase.co";
const ANON = process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlYmlndHlqaGphbWlwb29hamhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NjQ4OTEsImV4cCI6MjA5ODQ0MDg5MX0.PujrRSJA_CWQKEtzGLtbAwk2Uq6VZAJDKEyS56exP9A";

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const AS_JSON = process.argv.includes("--json");
// Two days, not one. The cron is a scheduled workflow, which GitHub delivers on
// a best-effort basis — the eight runs before 2026-09-11 started a mean 3.9h
// late. A one-day threshold would cry wolf on the morning of a late run and
// train the reader to ignore it, which is precisely the failure this replaces.
const STALE_DAYS = Number(arg("stale-days", 2));

const WF = ".github/workflows/catalog-refresh.yml";
const RATES_WF = ".github/workflows/catalog-rates-daily.yml";
const MAKES_TS = "supabase/functions/_shared/makes.ts";

const norm = (s) => String(s || "").trim().toLowerCase();
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const pad = (s, n) => String(s).padEnd(n);

// ---- what the refresh actually attempts -----------------------------------
// Parsed from the guard arguments, which is what the runner itself obeys. A
// make absent from every --makes= list is a make no step touches: not failing,
// not attempted. That distinction is the whole point of this report.
export function wiredMakes(path) {
  let src = "";
  try { src = readFileSync(path, "utf8"); } catch { return null; }
  const out = new Map();
  const re = /--makes="([^"]+)"([^\n]*)/g;
  for (let m; (m = re.exec(src)); ) {
    const level = /--msrp=(\w+)/.exec(m[2])?.[1] || null;
    for (const mk of m[1].split(",")) {
      const k = norm(mk);
      // required beats optional: a make in two steps is required if either is.
      if (!out.has(k) || level === "required") out.set(k, { make: mk.trim(), msrp: level });
    }
  }
  return out;
}

// A MAKE WITH ZERO ROWS IS INVISIBLE TO A GROUP-BY.
//
// The first version of this report derived its make list from msrp_catalog
// itself, so it could only ever report on makes that have at least one row. It
// therefore said nothing at all about AUDI — 0 rows, no scraper, no workflow
// step, seeded with 15 rows by 20260808_german_mbz_audi_vw_msrp_catalog.sql and
// gone since. A freshness report whose blind spot is the emptiest make is
// pointed the wrong way round: it was fluent about the 29 makes that are fine
// and silent about the one with nothing at all.
//
// CANONICAL_MAKES in supabase/functions/_shared/makes.ts is the set of makes the
// product can actually encounter on a listing, which is the right denominator
// for "do we have a denominator". Parsed, not copied, for the same reason the
// wired list is parsed: a second copy drifts and then agrees with itself.
export function canonicalMakes(path) {
  let src = "";
  try { src = readFileSync(path, "utf8"); } catch { return null; }
  const m = /const CANONICAL_MAKES\s*=\s*\[([\s\S]*?)\]/.exec(src);
  if (!m) return null;
  const out = [];
  for (const q of m[1].matchAll(/"([^"]+)"/g)) out.push(q[1]);
  return out.length ? out : null;
}

export function ratesMakes(path) {
  let src = "";
  try { src = readFileSync(path, "utf8"); } catch { return null; }
  const out = new Set();
  const re = /-\s*\{\s*name:\s*([^,]+),\s*script:/g;
  for (let m; (m = re.exec(src)); ) out.add(norm(m[1]));
  return out;
}

// ---- IS THE BASELINE ITSELF ANY GOOD? -------------------------------------
// Comparing every make to the newest write ANYWHERE is right while the refresh
// is running: it absorbs a late cron without crying wolf. It is catastrophic
// when the refresh STOPS. Every make then sits at the same frozen date, every
// age computes to zero, and the report cheerfully prints "EVERY MAKE
// REFRESHED" over a catalog nobody has touched in a week — a monitor that gets
// QUIETER the worse things get. The relative test finds the make that fell
// behind the others; only an absolute test finds the day they all did.
//
// Pure, and exported, so scripts/test-msrp-report.mjs can drive it with a
// frozen clock. A guard whose trigger condition only exists in production is a
// guard nobody has ever seen fire. [[repeat-fix-pattern]]
//
// Measured from the END of the newest written day, because `newest` is a date
// and not an instant — a write at 14:00 UTC must not read as 14 hours old at
// midnight. Clamped at zero: same-day is zero hours old, never negative.
export function catalogFreshness(newest, nowMs, staleDays) {
  if (!newest) return { ageHours: null, frozen: false };
  const endOfDay = Date.parse(`${newest}T23:59:59Z`);
  if (!Number.isFinite(endOfDay)) return { ageHours: null, frozen: false };
  const ageHours = Math.max(0, Math.round((nowMs - endOfDay) / 3600000));
  return { ageHours, frozen: ageHours > staleDays * 24 };
}

// ---- production -----------------------------------------------------------
async function page(table, cols) {
  const rows = [];
  for (let off = 0, i = 0; i < 40; i++, off += 1000) {
    const res = await fetch(`${SUPA}/rest/v1/${table}?select=${cols}&order=id.asc&limit=1000&offset=${off}`, {
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
    });
    if (!res.ok) throw new Error(`${table}: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`);
    const d = await res.json();
    rows.push(...d);
    if (d.length < 1000) break;
  }
  return rows;
}

// WHICH COLUMN CARRIES FRESHNESS, asked rather than assumed. msrp_catalog
// stamps `fetched_at`; lease_rate_catalog has no such column and stamps
// `created_at`. Hardcoding one name made this report print an HTTP 400 in the
// rates section on its first run — a report that cannot read a table must say
// so, but it should first make sure the table is genuinely unreadable and not
// merely differently shaped. Returns null when nothing readable is exposed.
async function freshnessColumn(table) {
  const res = await fetch(`${SUPA}/rest/v1/${table}?select=*&limit=1`, {
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
  });
  if (!res.ok) return { col: null, note: `HTTP ${res.status}` };
  const d = await res.json();
  if (!d.length) return { col: null, note: "no rows are visible to an anon reader" };
  for (const c of ["fetched_at", "created_at", "effective_date", "updated_at"]) {
    if (c in d[0]) return { col: c, note: null };
  }
  return { col: null, note: `no freshness column among ${Object.keys(d[0]).join(", ")}` };
}

function byMake(rows, dateCol) {
  const m = new Map();
  for (const r of rows) {
    const k = norm(r.make);
    const e = m.get(k) || { make: r.make, rows: 0, models: new Set(), newest: null, oldest: null };
    e.rows++;
    if (r.model) e.models.add(String(r.model));
    const d = r[dateCol] ? String(r[dateCol]).slice(0, 10) : null;
    if (d) {
      if (!e.newest || d > e.newest) e.newest = d;
      if (!e.oldest || d < e.oldest) e.oldest = d;
    }
    m.set(k, e);
  }
  return m;
}

async function main() {
  const wired = wiredMakes(WF);
  if (!wired) {
    console.error(`Could not read ${WF}. Run this from the repo root — the wired-make list is`);
    console.error("parsed from the workflow on purpose, and guessing it would defeat the check.");
    process.exitCode = 1;
    return;
  }
  const rateWired = ratesMakes(RATES_WF) || new Set();
  const canonical = canonicalMakes(MAKES_TS);

  const msrp = byMake(await page("msrp_catalog", "make,model,fetched_at"), "fetched_at");

  // Rates: read what we are allowed to read, and say so when we are not. An
  // anon reader is refused with an EMPTY SET, never an error, so "0 rows" and
  // "not allowed to look" are indistinguishable from the response alone — and
  // printing the first when the truth is the second is a manufactured alarm.
  let lease = null, leaseCol = null, leaseErr = null;
  try {
    const f = await freshnessColumn("lease_rate_catalog");
    leaseCol = f.col;
    if (!f.col) leaseErr = f.note;
    else lease = byMake(await page("lease_rate_catalog", `make,${f.col}`), f.col);
  } catch (e) { leaseErr = e.message; }
  let finErr = null;
  try {
    const f = await freshnessColumn("finance_rate_catalog");
    if (!f.col) finErr = `${f.note} — this table is not granted to the anon role, so this report cannot judge it`;
  } catch (e) { finErr = e.message; }

  // FRESH RELATIVE TO THE LAST WRITE, not to the wall clock. Running this at
  // 5am before the 5:23am cron must not report the whole catalog as stale.
  const newest = [...msrp.values()].map((e) => e.newest).filter(Boolean).sort().pop() || null;

  const { ageHours: catalogAgeHours, frozen: catalogFrozen } =
    catalogFreshness(newest, Date.now(), STALE_DAYS);

  const makes = [];
  const seen = new Set();
  for (const [k, e] of msrp) {
    seen.add(k);
    const w = wired.get(k);
    const age = e.newest && newest ? days(e.newest, newest) : null;
    makes.push({
      make: e.make, rows: e.rows, models: e.models.size, newest: e.newest, oldest: e.oldest,
      wired: !!w, level: w?.msrp || null, ageDays: age,
      state: !w ? "not-wired" : age === null ? "no-date" : age >= STALE_DAYS ? "stale" : "fresh",
    });
  }
  // A make wired into the refresh with NO rows at all is the built-but-unwired
  // failure in its purest form: a step runs, a guard passes, nothing is stored.
  for (const [k, w] of wired) {
    if (seen.has(k)) continue;
    seen.add(k);
    makes.push({ make: w.make, rows: 0, models: 0, newest: null, oldest: null, wired: true, level: w.msrp, ageDays: null, state: "empty" });
  }
  // And a make the PRODUCT can encounter that is in neither place — no rows and
  // no step. Audi is exactly this: 15 rows seeded by the 20260808 migration, now
  // zero, in CANONICAL_MAKES, invisible to every group-by over the table. A
  // report on an Audi has no denominator at all, which is a worse state than a
  // stale one, and nothing said so.
  for (const mk of canonical || []) {
    if (seen.has(norm(mk))) continue;
    makes.push({ make: mk, rows: 0, models: 0, newest: null, oldest: null, wired: false, level: null, ageDays: null, state: "absent" });
  }
  makes.sort((a, b) => (a.newest || "0").localeCompare(b.newest || "0") || a.make.localeCompare(b.make));

  const stale = makes.filter((m) => m.state === "stale" || m.state === "empty");
  const unwired = makes.filter((m) => m.state === "not-wired");
  const absent = makes.filter((m) => m.state === "absent");
  const fresh = makes.filter((m) => m.state === "fresh");

  if (AS_JSON) {
    console.log(JSON.stringify({
      newestWriteAnywhere: newest, catalogAgeHours, catalogFrozen, staleDays: STALE_DAYS, makes,
      rates: {
        financeReadable: !finErr, financeNote: finErr,
        leaseReadable: !leaseErr, leaseNote: leaseErr, leaseFreshnessColumn: leaseCol,
        leaseMakes: lease ? [...lease.values()].map((e) => ({ make: e.make, rows: e.rows, newest: e.newest })) : null,
        ratesWorkflowMakes: rateWired.size,
      },
    }, null, 2));
  } else {
    console.log("DAILY MSRP — is the denominator current?");
    console.log("=".repeat(72));
    console.log(`  Newest write anywhere in the catalog : ${newest || "none"}${catalogAgeHours == null ? "" : catalogAgeHours === 0 ? "  (written today)" : `  (${catalogAgeHours}h since that day ended)`}`);
    console.log(`  Makes in the catalog                 : ${msrp.size}`);
    console.log(`  Makes the refresh attempts           : ${wired.size}`);
    console.log(`  Total MSRP rows                      : ${[...msrp.values()].reduce((n, e) => n + e.rows, 0)}`);

    // STALE FIRST, ALWAYS. If there is nothing wrong this section says so in
    // one line; it never becomes a scroll past good news to find bad.
    console.log("");
    // And this above everything else: if the baseline itself is old, no
    // per-make comparison below it means anything.
    if (catalogFrozen) {
      console.log("THE WHOLE CATALOG IS FROZEN".padEnd(72, " "));
      console.log("-".repeat(72));
      console.log(`  Nothing has been written to msrp_catalog in ${catalogAgeHours} hours.`);
      console.log("  The per-make comparison below is relative to that frozen date, so it will");
      console.log("  read as if every make is current. IT IS NOT. The refresh itself has stopped:");
      console.log("  check the catalog-refresh workflow before reading anything else here.");
      console.log("");
    }
    if (unwired.length) {
      console.log(`NEVER REFRESHED — ${unwired.length} make(s) have NO step in the refresh`);
      console.log("-".repeat(72));
      console.log("  These are not failing. Nothing is attempted for them: no scraper file, no");
      console.log("  step in catalog-refresh.yml. Their rows are whatever was last put there by");
      console.log("  hand. Every run since has been green WITHOUT reading them.");
      for (const m of unwired) {
        const age = m.newest && newest ? `${days(m.newest, newest)}d ago` : "never";
        console.log(`    ${pad(m.make, 16)} ${pad(m.rows + " rows", 10)} last written ${m.newest || "never"}  (${age})`);
      }
    }
    if (stale.length) {
      if (unwired.length) console.log("");
      console.log(`STALE — ${stale.length} wired make(s) did not refresh`);
      console.log("-".repeat(72));
      for (const m of stale) {
        const why = m.state === "empty"
          ? "wired into the refresh but holds NO rows at all"
          : `${m.ageDays}d behind the newest write`;
        console.log(`    ${pad(m.make, 16)} ${pad(m.rows + " rows", 10)} ${pad(m.newest || "never", 12)} ${why}${m.level === "optional" ? "  (msrp=optional)" : ""}`);
      }
    }
    if (absent.length) {
      if (unwired.length || stale.length) console.log("");
      console.log(`NO DENOMINATOR AT ALL — ${absent.length} make(s) the product can encounter hold ZERO rows`);
      console.log("-".repeat(72));
      console.log("  These are in CANONICAL_MAKES, so a listing can name them and a report can be");
      console.log("  asked for one — but there is no MSRP to divide by. Not stale: absent. A");
      console.log("  group-by over the catalog cannot see these, which is why they are listed");
      console.log("  from the make list rather than from the rows.");
      for (const m of absent) console.log(`    ${pad(m.make, 16)} 0 rows     never written`);
    }
    if (!unwired.length && !stale.length && !absent.length) {
      console.log(`EVERY MAKE IN THE CATALOG REFRESHED WITHIN THE LAST ${STALE_DAYS} DAY(S).`);
    }

    console.log("");
    console.log(`CURRENT — ${fresh.length} make(s)`);
    console.log("-".repeat(72));
    console.log(`    ${pad("MAKE", 16)}${pad("ROWS", 7)}${pad("MODELS", 8)}${pad("LAST WRITTEN", 14)}OLDEST ROW STILL HELD`);
    for (const m of [...fresh].sort((a, b) => a.make.localeCompare(b.make))) {
      // The oldest row in a make that refreshed today is a real signal: it means
      // part of that make's catalog was not rewritten, only added to.
      const drag = m.oldest && m.newest && m.oldest !== m.newest ? m.oldest : "all same day";
      console.log(`    ${pad(m.make, 16)}${pad(m.rows, 7)}${pad(m.models, 8)}${pad(m.newest, 14)}${drag}`);
    }

    // Rates last, and explicitly demoted. This ordering is the fix for eight
    // consecutive red runs that were entirely rates while MSRP was perfect.
    console.log("");
    console.log("FINANCE / LEASE RATES — a separate question, and a lesser one");
    console.log("-".repeat(72));
    console.log("  A price is WRONG without MSRP. It is merely less complete without a rate.");
    if (finErr) console.log(`  finance_rate_catalog: ${finErr}`);
    if (leaseErr) console.log(`  lease_rate_catalog: ${leaseErr}`);
    if (lease && lease.size) {
      const rstale = [...lease.values()].filter((e) => e.newest && newest && days(e.newest, newest) >= STALE_DAYS);
      console.log(`  lease rates held for ${lease.size} make(s) (freshness read from ${leaseCol}); ${rstale.length} stale by ${STALE_DAYS}+ days.`);
      for (const e of rstale.sort((a, b) => (a.newest || "").localeCompare(b.newest || ""))) {
        console.log(`    ${pad(e.make, 16)} ${pad(e.rows + " rows", 10)} last written ${e.newest}`);
      }
    }
    console.log(`  Rates run on their own daily workflow (${RATES_WF}) for ${rateWired.size} makes.`);
    console.log("  Read that run for rate failures — they do not make MSRP wrong.");
    console.log("");
  }

  // THE CI ANNOTATION IS EMITTED HERE, not scraped from the text above.
  // The first version of the workflow step grepped this report's own output for
  // make names and got back "Jaguar Land Mitsubishi MAKE Acura Alfa BMW ..." —
  // it split "Land Rover" at the space and ran on into the next section. The
  // program holding the data is the only thing that can name it correctly, so
  // the annotation is written from the array, never re-derived from the prose.
  if (process.env.GITHUB_ACTIONS) {
    if (unwired.length) {
      console.log(`::warning title=${unwired.length} make(s) have no refresh step::` +
        unwired.map((m) => `${m.make} (last written ${m.newest || "never"})`).join(", "));
    }
    if (absent.length) {
      console.log(`::warning title=${absent.length} make(s) have no MSRP rows at all::` +
        absent.map((m) => m.make).join(", "));
    }
    if (stale.length) {
      console.log(`::error title=MSRP STALE for ${stale.length} wired make(s)::` +
        stale.map((m) => `${m.make} (${m.newest || "never"})`).join(", "));
    }
    if (catalogFrozen) {
      console.log(`::error title=msrp_catalog has not been written in ${catalogAgeHours}h::` +
        "the refresh has stopped; per-make freshness below is measured against a frozen baseline");
    }
  }

  // Red only for a make the refresh was SUPPOSED to write. An un-wired make is
  // a gap in what we built, reported every morning, not a nightly false alarm
  // about a job that is behaving exactly as configured.
  // A frozen catalog is the loudest failure this report can find — louder than
  // any single make — so it fails the run on its own.
  if (stale.length || catalogFrozen) process.exitCode = 1;
}

// Only run when invoked directly. scripts/test-msrp-report.mjs imports the two
// parsers above and must not fire a production read to do it.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("daily-msrp-report.mjs")) {
  main().catch((e) => { console.error(e?.message || e); process.exitCode = 1; });
}
