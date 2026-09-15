// NIGHT WATCH — an unsupervised defect rate, measured offline, on demand.
//
// WHY THIS EXISTS. The standing finding from 2026-09-13: three defects were
// caught only because Vic happened to be in the room, and every sample we have
// is a supervised one. A supervised sample cannot estimate the real error rate
// — you cannot count the defects that only got found because someone was
// watching. Correcting for that needs volume nobody watched.
//
// Volume was expensive for one reason: the only way to grade a listing was to
// run the deployed function, which fetches the dealer's live page and spends
// vendor money per call. So measurement was a scheduled, supervised, paid
// event, and the last one ran 2026-08-27.
//
// This splits the two halves apart. snapshot-golden-pages.mjs reads the pages
// once and stores the bytes. This script replays those bytes through the REAL
// shipped extractors and grades the result against the independent answer key.
// It touches no network, spends nothing, and can run as many times as you like
// — which is what makes it usable as the recheck half of a fix loop, unattended
// and overnight.
//
// WHAT IT ACTUALLY MEASURES, stated narrowly so no one over-reads it: how our
// extraction layer reads a stored page, graded on the points the page itself
// can prove — identity, condition, asking price, price-gating, VIN, odometer.
// It is not a whole-report grade. It does not exercise the catalog, MSRP
// authority, recalls, market value, or anything that needs a live lookup; those
// grade `not_gradable` here, never a silent pass. It cannot see a defect that
// lives downstream of extraction. A green run means one layer is clean, and
// says nothing about the others.
//
// AND IT CANNOT TELL YOU TODAY'S PRICE. The corpus is dated. A grade proves
// what our code makes of what that page said on the day it was stored, which is
// the extraction question and not a market question. Corpus age is printed on
// every run for exactly this reason.
//
// THE LEDGER IS THE POINT. A rate observed once in a terminal is an anecdote.
// Every run appends to scripts/fixtures/golden/defect-ledger.json — date,
// corpus hash, counts, accuracy, the 95% upper bound, and every defect found —
// so the number can be compared run over run, and a regression is visible as a
// regression rather than as a slightly different wall of text.
//
// EXIT CODES drive the loop: 0 clean, 1 defects found or a regression against
// the last ledger entry. Run it after a fix and the exit code tells you whether
// the fix landed, without anyone reading anything.
//
// Run:  node scripts/night-watch.mjs [--limit N] [--quiet] [--no-ledger]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { gradeListing, summarize, normUrl, pageDeclaresItself, isInventoryIndex } from "./lib/golden.mjs";
import { extractD2cVdpVehicle } from "../supabase/functions/_shared/d2c-vdp.js";
import { extractJsonLdVehicle } from "../supabase/functions/_shared/jsonld-vehicle.js";
import { extractConvertusVmsVehicle } from "../supabase/functions/_shared/convertus-vms.js";

const DIR = "scripts/fixtures/golden/pages";
const MANIFEST = `${DIR}/manifest.json`;
const KEYS = "scripts/fixtures/golden/answer-keys.json";
const LEDGER = "scripts/fixtures/golden/defect-ledger.json";

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? Number(process.argv[i + 1]) : d; };
const LIMIT = arg("--limit", 10_000);
const QUIET = process.argv.includes("--quiet");
const NO_LEDGER = process.argv.includes("--no-ledger");

const readJson = (f) => JSON.parse(readFileSync(f, "utf8").replace(/^﻿/, ""));

// ── Corpus ──────────────────────────────────────────────────────────────────
// No corpus is a hard stop, never an empty pass. A run over zero pages would
// report 0 defects and 100% of nothing, which is the false all-clear this
// instrument exists to prevent.
if (!existsSync(MANIFEST)) {
  console.error("night-watch: no page corpus.\n");
  console.error(`  ${MANIFEST} does not exist, so there is nothing to grade.`);
  console.error("  This script never fetches — it only replays stored pages.\n");
  console.error("  Build the corpus once (reads the same pool build-golden-set already reads):");
  console.error("    node scripts/snapshot-golden-pages.mjs");
  process.exit(1);
}

const manifest = readJson(MANIFEST);
const keys = readJson(KEYS);
const pages = Object.values(manifest.pages || {}).filter((p) => !p.blocked && p.file).slice(0, LIMIT);

if (!pages.length) {
  console.error("night-watch: the corpus manifest holds no readable pages (all blocked or empty).");
  console.error("A run over zero pages is not a pass — re-run scripts/snapshot-golden-pages.mjs.");
  process.exit(1);
}

// excluded = the listing was found gone (sold/404); grading a dead key books
// drift as defects.
const byUrl = new Map(keys.listings.filter((k) => !k.excluded).map((k) => [normUrl(k.url), k]));
// Excluded keys are not absent keys. A key the builder REFUSED to write -- the
// page served an inventory index, so there was no vehicle on it to be right or
// wrong about -- must read as "deliberately out of scope", never as "we have no
// answer for this one", which is what a bare `no key` count would imply.
const excludedBy = new Map(keys.listings.filter((k) => k.excluded)
  .map((k) => [normUrl(k.url), k.exclusionReason || "excluded"]));

// ── Replay ──────────────────────────────────────────────────────────────────
// The shipped extractors, imported directly — not a copy, not a mock. If these
// drift, this grade drifts with them, which is the entire point.
//
// Fixed precedence, and deliberately NOT keyed off the answer key's `platform`
// field: letting the key choose the extractor would let the key influence the
// thing it is grading. Each extractor returns null on a page it does not
// recognise, so precedence alone resolves it.
const EXTRACTORS = [
  ["d2c", extractD2cVdpVehicle],
  ["convertus", extractConvertusVmsVehicle],
  ["jsonld", extractJsonLdVehicle],
];

// NOT EVERY PLATFORM CAN BE REPLAYED FROM A STORED PAGE, and pretending
// otherwise would be the worst outcome here: 40 listings reported as "our
// extractors read nothing" when in truth there was never anything in the page
// to read. SM360 lots (the /new-inventory/ + /used-inventory/ id<digits> shape
// that parseSm360Listing matches) carry their facts in a paginated JSON feed
// the pipeline fetches from the dealer's origin, not in the VDP HTML. Those are
// declared out of scope, counted separately, and excluded from the grade —
// never scored, and never reported as a defect.
//
// Detected from the URL's own shape rather than the answer key's `platform`
// label, so the key has no influence on anything here at all.
const isFeedBacked = (url) => {
  try {
    const p = new URL(url).pathname;
    return /\/(new|used)-inventory\//i.test(p) && /id\d{4,}(?![0-9])/i.test(p);
  } catch { return false; }
};

// THE EXTRACTORS DO NOT AGREE ON A NAME FOR THE PRICE. convertus and d2c return
// `quotedPrice`; jsonld returns `price`. Reading only the first name dropped the
// price on all 11 jsonld-read pages, and the first run duly reported five
// listings as "page advertises $30,990, report has none" — a defect invented
// entirely by this harness. Two names for one fact, which is the very thing
// check:lineage exists to stop.
//
// Both names are read here, and a returned object that has some OTHER
// price-shaped key and neither of these is treated as a shape change worth
// failing on, not quietly zeroed: a third name appearing is exactly how this
// bug would come back.
const PRICE_FIELDS = ["quotedPrice", "price"];
const readPrice = (v) => {
  for (const f of PRICE_FIELDS) if (v[f] != null) return { value: v[f], drift: false };
  const other = Object.keys(v).find((k) => /price/i.test(k) && v[k] != null && typeof v[k] !== "object");
  return { value: null, drift: !!other, otherKey: other || null };
};

function analysisFrom(html) {
  for (const [name, fn] of EXTRACTORS) {
    let v = null;
    try { v = fn(html); } catch { v = null; }
    if (!v) continue;
    const price = readPrice(v);
    return {
      _extractor: name,
      _priceShapeDrift: price.drift ? `${name} returned no ${PRICE_FIELDS.join("/")} but has "${price.otherKey}"` : null,
      year: v.year ?? null,
      make: v.make ?? null,
      model: v.model ?? null,
      vin: v.vin ?? null,
      odometerKm: v.odometerKm ?? null,
      vehicleCondition: v.condition ?? null,
      quotedPrice: price.value ?? null,
      // The grader reads price-gating out of priceDisclosure/summary the same
      // way the report surfaces do. Only assert gating when the extractor
      // actually found the tell — an absence must never render as a claim.
      priceDisclosure: v.priceGated ? "hidden" : null,
      summary: null,
      // Extraction does not decide MSRP; msrp-authority does, and it needs the
      // catalog. Left null so the grader marks it not_gradable rather than
      // scoring a figure this layer never produced.
      msrp: null,
      msrpBasis: null,
    };
  }
  return null;
}

// ── Drift, and why most points cannot be graded against an older key ────────
// FOUND ON THE FIRST REAL RUN, 2026-09-15. The instrument reported 10 price
// defects at Silverhill Acura, all in the same direction. Every one was wrong.
// The answer keys were built 08-20; the pages were snapshotted 09-15. The
// dealer had cut prices in between, and our extraction matched all three of
// today's page statements exactly — meta description, JSON-LD offers.price, and
// the blob's internet_price. The key's own recorded evidence for one unit reads
// `internet_price=45130`; that same field on the same page now reads 42475.
// Same field, different day, different number.
//
// So a stale key does not measure our accuracy. It measures how much the market
// moved, and books it against us — which is this product's own cardinal sin
// aimed inward: accusing on evidence that has expired.
//
// grade-golden-set.mjs already knew this and prints a warning when results and
// keys are more than a day apart. A warning was the cheap branch and I took it
// by omitting it. This refuses instead: past the window, every point that can
// drift becomes not_gradable — never silently passed, never counted as a
// defect. What is left still grades, because it cannot drift: a VIN, a model
// year and a new/used condition are properties of the vehicle, not of the day.
// Freshness is PER LISTING, not per file. Once part of a key file is rebuilt
// from the snapshot, one file-level builtAt is a lie about the other part: it
// would make 79 untouched 08-20 keys look as fresh as the 41 rebuilt ones, and
// this check would wave their drift straight through. Each listing carries its
// own builtAt; the file-level date is only a fallback for keys written before
// that field existed.
// NOT APPLICABLE AT THIS LAYER, so never scored here. Extraction does not decide
// MSRP — msrp-authority does, from the catalog — so this harness passes
// `msrp: null` deliberately. The shared grader reads that as `missed` and was
// duly producing 12 "page states MSRP $X, report has none" points that mean
// nothing about the code under test. They never failed a run (a `missed` is not
// a `wrong`), which makes them worse, not better: a reader scanning the ledger
// would find twelve MSRPs we look like we dropped.
const NOT_APPLICABLE = new Set(["msrp_dealer_stated"]);

const FRESH_MS = 24 * 3600e3;
const DRIFTS = new Set(["price", "price_gating", "msrp_dealer_stated", "odometer"]);
const fileBuiltAt = Date.parse(keys?.meta?.builtAt || "");

function applyDrift(g, fetchedAt, key) {
  const pageAt = Date.parse(fetchedAt || "");
  const keyAt = Date.parse(key?.builtAt || "") || fileBuiltAt;
  const stale = !(Number.isFinite(keyAt) && Number.isFinite(pageAt) && Math.abs(pageAt - keyAt) <= FRESH_MS);

  let suppressed = 0, dropped = 0;
  const points = { ...g.points };
  for (const p of Object.keys(points)) {
    if (points[p] === "not_gradable") continue;
    if (NOT_APPLICABLE.has(p)) { points[p] = "not_gradable"; dropped++; continue; }
    if (stale && DRIFTS.has(p)) { points[p] = "not_gradable"; suppressed++; }
  }
  if (!suppressed && !dropped) return { g, suppressed: 0 };
  const vals = Object.values(points);
  const verdict = vals.includes("false_accusation") ? "FAIL_FALSE_ACCUSATION"
    : vals.includes("wrong") ? "FAIL"
    : vals.every((v) => v === "not_gradable") ? "NOT_GRADABLE"
    : "PASS";
  // Keep only the reasons for points that survived, so a suppressed point can
  // never leave its accusation behind in the output.
  const reasons = g.reasons.filter((r) => { const n = String(r).split(":")[0]; return !NOT_APPLICABLE.has(n) && !(stale && DRIFTS.has(n)); });
  return { g: { ...g, points, verdict, reasons }, suppressed };
}

// A DELISTED UNIT IS NOT AN EXTRACTION FAILURE. When a vehicle sells, these
// dealers serve the inventory SEARCH page at the old VDP URL — HTTP 200, full
// size, and titled "52 Used CHEVROLET cars… in Stock" with an ItemList instead
// of a Car. Every one of the 18 pages this harness first reported as "read by
// no extractor" was one of those. The extractors returning null there is the
// CORRECT answer; pulling some other vehicle out of that ItemList and filing it
// under this listing would be the cross-dealer attribution defect.
//
// The test is the VIN, because the VIN is what makes a page this listing's
// page. If the bytes we stored do not contain the VIN the key recorded, the
// unit is gone and there is nothing here to grade. If the VIN IS present and
// nothing could read the page, that is a genuine extraction failure and stays a
// finding. The key is used only to scope — never to supply a graded value.
// Classify from the page's OWN declaration, not from the key. The key cannot
// help here anyway: rebuilding it from this same snapshot means it was built
// from the search page too, so it has no VIN either — a lesson in what a key
// derived from the bytes can and cannot tell you.
//
// An inventory index says what it is, out loud and in machine-readable form: a
// schema.org ItemList and no Car/Vehicle node, under a title like "52 Used
// CHEVROLET cars, trucks, and SUVs in Stock". That is the dealer declaring a
// results page. A VDP whose template merely moved its data elsewhere makes no
// such declaration, and stays a finding.
// pageDeclaresItself / isInventoryIndex live in lib/golden.mjs, imported above.
// They were written here first and the key builder needed the same judgement;
// two copies of "is this page a vehicle" is two authors for one fact, which is
// what check:lineage exists to refuse. One author, both callers.

const grades = [];
const unrecognised = [];
const priceShapeDrift = [];
let noKey = 0;
let outOfScope = 0;
let gone = 0;
let suppressedPoints = 0;

for (const p of pages) {
  if (isFeedBacked(p.url)) { outOfScope++; continue; }
  const key = byUrl.get(normUrl(p.url));
  if (!key) {
    if (excludedBy.has(normUrl(p.url))) { gone++; continue; }
    noKey++;
    continue;
  }
  let html;
  try { html = readFileSync(`${DIR}/${p.file}`, "utf8"); } catch { continue; }

  const a = analysisFrom(html);
  if (a?._priceShapeDrift) priceShapeDrift.push(`${p.url} — ${a._priceShapeDrift}`);
  if (!a) {
    if (isInventoryIndex(html, p.url)) { gone++; continue; }
    // Nothing read it and it is not a confirmed delisting. That stays a finding
    // — a miss is never a clean bill — but say WHICH kind, so the two are not
    // chased as one. "looks like an index, unconfirmed" is a page that declares
    // itself a results page while its URL carries no VIN or id to corroborate
    // with; almost certainly a delisting, but not provable from these bytes.
    // "declares itself a vehicle page" is the serious one: a VDP our extractors
    // could not read.
    const shape = pageDeclaresItself(html);
    unrecognised.push({
      url: p.url,
      why: shape === "index" ? "looks like an index, no VIN or id in the URL to confirm"
        : shape === "vdp" ? "declares itself a vehicle page — REAL extraction gap"
        : "declares nothing either way",
    });
    continue;
  }
  const { g, suppressed } = applyDrift(gradeListing(key, a), p.fetchedAt, key);
  suppressedPoints += suppressed;
  grades.push({ ...g, extractor: a._extractor, fetchedAt: p.fetchedAt });
}

// ── Report ──────────────────────────────────────────────────────────────────
const s = summarize(grades);
const defects = grades.filter((g) => g.verdict !== "PASS" && g.verdict !== "NOT_GRADABLE");
const falseAcc = defects.filter((g) => g.verdict === "FAIL_FALSE_ACCUSATION");

const ages = pages.map((p) => Date.parse(p.fetchedAt || "")).filter(Number.isFinite);
const oldestDays = ages.length ? Math.round((Date.now() - Math.min(...ages)) / 864e5) : null;
// The answer keys are half of the measurement, so they belong in the identity
// of a run. Caught the first time this mattered: rebuilding 41 keys from the
// snapshot gave 5 previously key-less pages a key, which moved them out of
// "skipped, no key" and into the graded path, where they failed extraction.
// Unreadable went 13 -> 18 and the run was flagged a REGRESSION. Nothing had got
// worse — the instrument had started looking at five pages it used to ignore.
// Comparing two runs graded against different keys is not a comparison.
const keysHash = createHash("sha256")
  .update(JSON.stringify((keys.listings || []).map((k) => [k.url, k.builtAt]).sort()))
  .digest("hex").slice(0, 16);
const corpusHash = createHash("sha256")
  .update(pages.map((p) => p.sha256 || p.file).sort().join(""))
  .digest("hex").slice(0, 16);

if (!QUIET) {
  for (const g of defects) {
    console.log(`${g.verdict === "FAIL_FALSE_ACCUSATION" ? "!!" : "XX"} ${g.verdict.padEnd(22)} ${String(g.url).slice(0, 78)}`);
    for (const r of g.reasons) console.log(`      ${r}`);
    console.log(`      extractor: ${g.extractor}   page stored: ${String(g.fetchedAt).slice(0, 10)}`);
  }
}

console.log(`\n== night watch ==`);
console.log(`corpus: ${pages.length} stored pages, oldest ${oldestDays ?? "?"} days old (hash ${corpusHash})`);
if (oldestDays != null && oldestDays > 30) {
  console.log(`  NOTE: this corpus is over a month old. It still grades extraction correctly —`);
  console.log(`  that is a question about our code, not about today's market — but it cannot`);
  console.log(`  tell you what any of these vehicles costs now.`);
}
console.log(`in scope: ${pages.length - outOfScope}   feed-backed, not replayable offline: ${outOfScope}   not a vehicle page (index served at the VDP url): ${gone}`);
console.log(`matched to an answer key: ${grades.length}   no key: ${noKey}   unreadable by any extractor: ${unrecognised.length}`);
for (const u of unrecognised) console.log(`  unread: ${String(u.url).slice(8, 78)}
          ${u.why}`);

if (suppressedPoints) {
  console.log(`\n${suppressedPoints} drift-prone points NOT graded — their key and page are ` +
    `more than a day apart`);
  console.log(`  (price, price-gating, dealer-stated MSRP, odometer). A dealer moving a price`);
  console.log(`  is not our defect, and grading it against an expired key would accuse us of`);
  console.log(`  one. Identity, VIN and condition still grade — those cannot drift.`);
  console.log(`  Refresh those keys from the stored pages: npm run golden:build -- --from-snapshot`);
}
console.log(`graded: ${s.graded}   pass: ${s.pass}   fail: ${s.fail}   false accusations: ${s.false_accusations}`);
if (s.accuracyPct != null) console.log(`extraction accuracy (page-provable points): ${s.accuracyPct}%`);
// The rule of three needs a real n to say anything: 0 fails in 1 listing bounds
// the rate "under 300%", which is arithmetically true and useless, and a figure
// that makes a reader stop and ask what it means should not be printed at all.
if (s.ruleOfThree95UpperPct != null && s.ruleOfThree95UpperPct < 100) {
  console.log(`0 failures in ${s.graded} graded — true failure rate is under ${s.ruleOfThree95UpperPct}% at 95% confidence (rule of three).`);
} else if (s.ruleOfThree95UpperPct != null) {
  console.log(`0 failures, but only ${s.graded} graded — too few to bound the real rate. ` +
    `Reaching a 1% claim needs 300 clean gradings; 99% needs ${Math.ceil(3 / 0.01)}.`);
}
console.log(`\nScope: extraction only. Catalog, MSRP authority, recalls and market value are`);
console.log(`not exercised here and grade as not_gradable — a clean run means this layer is`);
console.log(`clean, and says nothing about the others.`);

// ── Ledger ──────────────────────────────────────────────────────────────────
const entry = {
  ranAt: new Date().toISOString(),
  corpusHash,
  keysHash,
  corpusPages: pages.length,
  outOfScopeFeedBacked: outOfScope,
  corpusOldestDays: oldestDays,
  graded: s.graded,
  pass: s.pass,
  fail: s.fail,
  falseAccusations: s.false_accusations,
  accuracyPct: s.accuracyPct,
  ruleOfThree95UpperPct: s.ruleOfThree95UpperPct,
  unreadable: unrecognised.length,
  gone,
  priceShapeDrift: priceShapeDrift.length,
  suppressedDriftPoints: suppressedPoints,
  keysBuiltAt: keys?.meta?.builtAt || null,
  defects: defects.map((g) => ({ url: g.url, verdict: g.verdict, reasons: g.reasons, extractor: g.extractor })),
  unreadableDetail: unrecognised,
};

const ledger = existsSync(LEDGER) ? readJson(LEDGER) : { version: 1, runs: [] };
const prior = ledger.runs.length ? ledger.runs[ledger.runs.length - 1] : null;

if (!NO_LEDGER) {
  ledger.runs.push(entry);
  writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 1)}\n`);
}

// A regression is only meaningful against the same corpus — a different corpus
// is a different question, and comparing across them would manufacture both
// fake regressions and fake improvements.
let regressed = false;
if (prior && prior.corpusHash === corpusHash && prior.keysHash === keysHash) {
  const dAcc = (entry.accuracyPct ?? 0) - (prior.accuracyPct ?? 0);
  console.log(`\nvs previous run (${String(prior.ranAt).slice(0, 10)}, same corpus): ` +
    `${dAcc >= 0 ? "+" : ""}${Math.round(dAcc * 10) / 10} points, ` +
    `fails ${prior.fail} -> ${entry.fail}, unreadable ${prior.unreadable} -> ${entry.unreadable}`);
  if (entry.fail > prior.fail || entry.unreadable > prior.unreadable) {
    regressed = true;
    console.error(`\nREGRESSION: this run is worse than the last one on the same pages.`);
  }
} else if (prior) {
  console.log(`\nprevious run used a different corpus or different answer keys — not compared.`);
}

if (falseAcc.length) {
  console.error(`\nSTOP: ${falseAcc.length} false accusation${falseAcc.length === 1 ? "" : "s"}.`);
  console.error(`The report told a buyer a dealer hid a price the page advertises. That is the`);
  console.error(`class that gets a report discredited, and it outranks every other defect here.`);
  process.exit(1);
}
if (priceShapeDrift.length) {
  console.error(`
PRICE SHAPE DRIFT: an extractor returned a price under a name this harness does not read.`);
  for (const d of priceShapeDrift.slice(0, 5)) console.error(`  ${d}`);
  console.error(`Add the name to PRICE_FIELDS — until then that listing is graded with no price.`);
}
if (defects.length || unrecognised.length || regressed || priceShapeDrift.length) {
  console.error(`\n${defects.length} defect${defects.length === 1 ? "" : "s"} and ${unrecognised.length} unreadable page${unrecognised.length === 1 ? "" : "s"} — fix one, run again, the exit code tells you if it landed.`);
  process.exit(1);
}
console.log(`\nclean.`);
process.exit(0);
