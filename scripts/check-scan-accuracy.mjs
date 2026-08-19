// SCAN ACCURACY GATE — three defects found 2026-08-13 while reviewing real
// scan output against the actual dealer pages before sending exhibits to
// outside counsel. Each is a report telling the buyer something the page
// in front of them contradicted.
//
// 1. MSRP "VERIFIED" for a floor, not an exact match. North Hill Mazda and
//    Taza Park Volkswagen both showed "MSRP (VERIFIED)" in the header while
//    the audit detail directly below said "no over/under call is made" —
//    because the header checked `priceVerified` (whether the ASKING price
//    was confirmed), not `msrpBasis === "exact"` (whether the MSRP itself is
//    an exact-trim match vs. a base "starting at" floor). Two different
//    questions, answered with one variable.
//
// 2. A real "Contact Us For Price" gate went undetected. Fish Creek Nissan's
//    Rock Creek listing price-gates in plain sight (screenshot confirmed),
//    but the report said "no 'contact for price' call-to-action either" —
//    because the sealed capture's own screenshot came back incomplete (the
//    sidebar carrying the CTA never rendered), so vision never saw it. The
//    accusation-gate correctly refused to accuse on an incomplete read, but
//    that produced a false CLEAN reading instead of an honest "couldn't
//    verify." A plain-text ground-truth check against the raw rendered DOM
//    doesn't depend on the screenshot being complete.
//
// 3. Blank sealed-evidence screenshots on sites with a blocking cookie-
//    consent overlay. Taza Park Volkswagen's "Consent Management" dialog
//    sits in front of the page until a human clicks through it — a bot
//    render never does, so the capture photographed the overlay's backdrop
//    instead of the listing. The capture call itself reported success (real
//    bytes, no error): a green signal with nothing behind it.
//
// Run (from repo root):  npm run check:scan-accuracy
// Exit 0 = clean; 1 = a violation.
import { readFileSync } from "node:fs";

const failures = [];
function code(path) {
  const src = readFileSync(path, "utf8");
  // Mask whole-line comments so a doc comment describing the bug (like this
  // file's own header) can't be mistaken for the bug itself. Same technique
  // as check-report-parity.mjs / check-copy-compliance.mjs.
  return src.split("\n").map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? " ".repeat(l.length) : l)).join("\n");
}
function lineOf(src, index) { return src.slice(0, index).split("\n").length; }

const EMAIL_FILE = "supabase/functions/email-quote-report/index.ts";
const APP_FILE = "src/App.jsx";
const SCRAPFLY_FILE = "supabase/functions/_shared/scrapfly.ts";
const ANALYZE_FILE = "supabase/functions/analyze-listing-url/index.ts";

const emailSrc = code(EMAIL_FILE);
const appSrc = code(APP_FILE);
const scrapflySrc = code(SCRAPFLY_FILE);
const analyzeSrc = code(ANALYZE_FILE);

// ── Rule 1 (forbidden): priceVerified must never choose the MSRP label ───────
// `priceVerified` answers "was the asking price confirmed?" — a genuinely
// different question from "is this MSRP an exact-trim match?" (msrpBasis).
// Reusing it for the header/gauge label is exactly how a base-trim floor got
// stamped "VERIFIED".
{
  // Specific to the MSRP label/figure, not the (correct, unrelated) quote
  // STATUS line, which legitimately reads priceVerified ? TEAL : CORAL. The
  // MSRP-figure bug pairs with SOFT (grey, "not confirmed") on the else
  // branch, or gates the "MSRP (VERIFIED)"/"manufacturer suggested" text
  // directly — those pairings are what distinguish the two variables' jobs.
  const re = /priceVerified\s*\?\s*(?:"MSRP[^"]*"|TEAL\s*:\s*SOFT|"manufacturer suggested")/g;
  for (const m of [...emailSrc.matchAll(re)]) {
    failures.push(`${EMAIL_FILE}:${lineOf(emailSrc, m.index)}: priceVerified gates an MSRP label/colour — use msrpExact (msrpBasis === "exact") instead. priceVerified is about the ASKING price, not the MSRP basis.`);
  }
  const reApp = /priceVerified\s*\?\s*"(?:MSRP|#fff)"/g;
  for (const m of [...appSrc.matchAll(reApp)]) {
    failures.push(`${APP_FILE}:${lineOf(appSrc, m.index)}: priceVerified gates an MSRP label/colour — use msrpExact instead.`);
  }
}
// ── Rule 1b (required): the correct check must actually be present ──────────
if (!/msrpExact\s*=\s*ms\s*>\s*0\s*&&\s*a\.msrpBasis\s*===\s*"exact"/.test(emailSrc)) {
  failures.push(`${EMAIL_FILE}: msrpExact (ms > 0 && a.msrpBasis === "exact") is missing — the PDF's MSRP "VERIFIED" label has nothing correct to fall back on.`);
}
if (!/msrpExact\s*=\s*isExactMsrp\(a\)/.test(appSrc)) {
  failures.push(`${APP_FILE}: msrpExact = isExactMsrp(a) is missing — the on-screen MSRP label has nothing correct to fall back on.`);
}

// ── Rule 2 (required): ground-truth CTA check must exist and be consumed ────
// A screenshot can be incomplete without erroring. Only a check against the
// raw rendered DOM text is independent of whether the capture succeeded.
if (!/PRICE_GATE_CTA_RE\s*=\s*\/contact/.test(scrapflySrc)) {
  failures.push(`${SCRAPFLY_FILE}: PRICE_GATE_CTA_RE is missing — nothing catches a price-gate CTA the vision pass missed on an incomplete capture.`);
}
if (!/renderGateCtaDetected\s*=\s*!!\(rendered\.html/.test(scrapflySrc)) {
  failures.push(`${SCRAPFLY_FILE}: rescueListingViaScrapfly must compute renderGateCtaDetected against the raw rendered HTML, not just trust the vision pass.`);
}
{
  const consumers = [...analyzeSrc.matchAll(/renderGateCtaDetected\s*===\s*true/g)];
  if (consumers.length < 4) {
    failures.push(`${ANALYZE_FILE}: found ${consumers.length} call site(s) consuming renderGateCtaDetected, expected at least 4 (main rescue path, JSON-LD fallback, Convertus fallback, render-only last-resort path). A rescue path that ignores the ground-truth signal can still ship a false "not_shown" or a generic failure over a confirmed price gate.`);
  }
}

// ── Rule 3 (required): both Scrapfly screenshot calls must strip overlays ───
// A blocking consent dialog makes a screenshot call succeed (real bytes, no
// error) while photographing the overlay instead of the page.
if (!/DISMISS_OVERLAYS_JS\s*=\s*`/.test(scrapflySrc)) {
  failures.push(`${SCRAPFLY_FILE}: DISMISS_OVERLAYS_JS is missing — nothing strips a blocking consent overlay before either screenshot call.`);
}
{
  const jsParamSites = [...scrapflySrc.matchAll(/searchParams\.set\("js",\s*DISMISS_OVERLAYS_JS_B64\)/g)];
  if (jsParamSites.length < 2) {
    failures.push(`${SCRAPFLY_FILE}: found ${jsParamSites.length} screenshot call(s) passing DISMISS_OVERLAYS_JS_B64, expected 2 (scrapflyRender's vision screenshot AND captureListingScreenshot's sealed evidence photo). Both are Scrapfly screenshot calls and both can capture a blocking overlay.`);
  }
}

if (failures.length) {
  console.error("SCAN ACCURACY GATE — FAILED\n");
  for (const f of failures) console.error("  ✗ " + f);
  console.error(`\n${failures.length} violation(s).`);
  process.exit(1);
}

console.log("SCAN ACCURACY GATE — clean (MSRP-basis label, ground-truth price-gate check, consent-overlay strip on both screenshot calls).");
