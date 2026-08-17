// Two ways a scheduled job can be silently incapable of doing its work.
// Both were live in this repo on 2026-08-17; both are cheap to check forever.
//
// 1. A WORKFLOW GITHUB NEVER SEES.
//    update-statcan-zev.yml sat in a DOTLESS `github/workflows/`. GitHub only
//    reads `.github/workflows/`, so the file was never a workflow at all — it
//    did not appear in `gh workflow list`, it had no runs, and it never failed,
//    because nothing ever ran it. It is scheduled daily; its data file showed
//    `last_checked_at: 2026-07-02`, so 46 consecutive days of a daily job passed
//    unnoticed. CLAUDE.md documented it as active the whole time. Nothing red
//    ever appears for this failure — that is what makes it worth a gate.
//
// 2. A REQUEST THE UPSTREAM REFUSES.
//    update-alberta-dealers.mjs posted to Overpass with no User-Agent. Node's
//    fetch sends nothing descriptive and the Overpass usage policy requires one,
//    so every mirror answered 406/429 in under a second — measured, not guessed.
//    Four "mirrors" and four retry rounds could never have helped: the request
//    shape was the bug. The job failed 4 of its last 5 weekly runs while the
//    upstream was perfectly healthy.
//
//    24 of the 30 fetching scripts already send a User-Agent. This makes that
//    existing convention the rule, so the next script to skip it fails here
//    rather than a month of Mondays later.
//
// Run: node scripts/check-scheduled-jobs.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const problems = [];

// ---- 1. every workflow file must live where GitHub looks -------------------
const LIVE_DIR = ".github/workflows";
function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    // node_modules and .git are noise; worktrees hold full copies of the repo
    // and would report every stale branch's files as if they were ours.
    if (e.isDirectory()) {
      if (["node_modules", ".git", "dist", ".claude"].includes(e.name)) continue;
      walk(p, out);
    } else if (/\.ya?ml$/.test(e.name)) out.push(p);
  }
  return out;
}
const yamls = walk(".");
for (const f of yamls) {
  const rel = relative(".", f).replace(/\\/g, "/");
  if (!/(^|\/)workflows\//.test(rel)) continue;          // not a workflow directory
  if (rel.startsWith(LIVE_DIR + "/")) continue;          // correct home
  problems.push(
    `${rel}\n      A workflow here is invisible to GitHub — it will never run, and it will ` +
    `never fail either.\n      Move it to ${LIVE_DIR}/.`);
}

// ---- 2. third-party fetches must identify themselves -----------------------
// Our own backend does not care, and flagging it would be noise. Anything else
// is somebody's public service that may refuse an anonymous client.
const OURS = /supabase\.co|supabase\.in|localhost|127\.0\.0\.1|\$\{|\bprocess\.env\b/;
const SCRIPTS = "scripts";
function scriptFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) scriptFiles(p, out);
    else if (/\.mjs$/.test(e.name)) out.push(p);
  }
  return out;
}
for (const f of scriptFiles(SCRIPTS)) {
  const src = readFileSync(f, "utf8");
  if (!/\bfetch\s*\(/.test(src)) continue;
  if (/[Uu]ser-[Aa]gent/.test(src)) continue;
  // Which third-party hosts does it name?
  const hosts = [...new Set((src.match(/https?:\/\/[a-z0-9.-]+/gi) || [])
    .filter((u) => !OURS.test(u)))];
  if (!hosts.length) continue;                            // only talks to us
  const rel = relative(".", f).replace(/\\/g, "/");
  problems.push(
    `${rel}\n      Fetches ${hosts.slice(0, 3).join(", ")}${hosts.length > 3 ? ", …" : ""} ` +
    `without a User-Agent.\n      Overpass answers 406 to anonymous clients; assume the next ` +
    `upstream will too. Add a descriptive header with a contact URL.`);
}

if (!problems.length) {
  console.log(`✅ scheduled-jobs: every workflow is in ${LIVE_DIR}/, and every third-party fetch identifies itself.`);
  process.exit(0);
}
console.error(`❌ scheduled-jobs: ${problems.length} job(s) cannot reliably do their work.\n`);
for (const p of problems) console.error(`  - ${p}\n`);
console.error(`A job that cannot run, or whose request is refused, produces no red signal.`);
console.error(`It just quietly stops being true.`);
process.exit(1);
