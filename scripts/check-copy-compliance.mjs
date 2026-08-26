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
  "src/PlanetAlerts.jsx",
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
    // App.jsx 6314 (report end-card), 6689 (verify badge), 6697 (verify body, twice).
    expected: 4,
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
    // 9 in public/index.html (incl. the meta description), 1 each in
    // alberta.html and live-price-index.html, 5 in App.jsx (4 report surfaces —
    // scroll, heatmap, sidebar, flipbook, PDF, email — plus the "10-point lane"
    // link now living in the quote-check nav's "More" menu). The 10-point
    // verification itself is unchanged: ten run, ten deliver.
    expected: 16,
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

for (const file of SURFACES) {
  let raw;
  try { raw = readFileSync(file, "utf8"); }
  catch { report.push(`  ! ${file} — not found, skipped`); continue; }
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

console.log(`\n${failed === 0 ? "✅" : "❌"} copy compliance: ${RULES.length - failed} of ${RULES.length} rules clean`);
process.exit(failed > 0 ? 1 : 0);
