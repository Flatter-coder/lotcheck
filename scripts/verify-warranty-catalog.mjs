// Re-read every manufacturer's own warranty page and check our catalogue against it.
//
// Runs 6am and midnight (America/Edmonton) from warranty-verify.yml.
// Vic, 2026-09-13: "fix warranty catalog, 6am and midnight".
//
// manufacturer_warranties holds 35 makes, every figure typed by hand from a
// manufacturer page, and it had NO refresh job of any kind. Point 09 of the ten
// tells a buyer what factory cover is left on a specific car and whether it
// transfers. That claim rested on a row nobody had re-read since it was written.
//
// IT VERIFIES, IT NEVER REWRITES. See scripts/lib/warranty-verify.mjs for why
// the asymmetry is the design and not timidity.
//
// POLITE BY CONSTRUCTION: every request goes through politeFetch, so it sends an
// honest LotCheckBot User-Agent, honours Retry-After, breaks the circuit on a
// host that refuses, and counts what it sent. ~35 requests per run, one page per
// make. The ledger is printed at the end because a job that asks for standing
// permission to knock should be able to say how often it knocks.
//
// Run: node scripts/verify-warranty-catalog.mjs            (needs SUPABASE_ACCESS_TOKEN)
//      node scripts/verify-warranty-catalog.mjs --dry-run  (fetch + report, no writes)

import { politeFetch, requestLedger } from "./lib/polite-fetch.mjs";
import { verifyRow } from "./lib/warranty-verify.mjs";

const PROJECT_REF = "debigtyjhjamipooajhk";
const DRY = process.argv.includes("--dry-run");
const PAUSE_MS = 800;            // one page per make; no need to hurry
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const q = (v) => (v == null || v === "" ? "null" : `'${String(v).replace(/'/g, "''")}'`);

async function runSql(sql) {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN is not set");
  // Through the limiter too, not around it. Supabase is not a dealer, but a
  // second fetch path in a listed caller is a second path with different rules --
  // and routing it here means the request ledger printed at the end of the run
  // accounts for EVERYTHING the job sent, not just the polite half.
  const res = await politeFetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) throw new Error(`Management API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json().catch(() => null);
}

// Enough to read prose out of a marketing page. Warranty terms live in body
// copy and tables, never in script or style, so dropping those wholesale
// removes the JSON blobs that would otherwise supply stray matching numbers.
function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

async function readPage(url) {
  try {
    const res = await politeFetch(url, { timeoutMs: 25_000 });
    if (!res.ok) return { page: null, http: res.status, why: `HTTP ${res.status}` };
    const text = htmlToText(await res.text());
    // A page that renders its warranty table in JS gives us a shell. Treating a
    // shell as "the manufacturer no longer says this" would manufacture drift
    // out of our own inability to read, which is the defect this codebase keeps
    // finding. Too short to judge is UNREACHABLE, not drifted.
    if (text.length < 600) return { page: null, http: res.status, why: `page too thin to judge (${text.length} chars) -- likely rendered client-side` };
    return { page: text, http: res.status, why: null };
  } catch (e) {
    return { page: null, http: null, why: (e?.message || String(e)).slice(0, 160) };
  }
}

async function main() {
  const sel = await runSql(
    `select make, basic_coverage, powertrain_coverage, corrosion_coverage,
            roadside_assistance, hybrid_ev_coverage, source_url,
            verify_status as prev_status
       from public.manufacturer_warranties order by make;`);
  const rows = Array.isArray(sel) ? sel : [];
  if (!rows.length) throw new Error("manufacturer_warranties returned no rows — refusing to report a verification of nothing.");
  console.log(`Warranty catalogue: ${rows.length} make(s) to verify.\n`);

  const results = [];
  for (const row of rows) {
    let page = null, http = null, why = null;
    if (row.source_url) ({ page, http, why } = await readPage(row.source_url));
    // The HTTP code travels with the page, so a refusal (403) can be told apart
    // from a dead link (404) and from a network that simply failed.
    const v = verifyRow(row, page, http);
    const note = page == null && why ? `${v.note} (${why})` : v.note;
    results.push({ make: row.make, status: v.status, note, http, url: row.source_url, prev: row.prev_status || null });
    const mark = { confirmed: "ok  ", drifted: "DRIFT", unreachable: "....", blocked: "BLOCK", dead_link: "DEAD ", cites_document: "PAPER", bad_url: "BADURL", no_source: "NOSRC", unparsed: "?????", empty_row: "empty" }[v.status] || "?";
    console.log(`  ${mark}  ${row.make.padEnd(16)} ${v.status === "confirmed" ? "" : note}`);
    if (row.source_url) await sleep(PAUSE_MS);
  }

  const by = (s) => results.filter((r) => r.status === s);
  // Counted separately on purpose. Lumping them under one word hid that only
  // four of twenty were ours to fix.
  console.log(`\n  confirmed ${by("confirmed").length}  ·  drifted ${by("drifted").length}` +
    `  ·  blocked by the maker ${by("blocked").length}  ·  cites paper ${by("cites_document").length}` +
    `  ·  dead link ${by("dead_link").length}  ·  bad url ${by("bad_url").length}` +
    `  ·  unreachable ${by("unreachable").length}  ·  no source ${by("no_source").length}  ·  unparsed ${by("unparsed").length}`);
  const ours = by("cites_document").length + by("dead_link").length + by("bad_url").length + by("no_source").length;
  if (ours) console.log(`  ${ours} of those are OUR data to fix, not the manufacturer's site.`);

  console.log("\nrequests sent:");
  for (const l of requestLedger()) console.log(`  ${l.origin.padEnd(48)} ${l.requests} req, ${l.refusals} refusal(s)${l.circuitOpen ? " [circuit open]" : ""}`);

  if (DRY) { console.log("\n--dry-run: no writes."); return finish(results); }

  // One statement, so a partial write cannot leave half the catalogue claiming
  // it was verified in this run when it was not.
  const values = results.map((r) =>
    `(${q(r.make)}, ${q(r.status)}, ${q(r.note)}, ${r.http == null ? "null" : r.http})`).join(",\n    ");
  await runSql(`
    update public.manufacturer_warranties w set
      verify_status = v.status, verify_note = v.note,
      verify_http = v.http, last_verified_at = now()
    from (values
    ${values}
    ) as v(make, status, note, http)
    where w.make = v.make;`);
  console.log(`\nWrote verification status for ${results.length} make(s).`);
  finish(results);
}

function finish(results) {
  const drifted = results.filter((r) => r.status === "drifted");
  /* SPLITTING A STATUS MUST NOT WEAKEN THE THRESHOLD.
   *
   * This guard fires when too much of the catalogue went unread, because
   * "no drift" across pages nobody could read is not a green result. Until
   * 2026-09-15 there was ONE word for every way that happens, so the count was
   * automatically complete. Now there are five, and if this kept counting only
   * "unreachable" the guard would have gone quiet on the very day the problem
   * was better understood -- a threshold silently loosened by a refactor.
   *
   * So it counts every status that means THE FIGURE WAS NOT RE-READ, however
   * that came about, ours or theirs. [[no-single-point-of-failure]]
   */
  const NOT_READ = ["unreachable", "blocked", "dead_link", "bad_url", "cites_document", "no_source"];
  const unreachable = results.filter((r) => NOT_READ.includes(r.status));
  const noSource = results.filter((r) => r.status === "no_source");

  // A RED RUN IS THE REPORT. Nothing here emails anyone.
  //
  // WHICH DRIFT GOES RED, AND WHY NOT ALL OF IT.
  //
  // A first probe of six real manufacturer pages called three "drifted" -- and
  // "unlimited km" missed on Lexus AND Acura in the same run, which is not two
  // brands changing terms in the same week. Manufacturers publish coverage in
  // TABLES, and flattening a table puts the label, the years and the distance
  // far enough apart that a proximity match misses them. The readability gate in
  // warranty-verify.mjs removed the worst of it (Mitsubishi correctly became
  // "unreachable"), but a residual false-positive rate remains and is not yet
  // measured.
  //
  // Failing the build on an unmeasured false-positive rate does not make the
  // catalogue safer. It makes a red run mean nothing within a week, and a signal
  // nobody believes is worse than no signal.
  //
  // So the run goes red for drift that is UNAMBIGUOUS: a make we have confirmed
  // before and can no longer confirm. That is a real change, measured against our
  // own history rather than against my confidence in a regex. A make that has
  // NEVER been confirmed is a gap in the matcher, not a finding about the
  // manufacturer -- reported loudly every run, and fixed by improving the
  // matcher.
  //
  // This is NOT "warn instead of refuse". Nothing is published on a weak signal
  // either way, because this job never writes a coverage figure at all -- the
  // only question is which colour the run is.
  // [[repeat-fix-pattern]] [[claims-must-stay-backed]]
  const regressed = drifted.filter((d) => d.prev === "confirmed");
  const neverConfirmed = drifted.filter((d) => d.prev !== "confirmed");

  if (neverConfirmed.length) {
    console.warn(`\n${neverConfirmed.length} make(s) never yet confirmed (matcher gap, not a finding about the maker):`);
    for (const d of neverConfirmed) console.warn(`  ${d.make}: ${d.note}\n    ${d.url}`);
    console.warn("  Improve the matcher in scripts/lib/warranty-verify.mjs, or correct the row if the source really did change.");
  }
  if (regressed.length) {
    console.error(`\n${regressed.length} make(s) WERE confirmed and no longer are:`);
    for (const d of regressed) console.error(`  ${d.make}: ${d.note}\n    ${d.url}`);
    console.error("\nThese figures are published to buyers about specific cars. Re-read the source and update the row by migration; do not edit a coverage value without moving source_url to a page that states it.");
    process.exit(1);
  }
  // A catalogue we could not check is not a verified catalogue. Tolerate a few
  // client-rendered or flaky pages; refuse to call a run green when most of the
  // makes went unread, because "0 drifted" would then mean "0 examined".
  if (unreachable.length > results.length / 2) {
    console.error(`\n${unreachable.length} of ${results.length} figures were not re-read (blocked, dead, unfetchable or uncited). "No drift" here means "nothing was checked" — treating that as green is the defect this job exists to prevent.`);
    process.exit(1);
  }
  if (noSource.length) console.warn(`\n${noSource.length} row(s) cite no source_url: ${noSource.map((r) => r.make).join(", ")}`);
  // A dead citation is its own problem: the figure may be right, but the page we
  // said it came from is gone, so nobody can check it. Infiniti's stored URL was
  // already a 404 on the day this job was written. [[make-it-dispute-proof]]
  const dead = results.filter((r) => r.http === 404);
  if (dead.length) console.warn(`\n${dead.length} source_url(s) return 404 -- the citation is dead even where the figure is right: ${dead.map((r) => r.make).join(", ")}`);
  console.log("\nVerification complete.");
}

main().catch((e) => { console.error("Warranty verification failed:", e.message); process.exit(1); });
