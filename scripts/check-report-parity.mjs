// REPORT PARITY GATE — a deterministic check that a report card can't render
// from a field nothing populates.
//
// WHY THIS EXISTS. On 2026-08-11 a 10-URL accuracy run found the "EV / PHEV
// rebate" card rendering a dead "—" on all three BEV listings in the sample.
// The cause was not a bad rebate calculation: the rebate is derived on the
// CLIENT (from the EVAP list plus the analysis), and two surfaces derived it
// inline while two others read `analysis.evapRebate` — a field the server has
// never sent. The scroll view and the emailed report showed the real number;
// the deck/heatmap/sidebar panel and its plain-language explainer showed
// nothing. One of the listings was openly advertising a $4,762 federal rebate
// at the time.
//
// That is a CLASS of bug, not one card: any client-derived report feature can
// drift between the surfaces that render it. The fix was one shared resolver
// (`resolveEvap` in src/App.jsx); this gate is what stops the inline
// re-derivation from growing back. Same move as scripts/check-copy-compliance.mjs
// and _shared/invariants.ts — fix the class, then lock it.
//
// Serves the standing rule: every report feature ships to ALL views in the same
// change (scroll + deck/scorecard/HUD/heatmap/sidebar + PDF + email HTML).
//
// Run (from repo root):  npm run check:parity
// Exit 0 = clean; 1 = a violation.
import { readFileSync } from "node:fs";

const FILE = "src/App.jsx";
const src = readFileSync(FILE, "utf8");
const failures = [];

// Comment-masked copy for the pattern scans: a doc comment that *describes* the
// bug (like the one above resolveEvap) must not read as the bug itself. Only
// whole-line comments are masked, and each is replaced by spaces of the same
// length so every match index still maps to the real line number.
const code = src
  .split("\n")
  .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? " ".repeat(line.length) : line))
  .join("\n");

// Line number for a match index, so a failure points at the code not a regex.
function lineOf(index) {
  return code.slice(0, index).split("\n").length;
}

// ── Rule 1 (required): the shared resolver must exist ────────────────────────
// Without it there is no single source of truth to funnel the surfaces through.
if (!/function\s+resolveEvap\s*\(/.test(code)) {
  failures.push(
    `${FILE}: resolveEvap() is missing. The EVAP rebate is derived client-side; ` +
    `every surface must read it from one resolver or the views silently diverge.`,
  );
}

// ── Rule 2 (forbidden): no surface may READ analysis.evapRebate ──────────────
// The server never sets this field. Writing it is allowed in exactly one place
// (the emailed-report payload, which hands the computed rebate to the email
// function); reading it back in a render path is always the bug we shipped.
// A read looks like `.evapRebate?` / `.evapRebate.` / `.evapRebate)` — a write
// looks like `evapRebate:`.
const reads = [...code.matchAll(/\.evapRebate\s*(?![:\s]*[:=])/g)];
for (const m of reads) {
  failures.push(
    `${FILE}:${lineOf(m.index)}: reads .evapRebate — the server never sets it, so this ` +
    `renders empty. Use resolveEvap(analysis) instead.`,
  );
}

// ── Rule 3 (guarded, count-pinned): every resolver call site is accounted for ─
// Pinned at 3: (1) ReportViews — the hoisted `evap`, feeding both the 10-point
// card and its "what this means" explainer; (2) the emailed-report payload;
// (3) the scroll view. A new report surface that renders the rebate SHOULD add
// a fourth — this gate failing is the prompt to confirm you wired every view,
// then bump EXPECTED_CALL_SITES with the new surface named below.
const EXPECTED_CALL_SITES = 3;
const calls = [...code.matchAll(/(?<!function\s)\bresolveEvap\s*\(/g)];
if (calls.length !== EXPECTED_CALL_SITES) {
  failures.push(
    `${FILE}: found ${calls.length} resolveEvap() call sites, expected ${EXPECTED_CALL_SITES} ` +
    `(lines ${calls.map((m) => lineOf(m.index)).join(", ") || "none"}). ` +
    `If you added a report surface, confirm the rebate renders on EVERY view ` +
    `(scroll + deck/heatmap/sidebar + PDF + email), then update EXPECTED_CALL_SITES.`,
  );
}

// ── Rule 4 (coverage): a report field must reach EVERY surface ───────────────
// Rules 1-3 stop one specific field from drifting. This one generalises the
// standing rule itself: a feature that renders on the deck but not the scroll,
// or in the app but not the emailed PDF, is a half-shipped feature — and that
// is exactly how days-on-lot went out missing the scroll view.
//
// Each entry pins the minimum number of render paths a field must appear in,
// across BOTH files. Adding a surface should push the count UP; a count that
// drops means a view was dropped. Deliberately mechanical: it counts mentions,
// so it cannot prove a card looks right — only that no surface forgot the field.
const EMAIL_FILE = "supabase/functions/email-quote-report/index.ts";
const emailSrc = readFileSync(EMAIL_FILE, "utf8");

const SURFACES = [
  {
    field: "financeContingent (S37)",
    // Each entry is one render path. If a surface is deleted or renamed, the
    // named anchor stops matching and the gate says WHICH view went missing --
    // strictly better than a count, which stayed green when the scroll card was
    // deleted during this gate's own trial run.
    app: {
      // Display modes have been cut twice: Bento/Deck/Scorecard/HUD on
      // 2026-08-12, then Heatmap/Book/3D on 2026-08-27. The surviving report
      // surfaces are SCROLL and SIDEBAR on screen, plus the emailed HTML and
      // PDF. Sidebar renders from the shared item pool below.
      "sidebar card pool":     "financeContingentItem = {",
      "flag pool (sidebar)":             "financeContingentItem ? [financeContingentItem]",
      "scroll summary tile strip":       'tiles.push({label:"Price conditions"',
      "bento watch-outs count":          "analysis.financeContingent?.contingent) watchOuts",
      "scroll view card":                "analysis.financeContingent&&analysis.financeContingent.contingent&&(",
      "share link encode":               "fcx:a.financeContingent&&a.financeContingent.contingent",
      "share link decode":               "financeContingent:c.fcx",
      "signed verify payload":           "fcx:a.financeContingent?.contingent?{r:",
      "verify page row":                 'o.fcx&&<Row t="Price conditions"',
    },
    email: {
      "emailed HTML deck": 'deck.push({ label: "Price depends on financing with the dealer"',
      "emailed PDF":       'kicker("PRICE DEPENDS ON FINANCING WITH THE DEALER")',
    },
  },
  {
    // Added 2026-08-22 after a post-ship audit found this shipped to exactly
    // TWO surfaces (ReportViews + the emailed PDF) and was missing from the
    // DEFAULT scroll view, the flipbook, /verify and the share link -- the
    // report-features-all-views rule broken on the single most valuable fact a
    // price-gated listing produces. Pinned per-surface so a future edit that
    // drops one says WHICH one.
    field: "gated-price recovery note (D2C 'Call for pricing')",
    app: {
      "shared note helper":        "function gatedPriceNote(a){",
      "sidebar":         "const gatedRecoveredNote = gatedPriceNote(a);",
      "scroll view card":          "const gatedNoteScroll=gatedPriceNote(analysis);",
      "share link encode":         "pg:a.priceGatedButRecovered?{m:a.priceGateMessage||null",
      "share link decode":         "priceGatedButRecovered:c.pg?true:undefined",
      "signed verify payload":     "gate:a.priceGatedButRecovered?{m:a.priceGateMessage||null",
      "verify page row":           'o.gate && o.price?.asking',
    },
    email: {
      "emailed HTML deck":  "const gatedPriceNoteHtml =",
      "emailed PDF":        "const gatedNote = (qp && a.priceGatedButRecovered)",
    },
  },
  {
    field: "trimRange (MSRP per trim, standing req 2026-08-19)",
    app: {
      "shared hook + cache":        "function useTrimRange",
      "scroll view card":           "<TrimMsrpRange analysis={analysis}",
      "sidebar pool item":  'key: "trimrange"',
      // Added 2026-08-27 after I shipped the nameplate label to 3 of 5 surfaces
      // in the very change that was fixing this class. A trim ladder spanning
      // several separately-priced vehicles must say so on EVERY surface, or the
      // buyer sees six rows named "Luxury" at six prices and no explanation.
      "sidebar nameplate label": "trimRange.multiNameplate && t.nameplate",
      "scroll trim card nameplate label": "tr.multiNameplate&&t.nameplate",
      "email payload attach":       "trimRangePayload(mainTrimRange)",
    },
    email: {
      "shape validation":     "function trimRangeOk",
      "server source map":    "EMAIL_MAKE_SITE",
      "emailed HTML card":    'deck.push({ label: "MSRP per trim"',
      "emailed PDF section":  'kicker("MSRP PER TRIM")',
      "emailed PDF nameplate label":  "x.p ? `${x.p}",
      "emailed HTML nameplate label": 'x.p ? escapeHtml(String(x.p))',
    },
  },
  {
    // The worked financing example had exactly ONE call site in the whole app.
    field: "financing worked example (FinancingBreakdown)",
    app: {
      "component":              "function FinancingBreakdown(",
      "scroll view mount":      "<FinancingBreakdown analysis={analysis}",
      "sidebar mount":  "<FinancingBreakdown analysis={a}",
      "in the shared item pool": 'key: "finex"',
    },
    email: {
      // The emailed report states the same two figures as its own points.
      "emailed financing points": 'P.push({ t: "Financing math"',
    },
  },
  {
    field: "daysOnLot parked-time care-asks",
    app: {
      "shared care-ask helper":      "function dolCareAsk",
      "care-ask applied to surfaces": "dolCareAsk(d)",
    },
    email: {
      "server care-ask helper":       "function dolCareAskTxt",
      "care-ask in HTML deck + PDF":  "oil was last changed",
    },
  },
  {
    field: "sealedShot (listing capture)",
    app: {
      // ONE component, mounted by each surface -- so the anchor is the MOUNT,
      // not the copy. Anchoring on the copy is how this gate certified the
      // scroll view green off ReportViews' own text for weeks: the string
      // existed somewhere in the file, and `src.includes()` cannot tell where.
      "shared evidence component": "function EvidenceCard(",
      "scroll view mount":         "<EvidenceCard a={analysis}",
      "sidebar mount":     "<EvidenceCard a={a}",
      // The Book is the surface a buyer is most likely to PRINT and hand over,
      // and it carried no report id, no verify link, no seal and no capture.
      "signed verify payload":   "shot:a.listingShotSha256||null",
      "verify page sealed row":  'o.shot&&P==="signed"&&<Row t="Listing photo"',
      "verify page drop zone":   "Check the sealed photo",
    },
    email: {
      "email capture box":     "Attached: the listing, as it looked at report time",
      "PDF evidence pages":    "SEALED LISTING CAPTURE",
      "attachment push":       "-Photo-Proof.",
      "verified seal gate":    "async function verifySealedShot",
    },
  },
];
// ── THE ANCHOR MUST LIVE IN THE SURFACE IT NAMES ────────────────────────────
//
// This gate used to ask `src.includes(anchor)` — anywhere in a 13,000-line
// file. So an anchor labelled "scroll view copy" was satisfied by a string that
// lives inside ReportViews, and the gate certified the SCROLL view green using
// the SIDEBAR's own text. Caught 2026-08-27: `capture rides along as its own
// photo file` occurs exactly once in src/App.jsx, inside ReportViews — while
// the scroll view, the DEFAULT surface, renders no sealed capture at all. The
// gate exited 0 the whole time.
//
// That is the same shape as everything this gate exists to stop: a green signal
// with no check behind it. A parity gate satisfiable by another surface's code
// is worse than none, because it gets CITED as proof.
//
// Now each label maps to the function that renders it and the anchor must be
// found inside that function's byte range. Labels naming shared machinery (a
// hook, the signed payload, an email helper) carry no region and match
// file-wide, as before.
const REGION_OF = [
  // Most specific first: the scroll view's trim card is its own top-level
  // component that QuoteCheckPage mounts, so an anchor inside it is NOT inside
  // QuoteCheckPage. The mount itself is pinned separately ("scroll view card").
  [/trim card/i,         "TrimMsrpRange"],
  [/scroll view/i,       "QuoteCheckPage"],
  [/sidebar/i,           "ReportViews"],
  [/verify page/i,       "VerifyPage"],
];
// The Heatmap, Book and 3D views were retired 2026-08-27 (Vic: "remove Book
// tab, Heatmap, 3D"). Their anchors are gone rather than left pointing at
// deleted code -- a gate that pins a surface nobody can open is the same lie
// this gate was made range-aware to stop.

/**
 * Byte range of a top-level `function NAME(`, ending where the next top-level
 * declaration begins. Deliberately coarse: it only has to be tight enough to
 * tell one render surface from another.
 */
function regionRange(source, name) {
  const start = source.search(new RegExp(`^function ${name}\\s*\\(`, "m"));
  if (start < 0) return null;
  const rest = source.slice(start + 1).search(/^(?:function|const|class) [A-Za-z]/m);
  return { start, end: rest < 0 ? source.length : start + 1 + rest };
}
const regionCache = new Map();
const regionFor = (name) => {
  if (!regionCache.has(name)) regionCache.set(name, regionRange(src, name));
  return regionCache.get(name);
};

for (const { field, app, email } of SURFACES) {
  for (const [surface, anchor] of Object.entries(app)) {
    if (!src.includes(anchor)) {
      failures.push(`${FILE}: '${field}' is missing from the ${surface}. Every report feature ships to ALL views in the same change.`);
      continue;
    }
    const regionName = (REGION_OF.find(([re]) => re.test(surface)) || [])[1];
    if (!regionName) continue;                        // shared machinery: anywhere is fine
    const r = regionFor(regionName);
    if (!r) {
      failures.push(`${FILE}: the gate names surface '${surface}', but function ${regionName}() no longer exists — re-anchor it.`);
      continue;
    }
    // An anchor may legitimately appear more than once; at least ONE occurrence
    // must be inside the surface being claimed.
    let found = false;
    for (let i = src.indexOf(anchor); i >= 0; i = src.indexOf(anchor, i + 1)) {
      if (i >= r.start && i < r.end) { found = true; break; }
    }
    if (!found) {
      failures.push(`${FILE}: '${field}' claims the ${surface}, but its anchor appears ONLY outside ${regionName}() — another surface's code is being counted as this one's.`);
    }
  }
  for (const [surface, anchor] of Object.entries(email)) {
    if (!emailSrc.includes(anchor)) failures.push(`${EMAIL_FILE}: '${field}' is missing from the ${surface}.`);
  }
}

if (failures.length) {
  console.error("REPORT PARITY GATE — FAILED\n");
  for (const f of failures) console.error("  ✗ " + f);
  console.error(`\n${failures.length} violation(s).`);
  process.exit(1);
}

console.log(`REPORT PARITY GATE — clean (${calls.length} resolveEvap call sites, 0 stale field reads, ${SURFACES.reduce((n,f)=>n+Object.keys(f.app).length+Object.keys(f.email).length,0)} named surfaces wired).`);
