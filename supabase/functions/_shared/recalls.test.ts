// Recall regression harness. Run BEFORE any recall-code change (and any time you
// touch models.ts / recalls.ts). It exercises the EXACT code that ships —
// canonicalModel() and lookupRecalls() are imported, not copied — so a
// regression fails here instead of in a user's report. See make-recalls-fail-safe.
//
// Run (Node 24+, from repo root):
//   node --experimental-strip-types supabase/functions/_shared/recalls.test.ts
// Deno also works:
//   deno run --allow-net supabase/functions/_shared/recalls.test.ts
//
// Exit code 0 = all pass; 1 = a failure (wire into CI / a pre-push check).
// Network cases that can't reach TC are reported as SKIP, not FAIL, so a flaky
// connection never masks a real regression as green — and never fails the run.
import { canonicalModel } from "./models.ts";
import { lookupRecalls } from "./recalls.ts";
import { CANON_FIXTURES, LIVE_FIXTURES } from "./recalls.fixtures.ts";

function categorize(r: any): string {
  if (!r || r.checked === false) return "unreachable";
  if (r.count > 0) return "found";
  return r.confirmed === true ? "clean" : "unconfirmed";
}

let pass = 0, fail = 0, skip = 0;
const fails: string[] = [];

// ── Part A: canonicalModel normalization (pure, deterministic) ───────────────
console.log("\n── canonicalModel (base-model normalization) ──");
for (const f of CANON_FIXTURES) {
  const got = canonicalModel(f.make, f.model);
  const ok = got === f.expect;
  if (ok) { pass++; console.log(`  ✓ ${f.make} "${f.model}" -> ${JSON.stringify(got)}`); }
  else { fail++; const line = `${f.make} "${f.model}" -> ${JSON.stringify(got)}, expected ${JSON.stringify(f.expect)}`; fails.push(line); console.log(`  ✗ ${line}`); }
}

// ── Part B: lookupRecalls tri-state against live Transport Canada ────────────
console.log("\n── lookupRecalls (live Transport Canada VRDB) ──");
for (const f of LIVE_FIXTURES) {
  const baseModel = canonicalModel(f.make, f.model);   // mirrors resolveBaseModel's static path
  let r: any;
  try { r = await lookupRecalls(f.year, f.make, f.model, baseModel); }
  catch (e) { r = { checked: false }; }
  const cat = categorize(r);
  if (cat === "unreachable" && f.expect !== "unreachable") {
    skip++; console.log(`  ⊘ SKIP ${f.year} ${f.make} "${f.model}" — TC unreachable`);
    continue;
  }
  const ok = cat === f.expect;
  const detail = `count=${r.count ?? "-"} confirmed=${r.confirmed ?? "-"} queried=${JSON.stringify(r.queriedModel ?? null)}`;
  if (ok) { pass++; console.log(`  ✓ ${f.year} ${f.make} "${f.model}" -> ${cat} (${detail})`); }
  else { fail++; const line = `${f.year} ${f.make} "${f.model}" -> ${cat}, expected ${f.expect} (${detail})`; fails.push(line); console.log(`  ✗ ${line}`); }
}

console.log(`\n${fail === 0 ? "✅" : "❌"} recalls: ${pass} passed, ${fail} failed, ${skip} skipped`);
if (fail > 0) { console.log("\nFailures:"); for (const l of fails) console.log("  - " + l); }
// Deno exposes Deno.exit; Node exposes process.exit. Support both.
const code = fail > 0 ? 1 : 0;
// @ts-ignore - runtime-dependent globals
(globalThis.Deno?.exit ?? globalThis.process?.exit)?.(code);
