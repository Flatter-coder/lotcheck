// GATE: the battery section must never put a number on THIS car's pack.
//
// Vic asked for a battery degradation report in used-EV reports. The honest
// version of that is three things kept separate — what this car IS (catalogue
// facts), what the published evidence says about the MODEL (cited, about a
// population), and how to get this car's REAL number (the instrument, by make).
//
// THE REGRESSION THIS EXISTS TO STOP is the fourth thing, the one that looks
// like an improvement: take a published fleet curve, apply it to this car's
// odometer, print "estimated 89% battery health". It reads as rigour. It is a
// fabricated figure about one identifiable vehicle, and it is the same shape as
// the warranty row that told a buyer a 2020 Model X was out of battery cover at
// 198,909 km when the real term was 240,000 km — a confident number, derived
// correctly from the wrong premise, about a named car.
//
// Two Model X at 200,000 km can differ by double-digit percentages of usable
// capacity depending on charging habits and climate. No curve closes that gap.
// Only the car's own BMS can. [[no-llm-generated-valuation-numbers]]
//
// Offline. No network, no database.
//
// Run: npm run test:ev-battery

import { requireSourced, batteryFacts, degradationContext, howToMeasure, batterySection } from "../supabase/functions/_shared/ev-battery.js";

let failed = 0;
const fail = (m, d) => { failed++; console.error(`FAIL  ${m}`); if (d) console.error(`      ${d}`); };
const pass = (m) => console.log(`ok    ${m}`);
const threw = (fn) => { try { fn(); return false; } catch { return true; } };

const STUDY = {
  finding: "Packs retained a median of 90% of original capacity at 200,000 km.",
  population: "across 15,000 vehicles of mixed make",
  publisher: "Some Institute",
  sourceUrl: "https://example.org/ev-degradation-study",
  readOn: "2026-09-12",
};

// ---- 1. AN UNSOURCED FIGURE CANNOT RENDER --------------------------------
{
  const noUrl = { ...STUDY, sourceUrl: "" };
  const badUrl = { ...STUDY, sourceUrl: "see the study" };
  const noDate = { ...STUDY, readOn: "" };
  const vagueDate = { ...STUDY, readOn: "September 2026" };
  const all = [noUrl, badUrl, noDate, vagueDate];
  if (!all.every((s) => threw(() => degradationContext(s, "this car")))) {
    fail("a study without a real source URL and read date still rendered",
      "the source requirement is the mechanism, not a lint — an unsourced figure must not reach a report");
  } else pass("a study with no URL, a fake URL, no date or a vague date all REFUSE to render");

  if (!threw(() => requireSourced({}, "t"))) fail("requireSourced accepted an empty entry");
  else pass("requireSourced rejects an empty entry");
}

// ---- 2. THE POPULATION DISCLAIMER IS IN THE SENTENCE ----------------------
// Not in a footnote, not in a tooltip — in the body text, so it survives being
// copied out of the report and pasted into an email.
{
  const c = degradationContext(STUDY, "this 2017 Model X");
  if (!c) { fail("a properly sourced study did not render"); }
  else {
    if (!/not a measurement of this 2017 Model X/i.test(c.body)) {
      fail("the context does not say, in the body, that it is not a measurement of this car");
    } else pass("the population disclaimer names the specific car, in the body text");

    if (!/GROUP|population/i.test(c.body)) fail("the context never says it describes a group");
    else pass("the context states it describes a group of vehicles");

    if (!/varied widely|charged|lived/i.test(c.body)) {
      fail("the context does not explain WHY the fleet figure cannot be applied to one car");
    } else pass("it explains why the fleet figure does not transfer to one car");

    if (c.sourceUrl !== STUDY.sourceUrl) fail("the source URL is not carried through to the reader");
    else pass("the source URL reaches the reader");
  }
}

// ---- 3. NO PER-VEHICLE PERCENTAGE, ANYWHERE IT COULD BE MISREAD -----------
// The facts block describes the car. If a health percentage ever appears there,
// something has started estimating.
{
  // ODOMETER IS DELIBERATELY PRESENT. The first version of this test omitted it,
  // so the estimating regression — `if (spec.odometerKm) facts.push({ health })`
  // — never fired and the gate passed while the defect was live. A gate that
  // cannot fail on the thing it was written for is not a gate.
  const spec = { packKwh: 100, chemistry: "NMC", dcKw: 120, acKw: 11, port: "NACS", heatPump: false, thermal: "liquid", odometerKm: 254473, modelYear: 2017 };
  const s = batterySection({ spec, study: STUDY, make: "Tesla", vehicleLabel: "this 2017 Model X", isElectric: true });

  // Scan EVERY per-vehicle surface, not just the two I thought of. The context
  // block is exempt: it quotes a study and is explicitly about a population.
  const perVehicle = [
    ...(s.facts || []).map((f) => `${f.label} ${f.value} ${f.note || ""}`),
    s.closing, s.lede, s.factsMissing || "", s.title,
  ].join(" | ");
  const pct = perVehicle.match(/\d{1,3}(?:\.\d+)?\s*%/g);
  if (pct) {
    fail(`a percentage reached a per-vehicle surface: ${pct.join(", ")}`,
      "nothing about THIS car's pack can be expressed as a percentage — only its own BMS can produce one");
  } else pass("no percentage reaches any per-vehicle surface");

  // And nothing may be labelled as an estimate of health, percentage or not.
  if (/estimated .{0,20}(health|capacity|degradation|soh)/i.test(perVehicle)) {
    fail("the section presents an ESTIMATE of this car's battery health",
      "a fleet curve applied to one odometer is a fabricated figure about a named vehicle");
  } else pass("nothing is presented as an estimate of this car's health");

  // The lede must say plainly that nothing here is a reading from this car.
  if (!/Nothing below is a reading from THIS car/i.test(s.lede)) {
    fail("the lede does not disclaim that nothing is measured from this car");
  } else pass("the lede disclaims measurement up front");
}

// ---- 4. MISSING DATA IS STATED, NOT PAPERED OVER --------------------------
{
  const bare = batterySection({ isElectric: true, make: "Tesla", vehicleLabel: "this car" });
  if (bare.facts !== null || !bare.factsMissing) fail("no catalogue data did not produce an explicit 'not held' line");
  else if (!/rather than estimated/i.test(bare.factsMissing)) fail("the missing-facts line does not say we declined to estimate");
  else pass("no specs -> says so, and says it declined to estimate");

  if (bare.context !== null || !bare.contextMissing) fail("no study did not produce an explicit 'none cited' line");
  else if (!/uncited figure would be worse than none/i.test(bare.contextMissing)) {
    fail("the missing-context line does not explain why nothing is quoted");
  } else pass("no citable study -> quotes nothing, and says why");

  // It must still hand the buyer the action even with zero data.
  if (!bare.howToMeasure?.ask || !bare.closing) fail("with no data the section gives the buyer nothing to do");
  else pass("even with no data, the buyer still gets the question to ask");
}

// ---- 5. a petrol car gets no battery section ------------------------------
{
  if (batterySection({ isElectric: false, make: "Honda" }) !== null) fail("a non-EV got a battery section");
  else pass("a non-EV gets no battery section");
}

// ---- 6. the instrument is make-specific -----------------------------------
{
  const tesla = howToMeasure("Tesla"), nissan = howToMeasure("Nissan"), kia = howToMeasure("Kia");
  if (tesla.ask === nissan.ask) fail("Tesla and Nissan get the same instruction", "the instrument differs by make and the line must name it");
  else pass("the instrument is named per make");
  if (!/bar/i.test(nissan.ask + nissan.bad)) fail("the Nissan line never mentions capacity bars");
  else pass("Nissan's line covers the capacity-bar trap");
  if (!kia.ask) fail("an unlisted make got no instruction at all");
  else pass("an unlisted make falls back to a usable instruction");
  // Every make must warn about the worthless answer.
  for (const [n, h] of [["tesla", tesla], ["nissan", nissan], ["default", kia]]) {
    if (!h.bad || h.bad.length < 20) { fail(`${n} has no "what a bad answer sounds like"`); break; }
  }
  if (!failed) pass("every make names what a poor answer sounds like");
}

// ---- 7. chemistry-specific advice is not generic --------------------------
{
  const lfp = batteryFacts({ packKwh: 60, chemistry: "LFP" });
  const note = (lfp || []).find((f) => f.label === "Cell chemistry")?.note || "";
  if (!/100%|not the usual 80/i.test(note)) {
    fail("LFP gets the same charging advice as a nickel pack", "LFP tolerates routine 100% charging; the usual 80% rule is wrong for it");
  } else pass("LFP gets chemistry-correct charging advice");
}

console.log("");
if (failed) { console.error(`${failed} check(s) failed.`); process.exitCode = 1; }
else console.log("EV battery: sourced or silent, never a number about this car's pack.");
