#!/usr/bin/env node
// WHAT IS DEPLOYED, ASKED OF THE DEPLOYMENT ITSELF.
//
// WHY THIS EXISTS. deploy-edge-functions.yml ran
//
//     supabase functions deploy --project-ref debigtyjhjamipooajhk
//
// inside a retry loop, read the exit code, and reported success. Exit 0 says
// the CLI finished. It does not say which bundle the gateway is now serving,
// and nothing downstream ever asked -- so the workflow could go green over a
// deploy that shipped nothing new.
//
// That is not a theoretical gap on this function. Cached analyses are keyed on
// CACHE_VER: `analysis._cacheVer !== CACHE_VER` at the cache read is the ONLY
// thing that makes a stored analysis re-scan. Every fix in that constant's
// comment marked THE BUMP IS MANDATORY -- the inflated-sticker accusation, the
// powertrain confirmation, the PDF's over/under figure, the all-in refusal --
// reaches a real buyer only if the new string reaches the running function. If
// it does not, stored analyses replay, the report keeps printing the pre-fix
// claim, the report id does not change, and the deploy log says SUCCESS.
//
// A step that reports success without verifying it did the thing is
// "Green signal, no check", the first shape named at the top of
// docs/FIXING-HISTORY.md. This is the check.
// [[verify-in-production-before-done]] [[no-single-point-of-failure]]
//
// HOW IT ASKS. A GET to the function returns its own compiled-in CACHE_VER and
// nothing else -- the branch reads no body, consults no query string, calls no
// vendor and touches no database, so asking costs nothing at Scrapfly, Nimble
// or Anthropic. The Management API alternative (/v1/projects/{ref}/functions)
// was rejected: it reports an `updated_at` that advanced, which proves a write
// happened, not WHICH BUNDLE it wrote. `updated_at` moving is the same class of
// evidence as the CLI's exit code.
//
// THE READBACK MUST COME FROM analyze-listing-url ITSELF, never from a sibling
// health function. Functions deploy independently; a fresh key-health beside a
// stale analyze-listing-url is precisely the failure being guarded against, and
// asking the wrong function would report it as green.
//
// "COULD NOT CHECK" IS A FAILURE, NEVER A PASS. Missing credentials, an
// unreachable host, a non-200, a response with no cacheVer in it: every one
// exits non-zero. The whole point of this file is that an unverified deploy
// stops looking like a verified one, so there is no path through it that exits
// 0 without a matched value in hand. [[supervised-correctness-is-not-correctness]]
//
// Run: node scripts/verify-deployed-cache-ver.mjs [--attempts=N] [--delay-ms=N]
// Env: SUPABASE_URL              (required)
//      SUPABASE_ANON_KEY         preferred, or
//      SUPABASE_SERVICE_ROLE_KEY fallback -- the repo secret CI already holds
import { readFileSync } from "node:fs";

const SOURCE = "supabase/functions/analyze-listing-url/index.ts";
const FUNCTION = "analyze-listing-url";
const UA = "LotCheck-deploy-verify/1.0 (+https://lotcheck.ca)";
const TIMEOUT_MS = 20_000;

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const n = Number(hit.split("=")[1]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

// A cold isolate and the gateway's own propagation can lag the CLI by a few
// seconds, so a single immediate probe would flake. The retries only buy TIME;
// they cannot turn a mismatch into a pass -- the loop ends in failure unless a
// probe actually matched.
const ATTEMPTS = Math.max(1, arg("attempts", 6));
const DELAY_MS = arg("delay-ms", 8_000);

const fail = (headline, lines = []) => {
  console.error(`\n❌ deploy-verify: ${headline}\n`);
  for (const l of lines) console.error(`   ${l}`);
  console.error("");
  process.exit(1);
};

// ---- 1. what did we COMMIT? -----------------------------------------------
// Same anchor scripts/check-cache-ver.mjs reads, for the same reason it refuses
// rather than assumes: an unreadable key is not a matching one.
let committed = null;
try {
  const body = readFileSync(SOURCE, "utf8");
  committed = (body.match(/^const CACHE_VER = "([^"]+)"/m) || [])[1] || null;
} catch (e) {
  fail(`could not read ${SOURCE}`, [String(e?.message || e).slice(0, 160)]);
}
if (!committed) {
  fail(`could not parse CACHE_VER out of ${SOURCE}`, [
    "Expected a line of the form: const CACHE_VER = \"...\";",
    "Refusing to pass on an unreadable key rather than assume it shipped.",
  ]);
}

// ---- 2. can we ASK production? --------------------------------------------
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
// Least privilege first. The readback branch checks no role at all -- the key
// exists only to satisfy the gateway's JWT verification, which runs before the
// function does. The anon key is the smaller one and is already public; the
// service-role key is the fallback because it is the secret CI already holds.
const KEY = (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

if (!SUPABASE_URL || !KEY) {
  fail("the deploy is UNVERIFIED — production could not be asked.", [
    `SUPABASE_URL is ${SUPABASE_URL ? "set" : "NOT SET"};`,
    `a key (SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY) is ${KEY ? "set" : "NOT SET"}.`,
    "",
    "This exits non-zero on purpose. \"We could not check\" must never read the",
    "same as \"we checked and it was fine\" — a deploy step that goes green",
    "without asking is the exact shape this file was written to close.",
  ]);
}

const endpoint = `${SUPABASE_URL}/functions/v1/${FUNCTION}`;
console.log(`deploy-verify: committed CACHE_VER is "${committed}"`);
console.log(`deploy-verify: asking ${endpoint} what it is running…`);

/** One GET. Returns { ok, ver, detail }. Never throws. */
async function probe() {
  try {
    const res = await fetch(endpoint, {
      method: "GET",
      headers: { authorization: `Bearer ${KEY}`, apikey: KEY, "User-Agent": UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) return { ok: false, ver: null, detail: `HTTP ${res.status} ${text.slice(0, 160)}` };
    let body;
    try { body = JSON.parse(text); } catch { return { ok: false, ver: null, detail: `unparseable response: ${text.slice(0, 160)}` }; }
    // A bundle predating the readback branch has no GET handler, so it falls
    // through to the scan path, fails to parse an absent body and answers an
    // error. Either way there is no cacheVer here, and an absent field is a
    // FAILED verification, not a missing one. [[two-authors-per-fact]]
    const ver = typeof body?.cacheVer === "string" ? body.cacheVer : null;
    // This early return shapes the MESSAGE, not the verdict, and the mutation
    // suite says so: delete it and every no-version response still fails,
    // because a null can never equal the committed string. Recorded as an
    // equivalent mutant rather than left looking like coverage it does not
    // give -- the refusal below is what actually holds the line.
    if (!ver) return { ok: false, ver: null, detail: `no cacheVer in the response: ${text.slice(0, 160)}` };
    return { ok: true, ver, detail: "" };
  } catch (e) {
    return { ok: false, ver: null, detail: String(e?.name || e?.message || e).slice(0, 160) };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 3. read it back ------------------------------------------------------
let last = { ok: false, ver: null, detail: "no attempt was made" };
for (let i = 1; i <= ATTEMPTS; i++) {
  last = await probe();
  if (last.ok && last.ver === committed) {
    console.log(`\n✅ deploy-verify: the running function reports CACHE_VER "${last.ver}" — it matches what was committed.`);
    console.log(`   Attempt ${i} of ${ATTEMPTS}. The deployed bundle is the one in this commit.`);
    process.exit(0);
  }
  const saw = last.ok ? `reported "${last.ver}"` : last.detail;
  console.log(`  attempt ${i}/${ATTEMPTS}: ${saw}`);
  if (i < ATTEMPTS) await sleep(DELAY_MS);
}

// ---- 4. it did not match -- this is a FAILED deploy, not a warning ---------
if (last.ok && last.ver && last.ver !== committed) {
  fail(`the deployed function is running CACHE_VER "${last.ver}", not the committed "${committed}".`, [
    "The deploy reported success and shipped a different bundle.",
    "",
    "Every cached analysis is keyed on this string. While they disagree, stored",
    "analyses REPLAY instead of re-scanning: buyers keep seeing the pre-fix",
    "figures, the report id does not change, and it looks like the code is live.",
    "",
    "Re-run the deploy. Do not merge anything on top of it until this matches.",
  ]);
}

fail(`could not confirm what is deployed after ${ATTEMPTS} attempt(s).`, [
  `Last answer: ${last.detail}`,
  `Committed CACHE_VER: "${committed}"`,
  "",
  "A bundle that predates the readback branch has no GET handler and cannot",
  "answer this — which is itself the finding: what is running is older than",
  "this commit. Treated as a failure either way, because an unverified deploy",
  "must not be reported as a verified one.",
]);
