// FACT LINEAGE GATE — one author per published fact.
//
// WHY THIS EXISTS. The 2026-09-03 audit found 21 of 22 defects shared one
// shape: a fact the report publishes was PRODUCED IN TWO PLACES. Not a bad
// formula — two formulas, agreeing on the day they were written and drifting
// after. The EVAP rebate rendered "—" on three BEV listings because two
// surfaces derived it inline and two read a field the server never sent. `fcx`
// and `source` lived on the client's canonicalReport() only, so a dealer tactic
// the product exists to surface could not appear on /verify. Signature drift in
// the emailed report came from auditing canonicalReport() and not the client
// SETTERS. Same class, three times.
//
// Each of those was closed with a point fix and a point gate. This one is aimed
// at the class: for every fact the signed record publishes, count the places
// that DERIVE it, and refuse to let that count grow unnoticed.
//
// WHAT IT CANNOT DO. It does not check that two authors agree — only that you
// know they exist. A fact with two authors is not automatically a defect (the
// per-platform extractors below are plural by design). It is an unguarded
// promise that two pieces of code will keep computing the same number the same
// way, with nothing enforcing it. This gate makes the promise visible and pins
// it, so growing it is a decision instead of an accident.
//
// WHAT COUNTS AS DERIVING. Forwarding is not authoring: `msrp: a.msrp`,
// `msrp: num(a.msrp)`, `msrp: x ?? null` all pass a value along. Deriving is
// producing one — a choice between two sources, arithmetic, a parse, a call
// into something that decides. Branches inside a single function count once:
// one function is one author, however many returns it has.
//
// THE FACT LIST IS READ FROM THE CODE, not typed here, so it cannot silently go
// stale: it is whatever canonicalReport() in report-sign.ts reads off the
// analysis. Add a published fact and this gate makes you declare its lineage.
//
// Run (from repo root):  npm run check:lineage
// Exit 0 = the map matches the pin; 1 = lineage changed, or the gate went blind.
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";

const traverse = _traverse.default || _traverse;

const SIGN_FILE = "supabase/functions/_shared/report-sign.ts";
const SELF = "scripts/check-fact-lineage.mjs";

// Facts carried by canonicalReport() that this gate does NOT track, and why:
// year/make/model/vehicle are identity strings that also appear by the hundred
// in catalog tables, so a name-based scan cannot tell a report field from a
// data row; summary is prose, not a figure. Everything else is tracked.
const UNTRACKED = new Set(["vehicle", "year", "make", "model", "summary"]);

// If canonicalReport() moves or is renamed, the harvest below finds nothing and
// this gate would pass while checking NOTHING. A deleted surface must never
// satisfy a check written about it, so a thin harvest is a failure, not a pass.
const MIN_FACTS = 20;

// Surfaces that assemble, render or seal a report.
const SURFACES = [
  "src/App.jsx",
  "supabase/functions/analyze-listing-url/index.ts",
  "supabase/functions/analyze-quote/index.ts",
  "supabase/functions/email-quote-report/index.ts",
  "supabase/functions/value-report/index.ts",
  ...readdirSync("supabase/functions/_shared")
    .filter((f) => /\.(ts|js)$/.test(f) && !/\.test\.|fixtures/.test(f))
    .sort()
    .map((f) => `supabase/functions/_shared/${f}`),
];

// Reshapers move a finished fact between wire formats. They have to name every
// field, which makes them look like authors to a name scan; they are not, and
// their drift is already gated by check:canonical.
const RESHAPERS = new Set(["canonicalReport", "decodeReport", "encodeReport", "canonicalValueReport"]);

// Coercion wrappers: `num(x)` is the same fact as `x`.
const COERCE = /^(n|num|toNum|readNum|Number|parseInt|parseFloat|String|Boolean)$/;

// CALLING THE AUTHORITY IS READING, NOT AUTHORING. Consolidating the VIN shape
// rule replaced `analysis.vin = vin` with `analysis.vin = vinShapeOrNull(vin)`
// and this gate counted vin's authors 6 -> 7: the fix that removed thirteen
// duplicate definitions was scored as making the problem worse. A gate that
// punishes the exact remedy it asks for teaches people to route around it.
//
// So a call to a function on this list is forwarding, and the DERIVATION INSIDE
// that function is the one author — which is the whole point of consolidating.
// The list is explicit rather than a name pattern, because "anything called
// resolve*" would let a new function quietly exempt itself from the gate by
// being named well. Adding to it is a deliberate act with a reviewable diff.
const AUTHORITIES = new Set([
  // _shared/vin.ts — what a VIN looks like, decided once.
  "normalizeVin", "isVinShape", "isPlausibleVin", "plausibleVinOrNull", "vinShapeOrNull",
  // _shared/price-verified.ts — "is this price verified", decided once.
  "resolvePriceVerified", "isVerifiedPriceSource",
]);

// Normalising a forwarded value is not authoring it. `String(ctx.vin).toUpperCase()`
// is the same VIN; `!!ctx.priceVerified` is the same boolean. Both were being
// counted as new authors on the first run against current code -- three phantom
// `priceVerified` authors in the market-count row builder and a phantom `vin`
// author in fetchOlderYears -- which would have pinned noise and taught everyone
// to ignore this gate. An ignored gate is worse than no gate.
const NORMALISERS = /^(toUpperCase|toLowerCase|trim|toString|normalize|padStart|padEnd|slice)$/;

// Per-platform readers. These are plural ON PURPOSE — one dealer platform each,
// every one reading a different page shape — so "several authors" is the
// correct design here, not debt. They still appear in the pinned map: a new
// extractor is a new place a price can come from, and should be seen.
const EXTRACTORS = new Set([
  "extractConvertusVmsVehicle",
  "extractD2cVdpVehicle",
  "extractJsonLdVehicle",
]);

// ── The pin ─────────────────────────────────────────────────────────────────
// fact -> every function that derives it, as `file::function`, sorted. Line
// numbers are deliberately absent: moving code within a file is not a lineage
// change, and pinning lines would make this gate fail on every unrelated edit.
//
// To update: run the gate, read the diff it prints, satisfy yourself the new
// author is intended, then paste the new list and say why in the commit.
const BASELINE = {
  addOns: [
    "supabase/functions/_shared/verification-checkpoints.ts::deriveCheckpoints",
    "supabase/functions/analyze-listing-url/index.ts::anon#f2ca81be",
    "supabase/functions/analyze-listing-url/index.ts::buildConvertusVmsFallbackAnalysis",
    "supabase/functions/analyze-listing-url/index.ts::buildJsonLdFallbackAnalysis",
    "supabase/functions/analyze-listing-url/index.ts::buildSm360FallbackAnalysis",
    "supabase/functions/analyze-quote/index.ts::buildAnalysis",
  ],
  allInPricing: [
    "supabase/functions/analyze-listing-url/index.ts::enrichAnalysisInner",
  ],
  capturedAt: [
    "src/App.jsx::EvidenceCard",
    "src/App.jsx::handleUrlAnalyze",
    "supabase/functions/_shared/scrapfly.ts::attachSealedScreenshot",
  ],
  daysOnLot: [
    "supabase/functions/_shared/jsonld-vehicle.js::fillFromJsonLd",
    "supabase/functions/_shared/lot-dates.js::readLotDates",
    "supabase/functions/analyze-listing-url/index.ts::buildConvertusVmsFallbackAnalysis",
    "supabase/functions/analyze-listing-url/index.ts::captureConvertusDaysOnLot",
    "supabase/functions/analyze-listing-url/index.ts::captureOwnDaysOnLot",
    "supabase/functions/analyze-listing-url/index.ts::captureSm360DaysOnLot",
  ],
  dealerCity: [
    "supabase/functions/_shared/convertus-vms.js::extractConvertusVmsVehicle",
    "supabase/functions/_shared/jsonld-vehicle.js::extractJsonLdVehicle",
    "supabase/functions/analyze-listing-url/index.ts::buildSm360FallbackAnalysis",
    "supabase/functions/analyze-listing-url/index.ts::resolveDealerReputation",
  ],
  dealerName: [
    "supabase/functions/_shared/convertus-vms.js::extractConvertusVmsVehicle",
    "supabase/functions/_shared/d2c-vdp.js::extractD2cVdpVehicle",
    "supabase/functions/_shared/jsonld-vehicle.js::extractJsonLdVehicle",
    "supabase/functions/analyze-listing-url/index.ts::buildSm360FallbackAnalysis",
    "supabase/functions/analyze-quote/index.ts::rawVehicles",
  ],
  dealerSentiment: [
    "supabase/functions/analyze-listing-url/index.ts::resolveDealerReputation",
  ],
  financeContingent: [
    "supabase/functions/analyze-listing-url/index.ts::buildConvertusVmsFallbackAnalysis",
    "supabase/functions/analyze-listing-url/index.ts::buildJsonLdFallbackAnalysis",
  ],
  financeRates: [
    "supabase/functions/analyze-listing-url/index.ts::anon#f2ca81be",
  ],
  financingCheck: [
    "supabase/functions/analyze-listing-url/index.ts::computeFinancingCheck",
    "supabase/functions/analyze-quote/index.ts::computeFinancingCheck",
  ],
  issuedAt: [
    "src/App.jsx::finalizeReport",
    "supabase/functions/_shared/report-sign.ts::finalizeServerSide",
    "supabase/functions/email-quote-report/index.ts::verifySealedShot",
  ],
  leverageScore: [
    "supabase/functions/analyze-listing-url/index.ts::computeLeverageScore",
    "supabase/functions/analyze-quote/index.ts::computeLeverageScore",
  ],
  listingShotSha256: [
    "supabase/functions/_shared/scrapfly.ts::attachSealedScreenshot",
    "supabase/functions/_shared/scrapfly.ts::rescueListingViaScrapfly",
  ],
  marketCount: [
    "supabase/functions/_shared/invariants.ts::repair",
    "supabase/functions/analyze-listing-url/index.ts::captureMarketCount",
    "supabase/functions/analyze-quote/index.ts::anon#106a73e9",
  ],
  marketValue: [
    "supabase/functions/_shared/invariants.ts::repair",
  ],
  msrp: [
    "supabase/functions/_shared/msrp-authority.js::resolveMsrpAuthority",
    "supabase/functions/_shared/report-bands.js::priceBand",
    "supabase/functions/analyze-listing-url/index.ts::earlyStructuredFacts",
  ],
  msrpBasis: [
    "supabase/functions/analyze-listing-url/index.ts::enrichAnalysisInner",
  ],
  odometerKm: [
    "supabase/functions/_shared/convertus-vms.js::extractConvertusVmsVehicle",
    "supabase/functions/_shared/d2c-vdp.js::extractD2cVdpVehicle",
    "supabase/functions/analyze-listing-url/index.ts::buildSm360FallbackAnalysis",
  ],
  olderYears: [
    "supabase/functions/_shared/invariants.ts::repair",
    "supabase/functions/analyze-listing-url/index.ts::enrichAnalysisInner",
    "supabase/functions/analyze-quote/index.ts::anon#106a73e9",
  ],
  pageDefault: [
    "supabase/functions/_shared/invariants.ts::repair",
    "supabase/functions/analyze-listing-url/index.ts::anon#f2ca81be",
    "supabase/functions/analyze-listing-url/index.ts::buildConvertusVmsFallbackAnalysis",
    "supabase/functions/analyze-listing-url/index.ts::buildJsonLdFallbackAnalysis",
    "supabase/functions/analyze-quote/index.ts::anon#106a73e9",
  ],
  priceDisclosure: [
    "supabase/functions/analyze-listing-url/index.ts::buildConvertusVmsFallbackAnalysis",
    "supabase/functions/analyze-listing-url/index.ts::buildJsonLdFallbackAnalysis",
  ],
  priceGateGoogleAdsBacked: [
    "supabase/functions/analyze-listing-url/index.ts::earlyStructuredFacts",
  ],
  priceGateMessage: [
    "supabase/functions/_shared/d2c-vdp.js::extractD2cVdpVehicle",
    "supabase/functions/analyze-listing-url/index.ts::earlyStructuredFacts",
  ],
  priceGatedButRecovered: [
    "supabase/functions/analyze-listing-url/index.ts::earlyStructuredFacts",
  ],
  priceVerified: [
    "supabase/functions/analyze-listing-url/index.ts::anon#f2ca81be",
  ],
  quotedPrice: [
    "supabase/functions/_shared/d2c-vdp.js::extractD2cVdpVehicle",
    "supabase/functions/analyze-listing-url/index.ts::earlyStructuredFacts",
    "supabase/functions/analyze-listing-url/index.ts::enrichAnalysisInner",
    "supabase/functions/analyze-quote/index.ts::lookupVerifiedMsrp",
  ],
  quotedPriceSource: [
    "supabase/functions/analyze-listing-url/index.ts::buildConvertusVmsFallbackAnalysis",
    "supabase/functions/analyze-listing-url/index.ts::buildJsonLdFallbackAnalysis",
    "supabase/functions/analyze-listing-url/index.ts::buildSm360FallbackAnalysis",
    "supabase/functions/analyze-listing-url/index.ts::earlyStructuredFacts",
  ],
  recalls: [
    "supabase/functions/analyze-listing-url/index.ts::enrichAnalysisInner",
    "supabase/functions/analyze-quote/index.ts::anon#106a73e9",
    "supabase/functions/value-report/index.ts::anon#831ecb02",
  ],
  sourceUrl: [
    "supabase/functions/_shared/msrp-authority.js::resolveMsrpAuthority",
    "supabase/functions/email-quote-report/index.ts::verifySealedShot",
  ],
  vin: [
    "src/App.jsx::UnlockModal",
    "supabase/functions/_shared/jsonld-vehicle.js::walk",
    "supabase/functions/_shared/verification-checkpoints.ts::deriveCheckpoints",
    "supabase/functions/value-report/index.ts::anon#831ecb02",
  ],
};

// ── Harvest the published facts ─────────────────────────────────────────────
function publishedFacts() {
  const src = readFileSync(SIGN_FILE, "utf8");
  const at = src.indexOf("export function canonicalReport");
  if (at < 0) throw new Error(`${SIGN_FILE}: no canonicalReport() — the fact list would come from nowhere`);
  const body = src.slice(at);
  const end = body.indexOf("\n}");
  if (end < 0) throw new Error(`${SIGN_FILE}: canonicalReport() has no closing brace at column 0`);
  const projected = body.slice(0, end);
  const names = new Set([...projected.matchAll(/\ba\.([A-Za-z_][\w]*)/g)].map((m) => m[1]));

  // A FACT READ THROUGH A RESOLVER IS STILL A FACT. Consolidating priceVerified
  // into resolvePriceVerified(a) removed the literal `a.priceVerified` from
  // canonicalReport, and this harvest quietly stopped tracking the field — the
  // gate then reported "0 authors" for a fact that plainly has one, and it was
  // a GOOD refactor that blinded it. Exactly the failure this file's header
  // warns about, one fact at a time instead of all of them.
  //
  // So follow every resolve*() call the signed projection makes, find that
  // function in the shared modules, and harvest the analysis fields it reads.
  for (const m of projected.matchAll(/\b(resolve[A-Z][A-Za-z0-9_]*)\s*\(/g)) {
    const fn = m[1];
    for (const file of SURFACES) {
      let fsrc;
      try { fsrc = readFileSync(file, "utf8"); } catch { continue; }
      const decl = new RegExp("function\\s+" + fn + "\\b");
      const at2 = fsrc.search(decl);
      if (at2 < 0) continue;
      const stop = fsrc.indexOf("\n}", at2);
      const fnBody = fsrc.slice(at2, stop < 0 ? fsrc.length : stop);
      for (const r of fnBody.matchAll(/\ba\??\.([A-Za-z_][\w]*)/g)) names.add(r[1]);
      break;
    }
  }

  for (const skip of UNTRACKED) names.delete(skip);
  return names;
}

// ── Classify a right-hand side: forwarded, or authored here? ────────────────
function isForwarded(node) {
  if (!node) return true;
  switch (node.type) {
    case "Identifier":
    case "MemberExpression":
    case "OptionalMemberExpression":
    // A LITERAL IS A DEFAULT, NOT A DERIVATION. `priceVerified: false` in a row
    // template, or the `""` in `String(ctx.vin || "").toUpperCase()`, produce no
    // value from anything -- there is no second formula to drift. Counting them
    // made `emptyMarketCount` an author of priceVerified and `fetchOlderYears`
    // an author of vin, neither of which decides anything.
    case "NullLiteral":
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
      return true;
    case "TemplateLiteral":
      return node.expressions.length === 0;
    case "TSNonNullExpression":
    case "TSAsExpression":
      return isForwarded(node.expression);
    // `x || null`, `x ?? y` — still the same fact, defaulted.
    case "LogicalExpression":
      return isForwarded(node.left) && isForwarded(node.right);
    // `!x`, `!!x` -- a boolean coercion of a forwarded value.
    case "UnaryExpression":
      return node.operator === "!" && isForwarded(node.argument);
    case "CallExpression":
    case "OptionalCallExpression": {
      // num(x) / String(x) -- a bare coercion wrapper.
      if (node.callee.type === "Identifier") {
        // A read from the single authority for this fact.
        if (AUTHORITIES.has(node.callee.name)) return true;
        return COERCE.test(node.callee.name) &&
               node.arguments.length === 1 &&
               isForwarded(node.arguments[0]);
      }
      // x.toUpperCase() / x.trim() -- normalising whatever it was called on.
      if (node.callee.type === "MemberExpression" || node.callee.type === "OptionalMemberExpression") {
        const m = node.callee.property;
        return m?.type === "Identifier" && NORMALISERS.test(m.name) && isForwarded(node.callee.object);
      }
      return false;
    }
  }
  return false;
}

// One function is one author, however many branches it returns from.
// AN ANONYMOUS FUNCTION MUST NOT BE NAMED BY ITS LINE NUMBER. The first version
// labelled them `fn@3128`, and the header of this file promises that moving code
// within a file is not a lineage change -- then broke that promise for every
// anonymous function, because an edit 200 lines above renames it. On the first
// run against current code that alone produced five false "new author / gone"
// pairs for code that had not changed at all.
//
// So walk up to the nearest NAMED enclosing function and qualify with `>anon`.
// That is stable under movement and changes only when the surrounding structure
// really does.
function nameOfFn(fn) {
  return fn.node.id?.name ||
    (fn.parentPath?.isVariableDeclarator?.() && fn.parentPath.node.id?.name) ||
    (fn.parentPath?.isObjectProperty?.() && fn.parentPath.node.key?.name) ||
    null;
}

// A `.then(cb)` / `.map(cb)` callback has no name of its own, but the binding
// its RESULT lands in does: `const earlyStructuredFacts = Promise.all([...])
// .then(([jl, cv, dv]) => ({ ... }))`. That const is the honest name for the
// author, and it survives the code moving. Walk out through the non-function
// ancestors of the statement to find it.
function bindingAround(fn) {
  for (let p = fn.parentPath, hops = 0; p && hops < 8; p = p.parentPath, hops++) {
    if (p.isFunction?.()) break;
    if (p.isVariableDeclarator?.() && p.node.id?.type === "Identifier") return p.node.id.name;
    if (p.isObjectProperty?.() && p.node.key?.type === "Identifier") return p.node.key.name;
    if (p.isAssignmentExpression?.()) {
      const l = p.node.left;
      if (l?.type === "Identifier") return l.name;
      if (l?.type === "MemberExpression" && l.property?.type === "Identifier") return l.property.name;
    }
  }
  return null;
}

// Last resort only. An anonymous author with no binding and no named ancestor
// still has to be TOLD APART from the next one: two of them collapsing to the
// same label would silently merge two authors into one, and this gate would
// then miss exactly what it exists to catch. A short digest of the function's
// own source is unique, and unlike a line number it does not move when code
// above it does.
// LINE ENDINGS ARE NOT PART OF THE IDENTITY. Hashing the raw slice made the
// same function digest differently on a CRLF checkout than on an LF one, so the
// pin was machine-dependent: green on Windows, red in CI, for code nobody had
// touched. CI caught it on the first run. Normalise before hashing, and only
// line endings -- collapsing more would let two genuinely different functions
// share a label, which is the miss this fallback exists to prevent.
function digestOf(fn, src) {
  const { start, end } = fn.node;
  const text = src.slice(start, end).split(String.fromCharCode(13)).join("");  // strip CR: a CRLF checkout must digest like an LF one
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

function siteOf(path, file, src) {
  const fn = path.getFunctionParent();
  if (!fn) return `${file}::<module>`;
  const own = nameOfFn(fn) || bindingAround(fn);
  if (own) return `${file}::${own}`;
  for (let up = fn.getFunctionParent?.(), depth = 1; up && depth < 8; up = up.getFunctionParent?.(), depth++) {
    const n = nameOfFn(up) || bindingAround(up);
    if (n) return `${file}::${n}${">anon".repeat(depth)}`;
  }
  return `${file}::anon#${digestOf(fn, src)}`;
}

function insideReshaper(path) {
  for (let p = path; p; p = p.parentPath) {
    const name = p.node.id?.name ||
      (p.parentPath?.isVariableDeclarator?.() && p.parentPath.node.id?.name);
    if (name && RESHAPERS.has(name)) return true;
  }
  return false;
}

// A property inside an array of three or more object literals is a data row
// (a catalog table), not a report field being assembled.
function insideDataTable(path) {
  const arr = path.parentPath?.parentPath;
  return !!arr?.isArrayExpression?.() && arr.node.elements.length >= 3;
}

// ── Walk ────────────────────────────────────────────────────────────────────
function lineage(facts) {
  const map = {};
  const lines = {};
  for (const file of SURFACES) {
    let src;
    try { src = readFileSync(file, "utf8"); } catch { continue; }
    let ast;
    try {
      ast = parse(src, {
        sourceType: "module",
        errorRecovery: true,
        plugins: ["jsx", "typescript", "classProperties", "optionalChaining", "nullishCoalescingOperator", "dynamicImport"],
      });
    } catch (e) {
      throw new Error(`${file}: parse failed (${e.message}) — this gate cannot see that file`);
    }

    const record = (name, path) => {
      const site = siteOf(path, file, src);
      (map[name] ||= new Set()).add(site);
      (lines[`${site}|${name}`] ||= []).push(path.node.loc.start.line);
    };

    traverse(ast, {
      ObjectProperty(path) {
        const k = path.node.key;
        const name = k.type === "Identifier" ? k.name : k.type === "StringLiteral" ? k.value : null;
        if (!name || !facts.has(name)) return;
        if (isForwarded(path.node.value) || insideReshaper(path) || insideDataTable(path)) return;
        record(name, path);
      },
      // `analysis.priceVerified = <derivation>` -- the enrichment path mutates
      // the analysis object rather than building a literal, so an assignment is
      // how most server-side facts are actually authored. Tracking only object
      // properties and declarations made this gate blind to them: after
      // priceVerified was consolidated it reported ZERO authors for a fact that
      // plainly has one, which is a false all-clear about lineage itself.
      AssignmentExpression(path) {
        const l = path.node.left;
        if (l?.type !== "MemberExpression" || l.computed) return;
        const name = l.property?.type === "Identifier" ? l.property.name : null;
        if (!name || !facts.has(name)) return;
        if (isForwarded(path.node.right) || insideReshaper(path)) return;
        record(name, path);
      },
      VariableDeclarator(path) {
        const id = path.node.id;
        if (id.type !== "Identifier" || !facts.has(id.name)) return;
        if (isForwarded(path.node.init) || insideReshaper(path)) return;
        record(id.name, path);
      },
    });
  }
  return { map, lines };
}

// ── Run ─────────────────────────────────────────────────────────────────────
let facts, map, lines;
try {
  facts = publishedFacts();
  if (facts.size < MIN_FACTS) {
    throw new Error(
      `harvested only ${facts.size} published facts from canonicalReport() (expected at least ${MIN_FACTS}). ` +
      `The shape moved and this gate went blind — it would have passed while checking nothing.`,
    );
  }
  ({ map, lines } = lineage(facts));
} catch (e) {
  console.error(`fact-lineage: ${e.message}`);
  process.exit(1);
}

const observed = Object.fromEntries(
  Object.entries(map).map(([k, v]) => [k, [...v].sort()]),
);

if (process.argv.includes("--emit-baseline")) {
  const keys = Object.keys(observed).sort();
  console.log("const BASELINE = {");
  for (const k of keys) {
    console.log(`  ${k}: [`);
    for (const site of observed[k]) console.log(`    ${JSON.stringify(site)},`);
    console.log("  ],");
  }
  console.log("};");
  process.exit(0);
}

// A PINNED FACT THAT LEAVES THE HARVEST MUST SAY SO. Every fact in BASELINE
// was, when pinned, something the signed record depends on. If it stops being
// visible here, either the report no longer publishes it — worth knowing — or
// this gate has gone blind to it and would report it clean while checking
// nothing. That second case already happened once, to priceVerified, and it
// took a manual read of the output to notice. Neither passes now.
const untracked = Object.keys(BASELINE).filter((f) => !facts.has(f));
if (untracked.length) {
  console.error("fact-lineage: pinned facts are no longer visible to the harvest.\n");
  for (const f of untracked) console.error(`  ${f}`);
  console.error("\nEither the report stopped publishing them — remove them from BASELINE and say");
  console.error("so in the commit — or this gate can no longer see how they are produced, which");
  console.error("means it would have reported them clean while checking nothing.");
  process.exit(1);
}

const allFacts = [...new Set([...Object.keys(observed), ...Object.keys(BASELINE)])].sort();
const drift = [];

for (const fact of allFacts) {
  const now = observed[fact] || [];
  const pinned = BASELINE[fact] || [];
  const added = now.filter((s) => !pinned.includes(s));
  const gone = pinned.filter((s) => !now.includes(s));
  if (added.length || gone.length) drift.push({ fact, added, gone, now, pinned });
}

if (drift.length) {
  console.error("fact-lineage: the lineage of a PUBLISHED fact has changed.\n");
  for (const d of drift) {
    console.error(`  ${d.fact}  (pinned ${d.pinned.length} author${d.pinned.length === 1 ? "" : "s"}, found ${d.now.length})`);
    for (const s of d.added) {
      const at = lines[`${s}|${d.fact}`];
      console.error(`    + NEW AUTHOR  ${s}${at ? `  (line${at.length > 1 ? "s" : ""} ${at.join(", ")})` : ""}`);
    }
    for (const s of d.gone) console.error(`    - gone        ${s}`);
    console.error("");
  }
  console.error("A NEW AUTHOR means this fact is now produced in one more place than it was.");
  console.error("Before pinning it, answer: does the new site compute the same number the same");
  console.error("way as the existing author, and what keeps them that way? If the answer is");
  console.error('"nothing", that is the defect — read the value from the existing author');
  console.error(`instead of deriving it again. If the split is intended, update BASELINE in`);
  console.error(`${SELF} and say why in the commit.\n`);
  console.error("A site marked `gone` is equally a change: an author was removed or renamed,");
  console.error("and the pin must record that, so a deleted surface cannot pass unnoticed.");
  process.exit(1);
}

// Clean. Print the standing debt every run — facts with more than one author
// that is not a per-platform extractor are unguarded promises, still owed.
const debt = allFacts
  .map((f) => ({ f, deciders: (observed[f] || []).filter((s) => !EXTRACTORS.has(s.split("::")[1])) }))
  .filter((d) => d.deciders.length > 1);

console.log(`fact-lineage: ${facts.size} published facts, ${Object.keys(observed).length} with derivation sites — all match the pin.`);
if (debt.length) {
  console.log(`\n  standing debt — ${debt.length} facts are still derived in more than one place:`);
  for (const d of debt) {
    console.log(`    ${d.f} (${d.deciders.length})`);
    for (const s of d.deciders) console.log(`      ${s}`);
  }
  console.log(`\n  Nothing checks that these agree. Each one collapsed to a single author is`);
  console.log(`  one fewer way for the report to state two different numbers for one fact.`);
}
process.exit(0);
