/* Matching a Calgary listing's model to NHTSA's model string.
 *
 * THIS IS THE PART THAT SILENTLY BREAKS. NHTSA and a dealer write the same truck
 * differently, and a miss renders as "nothing reported" -- our failure printed as
 * a fact about the car. Measured against the live corpus, 2026-09-14:
 *
 *   NHTSA writes            a Canadian listing writes
 *   F-150 SUPERCREW         F-150
 *   MAZDA3                  Mazda 3
 *   CR-V                    CR-V
 *   4 RUNNER *and* 4RUNNER  4Runner        (NHTSA holds both spellings)
 *   1500  (make = RAM)      Ram 1500
 *   ESCAPE HEV *and* ESCAPE HYBRID         (NHTSA holds both, same car)
 *
 * The API is worse than the flat file here: a query for "F-150" returns
 * count=0 with HTTP 200, because that channel only knows F-150 REGULAR CAB /
 * SUPERCAB / SUPER CREW. Zero-with-success is the most expensive kind of wrong.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POWERTRAIN IS NOT A SPELLING VARIANT. RAV4, RAV4 HYBRID and RAV4 PRIME stay
 * three keys. A hybrid has a battery, an inverter and a different transmission,
 * so its complaint profile is a different car's, and this repo already has the
 * rule the hard way. [[powertrain-identity-rule]] [[dealer-model-name-variants]]
 *
 * THERE IS EXACTLY ONE FALLBACK AND IT IS NOT FUZZY. Exact key first; failing
 * that, the powertrain token is dropped and the result is labelled
 * precision:"nameplate" so the card can say what it did. Nothing else is tried.
 * No edit distance, no prefix guessing, no "closest match" -- a near-miss is the
 * MacIsaac failure, the wrong entity stated as fact.
 * [[ai-defamation-entity-match-lesson]]
 */

/* Body and cab descriptors. These name how many doors the same truck has, not a
 * different truck, and NHTSA splits on them while dealers do not.
 */
const BODY_WORDS = [
  "REGULAR CAB", "SUPER CREW", "SUPERCREW", "SUPERCAB", "SUPER CAB", "CREW CAB",
  "EXTENDED CAB", "EXT CAB", "QUAD CAB", "MEGA CAB", "KING CAB", "CLUB CAB",
  "ACCESS CAB", "DOUBLE CAB", "CREWMAX", "XTRACAB",
  "HATCHBACK", "SEDAN", "COUPE", "WAGON", "CONVERTIBLE", "SPORTBACK",
  "LIFTBACK", "FASTBACK", "PICKUP TRUCK", "VAN", "MINIVAN", "SUV",
  "2 DOOR", "4 DOOR", "2DR", "4DR", "2WD", "4WD", "AWD", "FWD", "RWD",
];

/* Spellings NHTSA itself uses for one thing. Applied AFTER body words, before
 * the key is flattened. Deliberately short: every entry is a pair observed in
 * the live corpus, not a guess about what might exist.
 */
const SPELLING = [
  [/\bHEV\b/g, "HYBRID"],
  [/\bPLUG-?IN HYBRID\b/g, "PHEV"],
  [/\bPLUG-?IN\b/g, "PHEV"],
  [/\bELECTRIC\b/g, "EV"],
];

/* Words that are a trim, not a model. Kept deliberately tiny -- CIVIC SI and
 * MAZDASPEED3 are genuinely different cars and are NOT on this list.
 */
const TRIM_NOISE = [
  "BASE", "LIMITED EDITION", "SPECIAL EDITION",
];

export function modelKey(make, model) {
  let s = String(model || "").toUpperCase().trim();
  const mk = String(make || "").toUpperCase().trim();
  if (!s) return null;

  // "RAM 1500" -> "1500" when the make is already RAM, and "MAZDA3" -> "3" when
  // the make is already MAZDA. NHTSA stores the model bare for some makes and
  // make-prefixed for others; a listing does the opposite.
  if (mk) {
    const bare = mk.replace(/[^A-Z0-9]/g, "");
    s = s.replace(new RegExp(`^${escapeRe(mk)}[\\s-]*`), "").trim() || s;
    const flat = s.replace(/[^A-Z0-9]/g, "");
    if (flat.startsWith(bare) && flat.length > bare.length) {
      s = flat.slice(bare.length);
    }
  }

  for (const w of BODY_WORDS) s = s.replace(new RegExp(`\\b${escapeRe(w)}\\b`, "g"), " ");
  for (const [re, to] of SPELLING) s = s.replace(re, to);
  for (const w of TRIM_NOISE) s = s.replace(new RegExp(`\\b${escapeRe(w)}\\b`, "g"), " ");

  // Flatten to alphanumerics: "CR-V" and "CRV", "4 RUNNER" and "4RUNNER",
  // "CX-9" and "CX9" are each one car written two ways, and NHTSA holds both.
  const key = s.replace(/[^A-Z0-9]/g, "");
  return key || null;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export function cellKey(year, make, model) {
  const y = Number(year);
  const mk = String(make || "").toUpperCase().trim();
  const md = modelKey(mk, model);
  if (!y || y < 1900 || y > 2100 || !mk || !md) return null;
  return `${y}|${mk}|${md}`;
}

/* Why a lookup produced nothing. The panel renders these differently on purpose:
 * "we could not identify the car" and "this car has no complaints on file" are
 * different sentences and only one of them is about the vehicle.
 */
export const NO_VEHICLE = "no_vehicle";       // year/make/model not established
export const NO_CATALOGUE_ROW = "no_row";     // identified, but nothing on file
export const CATALOGUE_UNREADABLE = "unreadable";

/* Powertrain tokens, stripped ONLY for the second attempt below. */
const POWERTRAIN_TAIL = /(HYBRID|PHEV|EV|PRIME|ENERGI|ETRON|HEV)$/;

export function nameplateKey(make, model) {
  const k = modelKey(make, model);
  if (!k) return null;
  const base = k.replace(POWERTRAIN_TAIL, "");
  return base && base !== k && base.length >= 2 ? base : null;
}

/* TWO ATTEMPTS, AND THE SECOND ONE ADMITS WHAT IT DID.
 *
 * Exact key first. A 2021 RAV4 Hybrid keys to RAV4HYBRID and NHTSA has no such
 * model -- they file hybrid RAV4 complaints under plain RAV4 -- so an
 * exact-only matcher answers "not checked" for one of the most common cars in
 * Calgary while the data sits right there.
 *
 * So the second attempt drops the powertrain token and reports
 * precision:"nameplate", which the card must print: "NHTSA does not separate
 * the hybrid, so these are complaints about every RAV4 of this year."
 *
 * THE FALLBACK ONLY RUNS DOWNHILL. A plain RAV4 listing never reaches RAV4
 * PRIME's complaints: a hybrid can borrow the nameplate's record because it IS
 * one of the cars in it, but the nameplate cannot borrow a variant's.
 * [[powertrain-identity-rule]]
 */
export function lookupFaults(catalogue, analysis) {
  const y = Number(analysis?.year), mk = String(analysis?.make || "").toUpperCase().trim();
  const key = cellKey(y, mk, analysis?.model);
  if (!key) return { row: null, reason: NO_VEHICLE, key: null, precision: null };
  if (!catalogue) return { row: null, reason: CATALOGUE_UNREADABLE, key, precision: null };

  const get = (k) => (catalogue.get ? catalogue.get(k) : catalogue[k]);
  const exact = get(key);
  if (exact) return { row: exact, reason: null, key, precision: "exact" };

  const np = nameplateKey(mk, analysis?.model);
  if (np) {
    const npKey = `${y}|${mk}|${np}`;
    const row = get(npKey);
    if (row) return { row, reason: null, key: npKey, precision: "nameplate" };
  }
  return { row: null, reason: NO_CATALOGUE_ROW, key, precision: null };
}
