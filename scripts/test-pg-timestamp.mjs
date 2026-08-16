#!/usr/bin/env node
// ============================================================================
// The admin panel's 13 checkpoints all read "read failed", every rolling
// window, for as long as the panel had existed.
//
// The cause was one value. buildVerifIntervals gave the in-progress bucket
// JS's maximum Date as an open-ended sentinel. That end becomes p_until on
// fn_admin_verification_checks, and the maximum Date serialises to
// "+275760-09-13T00:00:00.000Z" — an extended year Postgres will not parse.
// It rejected the call outright, so the panel could report nothing but
// failure, and every layer above it looked equally guilty: the grants, the
// migration, the admin identity, the function signature. Days went into
// those before the window itself was suspected.
//
// The class is "a value that is a valid Date in JS but not a timestamp in
// Postgres reaches a query". Two locks, tested here:
//
//   1. pgTimestamp clamps anything out of range instead of emitting it.
//      A read window is the one thing where clamping is safe — too wide a
//      window still returns the right rows — so the panel degrades to
//      correct rather than to a dead read.
//   2. The sentinel literal is banned from the source outright, so the
//      habit cannot come back through a different builder.
//
// Runs offline against the real function, extracted from App.jsx rather than
// restated here — a test that restates the code proves only that the copy
// agrees with itself.
// ============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src", "App.jsx"), "utf8");

let pass = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${name}\n    ${err.message}`); }
}
function eq(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}\n    expected ${expected}\n    got      ${actual}`);
}

// --- extract the real pgTimestamp, brace-matched from its declaration -------
const start = src.indexOf("export function pgTimestamp(");
if (start === -1) {
  console.error("FAIL: pgTimestamp is gone from src/App.jsx.\n" +
    "It is the only thing standing between an out-of-range Date and a dead\n" +
    "admin panel. If it moved, point this test at its new home.");
  process.exit(1);
}
let depth = 0, end = start;
for (let i = src.indexOf("{", start); i < src.length; i++) {
  if (src[i] === "{") depth++;
  else if (src[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
}
const pgTimestamp = new Function(
  `${src.slice(start, end).replace("export function", "function")}; return pgTimestamp;`
)();

// --- 1. the exact value that broke it --------------------------------------
check("the maximum JS Date never reaches Postgres", () => {
  const raw = new Date(8640000000000000).toISOString();
  if (!raw.startsWith("+")) throw new Error("premise moved: max Date no longer serialises to an extended year");
  const got = pgTimestamp(8640000000000000);
  if (got.startsWith("+") || got.startsWith("-")) {
    throw new Error(`still emits an extended year Postgres cannot parse: ${got}`);
  }
  eq(got, "9999-12-31T00:00:00.000Z", "max Date should clamp to the last representable year");
});

check("the minimum JS Date never reaches Postgres", () => {
  const got = pgTimestamp(-8640000000000000);
  if (got.startsWith("+") || got.startsWith("-")) throw new Error(`extended year: ${got}`);
  eq(got, "1970-01-01T00:00:00.000Z", "min Date should clamp to the epoch");
});

// --- 2. every output is a timestamp Postgres will accept -------------------
check("no input of any shape produces an unparseable timestamp", () => {
  const inputs = [
    0, Date.UTC(2026, 7, 16), 8640000000000000, -8640000000000000,
    NaN, Infinity, -Infinity, undefined, null, "", "not a date",
    new Date(8640000000000000), new Date("nonsense"), new Date(2026, 0, 1),
    1e15, 1e18, Number.MAX_SAFE_INTEGER,
  ];
  // YYYY-MM-DDTHH:MM:SS.sssZ, four-digit year, no leading sign.
  const PG_SAFE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  for (const v of inputs) {
    const got = pgTimestamp(v);
    if (!PG_SAFE.test(got)) {
      throw new Error(`input ${String(v)} produced ${got}, which Postgres would reject`);
    }
  }
});

check("a normal date passes through untouched", () => {
  const d = new Date("2026-08-16T19:00:00.000Z");
  eq(pgTimestamp(d), "2026-08-16T19:00:00.000Z", "in-range Date must not be altered");
  eq(pgTimestamp(d.getTime()), "2026-08-16T19:00:00.000Z", "in-range epoch ms must not be altered");
});

// --- 3. the call site actually uses it -------------------------------------
check("the checkpoint read routes both bounds through pgTimestamp", () => {
  const call = src.match(/rpc\(\s*"fn_admin_verification_checks"[\s\S]{0,240}/);
  if (!call) throw new Error("fn_admin_verification_checks call site not found");
  for (const p of ["p_since", "p_until"]) {
    const line = call[0].match(new RegExp(`${p}\\s*:([^,\\n]+)`));
    if (!line) throw new Error(`${p} not found at the call site`);
    if (!line[1].includes("pgTimestamp")) {
      throw new Error(`${p} bypasses pgTimestamp: ${line[1].trim()}\n` +
        "    Raw .toISOString() is how this broke — an out-of-range Date kills the whole read.");
    }
  }
});

// --- 4. the sentinel cannot come back --------------------------------------
check("no open-ended Date sentinel anywhere in src/", () => {
  const lines = src.split(/\r?\n/);
  const hits = [];
  lines.forEach((line, i) => {
    // 8.64e15 ms is the JS Date limit in either direction. Skip this file's
    // own guard and any line that is only describing the problem in prose.
    if (/864000000000000\d/.test(line) && !/^\s*(\/\/|\*)/.test(line)) {
      hits.push(`src/App.jsx:${i + 1}  ${line.trim()}`);
    }
  });
  if (hits.length) {
    throw new Error(
      "the maximum-Date sentinel is back:\n      " + hits.join("\n      ") +
      "\n    An unbounded end is not free — it becomes a query parameter and " +
      "Postgres\n    rejects it. Use a real date one period past the start."
    );
  }
});

check("the in-progress bucket gets a real end", () => {
  const fn = src.match(/function buildVerifIntervals\([\s\S]*?\n}/);
  if (!fn) throw new Error("buildVerifIntervals not found");
  if (!/end:\s*i\+1<edges\.length\s*\?\s*edges\[i\+1\]\s*:\s*tail/.test(fn[0])) {
    throw new Error("the last interval's end is no longer the computed tail — " +
      "check it is a real date and never behind the clock");
  }
});

// ---------------------------------------------------------------------------
if (failures.length) {
  console.error(`\npg-timestamp: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.error(`  FAIL  ${f}\n`);
  process.exit(1);
}
console.log(`pg-timestamp: ${pass}/${pass} passed — no Date can reach Postgres unparseable`);
