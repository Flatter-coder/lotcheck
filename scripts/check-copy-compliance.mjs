// COPY COMPLIANCE GATE — a deterministic check that legally-loaded claims can't
// reach lotcheck.ca by accident.
//
// WHY THIS EXISTS. Today the shipped copy is clean: there is no "not a broker"
// language anywhere, no "guarantee", and the scrape-word sweep held. But that is
// held by memory and discipline, not by anything that would notice it coming
// back. One paste re-introduces a claim we deliberately paused. This is the same
// move as _shared/invariants.ts, applied to words instead of data: fix the CLASS,
// then lock it so it can't silently regress.
//
// Every rule below carries the rule_key of the obligation it serves in the legal
// register (supabase/migrations/20260810_legal_register.sql), so a failure tells
// you WHICH legal position it threatens, not just that a regex matched.
//
// TWO RULE KINDS:
//   forbidden — must never appear in user-facing copy. Any hit fails the run.
//   guarded   — allowed today only because a specific condition holds. The
//               occurrence COUNT is pinned. Adding, removing or moving one fails
//               the run, forcing whoever changed it to re-confirm the condition
//               still holds rather than letting the claim quietly spread.
//
// This checks OUR words only. It cannot tell you whether a claim is lawful —
// that is counsel's job, and the register is where their answer lives.
//
// Run (from repo root):  npm run check:copy
// Exit 0 = clean; 1 = a violation. Wire into CI before it can help you.
import { readFileSync } from "node:fs";

// ── What actually ships ──────────────────────────────────────────────────────
// app.html is the Vite build input; public/ is served as-is; src/ is the React
// app. The root-level city-panel-*/msrp-v5-*/trust-*/map-* files are design
// scratch that Vercel never serves, so they are deliberately out of scope.
const SURFACES = [
  "app.html",
  "public/index.html",
  "public/privacy.html",
  "public/alberta.html",
  "public/dealer-portal.html",
  "public/live-price-index.html",
  "public/canada-map.html",
  "public/statcan-zev-map.html",
  "src/App.jsx",
  "src/DealOrrery.jsx",
  // SERVER-SIDE COPY IS STILL COPY. The counter-script the buyer reads ALOUD at
  // the dealership is generated in deal.ts, and this gate scanned only the
  // frontend -- which is how "(the FTC CARS Rule in the US; AMVIC/OMVIC in
  // Canada)" reached an Alberta buyer's script. Comments are stripped for
  // non-HTML files above, so explanatory prose here is out of scope.
  "supabase/functions/_shared/deal.ts",
  "supabase/functions/_shared/msrp-claim.ts",
  "supabase/functions/_shared/point-state.ts",
  "supabase/functions/_shared/settled-claims.ts",
  "supabase/functions/_shared/reference-financing.ts",
  // The emailed HTML body and the PDF deck are the artifacts the buyer
  // FORWARDS TO THE DEALER -- the most adversarially-read copy LotCheck
  // produces -- and this gate never scanned them. Every rule below (no
  // accusation language, no "scraping", jurisdiction correctness) applies at
  // least as hard here as on screen. Added 2026-08-22 after an audit found
  // tonight's new gated-price sentence landed in this file completely
  // ungated.
  "supabase/functions/email-quote-report/index.ts",
];

const RULES = [
  {
    id: "no-foreign-regulator-citations",
    ruleKey: "ab-amvic-all-in-advertising",
    kind: "forbidden",
    why: "LotCheck serves Alberta buyers. Citing a US statute at them -- the counter-script read 'under all-in pricing rules (the FTC CARS Rule in the US; AMVIC/OMVIC in Canada)' -- invites a salesperson to answer 'that's American' and discard an otherwise correct line. Name the ONE regulator with authority over THIS sale, resolved from the dealer's province, or name none.",
    patterns: [
      /FTC/,
      /CARS Rule/i,
      /Federal Trade Commission/i,
      /in the US/i,
      /Magnuson[- ]Moss/i,
    ],
  },
  {
    id: "no-self-declared-regulatory-status",
    ruleKey: "ab-amvic-business-registration",
    kind: "forbidden",
    why: "AMVIC has told us LotCheck may need to register. Until the licence class is confirmed, copy may not characterise our regulatory status in EITHER direction.",
    patterns: [
      /\b(is|are|'re|am)\s+not\s+an?\s+broker\b/i,
      /\bnot\s+an?\s+(licensed|registered)\s+(broker|dealer)\b/i,
      /\bisn'?t\s+an?\s+broker\b/i,
      /\bno\s+(licence|license)\s+(is\s+)?required\b/i,
      /\bLotCheck\s+is\s+(an?\s+)?(AMVIC[- ])?(licensed|registered|regulated)\b/i,
      /\bAMVIC[- ](licensed|registered)\s+(advisory|advisor|adviser|service|platform|buyer)/i,
    ],
  },
  {
    id: "no-scraping-vocabulary",
    ruleKey: "ca-website-terms-automated-access",
    kind: "forbidden",
    why: "User-facing copy says we read dealers' own advertised prices from their public listings. The scrape vocabulary frames the same act as something else and is a gift to the other side.",
    patterns: [/\bscrap(e|es|ed|ing)\b/i],
  },
  {
    id: "no-absolute-accuracy-claims",
    ruleKey: "ca-no-misleading-representations",
    kind: "forbidden",
    why: "The Competition Act's general-impression test means an absolute promise fails even when each figure is individually right.",
    patterns: [
      // A NEGATED guarantee is the opposite of a promise, and quoting a dealer's
      // own hedge back at them is one of the strongest moves the counter-script
      // has: `Your fine print says the price "can't be guaranteed" — so confirm
      // it in writing`. Pointing this gate at server copy flagged that line, and
      // suppressing the quote to satisfy a regex would have removed evidence,
      // not a claim. The rule targets OUR promises, so exclude the negations.
      /(?<!\b(?:can'?t|cannot|not|never|no|isn'?t|aren'?t|won'?t)\s(?:be\s)?)\bguarantee(d|s)?\b/i,
      /\b100%\s+(accurate|correct|reliable)\b/i,
      /\balways\s+(saves?|beats?|wins?)\b/i,
      /\bnever\s+wrong\b/i,
    ],
  },
  {
    // Currently TRUE: flywheel capture ships disabled, so nothing is stored.
    // The moment admin_config.flywheel_capture_enabled flips to true, these
    // phrases become false statements to consumers. Pinning the count means the
    // flip cannot happen without this gate demanding the copy be revisited.
    id: "storage-promise-is-condition-bound",
    ruleKey: "ca-pipeda-deidentification",
    kind: "guarded",
    condition: "true only while admin_config.flywheel_capture_enabled = false",
    why: "'Analyzed once, never stored' must stay literally true of the running system, not aspirationally true.",
    patterns: [/\b(never|nothing|not)\s+stored\b/i],
    // App.jsx: report end-card ("Analyzed once, never stored"), the /verify badge
    // ("Tamper-proof · nothing stored"), the /verify camera-first callout
    // ("No app, nothing stored"), and the /value entry page footnote ("Real
    // listings · nothing stored · signed & verifiable" — the value-report function
    // computes + returns, no DB writes, so the promise holds there too). Was 3
    // before the 2026-08-26 /value page (Phase 4) added the fourth occurrence;
    // flywheel_capture_enabled is still false, so the promise remains literally true.
    // 2026-08-27: 5 -> 4. The Book view was retired (Vic: "remove Book tab,
    // Heatmap, 3D") and it carried one of the five. The CLAIM is unchanged and
    // is not weakened -- one surface that made it no longer exists.
    // RE-CONFIRMED before moving the number, as this rule requires:
    // 20260806_flywheel_capture.sql:22 seeds admin_config
    // flywheel_capture_enabled = 'false', and no migration anywhere sets it
    // true (grep across supabase/migrations). The live row is not anon-readable,
    // which is itself correct -- a buyer-facing key must not be able to read the
    // switch that governs whether their quote is captured.
    expected: 4, // was 5 before the Book view was retired. +1 2026-08-22: the emailed PDF's own 'never stored' line, newly in scope when email-quote-report joined SURFACES. Re-confirmed: admin_config.flywheel_capture_enabled is seeded 'false' and NO migration ever sets it true.
  },
  {
    // TWICE NOW a top-of-page photo has shipped described as the whole page --
    // PR #274 argued about WHICH half we got, PR #342 found we were labelling a
    // half "Full-page capture of the listing", and #342's own sweep then missed
    // two more sites (the /verify drop-zone and the email body). A third manual
    // sweep is not a fix; pinning the count is, because it forces whoever adds
    // one to re-confirm the claim is gated on evidence rather than assumed.
    //
    // THE CONDITION, precisely: this phrase may appear only where
    // listingShotKind is known to be "fullpage". It is NOT signed
    // (report-sign.ts seals only the capture's hash) and it does NOT ride in a
    // share link (encodeReport omits it), so surfaces that cannot read it --
    // /verify, the emailed HTML, the PDF caption -- must stay neutral and are
    // deliberately at zero here.
    id: "full-page-capture-claim-must-be-gated",
    ruleKey: "ab-no-unfair-practice-in-our-own-claims",
    kind: "guarded",
    condition: "true only while every occurrence sits inside a listingShotKind === \"fullpage\" branch",
    why: "The capture ladder can degrade to a photo of the top of the listing. Calling that the full page is an unbacked claim about our own evidence, printed on the one artifact a buyer hands to a dealer. [[capture-always-whole-page]] [[claims-must-stay-backed]]",
    patterns: [/full[-\s]page (capture|photo|screenshot)/i],
    // ── THE INVENTORY, enumerated 2026-08-27 (comments are stripped first) ──
    //   src/App.jsx:8202   the report card's fullpage arm, guarded on
    //                      a.listingShotKind === "fullpage". THE claim.
    //   src/App.jsx:11524  "A full-page screenshot works better than a cropped
    //                      one" -- upload guidance to the USER about their own
    //                      photo, not a claim about our capture. In scope on
    //                      purpose: if the wording ever migrates to describing
    //                      what WE produce, the count moves and someone looks.
    //   email-quote-report/index.ts  0  the emailed body and the PDF caption
    //                      are both neutral, because neither can read the kind.
    expected: 2,
  },
  {
    // The claim must map to ten checks that actually run and actually deliver a
    // backed result. Both halves are load-bearing: ten that exist, and ten that
    // are never blank.
    id: "ten-point-claim-is-load-bearing",
    ruleKey: "ab-no-unfair-practice-in-our-own-claims",
    kind: "guarded",
    condition: "true only while tenPoints renders all 10 with backed results and no dead placeholders",
    why: "We advertise a 10-point verification, so ten must run and ten must deliver.",
    patterns: [/\b10[-\s]point\b/i],
    // ── THE ACTUAL INVENTORY, enumerated 2026-08-27 ──────────────────────────
    // The note that stood here was WRONG about what it counted, which is worse
    // than no note: it said the App.jsx hits were "4 report surfaces — scroll,
    // heatmap, sidebar, flipbook, PDF, email". Not one of them is. All four are
    // navigation links to /#pipeline. Whoever re-confirmed this rule on the next
    // count change would have believed four report surfaces had been checked
    // when none was ever in the count.
    //
    //   public/index.html          6  nav link ×2, "10-point pipeline",
    //                                 the section aria-label, the <h2>, the lede
    //   public/alberta.html        1  nav link
    //   public/live-price-index.html 1  nav link
    //   src/App.jsx                4  nav links only (comments are not counted)
    //                              ─
    //                             12
    //
    // So this rule polices the ADVERTISEMENT, and only the advertisement.
    //
    // ── WHAT THIS RULE CANNOT DO ────────────────────────────────────────────
    // A regex occurrence count cannot observe an array's length. This rule
    // therefore stayed green across every commit that grew the on-screen grid
    // from 10 tiles to 16 — it was counting the CLAIM, never the thing claimed.
    // The structural assertion lives in `npm run check:points`, which reads the
    // arrays: App.jsx's ten pushes, tenPoints()'s ten, and the ten named in
    // public/index.html must be the same ten in the same order, with any extras
    // rendered under their own heading and never numbered as points.
    // Keep BOTH: this one catches a NEW use of the claim, that one catches the
    // claim drifting from the product. See [[ten-point-claim-policy]].
    expected: 12,
  },
];

// ── Extracting the words a user could actually read ──────────────────────────
// Code comments are not copy. Neither are identifiers like `scraped_at` or a
// Supabase .select() column list — hence \b-anchored patterns, which do not
// match across an underscore.
// Blanks a match while KEEPING its newlines, so reported line numbers still
// point at the real line in the real file. Collapsing a 20-line comment to one
// space would make every hit below it cite the wrong line.
const blank = (m) => m.replace(/[^\n]/g, " ");

function userFacingText(src, file) {
  let s = src;
  if (file.endsWith(".html")) {
    s = s.replace(/<!--[\s\S]*?-->/g, blank);
    s = s.replace(/<script\b[\s\S]*?<\/script>/gi, blank);
    s = s.replace(/<style\b[\s\S]*?<\/style>/gi, blank);
  } else {
    s = s.replace(/\/\*[\s\S]*?\*\//g, blank);
    s = s.replace(/^[ \t]*\/\/.*$/gm, blank);
    s = s.replace(/([^:'"`\\])\/\/[^\n'"`]*$/gm, (m, keep) => keep + blank(m.slice(1)));
  }
  return s;
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

let failed = 0;
const report = [];
const counts = new Map(RULES.map((r) => [r.id, []]));
const missing = [];

for (const file of SURFACES) {
  let raw;
  try { raw = readFileSync(file, "utf8"); }
  catch {
    // A surface that cannot be read is NOT a surface that passed. This used to
    // note-and-continue, so deleting or renaming a file silently dropped it out
    // of copy-compliance scope while the gate still printed "all rules clean" --
    // the warn-instead-of-refuse shape. If a surface is genuinely gone, delete
    // its entry above; that is a deliberate edit, which is the point.
    report.push(`  ✗ ${file} — listed as a surface but could not be read`);
    missing.push(file);
    continue;
  }
  const text = userFacingText(raw, file);

  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
      let m;
      while ((m = re.exec(text)) !== null) {
        counts.get(rule.id).push({ file, line: lineOf(text, m.index), match: m[0].trim() });
      }
    }
  }
}

console.log("\n── forbidden claims ──");
for (const rule of RULES.filter((r) => r.kind === "forbidden")) {
  const hits = counts.get(rule.id);
  if (hits.length === 0) { console.log(`  ✓ ${rule.id}`); continue; }
  failed++;
  console.log(`  ✗ ${rule.id}  [${rule.ruleKey}]`);
  console.log(`      ${rule.why}`);
  for (const h of hits) console.log(`      ${h.file}:${h.line}  "${h.match}"`);
}

console.log("\n── condition-bound claims (count pinned) ──");
for (const rule of RULES.filter((r) => r.kind === "guarded")) {
  const hits = counts.get(rule.id);
  if (hits.length === rule.expected) {
    console.log(`  ✓ ${rule.id} — ${hits.length} occurrence${hits.length === 1 ? "" : "s"}, as expected`);
    continue;
  }
  failed++;
  console.log(`  ✗ ${rule.id}  [${rule.ruleKey}]`);
  console.log(`      found ${hits.length}, expected ${rule.expected}`);
  console.log(`      This claim is ${rule.condition}.`);
  console.log(`      ${rule.why}`);
  console.log(`      Re-confirm the condition still holds, then update 'expected' in this file.`);
  for (const h of hits) console.log(`      ${h.file}:${h.line}  "${h.match}"`);
}

if (report.length) { console.log("\n── notes ──"); for (const l of report) console.log(l); }

// A surface this gate could not open is a surface it did not check. Skipping one
// with a note while still exiting 0 is how a renamed or deleted file silently
// drops out of copy-compliance scope under a green result. If a surface is
// genuinely gone, delete its SURFACES entry -- that is a deliberate edit.
if (missing.length) {
  console.error(`\n❌ ${missing.length} listed surface(s) could not be read: ${missing.join(", ")}`);
  console.error("   Delete the SURFACES entry if the file is gone. Do not let it pass unexamined.");
}

const clean = failed === 0 && missing.length === 0;
console.log(`\n${clean ? "✅" : "❌"} copy compliance: ${RULES.length - failed} of ${RULES.length} rules clean` +
  (missing.length ? `, ${missing.length} surface(s) unreadable` : ""));
process.exit(clean ? 0 : 1);
