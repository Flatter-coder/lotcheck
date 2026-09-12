// GATE: a warranty label must name what is left, and a hedged row must refuse.
//
// Two real defects, both found on a real customer report (LC-BDA3-B85, a 2020
// Tesla Model X at 198,909 km, 2026-09-12).
//
// DEFECT 1 — A HEDGED ROW RENDERED AS A CONFIDENT NUMBER.
// manufacturer_warranties holds ONE basic/powertrain/corrosion string per MAKE.
// Whoever populated the Tesla row knew that was not enough and wrote
// "8-year/160,000 km (battery & drive unit, varies by model)". The parser read
// past the parenthetical, took the 160,000, and published it as this car's
// number. It was wrong in BOTH directions on the two cars that exposed it:
//   * 2020 Model X — real term 8yr/240,000 km. We said the car was past its cap
//     at 198,909 km. It had 41,091 km of headroom. A false negative on the most
//     expensive component on the vehicle, told against the buyer.
//   * 2017 Model X — real term 8 years, NO distance cap. We invented a 160,000
//     km limit and would have killed a warranty the odometer cannot affect.
// Both are stated-as-fact claims about a named vehicle: the exposure shape in
// [[ai-defamation-entity-match-lesson]]. The hedge must REFUSE, not annotate.
//
// DEFECT 2 — "PASS / COVER REMAINING" OVER A CAR WITH ONLY CORROSION LEFT.
// Vic, 2026-09-12: "always explain reming warrynity is appliying for corroriosn
// to make awre client". Everywhere else in the report FLAG means bad and PASS
// means fine, so a buyer skimming the traffic lights read that card as "still
// under warranty" while the battery and drive unit — the expensive half — were
// the half that had gone. Corrosion is the LAST cover to expire on nearly every
// make (7-12 years, usually unlimited distance), so it is the one still
// standing on exactly the old high-kilometre cars where the buyer most needs to
// know the powertrain is naked. The generic label is at its most misleading
// precisely where it matters most. [[warranty-remaining-name-the-component]]
//
// Offline. No network, no database.
//
// Run: npm run test:warranty-labels

import { computeRemainingWarranty } from "../supabase/functions/_shared/warranty.ts";
import { warrantyLine } from "../supabase/functions/_shared/report-lines.js";

let failed = 0;
const fail = (m, d) => { failed++; console.error(`FAIL  ${m}`); if (d) console.error(`      ${d}`); };
const pass = (m) => console.log(`ok    ${m}`);

const line = (row, year, km, make = "Tesla") => {
  const rw = computeRemainingWarranty(row, year, km, 2026);
  if (rw) rw.make = make;
  return warrantyLine({ vehicleCondition: "used", remainingWarranty: rw });
};

const CORROSION = "12-year/unlimited km";

// ---- 1. THE ROW THAT REACHED A CUSTOMER --------------------------------
// Verbatim from production on 2026-09-12. It must never again produce a figure.
{
  const w = line({
    basic_coverage: "4-year/80,000 km",
    powertrain_coverage: "8-year/160,000 km (battery & drive unit, varies by model)",
    corrosion_coverage: CORROSION,
  }, 2020, 198909);

  if (w.value !== "CANNOT STATE") {
    fail(`the live hedged Tesla row still publishes a verdict: ${JSON.stringify(w.value)}`,
      "a row whose own text says it varies by model cannot answer for one model");
  } else if (w.tone === "pass") {
    fail("a refusal is rendered as a pass");
  } else if (!/varies by model/i.test(w.line)) {
    fail("the refusal does not quote the hedge it is refusing on",
      "the buyer must be able to see WHY we will not answer");
  } else {
    pass("the hedged row that reached a customer now refuses to state a figure");
  }

  // The specific false negative: it must not assert the cover has run out.
  if (/run out|expired|LIKELY EXPIRED/i.test(w.value + " " + w.line)) {
    fail("the hedged row still asserts the cover has expired",
      "at 198,909 km against the REAL 240,000 km term this car had 41,091 km left");
  } else pass("it no longer claims the powertrain cover has run out");
}

// ---- 2. hedges in every shape we have seen or can expect ----------------
for (const hedge of [
  "8-year/160,000 km (battery & drive unit, varies by model)",
  "5-year/100,000 km, varies by trim",
  "8 years/160,000 km depending on model",
  "6-year/110,000 km — check with dealer",
  "model-specific: 8-year/160,000 km",
]) {
  const w = line({ basic_coverage: "4-year/80,000 km", powertrain_coverage: hedge, corrosion_coverage: CORROSION }, 2020, 100000);
  if (w.value !== "CANNOT STATE") { fail(`hedge not caught: ${JSON.stringify(hedge)}`, `rendered as ${w.value}`); break; }
}
if (!failed) pass("every hedge phrasing refuses");

// ---- 3. CORROSION ONLY IS NAMED, AND IS NOT A PASS ---------------------
{
  // 2017 @ 254,473 km: basic and powertrain both long gone, corrosion alive.
  const w = line({
    basic_coverage: "4-year/80,000 km",
    powertrain_coverage: "8-year/unlimited km",
    corrosion_coverage: CORROSION,
  }, 2017, 254473);

  if (!/CORROSION ONLY/i.test(w.value)) {
    fail(`corrosion-only is not named in the label: ${JSON.stringify(w.value)}`,
      "a buyer reads the label, not the paragraph — Vic, 2026-09-12");
  } else pass("corrosion-only is named in the label");

  if (w.tone === "pass") {
    fail("corrosion-only still renders as a PASS",
      "FLAG means bad and PASS means fine everywhere else in this report; rust-through cover " +
      "on a car with a naked drivetrain is not a pass");
  } else pass("corrosion-only is not a pass");

  // And it must say what corrosion cover does NOT pay for.
  if (!/does NOT pay|rust-through|perforation/i.test(w.line)) {
    fail("the corrosion-only body never explains what that cover excludes");
  } else pass("it spells out what corrosion cover does not pay for");
}

// ---- 4. a genuinely covered car still reads as covered, and names both --
{
  // The CORRECT Model X term. 2020 @ 198,909 km -> 41,091 km of headroom.
  const w = line({
    basic_coverage: "4-year/80,000 km",
    powertrain_coverage: "8-year/240,000 km",
    corrosion_coverage: CORROSION,
  }, 2020, 198909);

  if (w.tone !== "pass") fail(`a car with live powertrain cover is not a pass: tone=${w.tone}`);
  else if (!/POWERTRAIN/i.test(w.value)) fail(`the label does not name powertrain: ${JSON.stringify(w.value)}`);
  else if (!/CORROSION/i.test(w.value)) fail(`the label names powertrain but drops corrosion: ${JSON.stringify(w.value)}`);
  else pass(`live powertrain cover reads as a pass and names both: ${w.value}`);

  // The regression that started all this: it must NOT say the cover ran out.
  if (/powertrain cover looks to have run out/i.test(w.line)) {
    fail("still claims the powertrain cover ran out on a car that has 41,091 km left");
  } else pass("it does not claim a live cover has expired");
}

// ---- 5. everything expired still says so plainly -----------------------
{
  const w = line({ basic_coverage: "3-year/60,000 km", powertrain_coverage: "5-year/100,000 km", corrosion_coverage: "5-year/unlimited km" }, 2010, 300000);
  if (!/EXPIRED/i.test(w.value)) fail(`a fully-expired car does not say so: ${JSON.stringify(w.value)}`);
  else if (w.tone === "pass") fail("a fully-expired warranty renders as a pass");
  else pass("a fully-expired warranty says so and is not a pass");
}

// ---- 6. the expired half is always named -------------------------------
// Listing only the LIVE terms let a car whose comprehensive cover had expired
// read as fully covered, because the expired line simply was not mentioned.
{
  const w = line({ basic_coverage: "4-year/80,000 km", powertrain_coverage: "10-year/160,000 km", corrosion_coverage: CORROSION }, 2019, 90000);
  if (!/comprehensive cover looks to have run out|comprehensive and/i.test(w.line)) {
    fail("the expired comprehensive cover is not named", "what has gone is a finding, not an omission");
  } else pass("the expired coverage is named alongside what remains");
}

console.log("");
if (failed) { console.error(`${failed} check(s) failed.`); process.exitCode = 1; }
else console.log("warranty labels: hedges refuse, corrosion-only is named and flagged.");
