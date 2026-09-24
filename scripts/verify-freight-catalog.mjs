// Re-read every freight figure against the source it cites, daily.
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
// IT VERIFIES, IT NEVER REWRITES. A change is reported, dated and turns the run
// red; no amount is ever auto-corrected. The figures live in fee-schedule.ts as
// reviewed constants, and a regex confident enough to overwrite a freight
// charge is confident enough to invent one.
//
// IT HONOURS robots.txt (RFC 9309) AND SAYS WHO IT IS. Every request goes
// through politeFetch, which sends the LotCheckBot User-Agent. A 403 is the
// maker's refusal, recorded as `blocked` and never routed around.
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
import { verifyRow, assess, robotsVerdict, STATUS_NOTE } from "./lib/freight-verify.mjs";
import { pdfText, looksLikePdf } from "./lib/pdf-text.mjs";
import { freightCatalog } from "../supabase/functions/_shared/fee-schedule.ts";

const DRY = process.argv.includes("--dry-run");
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TODAY = new Date().toISOString().slice(0, 10);
const PAUSE_MS = 750;

// ONE ROW PER (make, model, model year). A maker's freight moves between model
// years -- Volkswagen's own Alberta offers price the 2026 Atlas at $2,250 and
// the 2027 at $2,450 -- so the year is part of the figure's identity.
// freight_verification's key is (make, model), so the year rides in the model
// column rather than two rows colliding in one upsert (which Postgres refuses
// outright: "ON CONFLICT DO UPDATE command cannot affect row a second time").
const dbModel = (r) => (r.modelYear === "current" ? `${r.model} (current)` : r.modelYear ? `${r.model} MY${r.modelYear}` : r.model);
const urlOf = (r) => String(r.sourceUrl || "").replaceAll("{today}", TODAY);
const key = (r) => `${r.make}|${dbModel(r)}`;

// A FAILED STATE READ OR WRITE IS NOT A WARNING. Until 2026-09-24 both were:
// every run since 2026-09-17 logged "could not record verification state: HTTP
// 404" -- the table had never been created in production -- and exited green.
// With no stored state, "was confirmed yesterday" could never be true, so the
// only red path this job had could never fire. Each now says whether it worked,
// and a run holding credentials that cannot read or write its own state is red.
async function previousResults() {
  if (!URL_ || !KEY) return { ok: true, map: {} };
  try {
    const res = await politeFetch(`${URL_}/rest/v1/freight_verification?select=make,model,status,note`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
      timeoutMs: 15_000,
    });
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}`, map: {} };
    const rows = await res.json();
    const map = Object.fromEntries((Array.isArray(rows) ? rows : []).map((r) => [`${r.make}|${r.model}`, { status: r.status, note: r.note }]));
    return { ok: true, map };
  } catch (e) { return { ok: false, why: e.message, map: {} }; }
}

async function record(results) {
  if (DRY || !URL_ || !KEY) return { ok: true };
  const body = results.map((r) => ({
    make: r.make, model: r.dbModel, last_verified_at: new Date().toISOString(),
    status: r.status, amount_held: r.amount,
    amounts_seen: r.seen && r.seen.length ? r.seen : null,
    note: r.note, http: r.http ?? null,
  }));
  try {
    const res = await politeFetch(`${URL_}/rest/v1/freight_verification?on_conflict=make,model`, {
      method: "POST",
      headers: {
        apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(body),
      timeoutMs: 20_000,
    });
    return res.ok ? { ok: true } : { ok: false, why: `HTTP ${res.status} ${(await res.text()).slice(0, 200)}` };
  } catch (e) { return { ok: false, why: e.message }; }
}

// robots.txt, once per origin per run. robotsVerdict holds the RFC 9309 rules.
const robotsCache = new Map();
async function robotsFor(url) {
  const u = new URL(url);
  if (!robotsCache.has(u.origin)) {
    let status = 0, text = "";
    try {
      const res = await politeFetch(`${u.origin}/robots.txt`, { timeoutMs: 15_000 });
      status = res.status;
      if (res.ok) text = await res.text();
    } catch { status = 0; }
    robotsCache.set(u.origin, { status, text });
  }
  const { status, text } = robotsCache.get(u.origin);
  const v = robotsVerdict(status, text, u.pathname + u.search);
  if (v.crawlDelay) crawlDelay.set(u.origin, v.crawlDelay);
  return v;
}

// ONE FETCH PER SOURCE PER RUN. Toyota answers 32 model lines from one Alberta
// price feed, Kia 24 from one 25 MB build-and-price page, VW 13 from two offer
// responses. Each is fetched once and every row that cites it reads the same
// body -- which is also what makes their figures comparable within a run.
const bodies = new Map();
const lastHit = new Map();
const crawlDelay = new Map();
function fetchSource(row) {
  const req = row.request || {};
  const url = urlOf(row);
  const body = req.body == null ? null : typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  const k = `${req.method || "GET"} ${url} ${body || ""}`;
  if (!bodies.has(k)) {
    bodies.set(k, (async () => {
      // One request at a time, with a pause: Hyundai and Mazda answer a dozen
      // figures each from one host, and a daily check has no reason to hurry.
      // A host whose robots.txt names a Crawl-delay gets that, not ours.
      const origin = new URL(url).origin;
      const gap = Math.max(PAUSE_MS, (crawlDelay.get(origin) || 0) * 1000);
      const wait = (lastHit.get(origin) || 0) + gap - Date.now();
      await new Promise((r) => setTimeout(r, Math.max(PAUSE_MS, wait)));
      lastHit.set(origin, Date.now());
      try {
        const res = await politeFetch(url, {
          method: req.method || "GET",
          timeoutMs: 60_000,
          // Accept-Language is a true statement about who is asking, not a
          // disguise: Hyundai's own build-and-price API answers HTTP 400 to a
          // request that names no language and 200 to en-CA.
          headers: {
            Accept: row.read ? "application/json, text/html;q=0.9" : "text/html,application/xhtml+xml,*/*;q=0.8",
            "Accept-Language": "en-CA,en;q=0.9",
            ...(body ? { "Content-Type": req.contentType || "application/json" } : {}),
            ...(req.headers || {}),
          },
          // Honda and Acura's price calculator is a POST of [{modelKey,
          // modelYear}] -- the same read-only question their configurator asks.
          ...(body ? { body } : {}),
        });
        if (!res.ok) return { page: null, http: res.status };
        const buf = Buffer.from(await res.arrayBuffer());
        // Mitsubishi publishes its price guides as PDFs; their text streams
        // are compressed, so a raw read finds nothing.
        const page = looksLikePdf(res.headers.get("content-type"), buf) ? pdfText(buf) : buf.toString("utf8");
        return { page, http: res.status };
      } catch (e) {
        console.warn(`  ${row.make} ${dbModel(row)}: ${e.message}`);
        return { page: null, http: null };
      }
    })());
  }
  return bodies.get(k);
}

async function main() {
  const rows = freightCatalog();
  console.log(`Freight catalogue: ${rows.length} figure(s) across ${new Set(rows.map((r) => r.make)).size} make(s), read ${TODAY}.\n`);

  const prev = await previousResults();
  const previous = prev.map;
  const results = [];

  for (const row of rows) {
    let page = null;
    let http = null;
    let v = null;
    if (row.sourceUrl) {
      const rb = await robotsFor(urlOf(row));
      if (!rb.ok) {
        v = { status: rb.status, seen: [], note: STATUS_NOTE[rb.status] };
      } else {
        ({ page, http } = await fetchSource(row));
      }
    }
    const k = key(row);
    v ||= verifyRow(row, page, http, { today: TODAY, previous: previous[k] });
    results.push({ ...v, make: row.make, model: row.model, dbModel: dbModel(row), amount: row.amount, key: k, http });
  }

  // ── the report ───────────────────────────────────────────────────────────
  const a = assess(results, { previous });

  // CHANGES FIRST, DATED. A changed freight figure is the one thing this job
  // exists to catch, so it leads the report instead of sitting under the
  // confirmations.
  if (a.changed.length) {
    console.log(`CHANGED (${a.changed.length}) -- the maker's source no longer states the figure we hold`);
    for (const r of a.changed) console.log(`  ${r.make} ${r.dbModel}  — ${r.note}`);
    console.log("");
  }

  const byStatus = {};
  for (const r of results) if (r.status !== "drifted") (byStatus[r.status] ||= []).push(r);
  for (const [st, list] of Object.entries(byStatus)) {
    console.log(`${st.toUpperCase()} (${list.length})`);
    for (const r of list) {
      console.log(`  ${r.make} ${r.dbModel}  $${Number(r.amount).toLocaleString("en-CA")}  — ${r.note}`);
    }
    console.log("");
  }

  if (a.noSource) {
    console.warn(
      `${a.noSource} of ${a.total} figure(s) have no re-readable source, so nothing can check them. ` +
      "Each row says why in fee-schedule.ts (unsourced); that is our backlog, not a finding about any manufacturer.\n",
    );
  }

  console.log(requestLedger());
  const rec = await record(results);

  console.log(
    `\n${a.confirmed} confirmed · ${a.drifted} changed · ${a.failedToRead} could not be read ` +
    `· ${a.noSource} have no source URL · ${a.total} total`,
  );

  if (a.changed.length) {
    console.error(`\n${a.changed.length} freight figure(s) CHANGED at the source:`);
    for (const d of a.changed) {
      const was = a.regressed.includes(d) ? " (confirmed on the previous run)" : "";
      console.error(`  ${d.make} ${d.dbModel}${was}: ${d.note}`);
    }
    console.error("\nRe-read the source and update fee-schedule.ts by hand. This job never rewrites a figure.");
  }
  if (a.mostlyUnread) {
    console.error(
      `\n${a.failedToRead} of ${a.attempted} figures WITH a source URL could not be read. ` +
      `"No drift" here would mean "nothing was examined", and treating that as green is the defect this job exists to prevent.`,
    );
  }
  if (!prev.ok) console.error(`\nCould not read the previous verification state (${prev.why}); a change's first-seen date and "confirmed last run" are unknowable without it.`);
  if (!rec.ok) console.error(`\nCould not record this run's verification state (${rec.why}). Tomorrow's run would not know what today confirmed.`);

  process.exit(a.red || !prev.ok || !rec.ok ? 1 : 0);
}

main().catch((e) => { console.error("verify-freight-catalog failed:", e.message); process.exit(1); });
