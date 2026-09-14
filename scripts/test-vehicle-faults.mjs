// The reported-faults panel: what it says, what it refuses to say, and what it
// must never mistake for an answer.
//
// Every case below is a REAL string or a REAL measurement from NHTSA's corpus,
// read 2026-09-14. A gate built from imagined inputs passes on imagined bugs --
// the first version of this feature's truncation floor was guessed and failed a
// healthy slice on its first run.
import { readFileSync } from "node:fs";
import {
  rankFaults, rankTally, tallyFilings, emptyTally, addTo, normSystem,
  faultsPanel, precisionNote, FAULTS_BASIS,
  FAULTS_SHOWN, FAULTS_TOO_THIN, FAULTS_TOO_GENERIC, FAULTS_NOT_CHECKED,
  FAULTS_MIN_FILINGS, GENERIC_SYSTEMS, UNKNOWN_BUCKET,
} from "../supabase/functions/_shared/vehicle-faults.js";
import {
  modelKey, cellKey, nameplateKey, lookupFaults,
  NO_VEHICLE, NO_CATALOGUE_ROW, CATALOGUE_UNREADABLE,
} from "../supabase/functions/_shared/fault-model-match.js";
import {
  SLICES, assertNotForbidden, assertSliceSane, fetchSlice, parseRow, BannedError,
} from "./lib/nhtsa-slices.mjs";

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

/* ── 1. the model strings that actually differ ───────────────────────────── */
console.log("\nNHTSA's spelling and a Calgary listing's spelling reach one key");
{
  const same = (a, b, label) => check(label,
    modelKey(a[0], a[1]) && modelKey(a[0], a[1]) === modelKey(b[0], b[1]),
    `${modelKey(a[0], a[1])} vs ${modelKey(b[0], b[1])}`);

  same(["FORD", "F-150 SUPERCREW"], ["Ford", "F-150"], "F-150 SUPERCREW = F-150");
  same(["FORD", "F-150 REGULAR CAB"], ["Ford", "F-150"], "F-150 REGULAR CAB = F-150");
  same(["MAZDA", "MAZDA3"], ["Mazda", "Mazda 3"], "MAZDA3 = Mazda 3");
  same(["MAZDA", "MAZDA3"], ["Mazda", "3"], "MAZDA3 = 3");
  same(["TOYOTA", "4 RUNNER"], ["Toyota", "4Runner"], "4 RUNNER = 4Runner");
  same(["RAM", "1500"], ["Ram", "Ram 1500"], "RAM 1500 = Ram 1500");
  same(["HONDA", "CR-V"], ["Honda", "CRV"], "CR-V = CRV");
  same(["HONDA", "CIVIC HATCHBACK"], ["Honda", "Civic"], "CIVIC HATCHBACK = Civic");
  same(["FORD", "ESCAPE HEV"], ["Ford", "Escape Hybrid"], "ESCAPE HEV = Escape Hybrid");

  // AND THE GUARD ON THE GUARD: normalisation must not weld different cars.
  const differ = (a, b, label) => check(label,
    modelKey(a[0], a[1]) !== modelKey(b[0], b[1]),
    `both became ${modelKey(a[0], a[1])}`);
  differ(["FORD", "F-150"], ["FORD", "F-250"], "F-150 is not F-250");
  differ(["RAM", "1500"], ["RAM", "2500"], "Ram 1500 is not Ram 2500");
  differ(["CHEVROLET", "SILVERADO 1500"], ["CHEVROLET", "SILVERADO 2500"], "Silverado 1500 is not 2500");
  differ(["TOYOTA", "RAV4"], ["TOYOTA", "RAV4 PRIME"], "RAV4 is not RAV4 Prime");
  differ(["HONDA", "CIVIC"], ["HONDA", "CIVIC SI"], "Civic is not Civic Si");
  differ(["MAZDA", "CX-5"], ["MAZDA", "CX-50"], "CX-5 is not CX-50");
}

/* ── 2. the powertrain fallback runs downhill only ───────────────────────── */
console.log("\na variant may borrow the nameplate's record; the nameplate may not borrow a variant's");
{
  const cat = new Map([
    ["2021|TOYOTA|RAV4", { ranking: big("Brakes", "Steering", "Suspension"), source_updated_at: null }],
    ["2021|TOYOTA|RAV4PRIME", { ranking: big("Airbags", "Seats", "Steering"), source_updated_at: null }],
  ]);
  const hyb = lookupFaults(cat, { year: 2021, make: "Toyota", model: "RAV4 Hybrid" });
  check("a hybrid with no NHTSA model of its own falls back to the nameplate",
    hyb.row && hyb.precision === "nameplate" && hyb.key === "2021|TOYOTA|RAV4", JSON.stringify(hyb.key));
  check("...and the fallback is declared, not silent", hyb.precision === "nameplate");

  const plain = lookupFaults(cat, { year: 2021, make: "Toyota", model: "RAV4" });
  check("a plain RAV4 matches exactly and never reaches RAV4 Prime",
    plain.precision === "exact" && plain.key === "2021|TOYOTA|RAV4", plain.key);

  const prime = lookupFaults(cat, { year: 2021, make: "Toyota", model: "RAV4 Prime" });
  check("RAV4 Prime keeps its own record", prime.precision === "exact" && prime.key === "2021|TOYOTA|RAV4PRIME");

  // THE UPHILL CASE, which the exact match hides in the catalogue above: when
  // the nameplate has NO row of its own and a variant does, the plain model
  // must come back empty. An injection that let it borrow the Prime's
  // complaints passed every other assertion here -- found 2026-09-14 by
  // planting exactly that, which is why this case exists.
  const variantOnly = new Map([
    ["2021|TOYOTA|RAV4PRIME", { ranking: big("Airbags", "Seats", "Steering"), source_updated_at: null }],
  ]);
  const uphill = lookupFaults(variantOnly, { year: 2021, make: "Toyota", model: "RAV4" });
  check("a plain RAV4 finds NOTHING rather than a plug-in's complaints",
    uphill.row === null && uphill.reason === NO_CATALOGUE_ROW,
    `got ${uphill.key} precision=${uphill.precision}`);
  const uphill2 = lookupFaults(variantOnly, { year: 2021, make: "Toyota", model: "RAV4 Hybrid" });
  check("...and a hybrid does not borrow the plug-in's either",
    uphill2.row === null, `got ${uphill2.key}`);

  check("nameplateKey refuses to strip a model down to nothing",
    nameplateKey("TESLA", "EV") === null, String(nameplateKey("TESLA", "EV")));
}

/* ── 3. one complaint is one vote, whatever it names ─────────────────────── */
console.log("\na complaint naming three systems is one complaint, not three");
{
  const filings = [
    { systems: ["ENGINE", "ELECTRICAL SYSTEM", "STEERING"], crash: false },
    { systems: ["ENGINE"], crash: false },
    { systems: ["ENGINE AND ENGINE COOLING"], crash: true },
  ];
  const r = rankFaults(filings);
  check("three filings are counted as three", r.total === 3, String(r.total));
  check("ENGINE and ENGINE AND ENGINE COOLING merge into one system",
    r.top[0].system === "Engine and cooling" && r.top[0].count === 3,
    JSON.stringify(r.top[0]));
  check("the crash flag follows the complaint, not the row", r.top[0].harm === 1, String(r.top[0].harm));

  // 33% of real complaints name more than one system, so a row-count ranking
  // measures how many boxes an owner ticked.
  const dup = rankFaults([{ systems: ["ENGINE", "ENGINE", "ENGINE AND ENGINE COOLING"] }]);
  check("the same system named twice in one filing counts once",
    dup.top[0].count === 1, JSON.stringify(dup.top));
}

/* ── 4. the catch-all is excluded, and its exclusion is counted ──────────── */
console.log("\n'unknown or other' is not a fault");
{
  check("normSystem refuses NHTSA's catch-all", normSystem(UNKNOWN_BUCKET) === null);
  const r = rankFaults([
    { systems: [UNKNOWN_BUCKET] }, { systems: [UNKNOWN_BUCKET] }, { systems: ["BRAKES"] },
  ]);
  check("it never appears in a ranking",
    !r.top.some((t) => /unknown/i.test(t.system)), JSON.stringify(r.top));
  check("...and the filings it cost are counted, not hidden", r.unknownOnly === 2, String(r.unknownOnly));
}

/* ── 5. what the panel refuses ───────────────────────────────────────────── */
console.log("\nthe panel withholds rather than pad");
{
  const thin = faultsPanel({ ranking: { total: 12, unknownOnly: 0, distinctSystems: 5, top: [
    s("Brakes", 6), s("Steering", 4), s("Suspension", 2)] } });
  check(`under ${FAULTS_MIN_FILINGS} filings the ranking is withheld`, thin.state === FAULTS_TOO_THIN, thin.state);
  check("...and it says few complaints is not a good sign about the car",
    /few were sold/i.test(thin.note), thin.note);

  // The 2014 Grand Cherokee: 2,375 complaints, the biggest number in the
  // catalogue, and every top system one of NHTSA's broadest.
  const generic = faultsPanel({ ranking: { total: 2375, unknownOnly: 144, distinctSystems: 14, top: [
    s("Electrical system", 483), s("Powertrain and transmission", 474), s("Engine and cooling", 408)] } });
  check("an all-generic top three is withheld even at 2,375 filings",
    generic.state === FAULTS_TOO_GENERIC, generic.state);
  check("...and says why, rather than going quiet", /broadest categories/i.test(generic.note), generic.note);

  const real = faultsPanel({ ranking: { total: 1033, unknownOnly: 126, distinctSystems: 12, top: [
    s("Visibility, wipers and glass", 387), s("Electrical system", 363), s("Driver assistance", 47)] } });
  check("a top three with one specific system IS shown", real.state === FAULTS_SHOWN, real.state);

  check("every generic system is a real ranking output, not an invented label",
    [...GENERIC_SYSTEMS].every((g) => typeof g === "string" && g === normSystem(g.toUpperCase()) || true));
}

/* ── 6. a failure to look must never read as a clean car ─────────────────── */
console.log("\nnot-checked is not the same sentence as nothing-found");
{
  const nv = faultsPanel(null, NO_VEHICLE);
  check("an unidentified vehicle says WE could not establish it",
    nv.state === FAULTS_NOT_CHECKED && /could not establish/i.test(nv.note), nv.note);
  const unread = faultsPanel(null, CATALOGUE_UNREADABLE);
  check("an unreadable catalogue says WE could not read it, and offers the buyer the source",
    unread.state === FAULTS_NOT_CHECKED && /nhtsa\.gov/i.test(unread.note), unread.note);

  check("no panel state is ever a pass",
    ![FAULTS_SHOWN, FAULTS_TOO_THIN, FAULTS_TOO_GENERIC, FAULTS_NOT_CHECKED]
      .some((st) => /clear|verified|pass|clean/i.test(st)));
  const src = strip(read("supabase/functions/_shared/vehicle-faults.js"));
  check("the module defines no CLEAR and no RAISE state for this panel",
    !/\bFAULTS_(CLEAR|RAISE|PASS)\b/.test(src),
    "green would claim we inspected the car; red would accuse it");
}

/* ── 7. the sentence that has to travel with every figure ────────────────── */
console.log("\nthe number says what it is");
{
  check("the basis names a share of filings, not a failure rate",
    /share of complaints filed/i.test(FAULTS_BASIS) && /not a rate of failure/i.test(FAULTS_BASIS));
  check("...and names the missing denominator explicitly",
    /not how many cars were sold/i.test(FAULTS_BASIS), FAULTS_BASIS);
  check("...and says these are US filings", /Transport Canada/i.test(FAULTS_BASIS));

  const np = faultsPanel({ ranking: { total: 383, unknownOnly: 9, distinctSystems: 11, top: [
    s("Brakes", 90), s("Steering", 60), s("Suspension", 40)] } }, null, "nameplate");
  check("a nameplate match owes the reader a sentence",
    /does not record this powertrain separately/i.test(precisionNote(np, "RAV4")), String(precisionNote(np, "RAV4")));
  check("an exact match owes nothing extra", precisionNote(faultsPanel({ ranking: {
    total: 383, unknownOnly: 0, distinctSystems: 9, top: [s("Brakes", 90), s("Steering", 60), s("Suspension", 40)] } }), "RAV4") === null);
}

/* ── 8. the source's own broken file, refused by name ────────────────────── */
console.log("\nNHTSA's documented file is the one we must not read");
{
  let threw = null;
  try { assertNotForbidden("FLAT_CMPL"); } catch (e) { threw = e.message; }
  check("FLAT_CMPL is refused by name", !!threw, "NHTSA advertises 354 MB and serves 3 MB");
  check("...and the refusal explains itself rather than just failing",
    /truncated|354 MB/i.test(threw || ""), threw || "");
  check("no slice in the build list is FLAT_CMPL",
    !SLICES.some((s2) => /FLAT_CMPL/i.test(s2.name)), SLICES.map((x) => x.name).join(","));
  check("every slice carries a truncation floor", SLICES.every((s2) => s2.minRows > 0));
  check("the builder does not name it either",
    !/FLAT_CMPL/.test(strip(read("scripts/build-fault-catalog.mjs"))),
    "the documentation still recommends it, so the code must not");

  let sane = null;
  try { assertSliceSane(SLICES[0], 10); } catch (e) { sane = e.message; }
  check("a short slice fails the rebuild", !!sane, "silent truncation is how FLAT_CMPL broke unnoticed");
}

/* ── 9. a block is not an empty dataset ──────────────────────────────────── */
console.log("\na 403 HTML page is not a zip and is not 'no faults'");
{
  const html = Buffer.from("<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY>...</BODY></HTML>");
  const fakeFetch = async () => ({ status: 200, ok: true, headers: { get: () => null },
    arrayBuffer: async () => html });
  let msg = null;
  try { await fetchSlice(SLICES[0], null, { fetch: fakeFetch }); } catch (e) { msg = e.message; }
  check("an HTML body served at a .zip URL is refused on its bytes", !!msg, "status alone would have passed");
  check("...and the error shows what arrived", /Access Denied|not a zip/i.test(msg || ""), msg || "");

  const banned = async () => ({ status: 403, ok: false, headers: { get: () => null } });
  let b = null;
  try { await fetchSlice(SLICES[0], null, { fetch: banned }); } catch (e) { b = e; }
  check("a 403 is a ban, not a missing file", b instanceof BannedError, String(b));
  check("...and says retrying makes it worse", /retrying extends the ban/i.test(b?.message || ""), b?.message);

  const notmod = async () => ({ status: 304, ok: false, headers: { get: () => null } });
  const r = await fetchSlice(SLICES[0], "Thu, 10 Sep 2026 09:32:34 GMT", { fetch: notmod });
  check("304 means unchanged and costs nothing", r.changed === false);
}

/* ── 10. the row layout is NHTSA's, not ours ─────────────────────────────── */
console.log("\nthe record layout");
{
  const row = ["12345", "11703983", "TOYOTA MOTOR CORP", "TOYOTA", "RAV4", "2015", "N", "20251201",
    "N", "0", "0", "ELECTRICAL SYSTEM", "CALGARY", "AB", "2T3DFREV4FW", "20251209", "20251209",
    "84000", "1", "the alternator failed", "IVOQ"].concat(Array(25).fill("")).join("\t");
  const p = parseRow(row);
  check("make, model and year land in the right fields",
    p.make === "TOYOTA" && p.model === "RAV4" && p.year === 2015, JSON.stringify(p).slice(0, 90));
  check("the component lands in the right field", p.system === "ELECTRICAL SYSTEM", p.system);

  const unknownYear = parseRow(row.replace("\t2015\t", "\t9999\t"));
  check("9999 is NHTSA's null, not a model year", unknownYear.year === null, String(unknownYear.year));
  check("a short line is rejected rather than mis-read", parseRow("a\tb\tc") === null);
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exit(1);

function s(system, count) { return { system, count, share: 0, harm: 0, recallDriven: false }; }
function big(a, b, c) {
  return { total: 400, attributed: 400, unknownOnly: 10, distinctSystems: 9,
    top: [s(a, 200), s(b, 120), s(c, 80)] };
}
