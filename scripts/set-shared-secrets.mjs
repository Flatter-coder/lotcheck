#!/usr/bin/env node
// Install the three shared secrets that are missing, into BOTH stores at once.
//
// WHAT IS BROKEN RIGHT NOW, found by the 2026-08-31 key health check:
//
//   STATEMENT_SECRET        unset in BOTH stores. founder-statement rejects
//                           every call (`if (!STATEMENT_SECRET || ...)` -- it
//                           fails closed, correctly), so the monthly founder
//                           statement has not been able to run AT ALL.
//   INVOICE_INGEST_SECRET   unset. vendor-invoice-ingest rejects everything.
//                           Nothing calls it yet, so it is dormant rather than
//                           broken -- but it is armed the moment this runs.
//   RESEND_WEBHOOK_SECRET   unset, and this one fails OPEN: resend-webhook
//                           records the event with sig_verified=false and
//                           answers 200. Until the companion migration lands,
//                           an unsigned event still became a delivered_at in
//                           v_report_delivery_status.
//
// TWO KINDS OF SECRET, and only one can be generated here.
//
//   STATEMENT_SECRET and INVOICE_INGEST_SECRET are OURS. Both ends are systems
//   we configure, so any strong random value works as long as both ends get the
//   SAME one -- which is exactly why they are generated here and pushed to both
//   stores in one operation. Two humans pasting into two dashboards is how they
//   drift, and a drifted shared secret fails closed and looks like an outage.
//
//   RESEND_WEBHOOK_SECRET is RESEND'S. It must equal the `whsec_...` value from
//   their dashboard or signature verification cannot pass. It is prompted for,
//   with the input hidden.
//
// NOTHING IS PRINTED. No value is echoed, logged, or passed as a command-line
// argument -- argv is visible to anything that can list processes. `gh` gets
// each value on stdin, and the Supabase half is written by a workflow so the
// management token stays a repo secret rather than landing on a laptop.
//
// Run:  npm run key:shared

import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const REPO = "Flatter-coder/lotcheck";
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });

// 48 bytes of CSPRNG, base64url. Long enough that the constant-time compare in
// the edge functions is protecting something worth protecting.
const generate = () => randomBytes(48).toString("base64url");

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    const write = rl.output.write.bind(rl.output);
    rl.output.write = (chunk, ...rest) => (muted ? true : write(chunk, ...rest));
    rl.question(prompt, (a) => { rl.output.write = write; rl.close(); process.stdout.write("\n"); resolve(a); });
    muted = true;
  });
}

const auth = sh("gh", ["auth", "status"]);
if (auth.status !== 0) {
  console.error("gh is not authenticated. Run `gh auth login` first — nothing was generated or stored.");
  process.exit(1);
}

console.log("Installing the three missing shared secrets.\n");

// --- the two that are ours --------------------------------------------------
const toStore = [
  { name: "STATEMENT_SECRET", value: generate(), why: "founder-statement (monthly statement email)" },
  { name: "INVOICE_INGEST_SECRET", value: generate(), why: "vendor-invoice-ingest (dormant until a poster is wired)" },
];

// --- the one that is Resend's ------------------------------------------------
console.log("RESEND_WEBHOOK_SECRET is issued by Resend and cannot be generated here.");
console.log("Get it from https://resend.com/webhooks — the signing secret, starting `whsec_`.");
console.log("Press Enter on its own to skip; the other two still install.\n");
const pasted = String(await askHidden("Paste the Resend signing secret (hidden), or Enter to skip:\n> ") || "").trim();

if (pasted) {
  // Shape-check before storing. A pasted account id or API key would install
  // cleanly and then fail every signature silently -- which is the failure this
  // whole exercise exists to stop, so it is worth one regex.
  if (!/^whsec_[A-Za-z0-9+/=_-]{16,}$/.test(pasted)) {
    console.error("\nThat does not look like a Resend signing secret (expected `whsec_` followed by the key).");
    console.error("Nothing was stored. Take the value labelled 'Signing Secret' on the webhook's page.");
    process.exit(1);
  }
  toStore.push({ name: "RESEND_WEBHOOK_SECRET", value: pasted, why: "resend-webhook (delivery-event signatures)" });
} else {
  console.log("Skipped. Delivery events stay unverified, and — with the companion");
  console.log("migration — they will NOT count as deliveries until this is set.\n");
}

// --- store, over stdin, never argv ------------------------------------------
for (const s of toStore) {
  const r = sh("gh", ["secret", "set", s.name, "--repo", REPO], { input: s.value });
  if (r.status !== 0) {
    console.error(`\nStoring ${s.name} failed:\n${(r.stderr || "").trim()}`);
    console.error("Stop here — a partially applied set is worse than none, because the");
    console.error("two ends of a shared secret would disagree.");
    process.exit(1);
  }
  console.log(`  stored  ${s.name.padEnd(24)} ${s.why}`);
}

// --- and into Supabase, where the functions actually read them ---------------
//
// A repo secret alone fixes nothing here: every one of these is read by an EDGE
// FUNCTION. This is the same two-store split that left the Scrapfly key looking
// fixed while production stayed broken, so the propagation is not optional and
// not a separate thing to remember.
console.log("\nPropagating to the Supabase function secrets (where the functions read them)...");
const run = sh("gh", ["workflow", "run", "sync-shared-secrets.yml", "--repo", REPO, "--ref", "main"]);
if (run.status !== 0) {
  console.error(`  COULD NOT START IT: ${(run.stderr || "").trim().split("\n").pop()}`);
  console.error("  The repo secrets are set. THE FUNCTIONS STILL ARE NOT.");
  console.error("  Run this before considering it done:");
  console.error(`     gh workflow run sync-shared-secrets.yml --repo ${REPO} --ref main`);
  process.exit(1);
}
console.log("  started. Watch it with:  gh run watch --repo " + REPO);
console.log("\nThat run writes the Supabase secrets and then PROVES the statement");
console.log("endpoint accepts the new secret — using an unknown mode, so it");
console.log("authenticates and sends nothing. If the run is RED, it is not done.");
console.log("\nNo value was printed, logged, or passed as an argument.");
