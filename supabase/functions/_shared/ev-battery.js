// ev-battery.js — the battery section of a used-EV report.
//
// Vic, 2026-09-12: "add battery degradation report to the used ev reports".
//
// THE THING THIS MODULE EXISTS TO REFUSE.
//
// We cannot measure a specific car's battery from a VIN and a listing page. Not
// approximately, not with a caveat. State of health is read from the pack's own
// BMS and needs the car in front of you. Two Model X at 200,000 km can differ by
// double-digit percentages of usable capacity depending on how they were charged
// and where they lived.
//
// So the tempting move — take a published fleet curve, apply it to this car's
// odometer, print "estimated 89% health" — is a fabricated number about a named
// vehicle wearing a citation. It is the same failure shape as the warranty row
// that told a buyer a 2020 Model X was out of battery cover at 198,909 km when
// the real term was 240,000 km: a confident figure, derived correctly from the
// wrong premise, about one identifiable car.
// [[no-llm-generated-valuation-numbers]] [[ai-defamation-entity-match-lesson]]
//
// WHAT IT DOES INSTEAD — three parts, never blended, because they carry
// completely different weight and a reader must be able to tell them apart:
//
//   1. THIS CAR, from the catalogue. Pack size, chemistry, charge rates, port,
//      thermal management, battery-warranty terms for its model year. Facts
//      about the vehicle, each with a source.
//   2. WHAT THE PUBLISHED EVIDENCE SAYS about this model class — cited, dated,
//      and labelled as being about a POPULATION, explicitly not a measurement
//      of this car. Never rendered as a number beside this car's odometer.
//   3. HOW TO GET THIS CAR'S REAL NUMBER. The actual instrument, what it is
//      called for this make, who can run it, and what a good and a bad answer
//      sound like. A buyer-advocacy product that hands someone the right
//      question is doing its job, not failing at the other two.
//
// EVERY FIGURE CARRIES ITS SOURCE OR IT DOES NOT RENDER. `requireSourced()`
// below is not a lint — it is the mechanism. A row without a live source URL
// and a read date throws, so an unsourced figure cannot reach a report even if
// someone adds one to the catalogue in a hurry. [[msrp-100-percent-accuracy]]

/**
 * Every published figure must arrive with the page it was read from and the day
 * it was read. A catalogue entry that cannot answer both is not evidence.
 */
export function requireSourced(entry, where) {
  const url = String(entry?.sourceUrl || "");
  const read = String(entry?.readOn || "");
  if (!/^https?:\/\/\S+$/.test(url)) {
    throw new Error(`${where}: every published figure needs a real sourceUrl — got ${JSON.stringify(entry?.sourceUrl)}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(read)) {
    throw new Error(`${where}: every published figure needs readOn as YYYY-MM-DD — got ${JSON.stringify(entry?.readOn)}`);
  }
  return entry;
}

/**
 * Part 1 — what we know about THIS car, from the spec catalogue.
 * Returns null when we hold nothing, which renders as "not established",
 * never as a blank or a guess.
 */
export function batteryFacts(spec) {
  if (!spec) return null;
  const out = [];
  const add = (label, value, note) => { if (value != null && value !== "") out.push({ label, value: String(value), note: note || null }); };
  add("Battery capacity", spec.packKwh ? `${spec.packKwh} kWh` : null, spec.packUsableKwh ? `${spec.packUsableKwh} kWh usable` : null);
  add("Cell chemistry", spec.chemistry, spec.chemistry === "LFP"
    ? "LFP tolerates routine charging to 100% and degrades differently from nickel chemistries — the charging advice for this car is not the usual 80% rule."
    : null);
  add("Thermal management", spec.thermal, spec.thermal === "passive"
    ? "A passively cooled pack ages faster in heat and charges slower in cold than a liquid-cooled one."
    : null);
  add("Max DC fast charge", spec.dcKw ? `${spec.dcKw} kW` : null,
    spec.dcKw && spec.dcKw < 100 ? "Below about 100 kW, a long trip is a materially different experience from a modern EV." : null);
  add("Onboard AC charger", spec.acKw ? `${spec.acKw} kW` : null);
  add("Charge port", spec.port, spec.portNote || null);
  add("Cabin heating", spec.heatPump === true ? "Heat pump" : spec.heatPump === false ? "Resistive" : null,
    spec.heatPump === false ? "Resistive heating draws materially more range in an Alberta winter than a heat pump." : null);
  return out.length ? out : null;
}

/**
 * Part 2 — the published evidence, about the POPULATION.
 *
 * `study` is a catalogue row, not a computation. It is rendered as what it is:
 * a finding about many cars, beside an explicit statement that it is not a
 * measurement of this one. The wording carries that in the sentence itself, so
 * it survives being copied out of the report and pasted somewhere else.
 */
export function degradationContext(study, vehicleLabel) {
  if (!study) return null;
  requireSourced(study, "degradationContext");
  const who = vehicleLabel || "this vehicle";
  return {
    heading: "What the published data says — about the model, not this car",
    body: `${study.finding} That is ${study.population}, published by ${study.publisher} and read ${study.readOn}. `
      + `It describes a GROUP of vehicles. It is not a measurement of ${who}, and it must not be read as one: `
      + `individual packs in the same study varied widely, and how a car was charged and where it lived move the number more than distance does. `
      + `The only figure that describes ${who} is one read from its own battery management system — see below.`,
    sourceUrl: study.sourceUrl,
  };
}

/**
 * Part 3 — how to obtain the real number for THIS car.
 * The instrument differs by make, so the line names it.
 */
const HOW_BY_MAKE = {
  tesla: {
    instrument: "Tesla's own Service Mode battery health test, or a third-party app reading the car's BMS over Bluetooth",
    ask: "Ask the dealer to run a battery health check and send you the result in writing, with the date and the odometer reading on it.",
    good: "A dated report naming the usable capacity now against the original, ideally from a Tesla Service Centre.",
    bad: "\"The range display looks fine.\" The dash estimate is computed from recent driving and is not a capacity measurement.",
  },
  nissan: {
    instrument: "The dashboard capacity bars, plus a LeafSpy-style OBD-II read for the underlying SOH percentage",
    ask: "Ask how many capacity bars the car shows, and ask for an OBD read of state of health with the date on it.",
    good: "A stated SOH percentage and bar count, dated, that you can re-check yourself on a test drive.",
    bad: "Bars alone with no percentage — bars are coarse and a car can lose a lot of capacity inside one bar.",
  },
  default: {
    instrument: "An OBD-II battery health read, or the manufacturer's own battery check at a franchise service department",
    ask: "Ask for a dated battery health report from a franchise dealer for this make, showing usable capacity now against original.",
    good: "A dated document naming the measured capacity and who measured it.",
    bad: "A verbal assurance, or a printout with no date, no odometer and no named tester.",
  },
};

export function howToMeasure(make) {
  const k = String(make || "").trim().toLowerCase();
  return HOW_BY_MAKE[k] || HOW_BY_MAKE.default;
}

/**
 * The whole section. Renders honestly at every level of missing data:
 * no spec -> says so; no study -> omits part 2 entirely rather than reaching for
 * a neighbouring model's curve; never a number about this car.
 */
export function batterySection({ spec, study, make, vehicleLabel, isElectric }) {
  if (!isElectric) return null;
  const facts = batteryFacts(spec);
  const context = study ? degradationContext(study, vehicleLabel) : null;
  const how = howToMeasure(make);

  return {
    title: "Battery",
    // The headline is the honest one, and it leads. A reader who stops here has
    // still been told the single most important thing about a used EV.
    lede: "A used EV's battery is the most valuable part of the car and the one thing a listing never measures. "
      + "Nothing below is a reading from THIS car's battery — that number exists, but only the car can give it, and asking for it is the highest-value question in this whole report.",
    facts,
    factsMissing: facts ? null : "We do not hold verified battery specifications for this model yet, so nothing is stated here rather than estimated.",
    context,
    contextMissing: context ? null : "We have no published degradation study for this model that we can cite, so none is quoted. An uncited figure would be worse than none.",
    howToMeasure: how,
    // Deliberately last: it is the action, and it is what the buyer takes away.
    closing: `${how.ask} A good answer looks like: ${how.good} A poor answer looks like: ${how.bad}`,
  };
}
