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

// ── 1. no hand-rolled msrp_catalog writes outside the helper ────────────────
const files = [];
for (const dir of ["scripts", "scripts/lib"]) {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    if (f.isFile() && f.name.endsWith(".mjs")) files.push(join(dir, f.name).split(SEP).join("/"));
  }
}
const EXEMPT = (p) => p.endsWith("scripts/lib/catalog-io.mjs") || p.includes("scripts/test-");
const offenders = files.filter((f) => !EXEMPT(f) &&
  (readFileSync(f, "utf8").includes('replaceRows("msrp_catalog"') ||
   readFileSync(f, "utf8").includes("replaceRows('msrp_catalog'")));
t("no scraper writes msrp_catalog outside writeCatalogs()",
  offenders.length === 0,
  `these bypass the helper and lose the other tables when MSRP throws:\n       ${offenders.join("\n       ")}`);

// ── 2. the two stacks 5f4259d missed now use the helper ─────────────────────
for (const f of ["scripts/lib/tci-stack.mjs", "scripts/lib/fca-stack.mjs"]) {
  t(`${f} imports writeCatalogs`,
    readFileSync(f, "utf8").includes("writeCatalogs"),
    "still hand-rolling the three-table write sequence");
}

// ── 3. fca-stack must not let one make end the loop ─────────────────────────
const fca = readFileSync("scripts/lib/fca-stack.mjs", "utf8");
t("fca-stack keeps makes independent of each other",
  fca.includes("makeFailures") && fca.includes("try {"),
  "a throw on one make still aborts the loop, silently costing every make after it");

// ── 4. Toyota/Lexus MSRP provenance ─────────────────────────────────────────
const tci = readFileSync("scripts/lib/tci-stack.mjs", "utf8");
const mod = readFileSync("scripts/lib/tci-msrp.mjs", "utf8");

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
  tci.includes("74681.92") || mod.includes("74681.92"),
  "the reason vehicleStartPrice is unusable must stay, or someone will 'fix' it back");

console.log(`\n${fail ? "❌" : "✅"} catalog-writes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
