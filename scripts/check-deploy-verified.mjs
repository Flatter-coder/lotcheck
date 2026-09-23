#!/usr/bin/env node
// THE DEPLOY MUST READ BACK WHAT IT SHIPPED, AND MUST FAIL WHEN IT DOES NOT MATCH.
//
// WHY THIS GATE EXISTS. deploy-edge-functions.yml deployed, read the CLI exit
// code, and reported success. Exit 0 says the CLI finished; it does not say
// which bundle the gateway serves. Cached analyses are keyed on CACHE_VER, so a
// deploy that silently shipped an older bundle left every stored analysis
// replaying the pre-fix claim behind a green check — "Green signal, no check",
// the first shape named at the top of docs/FIXING-HISTORY.md, sitting on the
// step that puts code in front of buyers.
//
// scripts/verify-deployed-cache-ver.mjs closes that. This gate keeps it closed.
// A verification step is easy to delete, easy to reorder above the deploy it is
// meant to check, and easiest of all to neuter with `|| true` on a red day —
// and every one of those leaves the workflow green, which is the state it was
// already wrong in.
//
// IT DOES NOT GREP FOR GOOD INTENTIONS. This repo has been burned by gates that
// a comment could satisfy (check-cache-ver: "a gate that a comment can satisfy
// is not guarding the thing it names") and by gates true by construction. So
// the behavioural half below RUNS the verifier against a stub and pins what it
// does: it must exit 0 on a match and non-zero on a mismatch, on an error, on a
// response with no version in it, and on missing credentials. Entirely offline
// — a loopback server, no vendor call, no spend. [[cost-exploit-guards]]
//
// Run: node scripts/check-deploy-verified.mjs
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const FUNC = "supabase/functions/analyze-listing-url/index.ts";
const WORKFLOW = ".github/workflows/deploy-edge-functions.yml";
const VERIFIER = "scripts/verify-deployed-cache-ver.mjs";

const problems = [];
const note = (what, why) => problems.push(`${what}\n      ${why}`);

// ---------------------------------------------------------------------------
// 1. the function can answer "which bundle are you?"
// ---------------------------------------------------------------------------
const fn = readFileSync(FUNC, "utf8");

const committed = (fn.match(/^const CACHE_VER = "([^"]+)"/m) || [])[1] || null;
if (!committed) {
  note(`${FUNC}`, "No parseable `const CACHE_VER = \"...\"` line. Both the deploy readback and check:cache-ver anchor on it.");
}

const getAt = fn.indexOf('req.method === "GET"');
if (getAt === -1) {
  note(`${FUNC}`, "No GET branch. The deploy has no way to ask the running function which bundle it is, so a silent stale deploy reads as success.");
} else {
  // Extract the branch by brace matching so the assertions below are about the
  // branch itself and not about whatever happens to sit near it in the file.
  const open = fn.indexOf("{", getAt);
  let depth = 0, end = -1;
  for (let i = open; i < fn.length; i++) {
    if (fn[i] === "{") depth++;
    else if (fn[i] === "}" && --depth === 0) { end = i; break; }
  }
  const branch = end === -1 ? "" : fn.slice(open, end + 1);

  if (!/\bcacheVer\b/.test(branch) || !/\bCACHE_VER\b/.test(branch)) {
    note(`${FUNC}`, "The GET branch does not return `cacheVer: CACHE_VER`. A readback that reports anything else proves nothing about the cache key.");
  }

  // IT MUST BE FREE. A readback that scrapes, reads the database or waits on
  // anything is a readback nobody will leave switched on — and one that can be
  // handed work is an unauthenticated cost surface. Purity is the property that
  // makes it safe to hit on every deploy.
  for (const [re, what] of [
    [/\bfetch\s*\(/, "calls fetch()"],
    [/\bawait\b/, "awaits something"],
    [/Deno\.env/, "reads an environment value"],
    [/\breq\.json\b|\breq\.text\b|searchParams/, "reads the request body or query string"],
  ]) {
    if (re.test(branch)) {
      note(`${FUNC}`, `The GET branch ${what}. It must return a constant and nothing else: no vendor spend, no database, and no way to hand it a URL.`);
    }
  }

  // ORDER IS THE WHOLE POINT. Below resolveCreditUser or the body read, the
  // branch stops being free and stops answering when the function is
  // misconfigured — which is exactly when you need to know what is live.
  // Measured from `Deno.serve(`, never from the top of the file: both of these
  // names appear earlier as DECLARATIONS, and comparing against a declaration
  // reports the branch as too late no matter where it is. The first version of
  // this gate did exactly that. [[repeat-fix-pattern]]
  const serveAt = fn.indexOf("Deno.serve(");
  for (const after of ["resolveCreditUser(", "await req.json()"]) {
    const at = serveAt === -1 ? -1 : fn.indexOf(after, serveAt);
    if (at !== -1 && at < getAt) {
      note(`${FUNC}`, `The GET branch sits AFTER \`${after}\`. It must return before it, or the readback inherits that path's cost and its failure modes.`);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. the workflow actually runs the verifier, after the deploy, un-neutered
// ---------------------------------------------------------------------------
const wf = readFileSync(WORKFLOW, "utf8");

// The `deploy:` job only — a verification step in some other job would not be
// checking this deploy.
const jobAt = wf.indexOf("\n  deploy:");
const nextJob = jobAt === -1 ? -1 : wf.slice(jobAt + 3).search(/\n {2}[a-z0-9_-]+:\n/);
const job = jobAt === -1 ? "" : wf.slice(jobAt, nextJob === -1 ? wf.length : jobAt + 3 + nextJob);

if (!job) {
  note(WORKFLOW, "No `deploy:` job found. This gate cannot confirm the deploy is verified.");
} else {
  const deployAt = job.indexOf("functions deploy");
  // `verify:deployed-cache-ver` (the npm alias the workflow calls) or the
  // script path itself -- either is the step doing the work.
  const verifyMatch = job.match(/verify[:-]deployed-cache-ver/);
  const verifyAt = verifyMatch ? verifyMatch.index : -1;

  if (verifyAt === -1) {
    note(WORKFLOW, `The deploy job never runs ${VERIFIER}. It would report success on the CLI's exit code alone, which is what a stale deploy also produces.`);
  } else if (deployAt !== -1 && verifyAt < deployAt) {
    note(WORKFLOW, "The verification runs BEFORE the deploy. It would confirm the version that was already live — a check run at the wrong moment answers a question nobody asked.");
  }

  if (/continue-on-error:\s*true/.test(job)) {
    note(WORKFLOW, "The deploy job has `continue-on-error: true`. A verification that cannot fail the run is a warning, and a warning on a deploy is a green light.");
  }
  // `|| true`, `|| echo ...`, `|| :` on the verifier's own line.
  const line = (job.match(/^.*verify[:-]deployed-cache-ver.*$/m) || [""])[0];
  if (/\|\|/.test(line)) {
    note(WORKFLOW, `The verification step swallows its own failure: \`${line.trim()}\`. It must fail the run, not report it.`);
  }
}

// ---------------------------------------------------------------------------
// 3. the verifier actually behaves that way — run it and see
// ---------------------------------------------------------------------------
// Static checks above prove the step is WIRED. These prove it WORKS. Offline:
// one loopback server, four runs, no network and no vendor call.
// spawn, never spawnSync: the stub below lives in THIS process, and a
// synchronous child blocks the event loop that has to answer its request.
// Written with spawnSync first, and every probe timed out.
const runVerifier = (env) => new Promise((resolve) => {
  const p = spawn(process.execPath, [VERIFIER, "--attempts=1", "--delay-ms=0"],
    { env: { ...process.env, ...env } });
  let stdout = "", stderr = "";
  p.stdout.on("data", (d) => { stdout += d; });
  p.stderr.on("data", (d) => { stderr += d; });
  p.on("close", (status) => resolve({ status, stdout, stderr }));
});

// 3a. no credentials -> MUST FAIL. "We could not check" must never read the
// same as "we checked and it was fine".
{
  const r = await runVerifier({ SUPABASE_URL: "", SUPABASE_ANON_KEY: "", SUPABASE_SERVICE_ROLE_KEY: "" });
  if (r.status === 0) {
    note(VERIFIER, "It exits 0 when SUPABASE_URL / the key are unset. An unasked deploy would pass as a verified one — the exact failure this whole change exists to close.");
  }
}

// 3b..3e against a stub that answers whatever this run tells it to.
let reply = { status: 200, body: "{}" };
const server = createServer((_req, res) => {
  res.writeHead(reply.status, { "Content-Type": "application/json" });
  res.end(reply.body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const against = (status, body) => {
  reply = { status, body };
  return runVerifier({ SUPABASE_URL: base, SUPABASE_ANON_KEY: "stub-key", SUPABASE_SERVICE_ROLE_KEY: "" });
};

const cases = [
  ["the deployed version MATCHES", 200, JSON.stringify({ cacheVer: committed }), 0],
  ["the deployed version is OLDER", 200, JSON.stringify({ cacheVer: "2000-01-01a" }), 1],
  ["the function answers with no cacheVer", 200, JSON.stringify({ error: "nope" }), 1],
  ["the function errors", 500, JSON.stringify({ error: "boom" }), 1],
  // ONLY A 200 COUNTS. This case exists because mutation-testing found the
  // cases above could not see the status check at all: delete it and a 500
  // still fails, because the error body carries no version to match. A 500
  // that ECHOES the right version is the one input that tells the two apart,
  // and an unhealthy function is not a verified deploy however it answers.
  ["the function errors while echoing a matching version", 500, JSON.stringify({ cacheVer: committed }), 1],
];
for (const [label, status, body, want] of cases) {
  const r = await against(status, body);
  const got = r.status === 0 ? 0 : 1;
  if (got !== want) {
    note(VERIFIER,
      `When ${label}, it exits ${r.status}; expected ${want === 0 ? "0 (pass)" : "non-zero (fail)"}.\n      ` +
      `${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" | ").slice(0, 220)}`);
  }
}
server.close();

// ---------------------------------------------------------------------------
if (problems.length) {
  console.error("\n❌ deploy-verified: the deploy can report success without checking what it shipped.\n");
  for (const p of problems) console.error(`  - ${p}\n`);
  console.error("A deploy step that reports success without verifying the bundle is");
  console.error("\"Green signal, no check\" — docs/FIXING-HISTORY.md names it first for a reason.\n");
  process.exit(1);
}

console.log(`✅ deploy-verified: ${FUNC} answers a GET with its own CACHE_VER ("${committed}") before spending anything,`);
console.log(`   ${WORKFLOW} reads it back after deploying and cannot swallow the result,`);
console.log(`   and ${VERIFIER} was exercised on ${cases.length + 1} outcomes: a match passes; a mismatch, a missing version, an error,
   an error echoing the right version, and absent credentials all fail.`);
