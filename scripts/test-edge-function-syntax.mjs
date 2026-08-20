// Regression harness for the edge-function syntax+scope gate
// (check-edge-function-syntax.mjs / lib/edge-syntax-check.mjs).
//
// The point of this file: prove the gate would ACTUALLY have caught the
// 2026-08-19 corruption, not just that it looks plausible. Cases 1-2 are
// byte-for-byte the two real corrupted shapes found in analyze-listing-url/
// index.ts and search-recalls/index.ts (git show 717b681:...). They land on
// DIFFERENT halves of the gate: the "a> {" shape (case 1) is caught by the
// PARSE check alone -- Babel's parser is stricter than Node's own `node
// --check`, which accepted this exact text live during the incident. The
// comment-glued "c// ..." shape (case 2) still parses fine under either
// parser and is caught only by the SCOPE check. Both real shapes are
// covered, by different halves of the same gate -- which is the point of
// having two checks rather than one. A gate whose own regression suite only
// tests clean input is not proven -- see live-check-finance-contingent.mjs's
// pattern of grading against real failure cases, applied here to synthetic
// reconstructions of the real ones.
//
// Pure and offline -- no filesystem walk, no network.
//
// Run: node scripts/test-edge-function-syntax.mjs
import { checkSource, DENO_GLOBALS } from "./lib/edge-syntax-check.mjs";

let pass = 0, fail = 0;
const fails = [];
function record(ok, label, detail = "") {
  if (ok) pass++;
  else { fail++; fails.push(`${label}${detail ? ` — ${detail}` : ""}`); }
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        ${detail}`}`);
}

// ---- clean code passes both checks --------------------------------------
{
  const src = `
    import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("KEY")!);
    export async function tcFetchJson(url: string, timeoutMs: number): Promise<{ ok: boolean }> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: controller.signal });
        return { ok: res.ok };
      } finally { clearTimeout(timer); }
    }
  `;
  const r = checkSource(src);
  record(r.parseError === null, "clean TS with Deno/fetch/AbortController parses with no scope errors",
    JSON.stringify(r));
  record(r.scopeErrors.length === 0, "clean TS produces zero scope errors", JSON.stringify(r.scopeErrors));
}

// ---- case 1: the exact analyze-listing-url/analyze-quote pattern --------
// Byte-for-byte the real corrupted block (git show 717b681:supabase/functions
// /analyze-listing-url/index.ts, around line 530) -- a function header
// replaced with "a> {", body left intact and orphaned, plus bare "c"/"c"/"f"
// tokens where whole declarations were deleted.
//
// Node's own `node --check` accepted this exact text with NO error (verified
// live against the real file during the incident) -- V8's parser evidently
// disambiguates the construct differently. Babel does not: `a > {}` parses
// as a complete comparison-expression statement, and the `const` that
// immediately follows with no separator is then a genuine syntax error, not
// a fresh statement ASI can paper over. That makes Babel's parser strictly
// MORE useful here than Node's for this exact corruption shape -- the PARSE
// half of this gate alone would have caught it, no scope analysis needed.
{
  const src = `
export const TC_RECALLS_PAGE = "https://tc.canada.ca/";
c
c

f

a> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return { ok: res.ok };
  } finally {
    clearTimeout(timer);
  }
}
`;
  const r = checkSource(src);
  record(r.parseError !== null,
    "the real 'a> {' corruption pattern is caught as a PARSE failure by Babel (Node's own --check missed this exact text live)",
    JSON.stringify(r));
}

// ---- case 2: the search-recalls glued-onto-comment variant --------------
// This is the case that proves the SCOPE check earns its place independent
// of the parse check above. Gluing the stray letter onto the front of a
// comment ("c// Two-word makes...") makes `c` a real, syntactically valid
// expression statement immediately followed by a `//` comment that eats the
// rest of the line -- there is nothing left for Babel's parser to object to.
// Only scope resolution catches it: `c` is referenced and never bound.
{
  const src = `
c// Two-word makes we want to keep together when splitting free text.
const TWO_WORD_MAKES = new Set(["land rover"]);
`;
  const r = checkSource(src);
  record(r.parseError === null, "comment-glued corruption ('c// ...') parses cleanly -- the parse check alone would miss it");
  record(r.scopeErrors.some((e) => e.name === "c"), "the scope check catches it independently: 'c' is referenced with no binding",
    JSON.stringify(r.scopeErrors));
}

// ---- case 3: an orphaned-but-callable duplicate is NOT what this gate is for --
// (documented limitation: a fully-formed duplicate declaration parses AND
// resolves fine on its own -- that class is test:recall-source's job, "declared
// exactly once", not this gate's. This case just confirms clean code with a
// real function header does not false-positive.)
{
  const src = `
async function tcFetchJson(url: string, timeoutMs: number) {
  const controller = new AbortController();
  return controller;
}
`;
  const r = checkSource(src);
  record(r.parseError === null && r.scopeErrors.length === 0,
    "a real, complete function declaration never false-positives", JSON.stringify(r));
}

// ---- genuinely unparseable file (the fca-stack.mjs class) ---------------
{
  const src = `const x = \`unterminated template literal\n  and a newline that breaks it;`;
  const r = checkSource(src);
  record(r.parseError !== null, "a genuinely malformed file is caught as a PARSE failure, not a scope failure",
    JSON.stringify(r));
}

// ---- false-positive guards: TS-only syntax must never flag --------------
{
  const src = `
    interface Foo { bar: string; }
    type Bar = { baz: number };
    function f(behave: (n: number) => "timeout" | { html?: string }): void {}
    import type { SomeType } from "./types.ts";
    const x: SomeType = null as any;
  `;
  const r = checkSource(src);
  record(r.parseError === null && r.scopeErrors.length === 0,
    "interfaces, type aliases, function-type parameter names, and type-only imports never false-positive",
    JSON.stringify(r));
}
{
  const src = `Deno.serve(async (req) => { const u = new URL(req.url); return new Response(u.toString()); });`;
  const r = checkSource(src);
  record(r.parseError === null && r.scopeErrors.length === 0,
    "Deno.serve / URL / Response resolve via DENO_GLOBALS with no scope errors", JSON.stringify(r));
}

// ---- DENO_GLOBALS sanity: the set itself is non-empty and has Deno ------
record(DENO_GLOBALS.has("Deno") && DENO_GLOBALS.size >= 10,
  "DENO_GLOBALS is a real, populated allowlist, not an empty/trivial one", String(DENO_GLOBALS.size));

if (fail) { console.error(`\n${fail} failure(s):\n` + fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
console.log(`\n✅ edge-function-syntax gate: ${pass} passed, 0 failed`);
