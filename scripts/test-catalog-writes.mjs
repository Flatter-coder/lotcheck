// Two rules about catalog data: how it is WRITTEN, and where Toyota MSRP COMES FROM.
//
// 1. EVERY SCRAPER WRITES THROUGH writeCatalogs().
//    5f4259d fixed a real loss -- an MSRP write that throws must not take the
//    finance and lease writes down with it -- and converted twenty scrapers to
//    the shared helper. Two kept hand-rolled copies and so kept the bug:
//    tci-stack.mjs (Toyota, Lexus) and fca-stack.mjs (Jeep, Ram, Dodge,
//    Chrysler). That is why the very Toyota run that MOTIVATED 5f4259d was
//    still losing 123 finance and 120 lease rows months later. fca-stack
//    carried a second copy inside a per-make loop, so a collapse on the first
//    make skipped every make after it too.
//
// 2. TOYOTA/LEXUS MSRP COMES FROM from_prices, NEVER FROM vehicleStartPrice.
//    vehicleStartPrice is a province-CALCULATED price: the same 2026 Land
//    Cruiser returns twelve distinct values across thirteen provinces
//    (ON 74681.92, AB 75335, BC 74648, QC 74559.5 ...). Five of those are whole
//    dollars that disagree with each other, so the old whole-dollar filter did
//    not merely reject good rows -- at province=ON it ADMITTED 7 of 76 as
//    manufacturer prices.
//
//    The published national MSRP lives in
//      /bin/api/price_calculation/from_prices.<BRAND>.<PROVINCE>.json
//    which returns the identical figure in every province, and whose fee stack
//    reconciles to the printed subtotal (SUBTOTAL = MSRP + PACKAGE + fees),
//    which is what makes the basis knowable as ex-freight.
//
//    Base trims read it directly. Other trims are reached by a difference, and
//    that derivation is only allowed because it VERIFIES ITSELF: the same
//    subtraction is run in several provinces and the row is published only if
//    every province yields the identical whole-dollar figure. Removing that
//    agreement check turns a proof back into a guess, so it is pinned here.
//
// Run: node scripts/test-catalog-writes.mjs
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✅ ${n}`); };
const bad = (n, why) => { fail++; console.error(`  ❌ ${n}\n       ${why}`); };
const t = (n, cond, why) => cond ? ok(n) : bad(n, why);

const SEP = String.fromCharCode(92);   // backslash, without writing one

// COMMENTS ARE PROSE, NOT CODE. Every presence check below runs against the
// executable source only.
//
// 2026-09-22: it did not, and one check was worthless because of it. Both
// stacks name writeCatalogs in their explanatory comments, so
// `src.includes("writeCatalogs")` was satisfied by the comment. Removing the
// import AND renaming the call still reported "tci-stack imports
// writeCatalogs" green -- proven by mutation, not by reading. That is the same
// trap already recorded against test:live-dot, test:price-index and
// test:recall-single-source; the difference here is that this file asserts
// PRESENCE, so a stale comment reads as working code rather than as a false
// alarm. The stripper is quote-aware because a "//" inside a URL or a string
// literal is not a comment.
function stripComments(text) {
  let out = "", i = 0, q = null;
  while (i < text.length) {
    const c = text[i], d = text[i + 1];
    if (q) {
      if (c === SEP) { out += c + (d ?? ""); i += 2; continue; }
      if (c === q) q = null;
      out += c; i++; continue;
    }
    if (c === '"' || c === "'" || c === "`") { q = c; out += c; i++; continue; }
    if (c === "/" && d === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { const e = text.indexOf("*/", i + 2); i = e === -1 ? text.length : e + 2; continue; }
    out += c; i++;
  }
  return out;
}
const codeOf = (f) => stripComments(readFileSync(f, "utf8"));

// ── 1. no hand-rolled msrp_catalog writes outside the helper ────────────────
const files = [];
for (const dir of ["scripts", "scripts/lib"]) {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    if (f.isFile() && f.name.endsWith(".mjs")) files.push(join(dir, f.name).split(SEP).join("/"));
  }
}
const EXEMPT = (p) => p.endsWith("scripts/lib/catalog-io.mjs") || p.includes("scripts/test-");
const offenders = files.filter((f) => !EXEMPT(f) &&
  (codeOf(f).includes('replaceRows("msrp_catalog"') ||
   codeOf(f).includes("replaceRows('msrp_catalog'")));
t("no scraper writes msrp_catalog outside writeCatalogs()",
  offenders.length === 0,
  `these bypass the helper and lose the other tables when MSRP throws:\n       ${offenders.join("\n       ")}`);

// ── 2. the two stacks 5f4259d missed now use the helper ─────────────────────
for (const f of ["scripts/lib/tci-stack.mjs", "scripts/lib/fca-stack.mjs"]) {
  const c = codeOf(f);
  // Both halves, because either alone is satisfiable while the writes are
  // hand-rolled: an unused import, or a call to something else of that name.
  t(`${f} imports writeCatalogs from the shared helper`,
    /import\s*\{[^}]*\bwriteCatalogs\b[^}]*\}\s*from\s*["'][^"']*catalog-io\.mjs["']/.test(c),
    "still hand-rolling the three-table write sequence");
  t(`${f} actually calls it`,
    /\bawait\s+writeCatalogs\s*\(/.test(c),
    "an import nothing calls is the same defect wearing a different hat");
}

// ── 3. fca-stack must not let one make end the loop ─────────────────────────
const fca = codeOf("scripts/lib/fca-stack.mjs");
t("fca-stack keeps makes independent of each other",
  fca.includes("makeFailures") && fca.includes("try {"),
  "a throw on one make still aborts the loop, silently costing every make after it");

// ── 4. Toyota/Lexus MSRP provenance ─────────────────────────────────────────
const tci = codeOf("scripts/lib/tci-stack.mjs");
const mod = codeOf("scripts/lib/tci-msrp.mjs");
// The one check below that is ABOUT the comments keeps the raw text.
const tciRaw = readFileSync("scripts/lib/tci-stack.mjs", "utf8");
const modRaw = readFileSync("scripts/lib/tci-msrp.mjs", "utf8");

t("tci-stack reads the published from_prices table",
  tci.includes("from_prices."),
  "MSRP must come from the national from_prices endpoint, not from prices.json");

t("tci-stack never stores vehicleStartPrice as an MSRP",
  !tci.includes("const msrp = pkg?.vehicleStartPrice"),
  "vehicleStartPrice is province-calculated — storing it is the original defect");

t("a derived trim price must agree across provinces",
  mod.includes("provinces disagree") && mod.includes("distinct.length !== 1"),
  "cross-province agreement is what makes a derived MSRP publishable; without it this is a guess");

t("a single province is refused outright",
  mod.includes("usable.length < 2"),
  "one province cannot prove the fee stack cancelled");

const provs = (mod.split("CROSS_CHECK_PROVINCES")[1] || "").split("]")[0];
t("at least two cross-check provinces are configured",
  (provs.match(/"[A-Z]{2}"/g) || []).length >= 2,
  "fewer than two provinces makes the agreement check vacuous");

t("the price basis is stamped, not left silent",
  tci.includes('priceBasis: "excl_freight"'),
  "from_prices proves MSRP sits below freight; an unstamped row loses that");

t("internal grade codes are refused as trim names",
  tci.includes("looksLikeInternalCode"),
  'Toyota grades include "BX"/"WX"/"HI" — a row named that cannot match any listing');

t("the province evidence survives in the source",
  tciRaw.includes("74681.92") || modRaw.includes("74681.92"),
  "the reason vehicleStartPrice is unusable must stay, or someone will 'fix' it back");

console.log(`\n${fail ? "❌" : "✅"} catalog-writes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
