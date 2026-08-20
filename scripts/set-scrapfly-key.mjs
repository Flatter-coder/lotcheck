#!/usr/bin/env node
// Paste a Scrapfly API key. It is checked against Scrapfly BEFORE it is stored,
// and never printed, logged, or passed as a command-line argument.
//
// WHY THIS EXISTS. `gh secret set` will happily store anything. A wrong value
// looks identical to a right one until a workflow fails, and a workflow that
// probes 1,639 hosts takes 50 minutes to tell you. That happened twice: both
// times the key went in unchecked, both times the rescue pass burned a full run
// to report a flat 401. The check below costs one request and a second.
//
// The key is written to `gh` on STDIN rather than in argv, because arguments
// are visible to anything that can list processes. It is trimmed, because a
// secret pasted from a dashboard carries whatever whitespace came with it and a
// trailing newline produces a %0A-suffixed key that returns the same 401 as a
// wrong one.
//
// Run:  npm run key:scrapfly

import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";

const REPO = "Flatter-coder/lotcheck";
const SECRET = "SCRAPFLY_API_KEY";

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    const write = rl.output.write.bind(rl.output);
    rl.output.write = (chunk, ...rest) => (muted ? true : write(chunk, ...rest));
    rl.question(prompt, (answer) => { rl.output.write = write; rl.close(); process.stdout.write("\n"); resolve(answer); });
    muted = true;
  });
}

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });

// --- gh has to be usable before we ask for anything sensitive ---------------
const auth = sh("gh", ["auth", "status"]);
if (auth.status !== 0) {
  console.error("gh is not authenticated. Run `gh auth login` first — nothing was asked for or stored.");
  process.exit(1);
}

const raw = await askHidden(`Paste the Scrapfly API key (input hidden), then Enter:\n> `);
const key = String(raw || "").trim();
if (!key) { console.error("Nothing pasted. Nothing stored."); process.exit(1); }

// --- check it with Scrapfly BEFORE storing ----------------------------------
process.stdout.write("Checking the key with Scrapfly... ");
let code = 0, body = "";
try {
  const u = new URL("https://api.scrapfly.io/scrape");
  u.searchParams.set("key", key);
  u.searchParams.set("url", "https://example.com");
  const r = await fetch(u, { signal: AbortSignal.timeout(30_000) });
  code = r.status;
  if (!r.ok) body = (await r.text()).slice(0, 200).replace(/\s+/g, " ");
} catch (e) {
  console.error(`\nCould not reach Scrapfly (${e.name || e.message}). Nothing stored.`);
  process.exit(1);
}

if (code !== 200) {
  console.error(`REJECTED — HTTP ${code}`);
  if (body) console.error(`  Scrapfly says: ${body}`);
  console.error(`\nNothing was stored. The existing ${SECRET} secret is unchanged.`);
  console.error("Take the value from https://scrapfly.io/dashboard labelled API Key — not the");
  console.error("account id and not the project name.");
  process.exit(1);
}
console.log("valid.");

// --- store it: stdin, never argv --------------------------------------------
const set = sh("gh", ["secret", "set", SECRET, "--repo", REPO], { input: key });
if (set.status !== 0) {
  console.error(`Storing failed:\n${(set.stderr || "").trim()}`);
  process.exit(1);
}

const list = sh("gh", ["secret", "list", "--repo", REPO]);
const line = (list.stdout || "").split(/\r?\n/).find((l) => l.startsWith(SECRET));
console.log(`\nStored and verified against Scrapfly.`);
console.log(`  ${line ? line.trim() : SECRET + " (set)"}`);
console.log(`\nThe key was never printed and never passed as an argument.`);
