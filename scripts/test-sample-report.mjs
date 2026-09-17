// THE ADVERT MUST BE THE PRODUCT.
// Run: node --experimental-strip-types scripts/test-sample-report.mjs
//
// The Quote Check page shows a "Sample LotCheck Report". For most of 2026 that
// card was three hand-written dials, and one of them -- a 0-10 LEVERAGE gauge
// reading 8.2 -- outlived the surface it advertised by a week: PR #486 replaced
// the score with the dollars themselves, and the gauge survived in the ad
// because nothing tested the ad. That is [[run-every-gate-before-done]] seen
// from the other side: a DELETED surface passes every negative check written
// about it, so the last copy of it can sit in the shop window indefinitely.
//
// So this suite does not check that the sample looks nice. It checks that the
// sample is GENERATED -- that every word a visitor reads is composed by
// beforeYouSign(), from inputs in src/lib/sample-report.js, and that no figure
// is typed into the page by hand.

import { readFileSync } from "node:fs";
import { beforeYouSign } from "../supabase/functions/_shared/before-you-sign.ts";
import { SAMPLE_ANALYSIS } from "../src/lib/sample-report.js";

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `\n        ${detail}`}`);
  cond ? pass++ : fail++;
};

const DOLLAR = String.fromCharCode(36);
const src = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");

// ---------------------------------------------------------------- the block
const START = "THE SAMPLE IS GENERATED";
const i = src.indexOf(START);
check("the sample card is still on the page", i > 0, "marker comment not found in src/App.jsx");
const END = "Sample vehicle:";
const j = src.indexOf(END, i);
// The scan below reads RENDERED MARKUP, so it starts after the comment that
// explains the removal -- that comment quotes the old hand-written figures on
// purpose, and a history note is not an advertised number.
const bodyAt = src.indexOf("*/", i);
const block = i > 0 && j > 0 ? src.slice(bodyAt, src.indexOf("})()}", j)) : "";
check("...and the block could be read", block.length > 400, `read ${block.length} chars`);

// ------------------------------------------------- it calls the real builder
check("the sample is rendered by the report's own builder",
  block.includes("beforeYouSign(SAMPLE_ANALYSIS)"),
  "the card must call beforeYouSign(), not lay out findings of its own");

// --------------------------------------------- no figure is typed by hand
// Every dollar sign in the block must open a JSX expression or a template
// placeholder. A dollar followed by a DIGIT is a number somebody wrote into the
// advert, which is the whole defect this suite exists for.
const handWritten = [];
for (let k = 0; k < block.length; k++) {
  if (block[k] !== DOLLAR) continue;
  const next = block[k + 1] || "";
  if (next === "{") continue;                       // ${expr} or JSX {expr}
  if (/[0-9]/.test(next)) handWritten.push(block.slice(k, k + 24).split("\n")[0]);
}
check("no dollar figure is written into the advert by hand",
  handWritten.length === 0, JSON.stringify(handWritten));

// ------------------------------------------- the deleted surface stays deleted
check("no 0-10 leverage score anywhere in the app",
  !/of 10 · leverage/.test(src) && !/max=\{10\}/.test(src),
  "PR #486 replaced the abstract score with dollars; a gauge may not survive in the ad");
check("no invented 'typical' fee anywhere in the advert",
  !/TYP |typical \$/i.test(block),
  "the report compares a fee to the manufacturer's PUBLISHED maximum, never to a market average");

// ---------------------------------------------------- the card is worth showing
// An advert that renders empty is a broken advert, and the builder returns an
// empty card honestly whenever its inputs are thin. Pin the fixture so a
// half-filled sample fails the build rather than shipping.
const s = beforeYouSign(SAMPLE_ANALYSIS);
check("the sample produces a real finding", s.items.length >= 3, JSON.stringify(s.items.map((x) => x.label)));
check("...at least one of them worth raising", s.items.some((x) => x.tone === "raise"), s.line);
check("...with a dollar total", typeof s.total === "number" && s.total > 0, String(s.total));
check("...and questions to ask", s.questions.length >= 2, JSON.stringify(s.questions));
check("the headline counts what it found", /^\d+ thing/.test(s.line), s.line);

// ------------------------------------------------------- the fixture is safe
// A sample must not resolve to a real business or a real car.
// [[ai-defamation-entity-match-lesson]]
const fixture = JSON.stringify(SAMPLE_ANALYSIS);
check("the fixture is declared a sample", SAMPLE_ANALYSIS.sample === true, fixture.slice(0, 80));
check("the fixture names no dealer",
  !/dealerName|legalName|Motors|Ltd|Inc\b/i.test(fixture), fixture.slice(0, 200));
check("the fixture carries no VIN",
  !Object.keys(SAMPLE_ANALYSIS).some((k) => /^vin$/i.test(k)) && !/[A-HJ-NPR-Z0-9]{17}/.test(fixture),
  "a shape-valid VIN in an advert can resolve to somebody's real car");

// --------------------------------------------- the fee sample accuses nobody
// Showing a named brand's dealer breaking that brand's published cap would use
// a real marque to illustrate misconduct nobody committed.
// [[no-accusation-language]]
const df = SAMPLE_ANALYSIS.docFeeCheck || {};
check("the sample fee sits at the published cap, never above it",
  Number(df.docFee) <= Number(df.mfrCeiling), `${df.docFee} vs ${df.mfrCeiling}`);
check("...and the copy says so", /at the cap/i.test(s.items.map((x) => x.label).join(" ")), s.items.map((x) => x.label).join(" | "));

console.log(`\n${pass}/${pass + fail} passed${fail ? `  -- ${fail} FAILING` : "  all green"}`);
process.exit(fail ? 1 : 0);
