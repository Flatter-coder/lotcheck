// GATE: a check that FAILED may never render as a fact about the car or the dealer.
//
// WHY THIS EXISTS. On 2026-09-12 a paying customer's report went out with three
// defects in it. All three were caught by Vic reading the screenshots. None was
// caught by any gate:
//
//   AMVIC             NOT ON QUOTE   -- licence B2036047 was in our own copy of
//                                       the registry the whole time
//   Dealer reputation NOT CHECKED    -- printed as though it were a finding
//   Title status      (absent)       -- the dealer HAD disclosed a rebuilt title
//
// Vic, 2026-09-13: "it was done because i was around and on first attempt to
// create report we found 3 mistakes because i was around, which means doesn't
// give confidences to me."
//
// He is right, and the three were one defect repeated: OUR FAILURE RENDERED AS
// THE CAR'S FACT. Not one of them looked like an error. They looked like
// findings. That is why a human had to be the one to catch them -- nothing in
// the output distinguished "we checked and it is fine" from "we could not
// check". [[supervised-correctness-is-not-correctness]]
//
// WHY NO EXISTING GATE COULD CATCH IT. Every gate we had proves a MODULE works.
// test:amvic-match passed green through the entire period the matcher was never
// called. check:points extracts `PG.push({ title: "..." })` -- titles only; it
// has never once looked at a value -- and it requires the caption to read
// `{PG.length} / 10 backed`, a rule written to stop someone hardcoding "10".
// There are exactly ten PG.push calls and not one of them is conditional, so
// that rule guarantees the number is COMPUTED and the computation always
// returns ten. A report whose ten points all read NOT CHECKED passes green and
// prints "10 / 10 backed" directly above them.
//
// THE RULE THIS ENFORCES was already written, in report-lines.js:17-19 --
//   "Absence states say what was established, never more: 'Not shown' only when
//    the page's own data says so, 'None found' for a miss, 'Not read' when no
//    attempt was made."
// It was a comment. Comments do not fail builds.
//
//   An UNCHECKED state must attribute the gap to US. It may never assert
//   anything about the dealer's document, the dealer's page, the dealer's
//   conduct, or the car -- because from where the buyer sits, none of those is
//   distinguishable from our own lookup having failed.
//
// THREE LAYERS, because each catches what the others cannot:
//
//   1. EXECUTED -- drive each shared line builder with an input where the check
//      did not run, and read what it actually returns. Catches semantics.
//
//   2. CLASSIFIED -- every value literal in the two ten-point assemblers must be
//      declared below as what it ASSERTS and whether that assertion is BACKED.
//      An undeclared value FAILS: an allowlist, not a denylist, so a new string
//      cannot arrive unclassified. Catches literals that never pass through a
//      builder -- the "N/A (GAS)" and "NOT PUBLISHED" shapes.
//
//   3. WIRED -- a three-state helper with zero production call sites fails.
//      That is the shape that shipped TWICE on 2026-09-12 (the AMVIC website
//      path, and pageAbsenceCopy). Being tested is not being called.
//      [[repeat-fix-pattern]] shape 2.
//
// PART 0 SELF-TESTS THE CHECKER on every run: it plants a violation and requires
// its own checker to catch it, then plants a compliant sample and requires the
// checker to stay quiet. If the checker ever stops being able to fail, the build
// stops there, before a single real assertion has run. A gate that cannot fail
// is not a gate.
//
// Offline. No network, no database, no clock.
//
// Run: npm run test:unchecked-states

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dealerLicenceLine, warrantyLine } from "../supabase/functions/_shared/report-lines.js";
import { brandedTitleLine } from "../supabase/functions/_shared/branded-title.js";
import { dealerReputationPoint } from "../supabase/functions/_shared/point-state.ts";
import { POINT_TITLES } from "../supabase/functions/_shared/report-points.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let failed = 0;
const fail = (m, d) => {
  failed++;
  console.error(`FAIL  ${m}`);
  if (d) console.error(`      ${String(d).split("\n").join("\n      ")}`);
};
const pass = (m) => console.log(`ok    ${m}`);

// ===========================================================================
// THE VOCABULARY -- every value a ten-point card can display, and what it
// asserts. This table is the gate's whole opinion, in one readable place.
//
//   asserts "us"      -- names OUR limitation. Always safe.
//   asserts "result"  -- a measured result (a count, a delta, a rating).
//   asserts "dealer"  -- a claim about the dealer's document, page or conduct.
//   asserts "vehicle" -- a claim about the car itself.
//   asserts "nothing" -- says nothing at all. Never acceptable on a point the
//                        buyer paid for. [[report-never-empty]]
//
//   backed: true  -- this branch is reached ONLY after a positive observation.
//   backed: false -- this branch is ALSO reached when the check simply failed.
//
// THE RULE: asserts "dealer" / "vehicle" / "nothing" with backed:false FAILS.
// A value missing from this table FAILS. Declaring it is the point: you cannot
// add a card value without saying, on the record, what it claims.
// ===========================================================================
const VOCAB = {
  // -- price ---------------------------------------------------------------
  "HIDDEN BY DEALER":  { asserts: "dealer",  backed: true,  why: "priceDisclosure === 'contact_for_price' is the page's own words, positively read" },
  "AT MSRP":           { asserts: "result",  backed: true },
  "MSRP UNVERIFIED":   { asserts: "us",      backed: false },
  "PRICE READ ONCE":   { asserts: "us",      backed: false },
  "UNVERIFIED":        { asserts: "us",      backed: false },
  // -- recalls -------------------------------------------------------------
  "NONE OPEN":         { asserts: "result",  backed: true,  why: "gated on recalls.checked === true && count === 0 && confirmed !== false" },
  "UNCONFIRMED":       { asserts: "us",      backed: false },
  "COULDN'T VERIFY":   { asserts: "us",      backed: false },
  // -- fees ----------------------------------------------------------------
  "TRANSPARENT":       { asserts: "dealer",  backed: true,  why: "addOns were read and none flagged" },
  "ITEMIZED":          { asserts: "dealer",  backed: true,  why: "dealerFeeTotal > 0 -- the dealer's own published breakdown" },
  "NONE LISTED":       { asserts: "dealer",  backed: true,  why: "gated on feesRead === true (the Advantage Ford fix, 2026-08)" },
  "NOT READ":          { asserts: "us",      backed: false },
  // -- AMVIC ---------------------------------------------------------------
  "VALID":             { asserts: "result",  backed: true },
  // -- financing -----------------------------------------------------------
  "RECONCILES":        { asserts: "result",  backed: true },
  "DOESN'T ADD UP":    { asserts: "result",  backed: true },
  // -- odometer ------------------------------------------------------------
  "N/A (NEW)":         { asserts: "vehicle", backed: true,  why: "vehicleCondition === 'new' was positively read off the page" },
  // -- VIN -----------------------------------------------------------------
  "CHECK PATTERN":     { asserts: "result",  backed: true },
  // -- EV rebate -----------------------------------------------------------
  "NOT ELIGIBLE":      { asserts: "result",  backed: true,  why: "evapRebate.ineligibleReason exists -- a computed reason, not a gap" },
  "OVER $50K CAP":     { asserts: "result",  backed: true },
  "CHECK ELIGIBILITY": { asserts: "us",      backed: false },
  "NOT DETERMINED":    { asserts: "us",      backed: false },
  // -- reputation ----------------------------------------------------------
  "NOT CHECKED":       { asserts: "us",      backed: false },
  // -- warranty ------------------------------------------------------------
  // Safe only because the sentence beside it opens "We could not confirm".
  // The chip on its own owns nothing, so if that line is ever dropped from a
  // surface (the emailed EXTRAS strip already drops explanations) this moves.
  "SEE FACTORY TERMS": { asserts: "us",      backed: false },
  // -- trade-in tool (an "also checked" extra, not one of the ten) ----------
  "DETECTED":          { asserts: "dealer",  backed: true,  why: "gated on tradeInWidget.detected -- the widget was found on the page" },

  // ===== DECLARED VIOLATIONS -- live defects, named rather than hidden. =====
  "NOT ON QUOTE":      { asserts: "dealer",  backed: false, why: "AMVIC / odometer / VIN. Reached by a DB error, an unbuilt query, a swallowed throw, a matcher refusal, and by every analyze-quote report. And a URL scan has no quote at all." },
  "NOT PUBLISHED":     { asserts: "dealer",  backed: false, why: "VIN. Fires whenever our extraction failed -- bot wall, vision path, JSON-LD carrying no VIN field." },
  "NOT LISTED":        { asserts: "dealer",  backed: false, why: "Odometer. computeOdometerCheck returns early when the MODEL YEAR is missing, even with a real reading already parsed." },
  "NONE FOUND":        { asserts: "dealer",  backed: false, why: "Reputation. get-dealer-sentiment answers HTTP 200 on its own failures; the caller hard-sets checked:true and discards the reason." },
  "NO TERMS QUOTED":   { asserts: "dealer",  backed: false, why: "Financing. computeFinancingCheck bails when any one field is missing, while the same PDF can print the term and APR inches away." },
  "N/A (GAS)":         { asserts: "vehicle", backed: false, why: "EV rebate. The final else -- an unread drivetrain is reported as a gasoline car, which can cost a buyer the federal rebate outright." },
  "NOT STATED":        { asserts: "dealer",  backed: false, why: "Title status. brandedTitleLine(undefined) defaults here, so a page we never read prints as a page that said nothing." },
  "—":            { asserts: "nothing", backed: false, why: "Price vs MSRP renders a bare em dash, under a heading reading '10 / 10 backed'." },
};

// Concatenation parts of a computed value -- "3" + " OPEN", money(d) + " UNDER".
// Each is glued to a real number, so the number is the assertion and carries its
// own backing. Listed explicitly so a new bare literal cannot hide among them.
const FRAGMENTS = new Set([
  "OPEN", "FLAGGED", "UNDER", "OVER", "ELIGIBLE", "FLAG", "km", "FROM",
  "WHEN NEW", "AS STATED BY DEALER", "/MO REF", "$", "-",
  // glued either side of a real rating: 4.7 + "*" + " / " + 5,930
  "★", "/",
]);

// A value/line pair is checked against these. The line must ATTRIBUTE THE GAP TO
// US and must not assert what the dealer's page or document did.
const DEALER_ATTRIBUTING = [
  [/\b(this|the) listing (does not|doesn't|did not|didn't)\b/i, "asserts what the listing does not say"],
  [/\bno [^.]{0,40}\bwas (listed|shown|published|quoted|on)\b/i, "asserts the dealer omitted something"],
  [/\bwas(n't| not)? on (this|the) quote\b/i, "asserts what the quote contained"],
  [/\bwe searched\b/i, "claims we looked"],
  [/\bwe (did not find|didn't find|found no)\b/i, "claims we looked"],
  [/\bthe dealer (does not|doesn't|did not|didn't)\b/i, "asserts dealer conduct"],
  [/\b(isn't|is not) shown\b/i, "asserts what the page shows"],
  [/\b(doesn't|does not) publish\b/i, "asserts what the page publishes"],
  [/\bthe page published\b/i, "asserts what the page published"],
  [/\bthis dealer advertises no\b/i, "asserts what the dealer advertises"],
];

// At least one of these must appear, so the gap is owned rather than merely
// not-blamed. Silence about whose failure it was is how "NOT STATED" reads as
// the dealer's silence.
const SELF_ATTRIBUTING = [
  /\bwe (didn't|did not|couldn't|could not|weren't able|were not able|have not|haven't)\b/i,
  /\bwe'?re not making a claim\b/i,
  /\bthis lookup (wasn't|was not)\b/i,
  /\bour (read|check|lookup)\b/i,
  /\bnot (a|an) (gap|limitation) in the car\b/i,
  /\bthis says nothing about the dealer\b/i,
];

/**
 * The checker. Given what a builder returned for an input where the check did
 * NOT run, list everything wrong with it. Returns [] when the render is honest.
 *
 * Kept as one pure function with no I/O precisely so part 0 can run it against
 * planted samples and prove it still bites.
 */
function inspectUnchecked(value, line) {
  const out = [];
  const v = String(value ?? "").trim();
  const text = String(line ?? "");

  if (!v) out.push('value is empty -- a point the buyer paid for renders nothing');
  else {
    const known = VOCAB[v];
    if (!known) out.push(`value ${JSON.stringify(v)} is not declared in VOCAB -- say what it asserts`);
    else if (known.asserts === "dealer") out.push(`value ${JSON.stringify(v)} asserts something about the dealer, on a check that did not run`);
    else if (known.asserts === "vehicle") out.push(`value ${JSON.stringify(v)} asserts something about the car, on a check that did not run`);
    else if (known.asserts === "nothing") out.push(`value ${JSON.stringify(v)} says nothing at all`);
    else if (known.asserts === "result") out.push(`value ${JSON.stringify(v)} is a result value, on a check that did not run`);
  }

  for (const [re, why] of DEALER_ATTRIBUTING) {
    if (re.test(text)) out.push(`line ${why}: ${JSON.stringify(text.match(re)[0])}`);
  }
  if (text && !SELF_ATTRIBUTING.some((re) => re.test(text))) {
    out.push("line never says WE could not check -- the gap reads as the dealer's silence");
  }
  return out;
}

// The known-failing set, dated and enumerated. This list may only SHRINK.
// A quarantined entry that starts passing FAILS the gate, so the ledger cannot
// go stale and a fix cannot be silently un-credited. [[fixing-history-log]]
// WHICH LAYER OWNS WHAT. "NOT ON QUOTE" and "NOT STATED" are not listed as
// value: entries -- the assemblers write `v: dl.value`, so those strings never
// appear as literals and part 2 is blind to them. They are caught one layer up,
// as builder: entries. Listing them in both places would have made this ledger
// read as wider coverage than it has, which is the same dishonesty the gate
// exists to stop.
const QUARANTINE = new Map([
  ["value:NOT ON QUOTE",        "2026-09-13 audit #4/#5 -- odometer and VIN, hardcoded on screen (the AMVIC one is builder:dealerLicenceLine)"],
  ["value:NONE FOUND",          "2026-09-13 audit #8/#13 -- reputation on screen; the builder is right, its caller is not"],
  ["value:NOT PUBLISHED",       "2026-09-13 audit #20 -- VIN, emailed PDF"],
  ["value:NOT LISTED",          "2026-09-13 audit #19 -- odometer, emailed PDF"],
  ["value:NO TERMS QUOTED",     "2026-09-13 audit #18 -- financing math"],
  ["value:N/A (GAS)",           "2026-09-13 audit #25/#43/#44 -- EV rebate"],
  ["value:\u2014",              "2026-09-13 audit #48 -- price vs MSRP, on screen"],
  ["builder:dealerLicenceLine", "2026-09-13 audit #10/#11 -- no unchecked state on this builder; renders NOT ON QUOTE"],
  ["builder:brandedTitleLine",  "2026-09-13 audit #6/#26/#49 -- default param collapses unchecked into NOT STATED"],
  ["caller:dealerSentiment",    "2026-09-13 audit #8/#13 -- a 200 carrying reason:search_failed is stamped checked:true"],
  ["wired:pageAbsenceCopy",     "2026-09-13 audit #9/#12 -- built, tested, zero production call sites"],
]);
const hit = new Set();
const violation = (key, msg, detail) => {
  if (QUARANTINE.has(key)) {
    hit.add(key);
    console.log(`todo  ${msg}`);
    console.log(`      quarantined: ${QUARANTINE.get(key)}`);
    return;
  }
  fail(msg, detail);
};

// ===========================================================================
// PART 0 -- the gate proves it can still fail, before it judges anything else.
// ===========================================================================
console.log("\npart 0 -- the checker itself");
{
  // Vic's exact defect, planted. The checker must bite on all three counts:
  // an undeclared-safe value, a dealer-attributing sentence, and no admission.
  const bad = inspectUnchecked("NOT ON QUOTE", "No VIN was listed to check.");
  if (bad.length >= 2) pass(`a planted violation is caught (${bad.length} findings)`);
  else {
    console.error("FATAL the checker no longer catches a known violation. Every result below is meaningless.");
    console.error(`      planted: value "NOT ON QUOTE", line "No VIN was listed to check."`);
    console.error(`      got: ${JSON.stringify(bad)}`);
    process.exit(1);
  }

  // And it must not cry wolf, or the quarantine list becomes noise nobody reads.
  const good = inspectUnchecked(
    "NOT CHECKED",
    "We didn't run a reputation check on this listing - this says nothing about the dealer. Search their name on Google to see their rating and review count yourself.",
  );
  if (good.length === 0) pass("a compliant render is left alone");
  else {
    console.error("FATAL the checker flags an honest render. It would make the gate unusable.");
    console.error(`      got: ${JSON.stringify(good)}`);
    process.exit(1);
  }

  // The em dash must be caught by the value rule alone, with no line at all --
  // otherwise a point could render blank and satisfy the gate by saying nothing.
  const blank = inspectUnchecked("—", "");
  if (blank.length >= 1) pass("a value that says nothing is caught with no line to judge");
  else { console.error("FATAL the checker accepts an empty point."); process.exit(1); }
}

// ===========================================================================
// PART 1 -- EXECUTED. What do the builders actually return when nothing ran?
// ===========================================================================
console.log("\npart 1 -- builders, driven with a check that did not run");

const UNCHECKED_CASES = [
  {
    name: "dealerLicenceLine",
    // The AMVIC lookup errored, threw, built no query, refused an ambiguous
    // match, or was never wired (analyze-quote). All five land here.
    run: () => dealerLicenceLine({ dealerName: "XPERTS AUTO SALES LTD" }),
  },
  {
    name: "brandedTitleLine",
    // readBrandedTitle threw, or we are on a fallback path that never calls it.
    run: () => brandedTitleLine(undefined),
  },
  {
    name: "dealerReputationPoint",
    // No sentiment lookup ran for this listing.
    run: () => { const r = dealerReputationPoint(undefined); return { value: r.value, line: r.explain, tone: r.tone }; },
  },
  {
    name: "warrantyLine",
    // No catalogue row resolved for this make.
    run: () => warrantyLine({}),
  },
];

for (const c of UNCHECKED_CASES) {
  let got;
  try { got = c.run(); } catch (e) { fail(`${c.name} threw on an unchecked input`, e?.message); continue; }
  const problems = inspectUnchecked(got?.value, got?.line);
  if (!problems.length) pass(`${c.name} names our own gap`);
  else violation(`builder:${c.name}`, `${c.name} renders a check that never ran as a finding`,
    `${problems.join("\n")}\nreturned: ${JSON.stringify({ value: got?.value, tone: got?.tone })}`);
}

// The mirror: a builder fed a REAL result must render it. A gate that only ever
// demands silence would be satisfied by a report that says nothing at all.
console.log("\npart 1b -- builders still render a real answer");
{
  const licensed = dealerLicenceLine({ dealerLicence: { status: "Issued", state: "valid", registration_number: "B2036047" } });
  if (licensed.value === "VALID" && licensed.tone === "pass") pass("dealerLicenceLine renders a confirmed licence");
  else fail("dealerLicenceLine no longer renders a confirmed licence", JSON.stringify(licensed));

  const branded = brandedTitleLine({ status: "branded", brand: "rebuilt", quote: "REBUILT TITLE" });
  if (/REBUILT/.test(branded.value) && branded.tone === "flag") pass("brandedTitleLine renders a disclosed rebuilt title");
  else fail("brandedTitleLine no longer renders a disclosed brand", JSON.stringify(branded));

  const rep = dealerReputationPoint({ rating: 4.7, reviewCount: 5930, checked: true });
  if (rep.value === "4.7* / 5,930" && rep.state === "confirmed") pass("dealerReputationPoint renders a real rating");
  else fail("dealerReputationPoint no longer renders a real rating", JSON.stringify(rep));
}

// ===========================================================================
// PART 1c -- a builder can only be as honest as what its caller tells it.
//
// dealerReputationPoint passes part 1: fed nothing, it says NOT CHECKED. The
// defect is one level up. get-dealer-sentiment answers HTTP 200 with
// { dealerSentiment: null, reason: "search_failed" } when ITS OWN Places call
// fails, and analyze-listing-url does:
//
//     // A 200 IS a completed check, whether or not it found a rating.
//     analysis.dealerSentiment = { ...(data?.dealerSentiment ?? {}), checked: true };
//
// The comment states the premise, and the premise is false. `reason` -- the
// only field that separates "we looked and there are none" from "our lookup
// broke" -- is dropped by the spread, and checked:true is asserted anyway. The
// builder then correctly renders NONE FOUND for what it is told is a completed
// check, and a dealer with thousands of reviews is published as having none.
//
// So: wherever `checked: true` is asserted for the sentiment lookup, `reason`
// must be consulted nearby. This is narrow on purpose -- it encodes one real
// defect rather than pretending to a general theory of callers.
// ===========================================================================
console.log("\npart 1c -- callers do not manufacture a completed check");
{
  const f = "supabase/functions/analyze-listing-url/index.ts";
  const src = read(f).split(/\r?\n/);
  const at = src.findIndex((l) => /analysis\.dealerSentiment\s*=/.test(l));
  if (at < 0) fail(`${f}: no dealerSentiment assignment found`, "the gate cannot check what it cannot find");
  else {
    const near = src.slice(Math.max(0, at - 12), at + 12).join("\n");
    if (/\breason\b/.test(near)) pass("the sentiment caller consults `reason` before claiming a completed check");
    else violation("caller:dealerSentiment",
      `${f}:${at + 1} asserts checked:true without consulting the reason the response carries`,
      "get-dealer-sentiment returns 200 + reason:search_failed on its own failures, so a 200 is not a completed check");
  }
}

// ===========================================================================
// PART 2 -- CLASSIFIED. Every value literal in both assemblers is declared.
// ===========================================================================
console.log("\npart 2 -- every point value in both assemblers is declared");

/** Slice out a value expression: from `v:`/`value:` to the comma that ends it. */
function valueExpressions(src) {
  const out = [];
  // BOTH shapes the assemblers use. The emailed deck writes the value inline as
  // an object property (`v: a.x ? "A" : "B"`); the on-screen report almost
  // always computes it first (`const v=...` then `PG.push({title,tone,v,sub})`).
  // Matching only the property form read five values out of App.jsx and missed
  // every one that mattered -- including "NOT ON QUOTE" on three separate
  // points. An extractor that silently under-reads is worse than no gate, so
  // part 2 also refuses to pass when it finds nothing at all.
  const re = /(?:^|[\s{,(;])(?:const\s+|let\s+)?(?:v|value)\s*[:=](?![=>])/g;
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex, depth = 0, q = null, esc = false;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (q) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === q) q = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { q = ch; continue; }
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) { if (depth === 0) break; depth--; }
      else if ((ch === "," || ch === ";") && depth === 0) break;
    }
    out.push(src.slice(re.lastIndex, i));
  }
  return out;
}

function literalsIn(expr) {
  // A TS return-type annotation ("v: string; tone: "pass" | ...") is not a value
  // expression. Without this the tone words arrive as undeclared point values.
  if (/^\s*(string|number|boolean)\b/.test(expr)) return [];
  // A literal on the right of a comparison is an INPUT we branch on
  // (a.msrpBasis === "dealer_stated"), never anything the buyer is shown.
  const body = expr.replace(/[!=]==?\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, " ");
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(body))) {
    const raw = (m[1] ?? m[2] ?? "").replace(/\\"/g, '"').replace(/\\'/g, "'");
    const v = raw.trim();
    if (!v) continue;
    out.push(v);
  }
  return out;
}

/**
 * The body of `header ... { ... }`, found by BRACE MATCHING rather than by
 * guessing a closing marker. A bound that overshoots swallows neighbouring
 * functions and reports their strings as undeclared point values -- which is
 * noise, and noise is how a gate stops being read.
 */
function functionBody(src, header) {
  const i = src.indexOf(header);
  if (i < 0) return null;
  // The body brace is the first `{` outside the parameter list AND outside the
  // return-type annotation. Taking "the next {" latched onto the `{` inside
  // `Array<{ t: string; ... }>`, brace-matched the type literal, and handed
  // part 2 a block with no point values in it -- which read as a clean pass.
  let open = -1, pd = 0, ad = 0;
  for (let j = i + header.length - 1; j < src.length; j++) {
    const c = src[j];
    if (c === "(") pd++;
    else if (c === ")") pd--;
    else if (c === "<") ad++;
    else if (c === ">") { if (ad > 0) ad--; }
    else if (c === "{" && pd === 0 && ad === 0) { open = j; break; }
  }
  if (open < 0) return null;
  let depth = 0, q = null, esc = false, lineC = false, blockC = false;
  for (let j = open; j < src.length; j++) {
    const ch = src[j], nx = src[j + 1];
    if (lineC) { if (ch === "\n") lineC = false; continue; }
    if (blockC) { if (ch === "*" && nx === "/") { blockC = false; j++; } continue; }
    if (q) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === q) q = null;
      continue;
    }
    if (ch === "/" && nx === "/") { lineC = true; j++; continue; }
    if (ch === "/" && nx === "*") { blockC = true; j++; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { q = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return src.slice(open, j + 1); }
  }
  return null;
}

const ASSEMBLERS = [
  { file: "src/App.jsx", from: "const PG=[];", to: "const toneColor=" },
  { file: "supabase/functions/email-quote-report/index.ts", fn: "function tenPoints(" },
];

const titles = new Set(POINT_TITLES);
for (const asm of ASSEMBLERS) {
  const src = read(asm.file);
  let block = null;
  if (asm.fn) block = functionBody(src, asm.fn);
  else {
    const i = src.indexOf(asm.from);
    if (i >= 0) { const j = src.indexOf(asm.to, i + asm.from.length); block = src.slice(i, j < 0 ? src.length : j); }
  }
  if (!block) { fail(`${asm.file}: could not find the ten-point assembler`, "the gate cannot check what it cannot find -- fix the marker, never delete the check"); continue; }

  const seen = new Map();
  for (const expr of valueExpressions(block)) {
    for (const lit of literalsIn(expr)) {
      if (titles.has(lit) || FRAGMENTS.has(lit)) continue;
      if (!seen.has(lit)) seen.set(lit, expr.replace(/\s+/g, " ").slice(0, 120));
    }
  }
  if (!seen.size) { fail(`${asm.file}: extracted no point values at all`, "the extractor is broken, which would make this layer silently pass"); continue; }

  let bad = 0;
  for (const [lit, ctx] of seen) {
    const known = VOCAB[lit];
    if (!known) { bad++; fail(`${asm.file}: point value ${JSON.stringify(lit)} is not declared in VOCAB`, `declare what it asserts and whether that is backed\n  in: ${ctx}`); continue; }
    if (known.backed) continue;
    if (known.asserts === "dealer" || known.asserts === "vehicle" || known.asserts === "nothing") {
      bad++;
      violation(`value:${lit}`, `${asm.file}: ${JSON.stringify(lit)} asserts about the ${known.asserts === "nothing" ? "buyer's point (nothing)" : known.asserts} on an unbacked branch`, known.why);
    }
  }
  if (!bad) pass(`${asm.file}: all ${seen.size} point values declared and safe`);
  else console.log(`      (${asm.file}: ${seen.size} values inspected)`);
}

// ===========================================================================
// PART 3 -- WIRED. A three-state helper nothing calls is not a fix.
// ===========================================================================
console.log("\npart 3 -- the three-state helpers reach a render surface");

const SURFACES = [
  "src/App.jsx",
  "supabase/functions/email-quote-report/index.ts",
  "supabase/functions/analyze-listing-url/index.ts",
  "supabase/functions/analyze-quote/index.ts",
  "supabase/functions/value-report/index.ts",
];
const surfaceSrc = SURFACES.map((f) => {
  try { return { f, s: read(f) }; } catch { return null; }
}).filter(Boolean);

// Named here because each exists SOLELY to stop an absence being reported as
// the dealer's silence. If one is not called, the defect it was written for is
// live no matter how green its unit test is.
const MUST_BE_CALLED = ["pageAbsenceCopy", "dealerReputationPoint"];
for (const fn of MUST_BE_CALLED) {
  const callers = surfaceSrc.filter(({ s }) => new RegExp(`\\b${fn}\\s*\\(`).test(s)).map(({ f }) => f);
  if (callers.length) pass(`${fn} is called from ${callers.length} surface(s): ${callers.map((f) => path.basename(f)).join(", ")}`);
  else violation(`wired:${fn}`, `${fn} is exported and tested but called from no render surface`,
    "a helper that nothing calls cannot fix anything -- [[repeat-fix-pattern]] shape 2");
}

// ===========================================================================
// PART 4 -- the quarantine ledger may only shrink.
// ===========================================================================
console.log("\npart 4 -- the quarantine ledger");
{
  const stale = [...QUARANTINE.keys()].filter((k) => !hit.has(k));
  if (!stale.length) pass(`all ${QUARANTINE.size} quarantined defects still reproduce`);
  else for (const k of stale) {
    fail(`quarantined defect ${JSON.stringify(k)} no longer reproduces -- delete it from QUARANTINE`,
      `${QUARANTINE.get(k)}\nand log the fix in docs/fixing-history.md with its real commit hash`);
  }
  console.log(`      ${QUARANTINE.size} known defect(s) outstanding. This number must only go down.`);
}

console.log("");
if (failed) { console.error(`${failed} failure(s)`); process.exit(1); }
console.log(`all checks passed (${QUARANTINE.size} defect(s) quarantined)`);
