// _shared/recalls.ts calls itself "the SINGLE source of the recall lookup logic,
// imported by analyze-quote and analyze-listing-url". That sentence was false for
// as long as it had been written.
//
// It was imported by exactly one file: its own test. Both production functions
// carried their own local `lookupRecalls`, and search-recalls carried a third
// set of the primitives with a comment saying its logic was "lifted from
// analyze-quote". Four copies of TC_VRDB_BASE.
//
// THE COPIES HAD ALREADY DRIFTED, and only the unused one was correct:
//
//   _shared:  let confirmed = !!baseModel;
//             if (!confirmed) for (const cand of candidates)
//               if (await tcModelKnown(make, cand, year)) { confirmed = true; break; }
//
//   shipped:  const confirmed = !!baseModel || await tcModelKnown(make, baseModel || model, year);
//
// The shipped copies probed ONE name instead of walking the candidate ladder, so
// a renamed nameplate degraded to confirmed:false. The regression harness proved
// nothing about that, because it exercised the module nothing imported.
//
// This gate pins the property that makes the header sentence true: one
// declaration, and every consumer reaching it by import.
//
// Run: node scripts/test-recall-single-source.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const NL = String.fromCharCode(10);
const SHARED = "supabase/functions/_shared/recalls.ts";
const ROOT = "supabase/functions";
const PRIMITIVES = ["TC_VRDB_BASE", "TC_RECALLS_PAGE", "tcRecordToObj", "tcFetchJson",
                    "modelCandidates", "tcModelKnown", "lookupRecalls"];

let pass = 0, fail = 0;
const t = (name, cond, why) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}${NL}       ${why}`); }
};

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|js)$/.test(e.name) && !/\.test\.ts$|fixtures\.ts$/.test(e.name)) out.push(p.replace(/\\/g, "/"));
  }
  return out;
}
const files = walk(ROOT);
const src = Object.fromEntries(files.map((f) => [f, readFileSync(f, "utf8")]));

// Comments are stripped before any usage check. These files are heavily
// commented, INCLUDING comments that name the very symbols being looked for --
// search-recalls' own header says its logic was "lifted from analyze-quote's
// lookupRecalls()". Matching raw source made this gate demand an import for a
// function mentioned only in prose. Third time this trap has been hit here
// (test:live-dot, test:price-index), so it is worth stating plainly.
const stripComments = (text) => {
  let out = "";
  for (const line of text.split(NL)) {
    const t = line.trimStart();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
    const i = line.indexOf("//");
    out += (i >= 0 ? line.slice(0, i) : line) + NL;
  }
  let s2 = out, k;
  while ((k = s2.indexOf("/*")) !== -1) {
    const j = s2.indexOf("*/", k + 2);
    if (j === -1) break;
    s2 = s2.slice(0, k) + s2.slice(j + 2);
  }
  return s2;
};
const code = Object.fromEntries(files.map((f) => [f, stripComments(src[f])]));

// ---------------------------------------------------------------------------
// 1. ONE DECLARATION, AND IT IS IN _shared
// ---------------------------------------------------------------------------
for (const name of PRIMITIVES) {
  const decl = new RegExp("(^|" + NL + ")\\s*(export\\s+)?(async\\s+)?(function|const|let|var)\\s+" + name + "\\b");
  const owners = files.filter((f) => decl.test(code[f]));
  t(`${name} is declared exactly once`,
    owners.length === 1 && owners[0] === SHARED,
    `declared in ${owners.length} file(s): ${owners.join(", ") || "none"} — four copies of this logic drifted apart once already`);
}

// ---------------------------------------------------------------------------
// 2. EVERY CONSUMER REACHES IT BY IMPORT
// ---------------------------------------------------------------------------
for (const f of files) {
  if (f === SHARED) continue;
  const body = code[f];
  const used = PRIMITIVES.filter((n) => new RegExp("[^A-Za-z0-9_$.]" + n + "\\s*[(`]").test(body));
  if (!used.length) continue;
  const importLine = (body.match(/import\s*\{[^}]*\}\s*from\s*"\.\.\/_shared\/recalls\.ts"/) || [""])[0];
  const missing = used.filter((n) => !new RegExp("[^A-Za-z0-9_$]" + n + "[^A-Za-z0-9_$]").test(importLine));
  t(`${f.replace(ROOT + "/", "")} imports what it uses`,
    missing.length === 0,
    `uses ${used.join(", ")} but does not import ${missing.join(", ")} from ${SHARED}`);
}

// ---------------------------------------------------------------------------
// 3. THE SHARED MODULE IS ACTUALLY REACHED BY PRODUCTION
// ---------------------------------------------------------------------------
// The failure that hid the drift for so long was not the duplication itself —
// it was that the "single source" had no production consumer, so every test of
// it passed while none of it ran. A module imported only by its own test is
// indistinguishable from dead code.
{
  const importers = files.filter((f) => f !== SHARED && /from\s*"\.\.\/_shared\/recalls\.ts"/.test(code[f]));
  t("the shared module is imported by real functions, not only its test",
    importers.length >= 2,
    `imported by ${importers.length} production file(s): ${importers.join(", ") || "NONE"} — a 'single source' nothing imports is dead code that tests keep green`);
  t("both report paths import it",
    importers.some((f) => f.includes("analyze-quote")) && importers.some((f) => f.includes("analyze-listing-url")),
    "these are the two paths that put a recall claim in front of a buyer");
}

// ---------------------------------------------------------------------------
// 4. THE CLEAN BILL MUST BE BACKED BY THE REGISTRY, NOT BY OUR OWN CATALOGUE
// ---------------------------------------------------------------------------
// `confirmed` used to start as `!!baseModel`, justified in a comment as
// "baseModel (resolved canonically) proves" TC tracks the model. It proves
// nothing of the sort: in production baseModel comes from each caller's
// resolveBaseModel(), which matches rows in OUR OWN msrp_catalog, so it is
// evidence about what LotCheck knows, not about the registry.
//
// Measured against the live registry 2026-08-19: a 2026 Toyota 4Runner Hybrid
// resolved to base model "4Runner Hybrid", TC has no such nameplate, the year's
// list was empty — and the buyer was shown "No open recalls found", confirmed,
// for a name the registry never matched.
{
  // Comment-stripped, not raw: recalls.ts now EXPLAINS the old short-circuit in
  // its own comment, quoting the exact pattern this forbids. Matching raw source
  // would fail the file for documenting its own history.
  const shared = code[SHARED];
  t("confirmed is never short-circuited by our own base-model resolution",
    !/let\s+confirmed\s*=\s*!!\s*baseModel/.test(shared) &&
    !/const\s+confirmed\s*=\s*!!\s*baseModel/.test(shared),
    "a base model resolved from our own catalogue is not evidence about the registry — it produced a clean bill TC never backed");
  t("confirmed comes from probing the registry across the candidate ladder",
    /for\s*\(const cand of candidates\)\s*\{[\s\S]{0,160}tcModelKnown\(make, cand, year\)/.test(shared),
    "every candidate must be offered to TC; probing only one degrades a renamed nameplate to 'couldn't confirm'");
  // Checked in the RETURN, not merely declared. Asserting the identifier appears
  // somewhere passed even with confirmedBy dropped from the returned object --
  // the declaration alone satisfied it, and the caller got nothing.
  t("the confirmation records WHICH name the registry recognised",
    /return\s*\{[^}]*confirmed,\s*confirmedBy[^}]*\}/.test(shared),
    "a claim that names its authority can be checked; one that does not has to be trusted");
  t("an unconfirmed zero is still returned as unconfirmed",
    /count:\s*0,\s*items:\s*\[\],\s*confirmed/.test(shared),
    "the tri-state contract: count:0 with confirmed:false must reach the UI as 'couldn't confirm', never as an all-clear");
}

console.log(`${NL}${fail ? "❌" : "✅"} recall-single-source: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
