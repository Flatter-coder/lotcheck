// GATE: a branded title must be found, and a rebuilt gearbox must not be one.
//
// WHAT HAPPENED. 2026-09-12, a real customer report for a 2017 Tesla Model X
// never mentioned that the car carries a REBUILT TITLE — because
// analyze-listing-url contained zero references to rebuilt or salvage and the
// status never entered the pipeline. The dealer disclosed it prominently and
// correctly; we simply never read it. It is the most decision-relevant fact on
// that listing: the brand is permanent in Alberta, every future seller must
// disclose it, and it drives insurability, financing, resale and — on an EV —
// whether the manufacturer will still support the car.
//
// THE OPPOSITE ERROR IS WORSE. "Rebuilt transmission", "engine was rebuilt",
// "rebuilt turbo" are ordinary phrases in used listings and say nothing about
// the registration. Reading one as a branded title would invent a permanent,
// value-destroying defect on a clean car and publish it about a named dealer's
// stock. Most of the cases below exist to stop that.
//
// AND SILENCE IS NOT CLEAN. A page that says nothing about the title has told
// us nothing. It must render as a gap with a question attached, never as a
// pass. [[make-recalls-fail-safe]] [[present-without-creating-questions]]
//
// Offline. No network, no database.
//
// Run: npm run test:branded-title

import { readBrandedTitle, brandedTitleLine } from "../supabase/functions/_shared/branded-title.js";

let failed = 0;
const fail = (m, d) => { failed++; console.error(`FAIL  ${m}`); if (d) console.error(`      ${d}`); };
const pass = (m) => console.log(`ok    ${m}`);

const is = (text, want, label) => {
  const r = readBrandedTitle(text);
  if (r.status !== want) fail(`${label}: got "${r.status}", expected "${want}"`, `text: ${String(text).slice(0, 110)}`);
  return r;
};

// ---- 1. THE REAL SENTENCE THAT WAS MISSED ------------------------------
{
  const real = "RECERTIFIED | REBUILT | 2017 Tesla Model X 100D AWD | Electric AWD. " +
    "This unit is RECERTIFIED and carries a REBUILT TITLE due to previous rear-end damage " +
    "(NO STRUCTURAL DAMAGE). All repairs were completed by a licensed autobody and collision " +
    "facility, and the vehicle has passed all Alberta Government inspections.";
  const r = is(real, "branded", "the real xpertsautos listing");
  if (r.status === "branded") {
    if (r.brand !== "rebuilt") fail(`brand should be "rebuilt", got ${JSON.stringify(r.brand)}`);
    else if (!r.quote || !/REBUILT TITLE/i.test(r.quote)) fail("the dealer's own sentence is not quoted back", "a buyer must see what we read, not just a label");
    else pass("the real listing is read as REBUILT and quoted verbatim");
  }
}

// ---- 2. MECHANICAL "REBUILT" IS NOT A TITLE BRAND ----------------------
for (const t of [
  "Rebuilt transmission at 180,000 km, new tires, fresh brakes.",
  "The engine was rebuilt by a certified shop last year.",
  "Recently rebuilt turbo and a new clutch. Clean, well maintained.",
  "Rebuilt differential, rebuilt calipers, service records available.",
  "Motor is rebuilt with receipts.",
  "Rebuilt gearbox, runs and drives excellent.",
]) is(t, "not-stated", "mechanical rebuild must not read as a title brand");
if (!failed) pass("six mechanical-rebuild phrasings are not title brands");

// ---- 3. A DEALER DENYING IT SELLS BRANDED CARS -------------------------
for (const t of [
  "We do not sell salvage or rebuilt vehicles — every unit is inspected.",
  "No salvage, no rebuilt, no stories. Clean units only.",
  "This vehicle is not a salvage or rebuilt title car.",
]) {
  const r = readBrandedTitle(t);
  if (r.status === "branded") fail(`a denial was read as a declaration: ${t}`);
}
if (!failed) pass("a dealer denying it deals in branded cars is never read as declaring one");

// ---- 4. THE BRANDED PHRASINGS WE MUST CATCH ----------------------------
const BRANDED = [
  ["Salvage title, sold as-is, not registrable for road use.", "salvage"],
  ["This vehicle carries a rebuilt title.", "rebuilt"],
  ["Title is branded. Buyer to satisfy themselves.", "branded"],
  ["Reconstructed vehicle — passed provincial inspection.", "reconstructed"],
  ["Declared non-repairable by the insurer.", "non-repairable"],
  ["Previously written off by an insurer and rebuilt to standard.", null],
  ["Vehicle has a salvage brand on its registration.", "salvage"],
];
for (const [t, brand] of BRANDED) {
  const r = is(t, "branded", `branded phrasing: ${t.slice(0, 40)}`);
  if (r.status === "branded" && brand && r.brand !== brand) {
    fail(`brand word wrong for "${t.slice(0, 40)}": got ${JSON.stringify(r.brand)}, expected ${JSON.stringify(brand)}`);
  }
}
if (!failed) pass(`all ${BRANDED.length} branded phrasings are caught and named`);

// ---- 5. AN EXPLICIT CLEAN CLAIM ---------------------------------------
{
  const r = is("Clean title, no accidents, one owner.", "clean", "an explicit clean-title claim");
  if (r.status === "clean") {
    const c = brandedTitleLine(r);
    // It is the SELLER's claim, not a registry search, and the card must say so.
    if (!/seller's own statement|not a registry search/i.test(c.line)) {
      fail("a clean-title claim is presented as if we verified it", "we read the page; we did not search the registry");
    } else pass("a clean claim is attributed to the seller, not to us");
  }
}

// ---- 6. SILENCE IS NOT A PASS -----------------------------------------
{
  const r = is("2019 Honda Odyssey EX-L, 148,000 km, backup camera, heated seats.", "not-stated", "a page that never mentions title");
  const c = brandedTitleLine(r);
  if (c.tone === "pass") fail("silence about the title renders as a PASS", "an absence of a statement is not evidence of a clean title");
  else if (!/NOT a clean bill|not a clean bill/i.test(c.line)) fail("the not-stated card does not say it is not a clean bill");
  else if (!/in writing/i.test(c.line)) fail("the not-stated card does not tell the buyer to get it in writing");
  else pass("silence renders as a gap with a question, never a pass");
}

// ---- 7. TONES ---------------------------------------------------------
{
  const branded = brandedTitleLine(readBrandedTitle("Rebuilt title due to prior collision."));
  if (branded.tone !== "flag") fail(`a branded title must be a flag, got "${branded.tone}"`);
  else if (!/REBUILT TITLE/i.test(branded.value)) fail(`the label must name the brand, got ${JSON.stringify(branded.value)}`);
  else pass("a branded title is a flag and names the brand in the label");

  // Never an accusation: the dealer disclosed it correctly.
  if (/conceal|hid|hiding|failed to disclose|misleading|deceptive/i.test(branded.line)) {
    fail("the branded-title copy accuses the dealer", "the brand is lawful and was disclosed — state the consequences, not a motive");
  } else pass("the copy states consequences without accusing anyone");
}

// ---- 8. junk in, no crash ---------------------------------------------
for (const v of [null, undefined, "", "   ", 42, {}, []]) {
  const r = readBrandedTitle(v);
  if (r.status !== "not-stated") fail(`junk input produced "${r.status}"`, JSON.stringify(v));
}
if (!failed) pass("junk in, not-stated out");

console.log("");
if (failed) { console.error(`${failed} check(s) failed.`); process.exitCode = 1; }
else console.log("branded title: found when stated, never invented from a rebuilt gearbox, silence is not clean.");
