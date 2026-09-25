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
const VALUE_OK = /^(NOT CHECKED|NOT READ|NOT CONFIRMED|COULDN'T [A-Z ]+|PRICE READ ONCE|MSRP NOT MATCHED|NOT ENOUGH TO COMPARE|NOT COMPARED|NO EXACT MSRP MATCH|CHECK ELIGIBILITY|DRIVETRAIN NOT READ|MODEL NOT CONFIRMED)$/;

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
    quotedPrice: 38988, msrp: 37405, msrpBasis: "exact", msrpPriceBasis: "excl_freight", priceVerified: true, feesRead: true,
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

  // A USED CAR NEVER FALLS BACK TO MSRP. 2026-09-25, a used 2024 Civic Sedan
  // Hybrid: 0 like-for-like listings read, so the market was too thin -- and
  // point 01 dropped through to the catalogue and printed "MSRP NOT MATCHED"
  // under the title "Price vs market". A used car has no sticker to miss.
  const civicMv = { average: null, insufficient: true, nRead: 0, need: 5, yearFrom: 2023, yearTo: 2024,
    condition: "used", make: "Honda", model: "Civic Sedan", powertrain: "Hybrid", province: "AB", kmLow: 0, kmHigh: 62000 };
  const civic = reportBands({ quotedPrice: 33500, priceVerified: true, year: 2024, make: "Honda",
    model: "Civic Sedan", vehicleCondition: "used", marketValue: civicMv }).find((b) => b.n === "01");
  check("a used car with too few comparables says so, in the market's own words",
    civic.state === "unchecked" && civic.value === "NOT ENOUGH TO COMPARE", `${civic.state} ${civic.value}`);
  check("...and never mentions MSRP", !/MSRP|manufacturer/i.test(`${civic.value} ${civic.note}`), civic.note);
  auditUnchecked("used, too few comparables", civic);
  const noSet = used(33500, null);
  check("a used car with no comparison set read: not compared, still no MSRP",
    noSet.value === "NOT COMPARED" && !/MSRP|manufacturer/i.test(noSet.note), `${noSet.value} -- ${noSet.note}`);
  auditUnchecked("used, no comparison set", noSet);
  const stated = reportBands({ quotedPrice: 33500, priceVerified: true, vehicleCondition: "used", msrp: 34990,
    msrpBasis: "dealer_stated", marketValue: civicMv }).find((b) => b.n === "01");
  check("a dealer's own MSRP on a used listing does not pull point 01 back to MSRP",
    stated.value === "NOT ENOUGH TO COMPARE" && !/MSRP/.test(stated.note), `${stated.value} -- ${stated.note}`);
  const newCar = reportBands({ quotedPrice: 33500, priceVerified: true, vehicleCondition: "new", marketValue: civicMv }).find((b) => b.n === "01");
  check("a NEW car with no catalogue row still names the catalogue gap",
    newCar.value === "MSRP NOT MATCHED", newCar.value);

  // An exact manufacturer figure still wins: comps are the fallback, not the
  // replacement. [[reference-point-model]]
  const exact = reportBands({
    quotedPrice: 52000, msrp: 49000, msrpBasis: "exact", msrpPriceBasis: "excl_freight", priceVerified: true, marketValue: MV,
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
// ── no VIN and no trim are the SAME gap, and the report has to say so ────
// The 2026 4Runner Hybrid listing published neither. The VIN card explained the
// absence in terms of "recalls or history on this exact car" -- on a car nobody
// has owned, a reason that does not apply -- while the Price vs MSRP card
// separately said it could not pin a configuration. One ask closes both: the VIN
// is what identifies the build, and the build is what the price rests on.
{
  const card = (a, key) => reportBands(a).find((b) => b.key === key);
  const newNoVin = { quotedPrice: 72371, make: "Toyota", model: "4Runner Hybrid", year: 2026,
    priceVerified: true, allInPricing: true, vehicleCondition: "new", feesRead: true,
    msrp: 72371, msrpBasis: "dealer_stated",
    msrpReference: { msrp: 69207, trim: "4Runner Hybrid", make: "Toyota" } };

  const vin = card(newNoVin, "vin");
  check("a NEW car's missing VIN is not explained with used-car history",
    !/recalls or history/i.test(vin.note), vin.note);
  check("...it names what the VIN would actually settle: which build this is",
    /which one you are buying|exact trim, package and options/i.test(vin.note), vin.note);
  check("...and tells the buyer what to ask for, before money moves",
    /build sheet/i.test(vin.note) && /deposit/i.test(vin.note), vin.note);

  const price = card(newNoVin, "price_vs_msrp");
  check("the price card names the VIN as the thing that would close it",
    /publishes no VIN/i.test(price.note), price.note);
  check("...rather than leaving 'we could not pin it' as a dead end",
    /identifies the exact build/i.test(price.note), price.note);

  // A USED car keeps the history sentence -- that IS the right reason there.
  const usedNoVin = { ...newNoVin, vehicleCondition: "used", year: 2021 };
  const uvin = card(usedNoVin, "vin");
  check("a USED car's missing VIN still points at recalls and history",
    /recalls or history/i.test(uvin.note), uvin.note);
  check("...and the used price card does not talk about a new car's VIN",
    !/publishes no VIN/i.test(card(usedNoVin, "price_vs_msrp").note),
    card(usedNoVin, "price_vs_msrp").note);

  // When the VIN IS published there is nothing to ask for.
  const withVin = { ...newNoVin, vinCheck: { present: true, valid: true, vin: "JTEBU5JR0N5123456" } };
  check("a published VIN removes the ask from the price card",
    !/publishes no VIN/i.test(card(withVin, "price_vs_msrp").note),
    card(withVin, "price_vs_msrp").note);
}

if (failed) { console.error(`${failed} failure(s)`); process.exit(1); }

/* part N -- the hero band may not compare across two bases.
 *
 * Every exact-MSRP fixture above declares msrpPriceBasis, because a figure
 * whose freight convention we never captured cannot carry a subtraction. The
 * case below is the one that shipped: an Alberta ALL-IN advertised price
 * against an ex-freight catalogue MSRP, which printed +$3,164 OVER on a car
 * nobody had marked up. It is here as well as in test:freight-basis because
 * this suite is where the hero band is read. */
{
  const allIn = reportBands({
    make: "Toyota", quotedPrice: 72371, msrp: 69207, msrpBasis: "exact", priceVerified: true,
    msrpAllIn: null, allInPricing: { body: "AMVIC" }, vehicleCondition: "new", vinCheck: { present: true },
  }).find((b) => b.n === "01");
  check("the hero band refuses an all-in ask against an ex-freight MSRP",
    allIn.state !== "raise" && !/OVER/.test(String(allIn.value)), `${allIn.state} ${allIn.value}`);
  check("...and never prints the phantom $3,164",
    !allIn.note.includes("3,164"), allIn.note);
  check("...and is NOTED, never CLEAR", allIn.state === "noted", allIn.state);
}

console.log("all checks passed");
