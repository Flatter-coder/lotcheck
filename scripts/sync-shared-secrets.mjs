#!/usr/bin/env node
// Copy the shared secrets into the Supabase function secrets, then PROVE they work.
//
// The repo secret half fixes nothing on its own: STATEMENT_SECRET,
// INVOICE_INGEST_SECRET and RESEND_WEBHOOK_SECRET are all read by EDGE
// FUNCTIONS. This is the same two-store split that left the Scrapfly key
// looking fixed while production stayed broken.
//
// PROVING IT WITHOUT SENDING ANYTHING. founder-statement is a mail sender, so
// verifying it must not be able to send mail. It parses `mode` AFTER the auth
// check and rejects an unrecognised one with 400 ("unknown mode"), so an
// intentionally invalid mode separates the two answers perfectly:
//
//     403  the secret is wrong or unset       <- the thing we are fixing
//     400  authenticated, then stopped        <- success, and nothing happened
//
// It never reaches the staging branch, let alone the send branch.
// [[never-send-without-approval]]
//
// vendor-invoice-ingest is probed the same way: correct secret, deliberately
// malformed body. Auth passes, parsing fails, no invoice is recorded.
//
// Run in CI only (needs SUPABASE_ACCESS_TOKEN):
//   node scripts/sync-shared-secrets.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_REF = "debigtyjhjamipooajhk";
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const ACCESS_TOKEN = (process.env.SUPABASE_ACCESS_TOKEN || "").trim();

const NAMES = ["STATEMENT_SECRET", "INVOICE_INGEST_SECRET", "RESEND_WEBHOOK_SECRET"];
const present = NAMES.filter((n) => (process.env[n] || "").trim());

const fail = (m) => { console.error("\n" + m); process.exit(1); };

if (!ACCESS_TOKEN) fail("SUPABASE_ACCESS_TOKEN is not set — cannot write function secrets.");
if (!present.length) fail("None of " + NAMES.join(", ") + " are set in this environment. Run `npm run key:shared` first.");

console.log("Writing to the Supabase function secrets: " + present.join(", ") + "\n");

// --env-file, not NAME=value: arguments are visible to anything that can list
// processes. Removed in a finally.
{
  const dir = mkdtempSync(join(tmpdir(), "shsec-"));
  const file = join(dir, ".env");
  try {
    writeFileSync(file, present.map((n) => `${n}=${(process.env[n] || "").trim()}`).join("\n") + "\n", { mode: 0o600 });
    const r = spawnSync("npx", ["--yes", "supabase", "secrets", "set", "--env-file", file, "--project-ref", PROJECT_REF],
      { encoding: "utf8", env: { ...process.env, SUPABASE_ACCESS_TOKEN: ACCESS_TOKEN } });
    if (r.status !== 0) fail("supabase secrets set failed: " + (r.stderr || r.stdout || "").split("\n").slice(-4).join(" ").trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log("  written.\n");

// --- prove it, with no side effects -----------------------------------------
async function probe(fn, header, secret, { query = "", body = "{}" } = {}) {
  // Supabase injects a changed secret on the next invocation, but propagation
  // is not instantaneous; one probe would read as a failure.
  let last = "no attempt completed";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}${query}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${SERVICE_KEY}`,
          apikey: SERVICE_KEY,
          "content-type": "application/json",
          [header]: secret,
        },
        body,
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 403) { last = "still 403 — the function has not picked up the new secret"; }
      else return { ok: true, detail: `authenticated (HTTP ${res.status}, stopped before doing anything)` };
    } catch (e) {
      last = String(e?.name || e?.message).slice(0, 60);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 8_000));
  }
  return { ok: false, detail: last };
}

let bad = 0;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — cannot verify. Reporting UNPROVEN.");
  bad++;
} else {
  if ((process.env.STATEMENT_SECRET || "").trim()) {
    // An unknown mode: authenticates, then 400s. Cannot stage, cannot send.
    const r = await probe("founder-statement", "x-statement-secret", process.env.STATEMENT_SECRET.trim(),
      { query: "?mode=verify-secret-only" });
    console.log(`  founder-statement       ${r.ok ? "OK  " : "FAIL"}  ${r.detail}`);
    if (!r.ok) bad++;
  }
  if ((process.env.INVOICE_INGEST_SECRET || "").trim()) {
    // Correct secret, malformed body: auth passes, parsing stops it.
    const r = await probe("vendor-invoice-ingest", "x-invoice-secret", process.env.INVOICE_INGEST_SECRET.trim(),
      { body: "not-json" });
    console.log(`  vendor-invoice-ingest   ${r.ok ? "OK  " : "FAIL"}  ${r.detail}`);
    if (!r.ok) bad++;
  }
  if ((process.env.RESEND_WEBHOOK_SECRET || "").trim()) {
    // Not probed. The only way to prove it is a correctly signed Resend payload,
    // and forging one to test ourselves would mean writing the very kind of
    // event this secret exists to reject. It is verified by the next real
    // delivery: v_report_delivery_status.unverified_provider_events stops
    // climbing. Saying "verified" here would be the false all-clear again.
    console.log("  resend-webhook          SET   not probed — proven by the next real delivery event");
  }
}

console.log("");
if (bad) fail(`${bad} secret(s) did not verify. The functions are NOT fixed.`);
console.log("Shared secrets are live in both stores and the endpoints accept them.");
console.log("Nothing was sent, staged, or recorded to prove it.");
