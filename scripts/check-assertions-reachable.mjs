// GATE: a suite's assertions must actually run.
//
// A gate file that prints its summary and calls process.exit BEFORE some of its
// assertions reports green over code that never executed. It is the purest form
// of "a guard that cannot fail": every assertion below the exit is satisfied in
// every world, including the broken one, because none of them is evaluated.
//
// It happens for one mundane reason — appending a new case to the end of a file
// whose summary is already there — and it is invisible, because the suite still
// prints "N/N passed, all green". The count simply stops earlier than you think.
//
// 2026-09-22, four in one day. Three were caught before they shipped, by
// noticing the printed total had not moved. One shipped:
// test-quote-msrp-authority.mjs carried five assertions below its exit, and the
// PR that added them stated "24 -> 27" while the suite ran 24. The fix those
// assertions covered was correct; the proof of it was dead.
//
// Nothing about that is specific to one file, so this is mechanical now.
//
// Run: node scripts/check-assertions-reachable.mjs
import { readdirSync, readFileSync } from "node:fs";

const DIR = "scripts";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`ok    ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "\n       " + detail : ""}`); }
};

/**
 * The last TOP-LEVEL process.exit — column 0, or a one-line `if (...) exit`.
 * An exit nested inside a function or a conditional block is ordinary control
 * flow and says nothing about what runs afterwards.
 */
function lastTopLevelExit(lines) {
  let at = -1;
  lines.forEach((l, i) => {
    if (/^process\.exit\s*\(/.test(l)) at = i;
    else if (/^if\s*\([^)]*\)\s*process\.exit\s*\(/.test(l)) at = i;
  });
  return at;
}

/** Lines that would have asserted something, had they been reached. */
function assertionsAfter(lines, from) {
  return lines.slice(from + 1)
    .map((l, i) => ({ line: from + 2 + i, text: l }))
    .filter(({ text }) => /\b(check|assert|expect)\s*\(/.test(text) && !/^\s*(\/\/|\*)/.test(text));
}

const files = readdirSync(DIR).filter((f) => /^(test|check)-.*\.mjs$/.test(f));
check("there are gate files to check", files.length > 50, String(files.length));

const offenders = [];
for (const f of files) {
  const lines = readFileSync(`${DIR}/${f}`, "utf8").split(/\r?\n/);
  const exitAt = lastTopLevelExit(lines);
  if (exitAt < 0) continue;                 // no top-level exit: nothing to strand
  const dead = assertionsAfter(lines, exitAt);
  if (dead.length) {
    offenders.push(`${f}: ${dead.length} assertion(s) below the exit at line ${exitAt + 1}\n`
      + dead.slice(0, 3).map((d) => `         :${d.line}  ${d.text.trim().slice(0, 70)}`).join("\n"));
  }
}

check("no suite has assertions below its own exit", offenders.length === 0,
  offenders.join("\n       ") + "\n       Move the summary and process.exit to the END of the file.");

// ---- the detector must be able to fire ----------------------------------
// Proved on constructed sources, so a regex that stops matching cannot pass as
// "nothing to report".
{
  const stranded = [
    'let pass = 0;',
    'check("runs", true);',
    'console.log(`${pass} passed`);',
    'process.exit(fail ? 1 : 0);',
    '',
    'check("never runs", somethingBroken());',
  ];
  const at = lastTopLevelExit(stranded);
  check("the detector finds a stranded assertion", at === 3 && assertionsAfter(stranded, at).length === 1);

  const guarded = ['check("a", true);', 'if (fail) process.exit(1);', 'check("b", true);'];
  check("a one-line `if (fail) process.exit` still strands what follows",
    assertionsAfter(guarded, lastTopLevelExit(guarded)).length === 1,
    "this is the exact shape that shipped");

  const nested = [
    'function run() {',
    '  if (bad) process.exit(1);',
    '}',
    'check("still runs", true);',
  ];
  check("an exit INSIDE a function does not strand anything",
    lastTopLevelExit(nested) === -1,
    "ordinary control flow must not be reported");

  const clean = ['check("a", true);', 'check("b", true);', 'console.log("done");', 'process.exit(fail ? 1 : 0);'];
  check("a correctly-ordered suite is clean",
    assertionsAfter(clean, lastTopLevelExit(clean)).length === 0);

  const commented = ['process.exit(0);', '// check("documented, not run", true);'];
  check("a commented-out assertion is not counted",
    assertionsAfter(commented, lastTopLevelExit(commented)).length === 0,
    "the history above describes this shape in prose; a gate that cannot tell "
    + "description from code would fail on its own comments");

  const noExit = ['check("a", true);', 'console.log("done");'];
  check("a suite with no top-level exit is not flagged", lastTopLevelExit(noExit) === -1);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
