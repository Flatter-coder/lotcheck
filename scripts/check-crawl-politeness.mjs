// EVERY OUTBOUND REQUEST GOES THROUGH THE RATE LIMITER.
//
// LotCheck reads other people's servers, identifies itself honestly in its
// User-Agent, and asks them to tolerate a standing pass. A caller that bypasses
// politeFetch() cannot be backed off, cannot be circuit-broken and is not
// counted in the run's ledger — so the one thing we promise, that we stop when
// told to, would be true of most of the code and quietly false of one function.
//
// Measured on run 34162561357 (2026-09-07), before the limiter existed: 2,403
// requests refused with HTTP 429, every one of them followed by another request.
//
// THE RULE:
//   * scripts/lib/polite-fetch.mjs holds exactly one fetch() — the real one.
//   * Every file that talks to a dealer's server calls politeFetch and never
//     fetch() directly. Add new ones to CALLERS.
//
// Run: node scripts/check-crawl-politeness.mjs
import { readFileSync, existsSync } from "node:fs";

const LIMITER = "scripts/lib/polite-fetch.mjs";
const CALLERS = [
  "scripts/crawl-alberta-inventory.mjs",
  "scripts/survey-dealer-permission.mjs",
];
const RAW = /(^|[^a-zA-Z.])fetch\s*\(/;
const strip = (l) => l.replace(/\/\/.*$/, "");

let bad = 0;

if (!existsSync(LIMITER)) {
  console.error(`❌ ${LIMITER} is missing — there is no single rate-limited path any more.`);
  process.exit(1);
}
const lib = readFileSync(LIMITER, "utf8").split(/\r?\n/);
if (!lib.some((l) => /export\s+async\s+function\s+politeFetch\s*\(/.test(l))) {
  console.error(`❌ ${LIMITER} no longer exports politeFetch().`);
  bad++;
}
const libRaw = lib.filter((l) => RAW.test(strip(l)) && !/politeFetch\s*\(/.test(strip(l)));
if (libRaw.length !== 1) {
  console.error(`❌ ${LIMITER} contains ${libRaw.length} raw fetch() calls; expected exactly 1.`);
  console.error(libRaw.length === 0
    ? "      The limiter has been hollowed out — it no longer makes the request it is limiting."
    : "      A second fetch() inside the limiter is a second path with different rules.");
  bad++;
}

for (const file of CALLERS) {
  if (!existsSync(file)) {
    console.error(`❌ ${file} is listed as a caller but does not exist — fix the list or the filename.`);
    bad++;
    continue;
  }
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  if (!lines.some((l) => /from\s+["'].*polite-fetch\.mjs["']/.test(l))) {
    console.error(`❌ ${file} does not import the rate limiter.`);
    bad++;
  }
  lines.forEach((line, i) => {
    const code = strip(line);
    if (!RAW.test(code) || /politeFetch\s*\(/.test(code)) return;
    bad++;
    console.error(`❌ ${file}:${i + 1}  raw fetch() — cannot be backed off, circuit-broken or counted`);
    console.error(`      ${line.trim().slice(0, 120)}`);
  });
}

if (bad) {
  console.error("");
  console.error("Fix: call politeFetch(url, { ua, ...init }). It honours Retry-After, backs off on");
  console.error("429/503, opens a circuit after a host exhausts its retries, and counts what we sent.");
  process.exitCode = 1;
} else {
  console.log(`✅ crawl politeness: ${CALLERS.length} caller(s) route every request through ${LIMITER}.`);
}
