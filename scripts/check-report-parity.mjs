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
// Pinned at 2: (1) the emailed-report payload; (2) the glass-console report
// (QuoteCheckPage's done-state block), which hoists ONE `resolveEvap` call and
// reuses its `rebate`/`effectiveFuelType` result for both the EV/PHEV rebate
// point and the "also checked" extras. Was 3 until 2026-09-09 (Vic: "lets go
// with #02, you can remove Sidebar/Heatmap") — ReportViews's own hoisted call
// site went with it. A new report surface that renders the rebate SHOULD add
// a call site back — this gate failing is the prompt to confirm you wired
// every view, then bump EXPECTED_CALL_SITES with the new surface named below.
const EXPECTED_CALL_SITES = 2;
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
      // Display modes have been cut three times: Bento/Deck/Scorecard/HUD on
      // 2026-08-12, Heatmap/Book/3D on 2026-08-27, Sidebar itself on
      // 2026-09-09 (Vic: "lets go with #02, you can remove Sidebar/Heatmap").
      // The one surviving on-screen surface is the glass-console report; it
      // renders this as an "also checked" pill, not its own card.
      "scroll summary tile strip":       'tiles.push({label:"Price conditions"',
      "bento watch-outs count":          "analysis.financeContingent?.contingent) watchOuts",
      "glass-console also-checked pill": 'analysis.financeContingent&&analysis.financeContingent.contingent&&{label:"Price conditions"',
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
    // Added 2026-09-02 with the line itself. "Of N other listings read, M
    // advertise below this one" is computed ONCE on the server (marketCount),
    // sealed in the canonical (mc), and rendered by one shared builder
    // (report-lines.js marketCountLine) on every surface. Each anchor below is
    // one render path; a dropped surface names itself.
    field: "marketCount (other listings read, M below this one)",
    app: {
      "shared line builder import":  "marketCountLine, pageDefaultLine",
      "glass-console also-checked pill": 'value:marketCountLine(analysis).value',
      "scroll summary tile strip":   'tiles.push({label:"Other listings read"',
      "share link encode":           "mc:a.marketCount?",
      "share link decode":           "marketCount:c.mc",
      "signed verify payload":       "mc:a.marketCount?{st:",
      "verify page row":             'o.mc&&<Row t="Other listings read"',
    },
    email: {
      "emailed HTML deck": 'deck.push({ label: "Other listings read"',
      "emailed PDF":       'kicker("OTHER LISTINGS READ")',
      "emailed PDF audit row": 't: "Other listings read"',
    },
  },
  {
    // Added 2026-09-02 after LC-0F75-A93 printed "$9,908 above the local middle
    // value" against 2024 hybrids: the comparison is now like-for-like
    // (marketvalue.ts + likeForLikePool) and worded by ONE builder
    // (report-lines.js marketCompareLine) as three plain lines on every surface.
    field: "marketValue comparison (this car / similar listings / difference)",
    // Dropped from the on-screen report 2026-09-09 (full replacement with
    // concept #02 -- Vic accepted this specific capability going away rather
    // than the light hero-only restyle). /verify and the share link still
    // carry it -- those are checked below; there is no more app render path
    // to pin.
    app: {
      "shared line builder import":  "marketCompareLine",
      "share link encode":           "mv:a.marketValue?{avg:",
      "share link decode":           "marketValue:c.mv?{average:c.mv.avg",
      "signed verify payload":       "marketValue:a.marketValue?{avg:nn(",
      "verify page row":             'o.marketValue&&<Row t="How this vehicle compares"',
      "verify passes fcx":           'marketCompareLine({price:o.price,marketValue:o.marketValue,fcx:o.fcx,',
    },
    email: {
      "emailed HTML deck": 'deck.push({ label: line.title, tone: line.tone, glow: line.light === "red"',
      "emailed PDF":       'kicker(line.title.toUpperCase())',
    },
  },
  {
    // Added 2026-09-10: point 4 ("AMVIC") is real AMVIC-registry data, not
    // financing APR (Vic: "make it real AMVIC data") -- a live PDF had shown
    // the AMVIC-titled point still carrying a 4.9% financing rate as its
    // value, because the 09-09 rename ("just replace the words ... the rest
    // do not touch") was correctly scoped to the label only. Worded once in
    // report-lines.js (dealerLicenceLine) so a dealer's licence status can
    // never read differently on the point card, the emailed deck card and
    // the emailed compact row -- the exact divergence found while wiring
    // this in (the app checked state==="valid", the email's old extras row
    // checked state==="ok", a value classifyStatus() never returns, so a
    // validly-licensed dealer always read "muted" there).
    field: "AMVIC (point 4 — dealer licence, real registry data)",
    app: {
      "shared line builder import": "dealerLicenceLine",
      "glass-console point card":   'PG.push({title:"AMVIC"',
      "share link encode":          "lic:a.dealerLicence&&a.dealerLicence.status",
      "share link decode":          "dealerLicence:c.lic?",
    },
    email: {
      "shared line builder import": "dealerLicenceLine",
      "tenPoints core row":         'P.push({ t: "AMVIC"',
      "emailed HTML deck":          'deck.push({ label: "AMVIC"',
      "emailed PDF point explain":  'case "AMVIC"',
      "emailed PDF supplementary":  'kicker("DEALER LICENCE - AMVIC PUBLIC REGISTRY")',
    },
  },
  {
    // Added 2026-09-03. "Your premium after this purchase": what a change of
    // vehicle does to a renewal, and what the two-million-dollar liability
    // limit typically costs. Same Alberta gate as its sibling, worded once in
    // report-lines.js (insurancePremiumLine). Derived from no listing field at
    // all -- it is regulator copy -- so /verify gates on the canonical version
    // instead, and older reports do not grow a section their PDF lacks.
    field: "insurancePremium (your premium after this purchase)",
    // Dropped from the on-screen report 2026-09-09 (full replacement). /verify
    // still carries it -- checked below.
    app: {
      "shared line builder import":  "insurancePremiumLine",
      "Alberta-only gate":           "financeCoverageApplies",
      "verify page row":             'financeCoverageApplies(o)&&Number(o.v)>=10&&<Row t="Your premium after this purchase"',
      "verify detail is version-gated too": 'financeCoverageApplies(o)&&Number(o.v)>=10&&<div',
    },
    email: {
      "emailed HTML deck": "deck.push({ label: ipLine.title",
      "emailed PDF":       "kicker(ipLine.title.toUpperCase())",
      "Alberta-only gate": "financeCoverageApplies(a)",
    },
  },
  {
    // Added 2026-09-03. "Insurance before you sign": a sequencing warning from
    // Alberta's insurance regulator, worded once in report-lines.js
    // (financeCoverageLine) and gated on financeCoverageApplies (Alberta only).
    // Derived entirely from fields the canonical already seals (dflt, fcx,
    // finance, mc.pv), so there is no new share-link field to keep in step.
    field: "financeCoverage (insurance before you sign)",
    // Dropped from the on-screen report 2026-09-09 (full replacement).
    // /verify still carries it -- checked below.
    app: {
      "shared line builder import":  "financeCoverageLine",
      "Alberta-only gate":           "financeCoverageApplies",
      "verify page row":             'financeCoverageApplies(o)&&Number(o.v)>=9&&<Row t="Insurance before you sign"',
      // The detail block reads .meta/.lines off the line, which is null below
      // v9. Ungated, it blanked /verify for every pre-v9 Alberta report.
      "verify detail is version-gated too": 'financeCoverageApplies(o)&&Number(o.v)>=9&&<div',
    },
    email: {
      "emailed HTML deck": "deck.push({ label: fcLine.title",
      "emailed PDF":       "kicker(fcLine.title.toUpperCase())",
      // The hardest rule of this line -- never print Alberta statute outside
      // Alberta -- pinned on the emailed surfaces the way it is on the app.
      "Alberta-only gate": "financeCoverageApplies(a)",
    },
  },
  {
    // Added 2026-09-02. "What older model years ask today": the model-year
    // ladder as a report line, worded once (report-lines.js olderYearsLine)
    // from the sealed ladder (canonical v8 `oy`).
    field: "olderYears (what older model years ask today)",
    // Dropped from the on-screen report 2026-09-09 (full replacement).
    // /verify and the share link still carry it -- checked below.
    app: {
      "shared line builder import":  "olderYearsLine",
      "share link encode":           "oy:a.olderYears?{st:",
      "share link decode":           "olderYears:c.oy?{state:c.oy.st",
      "signed verify payload":       "oy:a.olderYears?{st:a.olderYears.state||null,rs:a.olderYears.reason||null,sy:nn(",
      "verify page row":             'o.oy&&<Row t="What older model years ask today"',
    },
    email: {
      "emailed HTML deck": 'deck.push({ label: oyLine.title',
      "emailed PDF":       'kicker(oyLine.title.toUpperCase())',
    },
  },
  {
    // Added 2026-09-02 with the line itself. "Payment default: this page
    // gives you N months, <frequency> payments at X%" is the page's own
    // pre-selected calculator scenario, read by code (page-default.js), sealed
    // in the canonical (dflt), rendered by report-lines.js pageDefaultLine.
    field: "pageDefault (this page's payment default is...)",
    app: {
      "glass-console also-checked pill": 'value:pageDefaultLine(analysis).value',
      "scroll summary tile strip":   'tiles.push({label:"Payment starting point"',
      "share link encode":           "dflt:a.pageDefault?",
      "share link decode":           "pageDefault:c.dflt",
      "signed verify payload":       "dflt:a.pageDefault?{st:",
      "verify page row":             'o.dflt&&<Row t="Payment starting point"',
    },
    email: {
      "emailed HTML deck": 'deck.push({ label: "Payment starting point"',
      "emailed PDF":       'kicker("PAYMENT STARTING POINT")',
      "emailed PDF audit row": 't: "Payment starting point"',
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
    // The full recovery-note PROSE (gatedPriceNote) is no longer called
    // on-screen since 2026-09-09 -- the glass-console price point uses a
    // short hand-written "sub" line off the same priceGatedG boolean instead.
    // The underlying fact (price was gated but recovered) still ships via the
    // share link / signed payload / verify row below.
    app: {
      "shared note helper":        "function gatedPriceNote(a){",
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
    // Dropped from the on-screen report 2026-09-09 (full replacement).
    // <TrimMsrpRange> and useTrimRange() are unmounted dead code now, kept
    // only because the email surface's payload still needs mainTrimRange.
    app: {
      "shared hook + cache":        "function useTrimRange",
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
  // "financing worked example (FinancingBreakdown)" field removed 2026-09-09:
  // <FinancingBreakdown> had exactly one mount (the scroll view) plus
  // ReportViews's sidebar mount, both gone with the full replacement. Nothing
  // else in the app renders a financing worked example now.
  {
    // TWO AUTHORS PER FACT is this repo's most common defect shape, and the
    // financing-math sentence was the plainest example: computeFinancingCheck
    // multiplies the advertised payment by the number of payments and compares
    // that with the disclosed total obligation -- it reads neither the price
    // nor the rate -- while the sentence on screen and in the email said "We
    // recomputed the advertised payment from the price, rate and term". Both
    // surfaces now call ONE builder that words the sentence from the check's
    // own recorded fields, so a change to what the check reads cannot leave a
    // stale description standing on four surfaces. [[report-features-all-views]]
    // "price unverified" answered nothing and asked one thing: against WHAT?
    // The builder that fixed it was wired into the emailed deck and the PDF and
    // NOT into App.jsx, so the screen kept saying nothing at all -- the
    // all-views defect, committed inside the fix for it. This anchor is why the
    // next one fails the build instead of shipping. [[report-features-all-views]]
    // "price read state (priceCheckState)" field removed 2026-09-09: its only
    // app anchor was ReportViews/scroll's explainer text, both gone with the
    // full replacement -- the glass-console price point uses a short
    // hand-written sub line off the same underlying fields instead. The
    // emailed cover chip still calls priceCheckState() on its own; that is
    // now an email-internal concern with no on-screen counterpart to compare
    // against, so it is untracked here rather than gated on a surface that no
    // longer exists.
    field: "financing math sentence (financingMathNote)",
    // Same story as priceCheckState just above: ReportViews's explainFor
    // entry is gone with the full replacement. The glass-console Financing
    // math point's sub line reads fc.note/rf.note directly (the same real
    // fields financingMathNote() itself reads) rather than a second call to
    // the shared builder.
    app: {
      "shared line builder import": "financingMathNote",
    },
    email: {
      "shared line builder import": "financingMathNote",
      "emailed deck + PDF explainer": "return financingMathNote(a);",
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
      // Sidebar retired 2026-09-09 -- its own <EvidenceCard a={a}> mount went
      // with it; the glass-console report is the only on-screen mount now.
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
  [/glass-console/i,     "QuoteCheckPage"],
  [/verify page/i,       "VerifyPage"],
];
// The Heatmap, Book and 3D views were retired 2026-08-27 (Vic: "remove Book
// tab, Heatmap, 3D"), and Sidebar itself on 2026-09-09 (Vic: "lets go with
// #02, you can remove Sidebar/Heatmap") -- ReportViews went with it. Their
// anchors are gone rather than left pointing at deleted code -- a gate that
// pins a surface nobody can open is the same lie this gate was made
// range-aware to stop.

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

// ── The intake page's "Every report checks all 10" list vs the audit itself ──
// RETIRED 2026-09-10 (Vic: "remove this please, they are getting this info on
// report"). The Quote Check intake card used to name the ten checks a report
// contains, as a static list -- this rule kept that list in sync with the
// canonical audit's own titles by reading both back out of source and
// comparing them as a SET. The intake card no longer makes that promise at
// all (the ten are still named, with real values, on the report itself), so
// there is nothing left for this rule to compare. The landing page's own
// "what we advertise" section (public/index.html) still carries the
// equivalent promise and is still checked, in check-report-points.mjs.

if (failures.length) {
  console.error("REPORT PARITY GATE — FAILED\n");
  for (const f of failures) console.error("  ✗ " + f);
  console.error(`\n${failures.length} violation(s).`);
  process.exit(1);
}

console.log(`REPORT PARITY GATE — clean (${calls.length} resolveEvap call sites, 0 stale field reads, ${SURFACES.reduce((n,f)=>n+Object.keys(f.app).length+Object.keys(f.email).length,0)} named surfaces wired).`);
