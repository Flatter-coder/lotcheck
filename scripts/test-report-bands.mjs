// GATE: the ten bands, and what they say when a check did not run.
//
// report-bands.js is the model both report surfaces read. Everything the
// Traffic Column design promises rests on it being right:
//
//   - the printed page and the phone show the SAME document, because there is
//     one author for each fact instead of two that already disagree
//   - a rail is a verdict, so a check that never ran gets no rail
//   - the counter names states, never a total that is ten by construction
//
// The empty analysis `{}` is the most important fixture in this file. It is
// what every fallback report path produces, and what an uploaded quote produces
// for the checks it does not implement. Every band it yields must name OUR gap.
//
// Run: npm run test:report-bands

import { reportBands, bandTally, RAISE, CLEAR, NOTED, UNCHECKED, STATE_WORD }
  from "../supabase/functions/_shared/report-bands.js";
import { REPORT_POINTS } from "../supabase/functions/_shared/report-points.js";
import fs from "node:fs";

let failed = 0;
const fail = (m, d) => { failed++; console.error(`FAIL  ${m}`); if (d) console.error(`      ${d}`); };
const ok = (m) => console.log(`ok    ${m}`);
const check = (m, cond, d) => cond ? ok(m) : fail(m, d);

/* Sentences that assert something about the dealer's document, page or conduct,
 * or about the car. None may appear on a band whose check did not run. */
const ATTRIBUTING = [
  [/\b(this|the) listing (does not|doesn't|did not|didn't)\b/i, "asserts what the listing does not say"],
  [/\bno [^.]{0,40}\bwas (listed|shown|published|quoted|on)\b/i, "asserts the dealer omitted something"],
  [/\bnot on (this|the) quote\b/i, "asserts what the quote contained"],
  [/\bwe searched\b/i, "claims we looked"],
  [/\bwe (did not find|didn't find|found no)\b/i, "claims we looked"],
  [/\bthe dealer (does not|doesn't|did not|didn't)\b/i, "asserts dealer conduct"],
  [/\b(isn't|is not) shown\b/i, "asserts what the page shows"],
  [/\b(doesn't|does not) publish\b/i, "asserts what the page publishes"],
];
/* An unchecked band must OWN the gap, not merely avoid blaming anyone.
 * Silence about whose failure it was is how "NOT STATED" reads as the
 * dealer's silence. */
const OWNS_IT = [
  /\bwe (did not|didn't|could not|couldn't|have not|haven't)\b/i,
  /\bwe are not making\b/i, /\bwe're not making\b/i,
  /\bgap in (our|the) (catalogue|read)\b/i,
  /\bsays nothing about the dealer\b/i,
];
const VALUE_OK = /^(NOT CHECKED|NOT READ|NOT CONFIRMED|COULDN'T [A-Z ]+|PRICE READ ONCE|MSRP NOT MATCHED|NO EXACT MSRP MATCH|CHECK ELIGIBILITY|DRIVETRAIN NOT READ|MODEL NOT CONFIRMED)$/;

function auditUnchecked(label, b) {
  const p = [];
  if (!VALUE_OK.test(b.value)) p.push(`value ${JSON.stringify(b.value)} does not name our own gap`);
  for (const [re, why] of ATTRIBUTING) if (re.test(b.note)) p.push(`${why}: ${JSON.stringify(b.note.match(re)[0])}`);
  if (!OWNS_IT.some((re) => re.test(b.note))) p.push("note never says WE could not check");
  check(`${label} · ${b.n} ${b.title}: names our gap`, p.length === 0, p.join("\n      "));
}

/* ── 0. the checker bites ────────────────────────────────────────────────── */
console.log("\npart 0 -- the checker itself");
{
  const planted = { n: "07", title: "VIN check", value: "NOT ON QUOTE", note: "No VIN was listed to check." };
  const p = [];
  if (!VALUE_OK.test(planted.value)) p.push("value");
  for (const [re] of ATTRIBUTING) if (re.test(planted.note)) p.push("note");
  if (!OWNS_IT.some((re) => re.test(planted.note))) p.push("owns");
  if (p.length >= 2) ok(`a planted violation is caught (${p.length})`);
  else { console.error("FATAL the checker no longer catches the 2026-09-12 defect."); process.exit(1); }

  const good = { value: "NOT CHECKED", note: "We did not confirm this dealer against AMVIC's public registry. That says nothing about the dealer." };
  const q = [];
  if (!VALUE_OK.test(good.value)) q.push("value");
  for (const [re] of ATTRIBUTING) if (re.test(good.note)) q.push("note");
  if (!OWNS_IT.some((re) => re.test(good.note))) q.push("owns");
  if (q.length === 0) ok("an honest render is left alone");
  else { console.error("FATAL the checker flags honest copy: " + q.join(",")); process.exit(1); }
}

/* ── 1. the empty analysis ───────────────────────────────────────────────── */
console.log("\npart 1 -- {} : every fallback path, and every uploaded quote");
{
  const b = reportBands({});
  check(`builds all ${REPORT_POINTS.length} bands`, b.length === REPORT_POINTS.length, `got ${b.length}`);
  check("in canonical order", JSON.stringify(b.map((x) => x.key)) === JSON.stringify(REPORT_POINTS.map((p) => p.key)),
    b.map((x) => x.key).join(","));
  check("numbered 01..10", b.every((x, i) => x.n === String(i + 1).padStart(2, "0")), b.map((x) => x.n).join(","));
  check("NOT ONE band claims a verdict", b.every((x) => x.state === UNCHECKED),
    b.filter((x) => x.state !== UNCHECKED).map((x) => `${x.n} ${x.title} -> ${x.state} "${x.value}"`).join("\n      "));
  for (const x of b) auditUnchecked("{}", x);
  const t = bandTally(b);
  check("tally reads 0/0/10", t.raise === 0 && t.clear === 0 && t.unchecked === 10, JSON.stringify(t));
}

/* ── 2. the real defects from 2026-09-12, one fixture each ───────────────── */
console.log("\npart 2 -- the five that reached a paying customer");
{
  // AMVIC: the registry query errored, so dealerLicence was never written.
  const a = reportBands({ dealerName: "XPERTS AUTO SALES LTD" })[3];
  check("04 AMVIC does not say NOT ON QUOTE", a.value !== "NOT ON QUOTE", a.value);
  check("04 AMVIC is unchecked, not a verdict", a.state === UNCHECKED, a.state);
  check("04 AMVIC never asserts what the dealer disclosed",
    !/quote|registry (shows|lists)/i.test(a.value), a.value);

  // VIN on a page we could not read vs one we could.
  const unread = reportBands({})[6];
  const read = reportBands({ feesRead: true })[6];
  check("07 VIN unreadable page -> our gap", unread.state === UNCHECKED && /COULDN'T/.test(unread.value), `${unread.state} "${unread.value}"`);
  check("07 VIN readable page, no VIN -> a real finding", read.state === RAISE, `${read.state} "${read.value}"`);
  check("07 the two states differ", unread.value !== read.value, `both "${unread.value}"`);

  // EV rebate: an unread drivetrain is not a gas car.
  const noFuel = reportBands({})[7];
  const gas = reportBands({ fuelType: "Gas" })[7];
  check("08 unread drivetrain is not reported as gas", !/GAS/.test(noFuel.value), noFuel.value);
  check("08 unread drivetrain is unchecked", noFuel.state === UNCHECKED, noFuel.state);
  check("08 a drivetrain we DID read still renders N/A", /N\/A/.test(gas.value), `${gas.state} "${gas.value}"`);
  check("08 a not-applicable is NOTED, never green", gas.state === NOTED, gas.state);

  // Odometer: a missing MODEL YEAR must not print as the dealer omitting the reading.
  const odo = reportBands({})[5];
  check("06 odometer does not say NOT LISTED", odo.value !== "NOT LISTED", odo.value);

  // Price: never a bare em dash.
  const px = reportBands({ quotedPrice: 34995, priceVerified: true })[0];
  check("01 price is never an em dash", px.value !== "—" && px.value.length > 2, JSON.stringify(px.value));
  check("01 price carries the figure we hold", /34,995/.test(px.note), px.note);
}

/* ── 3. a real answer still renders ──────────────────────────────────────── */
console.log("\npart 3 -- a fully-checked listing still says something");
{
  const full = {
    quotedPrice: 38988, msrp: 37405, msrpBasis: "exact", priceVerified: true, feesRead: true,
    recalls: { checked: true, count: 1, items: [{ system: "Lights And Instruments" }] },
    addOns: [{ verdict: "flagged", price: 1847 }], totalFlaggedCost: 1847,
    dealerLicence: { status: "Issued", state: "valid", registration_number: "B2036047" },
    financingCheck: { checked: true, consistent: true },
    odometerCheck: { checked: true, km: 14820, flag: false },
    vinCheck: { present: true, valid: true, vin: "2T3P1RFV5RW123456" },
    fuelType: "Gas",
    remainingWarranty: { make: "Toyota", modelYear: 2024,
      basic:      { term: "3-year/60,000 km", active: true,  yearsLeft: 1.0, kmLeft: 22000, odometerKnown: true },
      powertrain: { term: "5-year/100,000 km", active: true, yearsLeft: 3.0, kmLeft: 62000, odometerKnown: true },
      corrosion:  { term: "5-year/unlimited", active: true,  yearsLeft: 3.0, kmUnlimited: true, odometerKnown: true } },
    dealerSentiment: { rating: 4.3, reviewCount: 612, checked: true },
  };
  const b = reportBands(full), t = bandTally(b);
  check("nothing is unchecked on a complete scan", t.unchecked === 0,
    b.filter((x) => x.state === UNCHECKED).map((x) => x.n + " " + x.title).join(", "));
  check("01 states the real gap", b[0].value === "+$1,583 OVER", b[0].value);
  check("01 carries a scale for the hero band", !!b[0].hero && !!b[0].scale, JSON.stringify(b[0].scale));
  check("02 raises the open recall", b[1].state === RAISE && b[1].value === "1 OPEN", b[1].value);
  check("04 reads LICENSED, not a bare status", b[3].state === CLEAR && b[3].value === "LICENSED", b[3].value);
  check("07 VIN valid", b[6].state === CLEAR && b[6].value === "VALID", b[6].value);
  check(`tally adds to ${REPORT_POINTS.length}`,
    t.raise + t.clear + t.noted + t.unchecked === REPORT_POINTS.length, JSON.stringify(t));
  // The gas rebate band is NOTED, not green: "no rebate applies to a petrol car"
  // is a true statement and not a thing we verified about this vehicle.
  check("tally is not a constant: 3 raise / 6 verified / 1 noted",
    t.raise === 3 && t.clear === 6 && t.noted === 1, JSON.stringify(t));
}

/* ── 4. the counter can never be ten-by-construction ─────────────────────── */
console.log("\npart 4 -- the counter measures something");
{
  const a = bandTally(reportBands({}));
  const b = bandTally(reportBands({ feesRead: true, vinCheck: { present: true, valid: true }, fuelType: "Gas" }));
  check("two different scans give two different tallies", JSON.stringify(a) !== JSON.stringify(b),
    `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  check("every state has a printable word", [RAISE, CLEAR, UNCHECKED].every((s) => typeof STATE_WORD[s] === "string" && STATE_WORD[s].length),
    JSON.stringify(STATE_WORD));
}

/* ── 5. green is a claim ─────────────────────────────────────────────────── */
console.log("\npart 5 -- green carries its evidence, or it is not green");
{
  // Vic, 2026-09-13: "putting pass in green on report without any data or
  // factual evindence is not acceptble." Six bands were doing exactly that.
  const FIXTURES = [
    ["{}", {}],
    ["page read, nothing else", { feesRead: true }],
    ["petrol car", { fuelType: "Gas" }],
    ["new vehicle", { vehicleCondition: "new" }],
    ["reference payment only", { referenceFinancing: { atAsking: { monthly: 312 } } }],
    ["searched, no reviews", { dealerSentiment: { checked: true } }],
    ["rebate ruled out", { evapRebate: { ineligibleReason: "Used vehicles are not eligible." } }],
  ];
  // An ABSENCE and a NOT-APPLICABLE are both true and neither is a pass.
  const NOT_A_VERIFICATION = /^(NONE\b|NOT ELIGIBLE$|N\/A\b|NO\b)|\/MO REF$/;
  let bad = 0;
  for (const [name, a] of FIXTURES) {
    for (const b of reportBands(a)) {
      if (b.state !== CLEAR) continue;
      if (!b.source) { bad++; fail(`${name} \u00b7 ${b.n} ${b.title}: green with no source`, b.value); }
      if (NOT_A_VERIFICATION.test(b.value)) {
        bad++;
        fail(`${name} \u00b7 ${b.n} ${b.title}: green on an absence or a not-applicable`,
          `"${b.value}" \u2014 true, but nothing was verified. That is NOTED.`);
      }
    }
  }
  if (!bad) ok(`across ${FIXTURES.length} fixtures, every green band names what it was verified against`);

  // And the invariant is structural: a sourceless green cannot be built at all.
  const t = bandTally(reportBands({ feesRead: true }));
  check("a page we merely read produces no green at all", t.clear === 0,
    reportBands({ feesRead: true }).filter((b) => b.state === CLEAR).map((b) => b.n + " " + b.value).join(", "));
  check("...but it is not all unknown either \u2014 what we did read is NOTED",
    t.noted > 0, JSON.stringify(t));

  // AND THE GUARD ITSELF MUST STILL BE THERE. Every fixture above passes with
  // the invariant deleted, because none of them violates it -- so the throw
  // could be removed in one line and nothing would go red until someone later
  // added a sourceless green. Found by injecting exactly that and watching
  // this file stay green. A guard that can be silently deleted is not a guard.
  // [[audit-your-own-fix-same-night]]
  const SRC = fs.readFileSync(new URL("../supabase/functions/_shared/report-bands.js", import.meta.url), "utf8");
  check("reportBands still refuses to build a green band with no source",
    /b\.state === CLEAR && !b\.source/.test(SRC) && /Green must name what it was verified against/.test(SRC),
    "the CLEAR-requires-a-source throw is gone from report-bands.js");
}

/* ── point 01 must answer on a used car ──────────────────────────────────── */
{
  // msrp_catalog held 997 of 1,000 rows at model year 2025-26 on 2026-09-15 and
  // THREE rows for everything older, so every used listing fell through to
  // "MSRP NOT MATCHED" -- the hero band, the reason the report is bought, blank
  // on the whole used market.
  const MV = {
    average: 31500, low: 27900, high: 37500, comps: 14, dealers: 6,
    asOf: "2026-09-07", seenMin: "2026-08-24", seenMax: "2026-09-07",
    yearFrom: 2019, yearTo: 2019, trimScope: "model", condition: "used",
    make: "Subaru", model: "Outback", province: "AB", kmLow: 60000, kmHigh: 140000,
  };
  const used = (ask, mv = MV) => reportBands({
    quotedPrice: ask, priceVerified: true, year: 2019, make: "Subaru",
    model: "Outback", vehicleCondition: "used", marketValue: mv,
  }).find((b) => b.n === "01");

  const above = used(39900), mid = used(36900), below = used(31400);

  check("a used car with comparables gets a real figure, not a catalogue apology",
    !/MSRP NOT MATCHED/.test(String(above.value)) && /ABOVE THE MIDDLE/.test(String(above.value)),
    String(above.value));

  // The v7 light rules, unchanged: green is at-or-below the median, red is
  // above EVERY listing compared, amber is above the median but still inside
  // the range real cars are advertised at.
  check("asking above every comparable is a raise", above.state === "raise", above.state);
  check("asking above the middle but inside the range is NOTED, not red",
    mid.state === "noted", mid.state);
  check("asking at or below the middle is clear", below.state === "clear", below.state);
  check("...and that green names the comparison set it was measured against",
    /comparable listing/.test(String(below.source || "")), String(below.source));

  // THE REFUSAL. Too few comparables must not become a verdict about the price.
  const thin = used(31400, { average: null, insufficient: true, nRead: 2, need: 5 });
  check("too few comparables is never a verdict",
    thin.state === "unchecked" && !/ABOVE|BELOW|MIDDLE/.test(String(thin.value)),
    `${thin.state} ${thin.value}`);

  // An exact manufacturer figure still wins: comps are the fallback, not the
  // replacement. [[reference-point-model]]
  const exact = reportBands({
    quotedPrice: 52000, msrp: 49000, msrpBasis: "exact", priceVerified: true, marketValue: MV,
  }).find((b) => b.n === "01");
  check("an exact MSRP still outranks the comparison set",
    /OVER/.test(String(exact.value)), String(exact.value));

  // The hero scale must have something to draw. It read marketValue.median --
  // a field that does not exist and never has -- so the comps mark had never
  // once rendered.
  check("the scale carries the market median on a used car",
    above.scale && above.scale.comps === 31500 && above.scale.msrp === null,
    JSON.stringify(above.scale));
  check("...and still carries both anchors on a new one",
    exact.scale && exact.scale.msrp === 49000 && exact.scale.comps === 31500,
    JSON.stringify(exact.scale));
}

// ── whose MSRP is it? ───────────────────────────────────────────────────────
// Found by auditing a real report: a 2026 4Runner Hybrid at Okotoks Toyota read
// "The nearest figure we hold is $72,371, and this listing asks $72,371" -- the
// dealer's own stated MSRP, compared against itself, with our name on one side.
// The catalogue holds NO 4Runner row at $72,371. It does hold the hybrid ladder
// from $69,207, and the card offered none of it.
{
  // The REAL listing is in Alberta, so its advertised price is all-in. The
  // fixture carries that, because leaving it off is what let the first draft of
  // this card subtract an ex-freight catalogue figure from an all-in ask.
  const base = { quotedPrice: 72371, make: "Toyota", model: "4Runner Hybrid", year: 2026,
    priceVerified: true, allInPricing: true };
  const card = (a) => reportBands(a).find((b) => b.key === "price_vs_msrp");
  const REF = { msrp: 69207, trim: "4Runner Hybrid", make: "Toyota" };

  const stated = card({ ...base, msrp: 72371, msrpBasis: "dealer_stated", msrpReference: REF });
  check("a dealer-stated MSRP is never called a figure WE hold",
    !/figure we hold/i.test(stated.note), stated.note);
  check("it says whose number it is", /dealer's own figure/i.test(stated.note), stated.note);
  check("and offers the published reference we DO hold",
    stated.note.includes("publishes the 4Runner Hybrid from $69,207"), stated.note);

  // ── THE BASIS RULE ────────────────────────────────────────────────────────
  // $72,371 all-in minus $69,207 ex-freight = $3,164, and Toyota's own Alberta
  // page shows a 4Runner advertised with $1,930 delivery, $100 A/C, $20 tire
  // levy, $10 AMVIC and up to $999 retailer admin INSIDE the figure -- about
  // $3,059 of the $3,164. Publishing that subtraction would have told the buyer
  // in writing that a dealer had marked the car up by mandatory fees they did
  // not set. msrp-claim.ts refuses this comparison; this card must not route
  // around it.
  check("an ALL-IN ask is NOT subtracted from an ex-freight catalogue figure",
    !stated.note.includes("$3,164 above"), stated.note);
  check("...and the refusal says WHY, so silence is not read as 'no gap'",
    /not on the same basis/.test(stated.note), stated.note);

  // Same car, but we hold the manufacturer's OWN all-in for it: now the two
  // sides match and the subtraction is sound.
  const allIn = card({ ...base, msrp: 72371, msrpBasis: "dealer_stated",
    msrpReference: { ...REF, allIn: 72266 } });
  check("with an all-in reference the gap IS worked out",
    allIn.note.includes("$105 above that published all-in price"), allIn.note);
  check("...and it is labelled all-in, so nobody re-reads it as ex-freight",
    /published all-in price/.test(allIn.note), allIn.note);

  // Outside an all-in province the advertised price is ex-fees, so the
  // ex-freight reference is the matching one and the subtraction stands.
  const exFees = card({ ...base, allInPricing: false, msrp: 72371,
    msrpBasis: "dealer_stated", msrpReference: REF });
  check("where the ask is NOT all-in, the ex-freight comparison is sound",
    exFees.note.includes("$3,164 above that published price"), exFees.note);

  // Never invent a reference we do not have.
  const noRef = card({ ...base, msrp: 72371, msrpBasis: "dealer_stated" });
  check("no catalogue reference -> claims none", !/publishes/i.test(noRef.note), noRef.note);

  // An ask BELOW the published base is not an overage.
  const below = card({ ...base, allInPricing: false, quotedPrice: 67000, msrp: 72371,
    msrpBasis: "dealer_stated", msrpReference: REF });
  check("asking under the published base claims no overage",
    !/above that published/i.test(below.note), below.note);
  check("but still names the published figure", below.note.includes("from $69,207"), below.note);

  // A figure we genuinely hold may still be described as ours.
  const ours = card({ ...base, msrp: 69207, msrpBasis: "starting_at" });
  check("a catalogue figure is still 'the nearest figure we hold'",
    /nearest figure we hold/i.test(ours.note), ours.note);
}

console.log("");
if (failed) { console.error(`${failed} failure(s)`); process.exit(1); }
console.log("all checks passed");
