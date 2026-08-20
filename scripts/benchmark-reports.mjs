// LOTCHECK REPORT BENCHMARK — measured failure rate against the LIVE function.
//
// Runs N real dealer listing URLs through the deployed analyze-listing-url and
// counts what came back missing. Extends the 10-listing method recorded in
// memory (report-failure-baseline) so runs stay comparable.
//
// It measures COVERAGE, not correctness: a figure that is present but wrong is
// counted as present. Grading correctness needs an independent answer key (see
// live-check-finance-contingent.mjs for that pattern).
//
// Run: node scripts/benchmark-reports.mjs [--limit N] [--concurrency N] [--urls-file path] [--out path] [--resume]
//
// CRASH SAFETY: writes --out after every batch (partial:true until the last
// one), not only at the end. An 8-hour unattended run WILL get interrupted
// eventually (sleep, reboot, closed terminal) -- without incremental writes
// that loses both the vendor spend already made and every result. --resume
// reads a prior --out from the SAME --urls-file (checked by hash) and skips
// URLs it already has a result for, so an interruption costs at most one
// in-flight batch, never the whole run.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const FN = "https://debigtyjhjamipooajhk.supabase.co/functions/v1/analyze-listing-url";
const KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlYmlndHlqaGphbWlwb29hamhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NjQ4OTEsImV4cCI6MjA5ODQ0MDg5MX0.PujrRSJA_CWQKEtzGLtbAwk2Uq6VZAJDKEyS56exP9A";

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? Number(process.argv[i + 1]) : d; };
const strArg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(n);
const LIMIT = arg("--limit", 100);
const CONC = arg("--concurrency", 5);
const URLS_FILE = strArg("--urls-file", "scripts/tmp-benchmark-urls.json");
const OUT_FILE = strArg("--out", "scripts/tmp-benchmark-results.json");
const RESUME = flag("--resume");
const TIMEOUT = 180_000;

// url-pool.json (golden-set format) is a flat array same as tmp-benchmark-urls.json;
// strip a BOM either file might carry from a PowerShell redirect.
const urlsRaw = readFileSync(URLS_FILE, "utf8").replace(/^﻿/, "");
const urls = JSON.parse(urlsRaw).slice(0, LIMIT);
const poolHash = createHash("sha256").update(urlsRaw).digest("hex").slice(0, 16);

let priorResults = [];
if (RESUME && existsSync(OUT_FILE)) {
  try {
    const prior = JSON.parse(readFileSync(OUT_FILE, "utf8").replace(/^﻿/, ""));
    if (prior?.summary?.poolHash === poolHash) {
      priorResults = prior.results.map((r) => ({ url: r.url, status: r.status, secs: r.secs, body: { analysis: r.a } }));
      process.stderr.write(`--resume: found ${priorResults.length} prior results for this exact pool, skipping those URLs\n`);
    } else {
      process.stderr.write(`--resume: ${OUT_FILE} is from a different pool (hash mismatch) -- ignoring, starting fresh\n`);
    }
  } catch (e) {
    process.stderr.write(`--resume: couldn't read ${OUT_FILE} (${String(e.message).slice(0, 60)}) -- starting fresh\n`);
  }
}
const priorUrls = new Set(priorResults.map((r) => r.url));
const pending = urls.filter((u) => !priorUrls.has(u));

async function scan(url, attempt = 1) {
  const t0 = Date.now();
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), TIMEOUT);
  try {
    const r = await fetch(FN, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, apikey: KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      signal: c.signal,
    });
    const secs = (Date.now() - t0) / 1000;
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* non-JSON */ }
    // One retry on a 5xx: the 2026-08-11 run saw rainbowford 502 then succeed
    // unchanged, so a transient must not be booked as a coverage failure.
    if (r.status >= 500 && attempt === 1) return scan(url, 2);
    return { url, status: r.status, secs, body, retried: attempt > 1 };
  } catch (e) {
    if (attempt === 1) return scan(url, 2);
    return { url, status: 0, secs: (Date.now() - t0) / 1000, body: null, error: String(e.message).slice(0, 60) };
  } finally { clearTimeout(timer); }
}

// The live function's breaker allows 3 free checks per IP per day (and 25/day
// overall). Every request here comes from one IP, so the run goes in batches of
// 3 with the existing "Reset test limits" workflow in between -- the same
// dispatch used by hand during testing. This deliberately does NOT widen the
// production caps: the breaker is what stops a stranger spending Vic's money,
// and a benchmark is not a reason to leave it open.
//
// The reset also clears listing_analysis_cache, so every scan exercises live
// code rather than a cached answer -- which is what makes the number honest.
const BATCH = 3;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function resetLimits() {
  try {
    execFileSync("gh", ["workflow", "run", "Reset test limits"], { stdio: "pipe" });
    return true;
  } catch (e) {
    process.stderr.write(`  reset dispatch failed: ${String(e.message).slice(0, 80)}
`);
    return false;
  }
}

// ── tally (reused for every checkpoint write, not just the final one) ────────
const A = (r) => r.body?.analysis || r.body || {};

function tally(results, partial) {
  const ok = results.filter((r) => r.status === 200 && A(r) && (A(r).vin || A(r).quotedPrice || A(r).vehicle));
  const hardFail = results.filter((r) => !ok.includes(r));

  const count = (fn, set = ok) => set.filter(fn).length;
  const pct = (n, d = ok.length) => d ? `${((n / d) * 100).toFixed(0)}%` : "—";

  const used = ok.filter((r) => /used|certified/i.test(A(r).vehicleCondition || ""));
  const neu = ok.filter((r) => !/used|certified/i.test(A(r).vehicleCondition || ""));

  const rows = [
    ["Hard failure (no usable report)", hardFail.length, results.length],
    ["Price missing", count((r) => !A(r).quotedPrice), ok.length],
    ["VIN missing", count((r) => !A(r).vin), ok.length],
    ["MSRP missing", count((r) => !A(r).msrp), ok.length],
    ["MSRP unverified (dealer_stated)", count((r) => A(r).msrpBasis === "dealer_stated"), ok.length],
    ["MSRP exact (verified)", count((r) => A(r).msrpBasis === "exact"), ok.length],
    ["Dealer APR missing", count((r) => !(A(r).financeRates?.dealer?.apr || A(r).financing?.rate)), ok.length],
    ["Manufacturer APR missing", count((r) => !A(r).financeRates?.manufacturer?.apr), ok.length],
    ["AMVIC licence missing", count((r) => !A(r).dealerLicence?.status), ok.length],
    ["Days-on-lot missing", count((r) => !(Number(A(r).daysOnLot?.days) > 0)), ok.length],
    ["Recalls not checked", count((r) => !A(r).recalls?.checked), ok.length],
    ["— finance-contingent DETECTED (S37)", count((r) => A(r).financeContingent?.contingent), ok.length],
    ["— trade-in widget DETECTED (S36)", count((r) => A(r).tradeInWidget?.detected), ok.length],
  ];

  const lat = ok.map((r) => r.secs).sort((a, b) => a - b);
  const summary = {
    ranAt: new Date().toISOString(),
    poolHash,
    partial,
    attempted: results.length,
    ofPool: urls.length,
    usable: ok.length,
    hardFail: hardFail.length,
    newVsUsed: { new: neu.length, used: used.length },
    latency: lat.length ? { mean: +(lat.reduce((s, x) => s + x, 0) / lat.length).toFixed(1), median: +lat[Math.floor(lat.length / 2)].toFixed(1), max: +lat[lat.length - 1].toFixed(1) } : null,
    rows: rows.map(([label, n, d]) => ({ label, n, of: d, pct: pct(n, d) })),
    usedMsrpMissing: { n: used.filter((r) => !A(r).msrp).length, of: used.length },
    byHost: Object.fromEntries(Object.entries(results.reduce((m, r) => {
      const h = new URL(r.url).hostname.replace(/^www\./, "");
      (m[h] = m[h] || { n: 0, fail: 0 }).n++;
      if (hardFail.includes(r)) m[h].fail++;
      return m;
    }, {})).map(([h, v]) => [h, `${v.fail}/${v.n} failed`])),
    failures: hardFail.map((r) => ({ url: r.url, status: r.status, err: r.error || r.body?.error || null })),
  };
  return { ok, hardFail, summary };
}

function checkpoint(results, partial) {
  const { summary } = tally(results, partial);
  writeFileSync(OUT_FILE, JSON.stringify({ summary, results: results.map((r) => ({ url: r.url, status: r.status, secs: r.secs, a: A(r) })) }, null, 1));
  return summary;
}

const results = [...priorResults];
let done = priorResults.length;
if (pending.length === 0) {
  process.stderr.write(`nothing pending -- all ${urls.length} URLs already have a result in ${OUT_FILE}\n`);
} else {
  process.stderr.write(`${pending.length} pending of ${urls.length} in pool (${priorResults.length} already done)\n`);
}

for (let i = 0; i < pending.length; i += BATCH) {
  const batch = pending.slice(i, i + BATCH);
  resetLimits();
  await wait(18_000); // let the workflow land before the batch goes out

  const settled = await Promise.all(batch.map(scan));
  for (const res of settled) {
    results.push(res);
    done++;
    const a = res.body?.analysis || res.body || {};
    const tag = res.status === 200 ? "ok " : String(res.status);
    process.stderr.write(`[${String(done).padStart(3)}/${urls.length}] ${tag} ${String(res.secs.toFixed(0)).padStart(3)}s  ${(a.vehicle || res.body?.error || "—").toString().slice(0, 40)}
`);
  }
  // Checkpoint after EVERY batch: at most one in-flight batch (~$0.30-0.60) is
  // ever at risk from an interruption, never the whole run. Re-run with
  // --resume to pick up exactly where this left off.
  const cp = checkpoint(results, /* partial */ i + BATCH < pending.length);
  process.stderr.write(`  checkpoint written: ${done}/${urls.length} (${cp.usable} usable, ${cp.hardFail} hard-fail)\n`);
}

const { ok, hardFail, summary } = tally(results, false);
writeFileSync(OUT_FILE, JSON.stringify({ summary, results: results.map((r) => ({ url: r.url, status: r.status, secs: r.secs, a: A(r) })) }, null, 1));

console.log(`\nLOTCHECK REPORT BENCHMARK — ${summary.attempted} listings, ${Object.keys(summary.byHost).length} dealers\n`);
console.log(`usable reports: ${ok.length}/${results.length}   hard failures: ${hardFail.length}`);
console.log(`new: ${summary.newVsUsed.new}  used: ${summary.newVsUsed.used}`);
if (summary.latency) console.log(`latency: mean ${summary.latency.mean}s  median ${summary.latency.median}s  max ${summary.latency.max}s\n`);
for (const { label, n, of, pct: p } of summary.rows) console.log(`  ${label.padEnd(38)} ${String(n).padStart(3)}/${String(of).padEnd(4)} ${p}`);
console.log(`\n  USED vehicles missing MSRP: ${summary.usedMsrpMissing.n}/${summary.usedMsrpMissing.of}`);
console.log("\nby dealer:"); for (const [h, v] of Object.entries(summary.byHost)) console.log(`  ${h.padEnd(24)} ${v}`);
if (summary.failures.length) { console.log("\nfailures:"); for (const f of summary.failures.slice(0, 15)) console.log(`  ${f.status} ${f.err || ""} ${f.url.slice(0, 80)}`); }
console.log("\nfull results -> scripts/tmp-benchmark-results.json");
