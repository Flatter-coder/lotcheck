// A PROMOTION THAT PROMOTES NOTHING MUST NOT REPORT SUCCESS.
//
// dealer_source.active gates the whole crawl: `active = true AND platform IN
// (...)` is the roster. A catalogue row arrives dormant (active defaults to
// false since 20260830) and is promoted only by a discovery run that confirms
// a working feed AND a current AMVIC licence.
//
// For a month it promoted nothing, and said it had. Two faults, compounding:
//
//   1. The seed objects never set `active`, so a host that cleared both gates
//      was written back dormant.
//   2. The upsert used `ignoreDuplicates: true` on conflict of `host` — and the
//      AMVIC catalogue build had already put EVERY Alberta host in the table.
//      So the write matched an existing row and did nothing, every time.
//
// The run then printed how many rows it SENT, which stayed constant and
// reassuring while the number promoted was zero. 32 active of 1,622 catalogued
// was a high-water mark, not a rate: the only thing that ever set active = true
// was a one-shot migration, and the only runtime write to that column sets it
// false. The roster could only shrink.
//
// THE RULES, in the discovery script:
//   * no `ignoreDuplicates` on a dealer_source upsert — it cannot promote
//   * every seeded row carries `active`
//   * the run reports the ACTIVE-COUNT DELTA, not the row count it sent
//
// Run: node scripts/check-promotion-path.mjs
import { readFileSync } from "node:fs";

const FILE = "scripts/discover-dealer-feeds.mjs";
const src = readFileSync(FILE, "utf8");
const lines = src.split(/\r?\n/);
const code = (l) => l.replace(/\/\/.*$/, "");

let bad = 0;

// 1. the write must be able to update
lines.forEach((l, i) => {
  if (!/ignoreDuplicates/.test(code(l))) return;
  bad++;
  console.error(`❌ ${FILE}:${i + 1}  ignoreDuplicates on a dealer_source write — it can never promote.`);
  console.error(`      ${l.trim().slice(0, 120)}`);
});

// 2. every seeded row must state active
const seedStart = lines.findIndex((l) => /^\s*let seed = \[/.test(l));
if (seedStart < 0) {
  console.error(`❌ ${FILE}  could not find the seed array — this gate cannot verify the promotion.`);
  bad++;
} else {
  let depth = 0, end = seedStart;
  for (let i = seedStart; i < lines.length; i++) {
    depth += (lines[i].match(/\[/g) || []).length - (lines[i].match(/\]/g) || []).length;
    if (depth <= 0 && i > seedStart) { end = i; break; }
  }
  const block = lines.slice(seedStart, end + 1);
  const mappers = block.filter((l) => /\.map\(\(r\)\s*=>\s*\(\{/.test(l));
  if (!mappers.length) { console.error(`❌ ${FILE}  no seed mappers found.`); bad++; }
  mappers.forEach((l) => {
    if (/\bactive\s*:/.test(l)) return;
    bad++;
    const plat = (l.match(/platform:\s*"([a-z_]+)"/) || [])[1] || "?";
    console.error(`❌ ${FILE}  seed mapper for platform "${plat}" does not set \`active\` — it writes back dormant.`);
  });
}

// 3. the run must report what it actually promoted
// Both halves: the function must EXIST and must be CALLED. Checking only the
// call passes on a rename that leaves the call site pointing at nothing.
const defined = /async\s+function\s+countActive\s*\(/.test(src);
const called = /await\s+countActive\s*\(/.test(src);
if (!defined || !called) {
  console.error(`❌ ${FILE}  no countActive() — the run cannot state the promotion it achieved,`);
  console.error("      only the rows it sent. Those were silently different for a month.");
  bad++;
}

if (bad) {
  console.error("");
  console.error("Fix: seed rows with active: true, upsert without ignoreDuplicates, and report");
  console.error("the active-count delta so a zero-promotion run says so out loud.");
  process.exitCode = 1;
} else {
  console.log("✅ promotion path: seeds are active, the write can update, and the delta is reported.");
}
