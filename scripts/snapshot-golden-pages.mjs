// GOLDEN PAGE SNAPSHOT — freeze the corpus once so correctness can be measured
// forever after, offline and for free.
//
// WHY THIS EXISTS. The accuracy instrument we already have (build-golden-set →
// benchmark-reports → grade-golden-set) can only run by hitting the deployed
// function, which fetches live dealer pages and spends vendor money per call.
// That makes a measurement run something you schedule, supervise and pay for —
// so it happens rarely. The last one was 2026-08-27. Meanwhile the standing
// finding from 09-13 is that every sample we have is SUPERVISED, and a
// supervised sample cannot estimate the real error rate.
//
// The fix is to separate the two things that got welded together: reading the
// dealer's page (a network act, rate-limited, robots-governed, occasional) and
// grading what our extractors make of it (pure computation, free, repeatable).
// This script does the first once and writes the bytes to disk. night-watch.mjs
// does the second as often as you like, touching no network at all.
//
// WHAT THIS DOES NOT CHANGE. It fetches exactly the pages build-golden-set.mjs
// already fetches, from the same six dealer hosts already in url-pool.json, the
// same way (one GET, identified User-Agent, robots checked first). It is not a
// crawl, it does not discover URLs, and it is not the gated inventory crawl —
// it re-reads a fixed, already-used list. Running it REPLACES live fetching in
// the measurement loop rather than adding to it.
//
// Every snapshot records sha256 + fetchedAt. A stored page is dated evidence:
// if a grade later says our extractor read a price wrong, the bytes that proved
// it are still on disk and the finding is reproducible, not an anecdote.
//
// STALENESS IS A FEATURE, NOT A BUG, as long as it is declared. Dealers change
// prices; a corpus from three weeks ago grades our EXTRACTORS against what the
// page said that day, which is exactly the question. It does not tell you
// today's price. night-watch prints the corpus age on every run so a stale
// corpus can never be mistaken for a live one.
//
// Run:  node scripts/snapshot-golden-pages.mjs [--limit N] [--delay MS] [--force]
//       --force re-fetches pages already snapshotted (default: skip them)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseRobots, isPathAllowed } from "./lib/robots.mjs";

const POOL = "scripts/fixtures/golden/url-pool.json";
const DIR = "scripts/fixtures/golden/pages";
const MANIFEST = `${DIR}/manifest.json`;

// check:jobs requires every third-party fetch in scripts/ to identify itself.
// Anonymous requests drew 406/429 and silently lost runs; a named agent with a
// contact URL is also the minimum courtesy owed to a site we are reading.
const UA_PRODUCT = "LotCheckGoldenSnapshot";
const UA = `Mozilla/5.0 (compatible; ${UA_PRODUCT}/1.0; +https://lotcheck.ca/about)`;

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? Number(process.argv[i + 1]) : d; };
const LIMIT = arg("--limit", 1000);
const DELAY = arg("--delay", 2000);
const FORCE = process.argv.includes("--force");

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyOf = (url) => sha256(url).slice(0, 20);

async function get(url, ms = 30_000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "en-CA" },
      signal: c.signal, redirect: "follow",
    });
    return { status: r.status, html: r.ok ? await r.text() : "" };
  } catch (e) {
    return { status: 0, html: "", err: String(e?.message || e) };
  } finally { clearTimeout(t); }
}

// Permission is DATA: read robots.txt now, for this run, and record what it
// said. A licence checked last month is not a licence today.
const robotsCache = new Map();
async function allowed(url) {
  const u = new URL(url);
  if (!robotsCache.has(u.origin)) {
    const r = await get(`${u.origin}/robots.txt`, 15_000);
    robotsCache.set(u.origin, {
      rules: r.status === 200 ? parseRobots(r.html, UA_PRODUCT) : null,
      status: r.status,
      readAt: new Date().toISOString(),
    });
    await sleep(DELAY);
  }
  const c = robotsCache.get(u.origin);
  // No robots.txt served is not permission denied; a robots.txt we could not
  // read at all is. status 0 means the request failed outright.
  if (c.status === 0) return { ok: false, why: "robots.txt unreachable" };
  if (!c.rules) return { ok: true, why: `no robots.txt (HTTP ${c.status})` };
  return isPathAllowed(c.rules, u.pathname + u.search)
    ? { ok: true, why: "robots allows" }
    : { ok: false, why: "robots disallows this path" };
}

mkdirSync(DIR, { recursive: true });

const urls = JSON.parse(readFileSync(POOL, "utf8").replace(/^﻿/, "")).slice(0, LIMIT);
const manifest = existsSync(MANIFEST)
  ? JSON.parse(readFileSync(MANIFEST, "utf8").replace(/^﻿/, ""))
  : { version: 1, pages: {} };

let fetched = 0, skipped = 0, blocked = 0, failed = 0;

for (const url of urls) {
  const k = keyOf(url);
  const file = `${DIR}/${k}.html`;
  if (!FORCE && manifest.pages[k] && existsSync(file)) { skipped++; continue; }

  const perm = await allowed(url);
  if (!perm.ok) {
    blocked++;
    manifest.pages[k] = { url, blocked: true, why: perm.why, checkedAt: new Date().toISOString() };
    process.stderr.write(`blocked  ${perm.why.padEnd(26)} ${url}\n`);
    await sleep(DELAY);
    continue;
  }

  const r = await get(url);
  if (r.status !== 200 || !r.html) {
    failed++;
    process.stderr.write(`failed   HTTP ${String(r.status).padEnd(21)} ${url}${r.err ? `  (${r.err})` : ""}\n`);
    await sleep(DELAY);
    continue;
  }

  writeFileSync(file, r.html);
  manifest.pages[k] = {
    url,
    host: new URL(url).hostname.replace(/^www\./, ""),
    file: `${k}.html`,
    bytes: Buffer.byteLength(r.html),
    sha256: sha256(r.html),
    fetchedAt: new Date().toISOString(),
    robots: perm.why,
  };
  fetched++;
  process.stdout.write(`ok       ${String(Buffer.byteLength(r.html)).padStart(8)} bytes  ${url}\n`);
  await sleep(DELAY);
}

manifest.meta = {
  version: 1,
  poolFile: POOL,
  snapshotAt: new Date().toISOString(),
  userAgent: UA,
  counts: { fetched, skipped, blocked, failed, total: urls.length },
};
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 1)}\n`);

const live = Object.values(manifest.pages).filter((p) => !p.blocked).length;
console.log(`\nsnapshot: ${fetched} fetched, ${skipped} already stored, ${blocked} robots-blocked, ${failed} failed.`);
console.log(`corpus now holds ${live} pages in ${DIR}/`);
console.log(`\nFrom here the measurement costs nothing and touches no network:`);
console.log(`  npm run night-watch`);
process.exit(failed && !live ? 1 : 0);
