// A powertrain variant is a DIFFERENT VEHICLE, not a trim of the base model.
//
// WHY THIS EXISTS. On 2026-08-12 a live scan of a battery-electric
// "2026 Chevrolet Equinox EV LT" reported an MSRP of $44,942 — the sticker of
// the GASOLINE 2027 Equinox RS. The catalog holds no "Equinox EV" rows, and
// the base-model resolver matches on a prefix (`"EQUINOX EV LT"` starts with
// `"EQUINOX "`), so the EV collapsed onto the gas model and inherited its
// price. The fuel partition could not catch it either: those gas rows carry
// `fuel_type = null`, so there was nothing to disagree with.
//
// Prefix-stripping is right for TRIM noise ("Palisade Ultimate Calligraphy" ->
// "Palisade"). It is wrong for a powertrain suffix, because an Equinox EV, a
// RAV4 Prime and an F-150 Lightning are separate vehicles with separate
// price ladders. Dropping one silently swaps in another car's sticker, and
// MSRP is the number the whole "Price vs MSRP" card is built on.
//
// The rule: a catalog model may stand in for a listing model only if it does
// not DROP a powertrain marker the listing carries. Losing coverage is
// acceptable here; inventing a comparison against the wrong car is not — no
// MSRP is honest, a gas MSRP on an EV is a false anchor.

// Markers that denote a distinct powertrain variant sold alongside a base
// model. Deliberately narrow: only nameplate-level suffixes that manufacturers
// price as separate vehicles.
const MARKERS = [
  ["bev", /\bev\b|\be-?tron\b|\blightning\b|\bmach-?e\b|\bev6\b|\bev9\b|\bioniq\s*[56]\b|\bbz4x\b|\bsolterra\b/i],
  ["phev", /\bphev\b|\bplug-?in\b|\bprime\b|\b4xe\b|\brecharge\b/i],
  ["hybrid", /\bhybrid\b|\bhev\b|\bhybride\b/i],
];

/**
 * The set of powertrain markers a model/trim string carries.
 * @param {string} s
 * @returns {Set<string>}
 */
export function powertrainMarkers(s) {
  const t = String(s || "");
  const out = new Set();
  for (const [name, re] of MARKERS) if (re.test(t)) out.add(name);
  // "Plug-in Hybrid" is a plug-in, not a conventional hybrid: the stronger
  // claim wins so a PHEV is never reduced to a hybrid (or vice versa).
  if (out.has("phev")) out.delete("hybrid");
  return out;
}

/**
 * May `catalogModel` stand in as the base model for `listingModel`?
 *
 * False whenever the catalog name drops a powertrain marker the listing has —
 * that is the Equinox-EV-priced-as-gas case. Extra markers on the catalog side
 * are also refused: a plain gasoline RAV4 must not inherit a RAV4 Prime price.
 *
 * @param {string} listingModel  model (optionally + trim) read off the listing
 * @param {string} catalogModel  candidate model name from msrp_catalog
 * @returns {boolean}
 */
// Powertrain words that are MODIFIERS, never a nameplate. Stripping these lets
// the base-model match ignore where the dealer put the word.
//
// WHY (Vic, 2026-08-15): "RAV4 Hybrid XLE", "RAV4 HEV XLE", "RAV4 XLE HYBRID"
// and "RAV4 XLE HEV" are the same car, and dealers write all four. The
// base-model resolver matches on a PREFIX, so only the first ever matched a
// catalog row called 'RAV4 Hybrid' — the other three silently found nothing and
// the report lost its MSRP.
//
// Deliberately EXCLUDES markers that ARE the nameplate — bZ4X, Solterra, EV6,
// EV9, Ioniq 5/6, Mach-E, Lightning, e-tron. Stripping those would erase the
// model name itself and break matches that work today. `\bev\b` is safe: word
// boundaries mean it takes the "EV" in "Equinox EV" and leaves "EV6" alone.
const MODIFIER_RE = /\b(plug-?in\s+hybrid|plug-?in|phev|hybride|hybrid|hev|prime|4xe|recharge|ev)\b/gi;

/**
 * The model name with powertrain modifiers removed, for order-insensitive
 * base-model matching. NEVER use this for the powertrain decision itself —
 * that is powertrainCompatible's job, on the ORIGINAL strings.
 * @param {string} s
 * @returns {string}
 */
export function stripPowertrain(s) {
  return String(s || "").replace(MODIFIER_RE, " ").replace(/\s+/g, " ").trim();
}

export function powertrainCompatible(listingModel, catalogModel) {
  const a = powertrainMarkers(listingModel);
  const b = powertrainMarkers(catalogModel);
  if (a.size !== b.size) return false;
  for (const m of a) if (!b.has(m)) return false;
  return true;
}
