#!/usr/bin/env node
// ONE KEY, TWO STORES -- keep them in sync, and prove it.
//
// SCRAPFLY_API_KEY lives in two independent places and only one of them has
// ever had a way to set it:
//
//   GitHub repo secret   -> discover-feeds, probe-one-url, published-msrp
//   Supabase function    -> _shared/scrapfly.ts and render-page/index.ts,
//     secret                which is the one a REAL BUYER'S SCAN depends on
//
// `npm run key:scrapfly` stores the first and prints "Stored and verified". A
// person who runs it has every reason to believe the key is fixed. The half
// that renders pages for buyers is untouched, and nothing tells them.
//
// WHY THAT IS THE EXPENSIVE HALF. The anti-bot render is the fallback for the
// ~28% of Alberta dealer hosts that refuse our datacenter IP -- measured
// 2026-08-31, 155 of 179 refusing hosts become readable through it. With a dead
// key, scrapflyRender() returns null and every one of those hosts degrades to
// "we could not read this page", which is indistinguishable from a page that
// genuinely had nothing on it.
//
// AND scrapflyEnabled() CANNOT SEE IT. It returns !!SCRAPFLY_API_KEY -- whether
// the key EXISTS, never whether it WORKS. A rejected key is "enabled". That is
// a green signal with no check behind it, on the single path that decides
// whether a quarter of the province is readable. [[no-single-point-of-failure]]
//
// TWO MODES:
//   --check   verify both stores and report. Writes nothing. Exit 1 if either
//             is broken, so a scheduled run is a RED signal rather than a log
//             nobody reads.
//   (default) verify the key, copy it into the Supabase function secret, then
//             prove end-to-end that production can actually render with it.
//
// A key is NEVER propagated before it is verified. Copying a dead key into the
// second store would turn one broken surface into two.
//
// Run: node scripts/sync-scrapfly-key.mjs [--check]

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_REF = "debigtyjhjamipooajhk";
const CHECK_ONLY = process.argv.includes("--check");
// A manufacturer host render-page already allows. It is the ONLY way to ask
// production "does your key work" without a dealer request or a buyer's credit.
const PROBE_URL = "https://www.toyota.ca/";
const UA = "LotCheck/1.0 (Scrapfly key verification; +https://lotcheck.ca)";

const KEY = (process.env.SCRAPFLY_API_KEY || "").trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const ACCESS_TOKEN = (process.env.SUPABASE_ACCESS_TOKEN || "").trim();

const fail = (msg) => { console.error("\n" + msg); process.exit(1); };
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });

// --- 1. is the key we hold actually good? -----------------------------------
async function verifyKey(key) {
  const u = new URL("https://api.scrapfly.io/scrape");
  u.searchParams.set("key", key);
  u.searchParams.set("url", "https://example.com");
  const r = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30_000) });
  if (r.ok) return { ok: true };
  const body = (await r.text().catch(() => "")).slice(0, 200).replace(/\s+/g, " ");
  return { ok: false, status: r.status, body };
}

// --- 2. what does PRODUCTION think? -----------------------------------------
//
// render-page is service-role gated and host-allowlisted, and it reports the
// upstream status verbatim -- so its answer separates the three cases that
// matter, which is exactly what nothing else in the repo could do:
//   200                     the Supabase secret is present AND works
//   503                     no key configured in the function at all
//   502 scrapfly HTTP 401   a key is configured and Scrapfly rejects it
async function askProduction() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { state: "unknown", detail: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set" };
  }
  let last = { state: "unknown", detail: "no attempt completed" };
  // Supabase injects a changed secret on the next invocation, but propagation
  // is not instantaneous; a single probe would read as a failure.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(SUPABASE_URL + "/functions/v1/render-page", {
        method: "POST",
        headers: {
          authorization: "Bearer " + SERVICE_KEY,
          apikey: SERVICE_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: PROBE_URL }),
        signal: AbortSignal.timeout(120_000),
      });
      const text = await res.text().catch(() => "");
      let err = "";
      try { err = JSON.parse(text)?.error || ""; } catch { /* not json */ }
      if (res.ok) return { state: "working", detail: "render-page returned " + Math.round(text.length / 1024) + "KB of HTML" };
      if (res.status === 503) return { state: "absent", detail: err || "SCRAPFLY_API_KEY not configured" };
      if (/scrapfly HTTP 40[12]/.test(err)) return { state: "rejected", detail: err };
      last = { state: "unclear", detail: "HTTP " + res.status + " " + (err || text.slice(0, 120)) };
    } catch (e) {
      last = { state: "unclear", detail: String(e?.name || e?.message).slice(0, 80) };
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 5_000));
  }
  return last;
}

// --- 3. copy into the Supabase function secret ------------------------------
//
// --env-file, not NAME=value on the command line: arguments are visible to
// anything that can list processes, which is the same reason set-scrapfly-key
// writes to gh over stdin. The file is removed in a finally.
function pushToSupabase(key) {
  const dir = mkdtempSync(join(tmpdir(), "sfkey-"));
  const file = join(dir, ".env");
  try {
    writeFileSync(file, "SCRAPFLY_API_KEY=" + key + "\n", { mode: 0o600 });
    const r = sh("npx", ["--yes", "supabase", "secrets", "set", "--env-file", file, "--project-ref", PROJECT_REF],
      { env: { ...process.env, SUPABASE_ACCESS_TOKEN: ACCESS_TOKEN } });
    // Never surface the child's stdout wholesale -- it echoes the env file path
    // and, in some CLI versions, the parsed names.
    if (r.status !== 0) {
      return { ok: false, detail: (r.stderr || r.stdout || "").split("\n").slice(-4).join(" ").trim() };
    }
    return { ok: true };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- run --------------------------------------------------------------------
console.log("Scrapfly key: " + (CHECK_ONLY ? "CHECKING both stores" : "SYNCING into both stores") + "\n");

let ciState = "unknown", ciDetail = "";
if (!KEY) {
  ciState = "absent";
  ciDetail = "SCRAPFLY_API_KEY is not set in this environment";
} else {
  const v = await verifyKey(KEY);
  if (v.ok) {
    ciState = "working";
    ciDetail = "accepted by Scrapfly";
  } else {
    ciState = v.status === 401 || v.status === 402 ? "rejected" : "unclear";
    ciDetail = "HTTP " + v.status + (v.body ? " " + v.body : "");
  }
}
console.log("  GitHub repo secret (workflows)     " + ciState.toUpperCase().padEnd(9) + " " + ciDetail);

if (!CHECK_ONLY) {
  if (ciState !== "working") {
    fail("Refusing to propagate. The key in this environment is " + ciState + " (" + ciDetail + ").\n" +
      "Copying it into the Supabase function secret would break the buyer-facing\n" +
      "render as well. Fix the repo secret first:  npm run key:scrapfly");
  }
  if (!ACCESS_TOKEN) fail("SUPABASE_ACCESS_TOKEN is not set - cannot write the function secret.");
  process.stdout.write("  copying into the Supabase function secret... ");
  const p = pushToSupabase(KEY);
  console.log(p.ok ? "done." : "FAILED.");
  if (!p.ok) fail("supabase secrets set failed: " + p.detail);
}

const prod = await askProduction();
console.log("  Supabase function secret (buyers)  " + prod.state.toUpperCase().padEnd(9) + " " + prod.detail);

console.log("");
if (prod.state === "working" && ciState === "working") {
  console.log("Both stores hold a key Scrapfly accepts. The anti-bot render is live for");
  console.log("the ~28% of Alberta hosts that refuse a plain fetch.");
  process.exit(0);
}

// Exit 1 on anything less. A scheduled check that reports a dead key as a note
// in a log is the same as no check at all.
console.error("NOT HEALTHY.");
if (ciState !== "working") console.error("  - the workflows' key is " + ciState + ": fix with  npm run key:scrapfly");
if (prod.state === "absent") console.error("  - production has NO Scrapfly key: every walled dealer host is unreadable right now");
if (prod.state === "rejected") console.error("  - production's key is REJECTED by Scrapfly: every walled dealer host is unreadable right now");
if (prod.state === "unknown") console.error("  - production could not be asked: " + prod.detail);
if (prod.state === "unclear") console.error("  - production's answer was not conclusive: " + prod.detail);
process.exit(1);
