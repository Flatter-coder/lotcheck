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
import { pdfText, looksLikePdf } from "./lib/pdf-text.mjs";
import { verifyRowFields, rowSourceUrls, htmlToText, VERIFY_FIELDS } from "./lib/warranty-verify.mjs";

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


async function readPage(url) {
  try {
    const res = await politeFetch(url, { timeoutMs: 25_000 });
    if (!res.ok) return { page: null, http: res.status, why: `HTTP ${res.status}` };

    // A FIGURE PUBLISHED IN A DOCUMENT IS STILL PUBLISHED. Toyota's hybrid terms
    // are not on its warranty landing page at all -- that page shows only BEV
    // and Electric Vehicle tiles -- they are in the Owner's Manual Supplement
    // PDF. On 2026-09-21 that produced a DRIFT on figures that were correct, and
    // acting on it would have cut two years and 80,000 km off the hybrid battery
    // term in every Toyota hybrid report. Ford, Nissan and Subaru report "cites
    // a printed booklet" for the same reason: the booklet is online, we just
    // could not open one.
    const buf = Buffer.from(await res.arrayBuffer());
    if (looksLikePdf(res.headers.get("content-type"), buf)) {
      const pdf = pdfText(buf);
      // A PDF whose text is an image extracts to nothing. That is "could not be
      // read" -- never "the manufacturer no longer says this".
      if (pdf.length < 600) return { page: null, http: res.status, why: `PDF carried no extractable text (${pdf.length} chars) -- likely scanned images` };
      return { page: pdf, http: res.status, why: null };
    }
    const text = htmlToText(buf.toString("utf8"));
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
            roadside_assistance, hybrid_ev_coverage, source_url, field_sources,
            verify_status as prev_status
       from public.manufacturer_warranties order by make;`);
  const rows = Array.isArray(sel) ? sel : [];
  if (!rows.length) throw new Error("manufacturer_warranties returned no rows — refusing to report a verification of nothing.");
  console.log(`Warranty catalogue: ${rows.length} make(s) to verify.\n`);

  const results = [];
  for (const row of rows) {
    // A row may cite a different document per figure (field_sources). Each
    // DISTINCT url is fetched once, so a make with two sources costs two
    // requests and a make with one still costs one.
    const urls = rowSourceUrls(row);
    const fetched = {};
    let firstWhy = null, firstHttp = null;
    for (const u of urls) {
      const got = await readPage(u);
      fetched[u] = { page: got.page, http: got.http };
      if (firstHttp == null) firstHttp = got.http;
      if (!firstWhy && got.page == null && got.why) firstWhy = got.why;
      await sleep(PAUSE_MS);
    }
    // The HTTP code travels with each page, so a refusal (403) can be told apart
    // from a dead link (404) and from a network that simply failed.
    const v = verifyRowFields(row, fetched);
    const note = firstWhy && v.status !== "confirmed" ? `${v.note} (${firstWhy})` : v.note;
    // Figures, not rows. A partial row is partly read and partly not, and the
    // threshold in finish() has to see both halves.
    const live = VERIFY_FIELDS.filter((f) => v.fields[f] && v.fields[f].state !== "absent");
    const unread = live.filter((f) => v.fields[f].state === "unread");
    results.push({
      make: row.make, status: v.status, note, http: firstHttp,
      url: urls.join(" , ") || row.source_url, prev: row.prev_status || null,
      live: live.length, unread: unread.length,
    });
    const mark = { confirmed: "ok  ", partial: "PART ", drifted: "DRIFT", unreachable: "....", blocked: "BLOCK", dead_link: "DEAD ", cites_document: "PAPER", bad_url: "BADURL", no_source: "NOSRC", unparsed: "?????", empty_row: "empty" }[v.status] || "?";
    console.log(`  ${mark}  ${row.make.padEnd(16)} ${v.status === "confirmed" ? "" : note}`);
  }

  const by = (s) => results.filter((r) => r.status === s);
  // Counted separately on purpose. Lumping them under one word hid that only
  // four of twenty were ours to fix.
  console.log(`\n  confirmed ${by("confirmed").length}  ·  partly confirmed ${by("partial").length}  ·  drifted ${by("drifted").length}` +
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

  /* AND THE SAME TRAP A SECOND TIME, FOR THE SAME REASON.
   *
   * The comment above records that splitting one status into five nearly
   * loosened this threshold silently. field_sources splits it again, along a
   * different axis: a row is no longer read or unread, it can be BOTH. Lexus
   * verifies three figures against one page and its roadside figure against
   * another, and if that second page fails, counting ROWS scores the make as
   * fully read.
   *
   * So the count moves to FIGURES, which is what the message always claimed
   * to be counting and was not. Each row reports how many figures it holds
   * and how many went unread, and the threshold reads those. With one source
   * per row the two are identical, so nothing about the current catalogue
   * changes. [[no-single-point-of-failure]]
   */
  const figuresLive = results.reduce((n, r) => n + (r.live || 0), 0);
  const figuresUnread = results.reduce((n, r) => n + (r.unread || 0), 0);

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
  if (figuresUnread > figuresLive / 2) {
    console.error(`\n${figuresUnread} of ${figuresLive} figures were not re-read (blocked, dead, unfetchable or uncited). "No drift" here means "nothing was checked" — treating that as green is the defect this job exists to prevent.`);
    process.exit(1);
  }
  if (figuresUnread) {
    console.log(`\n${figuresLive - figuresUnread} of ${figuresLive} figures re-read against the document that states them.`);
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
