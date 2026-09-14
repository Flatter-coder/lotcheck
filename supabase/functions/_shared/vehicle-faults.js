/* What owners reported to the US safety regulator.
 *
 * ONE AUTHOR for what this panel says, read by the on-screen report, the emailed
 * PDF and the catalogue builder. [[two-authors-per-fact]]
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS PANEL REFUSES MORE OFTEN THAN IT SPEAKS
 *
 * Vic asked for "the 3 most common faults" on every used vehicle, MY2025 back to
 * 1995. An adversarial pass over the real corpus (192,200 rows, 7,083
 * year|make|model cells) refused that framing on measured grounds:
 *
 *   - only 19% of cells (1,314/7,083) hold enough filings to rank at all
 *   - 44% of those rankable cells produce a top-3 built ENTIRELY from generic
 *     catch-alls, and 168 different vehicles receive the identical answer
 *     "Electrical System + Engine + Unknown or Other"
 *   - "UNKNOWN OR OTHER" appears in 49% of top-3s and is the #1 "fault" in 9%
 *   - 58% of rankings FLIP when same-family buckets are merged, so the answer is
 *     a property of NHTSA's labelling and our grouping, not of the car
 *   - there is no exposure denominator anywhere in the 51-field layout, so raw
 *     counts track units sold (2022 Silverado 643, Corolla 54, Mirage 0)
 *
 * So this is not a reliability ranking and must never be dressed as one. It is a
 * count of safety complaints filed with one regulator, and it is shown only when
 * it says something a buyer could not have guessed. Everywhere else it says so.
 * [[design-must-be-self-explanatory]] [[present-without-creating-questions]]
 *
 * AND IT NEVER CLEARS A CAR. There is no CLEAR state below and no RAISE state:
 * green would claim we verified the vehicle, which we did not, and red would be
 * an adverse claim about a car nobody has inspected. [[no-accusation-language]]
 */

export const FAULTS_MIN_FILINGS = 30;   // below this a ranking is noise
export const FAULTS_MIN_SYSTEMS = 3;    // fewer than three distinct systems is not a top-three
export const RECALL_SHARE = 0.5;        // a system this recall-dominated belongs to point 02

/* Official ODI component strings that name the SAME system to a buyer.
 * NHTSA's own record layout concedes the drift, verbatim: "Manufacturer name,
 * make, model and component name of the product(s) in a complaint may have
 * changed over time and the new flat file will now reflect them." Measured: the
 * MY1998-2003 label is ENGINE AND ENGINE COOLING and the MY2015+ label is
 * ENGINE, so a 1995-2025 catalogue mixes eras. Left unmerged, 11% of vehicles
 * print two buckets of one family in the same top-three -- a visibly broken line
 * such as "ENGINE | ENGINE AND ENGINE COOLING | POWER TRAIN".
 */
export const SYSTEM_GROUP = {
  "ENGINE": "Engine and cooling",
  "ENGINE AND ENGINE COOLING": "Engine and cooling",
  "ENGINE COOLING SYSTEM": "Engine and cooling",
  "POWER TRAIN": "Powertrain and transmission",
  "POWER TRAIN:AUTOMATIC TRANSMISSION": "Powertrain and transmission",
  "POWER TRAIN:MANUAL TRANSMISSION": "Powertrain and transmission",
  "POWER TRAIN:AXLE ASSEMBLY": "Powertrain and transmission",
  "FUEL SYSTEM": "Fuel and propulsion",
  "FUEL/PROPULSION SYSTEM": "Fuel and propulsion",
  "FUEL SYSTEM, GASOLINE": "Fuel and propulsion",
  "FUEL SYSTEM, DIESEL": "Fuel and propulsion",
  "FUEL SYSTEM, OTHER": "Fuel and propulsion",
  "SERVICE BRAKES": "Brakes",
  "SERVICE BRAKES, HYDRAULIC": "Brakes",
  "SERVICE BRAKES, AIR": "Brakes",
  "HYDRAULIC": "Brakes",
  "PARKING BRAKE": "Brakes",
  "ELECTRICAL SYSTEM": "Electrical system",
  "ELECTRICAL SYSTEM:BATTERY": "Electrical system",
  "STEERING": "Steering",
  "SUSPENSION": "Suspension",
  "VISIBILITY": "Visibility, wipers and glass",
  "VISIBILITY/WIPER": "Visibility, wipers and glass",
  "AIR BAGS": "Airbags",
  "AIR BAGS:FRONTAL": "Airbags",
  "AIR BAGS:SIDE/WINDOW": "Airbags",
  "SEAT BELTS": "Seat belts",
  "SEATS": "Seats",
  "STRUCTURE": "Body and structure",
  "STRUCTURE:BODY": "Body and structure",
  "STRUCTURE:FRAME AND MEMBERS": "Body and structure",
  "EXTERIOR LIGHTING": "Exterior lighting",
  "EXTERIOR LIGHTING:HEADLIGHTS": "Exterior lighting",
  "VEHICLE SPEED CONTROL": "Speed control",
  "WHEELS": "Wheels and tyres",
  "TIRES": "Wheels and tyres",
  "LATCHES/LOCKS/LINKAGES": "Latches and locks",
  "EQUIPMENT": "Equipment",
  "EQUIPMENT:OTHER:LABELS": "Equipment",
  "FORWARD COLLISION AVOIDANCE": "Driver assistance",
  "FORWARD COLLISION AVOIDANCE:ADAPTIVE CRUISE CONTROL": "Driver assistance",
  "FORWARD COLLISION AVOIDANCE:AUTOMATIC EMERGENCY BRAKING": "Driver assistance",
  "FORWARD COLLISION AVOIDANCE:WARNINGS": "Driver assistance",
  "LANE DEPARTURE": "Driver assistance",
  "LANE DEPARTURE:ASSIST": "Driver assistance",
  "LANE DEPARTURE:WARNING": "Driver assistance",
  "ELECTRONIC STABILITY CONTROL": "Driver assistance",
  "TRACTION CONTROL SYSTEM": "Driver assistance",
  "BACK OVER PREVENTION": "Driver assistance",
  "BACK OVER PREVENTION:SENSING SYSTEM:CAMERA": "Driver assistance",
  "AIR BAGS:SENSOR:CONTROL MODULE": "Airbags",
  "TRAILER HITCHES": "Trailer hitch",
  "VEHICLE SPEED CONTROL:ACCELERATOR PEDAL": "Speed control",
  "VEHICLE SPEED CONTROL:CRUISE CONTROL": "Speed control",
};

/* NHTSA's own catch-all. 10% of all vehicle rows, the 4th most common bucket
 * overall -- it outranks brakes, steering and airbags. Printing "Unknown or
 * other -- 20%" as a top fault tells a buyer nothing and reads like a finding.
 * Excluded, and the exclusion is DISCLOSED on the card rather than done quietly.
 */
export const UNKNOWN_BUCKET = "UNKNOWN OR OTHER";

/* Systems so broad that three of them together say nothing specific to a car.
 * The suppression rule below uses this: a top-three drawn entirely from these is
 * the answer 168 different vehicles share, and it is withheld rather than sold.
 */
export const GENERIC_SYSTEMS = new Set([
  "Engine and cooling", "Electrical system", "Powertrain and transmission",
  "Fuel and propulsion", "Equipment",
]);

/* CMPL_TYPE values NHTSA defines as recall-driven: "RC = RECALL COMPLAINT,
 * RESULT OF A RECALL INVESTIGATION" and "RP = RECALL PETITION". Structured, so
 * it beats guessing from narrative text -- though narrative matching is still
 * needed for campaigns like Takata, filed by owners as ordinary questionnaires.
 */
export const RECALL_TYPES = new Set(["RC", "RP"]);
export const RECALL_WORDS = /\b(recall|takata|campaign\s*(?:no|number|#))\b/i;

export function normSystem(compdesc) {
  const raw = String(compdesc || "").trim().toUpperCase();
  if (!raw || raw === UNKNOWN_BUCKET) return null;
  if (SYSTEM_GROUP[raw]) return SYSTEM_GROUP[raw];
  // An unmapped label keeps NHTSA's own words rather than being dropped: a
  // silent drop would quietly reshape the ranking, which is the thing this
  // module exists to stop.
  const head = raw.split(":")[0].trim();
  return SYSTEM_GROUP[head] || titleCase(head);
}

function titleCase(s) {
  return String(s).toLowerCase().replace(/(^|[\s/(-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
}

/* Rank the systems for ONE year|make|model cell.
 *
 * `filings` is one entry per COMPLAINT (not per component row). NHTSA repeats
 * ODINO across components -- 1.48 rows per complaint, and 33% of complaints name
 * more than one system -- so counting rows would over-weight vehicles whose
 * owners tick more boxes. That is reporting style, not failure rate. The caller
 * groups by ODINO first; this function requires it and says so.
 */
export function rankFaults(filings, limit = 3) {
  return rankTally(tallyFilings(filings), limit);
}

/* ONE ranking function, two entry points.
 *
 * The bulk builder cannot hold 2.1 million complaint objects in memory, so it
 * folds each slice into a TALLY and sums tallies across slices -- which is exact,
 * because an ODINO is received once and therefore appears in exactly one slice.
 * The API path has whole filings. Both end up in rankTally, so the ranking a
 * buyer sees can never depend on which road the data took.
 * [[two-authors-per-fact]]
 */
export function emptyTally() {
  return { systems: Object.create(null), total: 0, unknownOnly: 0 };
}

export function tallyFilings(filings) {
  const t = emptyTally();
  for (const f of filings || []) {
    t.total++;
    const systems = [...new Set((f.systems || []).map(normSystem).filter(Boolean))];
    if (!systems.length) { t.unknownOnly++; continue; }
    const harmed = !!(f.crash || f.fire || (f.injured || 0) > 0 || (f.deaths || 0) > 0);
    for (const s of systems) addTo(t, s, harmed, !!f.recall);
  }
  return t;
}

export function addTo(t, system, harmed, recall) {
  const e = t.systems[system] || (t.systems[system] = { count: 0, harm: 0, recall: 0 });
  e.count++;
  if (harmed) e.harm++;
  if (recall) e.recall++;
}

export function mergeTally(into, from) {
  into.total += from.total;
  into.unknownOnly += from.unknownOnly;
  for (const [s, e] of Object.entries(from.systems)) {
    const d = into.systems[s] || (into.systems[s] = { count: 0, harm: 0, recall: 0 });
    d.count += e.count; d.harm += e.harm; d.recall += e.recall;
  }
  return into;
}

export function rankTally(t, limit = 3) {
  const ranked = Object.entries(t.systems)
    .map(([system, e]) => ({ system, ...e }))
    .sort((a, b) => b.count - a.count || a.system.localeCompare(b.system));
  const attributed = ranked.reduce((n, r) => n + r.count, 0);
  return {
    total: t.total,
    attributed,
    unknownOnly: t.unknownOnly,
    distinctSystems: ranked.length,
    top: ranked.slice(0, limit).map((r) => ({
      system: r.system,
      count: r.count,
      share: attributed ? Math.round((100 * r.count) / attributed) : 0,
      harm: r.harm,
      recallDriven: r.count > 0 && r.recall / r.count >= RECALL_SHARE,
    })),
  };
}

export const FAULTS_TITLE = "What owners reported to the safety regulator";

/* The states this panel may take. Deliberately three, and deliberately without
 * CLEAR or RAISE -- see the header.
 */
export const FAULTS_SHOWN = "shown";
export const FAULTS_TOO_THIN = "too_thin";
export const FAULTS_TOO_GENERIC = "too_generic";
export const FAULTS_NOT_CHECKED = "not_checked";

/* Decide what the panel says for one vehicle.
 *
 * `cat` is the catalogue row (or null). `reason` explains a null: a missing row
 * because nothing was found is NOT the same as a missing row because the lookup
 * failed, and the second must never render as the first.
 * [[supervised-correctness-is-not-correctness]]
 */
export function faultsPanel(cat, reason = null, precision = "exact") {
  if (!cat) {
    return panel(FAULTS_NOT_CHECKED, null, reason === "no_vehicle"
      ? "We could not establish the year, make and model firmly enough to look this up."
      : "We could not read the safety-complaint record for this vehicle. Search it yourself by year, make and model at nhtsa.gov/complaints.");
  }
  const r = cat.ranking || {};
  const top = r.top || [];

  if ((r.total || 0) < FAULTS_MIN_FILINGS) {
    return panel(FAULTS_TOO_THIN, cat,
      `Only ${r.total || 0} complaint${(r.total || 0) === 1 ? " has" : "s have"} been filed about this model year. ` +
      "That is too few to rank what goes wrong, so no ranking is shown. Few complaints is not evidence of a good car — " +
      "it is most often evidence that few were sold.", precision);
  }
  if (top.length < FAULTS_MIN_SYSTEMS || r.distinctSystems < FAULTS_MIN_SYSTEMS) {
    return panel(FAULTS_TOO_THIN, cat,
      "The filings on this model year do not name three distinct systems, so there is no top three to show.", precision);
  }
  if (top.every((t) => GENERIC_SYSTEMS.has(t.system))) {
    return panel(FAULTS_TOO_GENERIC, cat,
      "Every one of the three most-named systems here is one of NHTSA's broadest categories — the same answer " +
      "given for scores of unrelated vehicles. It would tell you nothing specific about this car, so it is not shown.", precision);
  }
  return panel(FAULTS_SHOWN, cat, null, precision);
}

function panel(state, cat, note, precision = "exact") {
  return {
    key: "reported_faults",
    // "exact" means NHTSA holds this exact model. "nameplate" means they do not
    // separate this powertrain and the figures cover every variant of the
    // nameplate -- which the card MUST say, or the buyer reads a number about a
    // different set of cars than the one in front of them.
    precision,
    title: FAULTS_TITLE,
    state,
    note,
    // About the MODEL YEAR. Stated in the object so no surface can forget it.
    scope: "model_year",
    top: state === FAULTS_SHOWN ? (cat.ranking.top || []) : [],
    total: cat ? cat.ranking?.total ?? null : null,
    unknownOnly: cat ? cat.ranking?.unknownOnly ?? null : null,
    // Freshness is NHTSA's, never our job's run time. A slice of this corpus was
    // 36 days stale while the publisher's page still claimed daily updates, so a
    // date taken from our own cron would be a false claim about their data.
    // [[live-data-green-dot]]
    sourceUpdatedAt: cat?.source_updated_at || null,
    source: cat ? "complaints filed with the US National Highway Traffic Safety Administration" : null,
  };
}

/* The sentence that has to travel with every rendering of this panel. */
/* The extra sentence a nameplate match owes the reader. */
export function precisionNote(panel, modelLabel) {
  if (!panel || panel.precision !== "nameplate") return null;
  return `NHTSA does not record this powertrain separately, so these are complaints about every ` +
    `${modelLabel} of this model year, hybrid and petrol together.`;
}

export const FAULTS_BASIS =
  "Share of complaints filed, not a rate of failure. NHTSA publishes complaints, not how many cars were sold, " +
  "so a model that sold two million collects more filings than one that sold fifty thousand. " +
  "These are US filings; complaints in Canada go to Transport Canada, which does not publish them.";
