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
// THE JAPANESE-LUXURY NUMERIC-H CONVENTION WAS MISSING, and it is not a rare
// edge: Lexus/Acura/Infiniti name their hybrids "NX 350h", "RX 500h",
// "MDX Sport Hybrid", and their plug-ins "NX 450h+". None of the three
// patterns below matched any of those, so "NX 350h" read as MARKER-FREE and
// powertrainCompatible() matched it against the GAS "NX" series.
//
// Confirmed live 2026-08-27 on a real customer report: a 2026 Lexus NX 350h
// Premium Hybrid AWD was anchored to the gas NX's $55,080 base MSRP while the
// dealer's own page stated $58,675 for that exact unit -- a false anchor of
// precisely the kind [[powertrain-identity-rule]] forbids ("an EV/PHEV/hybrid
// never inherits its gas sibling's MSRP").
//
// The "+" in 450h+ is the plug-in marker in this convention, so it is matched
// by the phev pattern; powertrainMarkers() below already promotes plug-in over
// hybrid when both fire.
const MARKERS = [
  ["bev", /\bev\b|\be-?tron\b|\blightning\b|\bmach-?e\b|\bev6\b|\bev9\b|\bioniq\s*[56]\b|\bbz4x\b|\bsolterra\b/i],
  ["phev", /\bphev\b|\bplug-?in\b|\bprime\b|\b4xe\b|\brecharge\b|\d{3}h\+|\be:?phev\b/i],
  ["hybrid", /\bhybrid\b|\bhev\b|\bhybride\b|\b\d{3}h\b|\be:?hev\b|\be-?power\b|\bsport\s+hybrid\b/i],
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

// THE SAME CAR, FILED UNDER TWO MODEL NAMES.
//
// WHAT BROKE. A real report on a 2026 Lexus NX 350 F SPORT 3 at Lexus of
// Royal Oak said "Other listings read: None read" and "Not enough similar
// listings to compare". We were holding NINETY-FIVE 2026 Lexus NX listings in
// Alberta at the time, 51 of them gas NX 350s between $54,830 and $72,146 --
// against a car asking $72,241, at the very top of that range. The buyer was
// shown nothing.
//
// The cause is one line of SQL in fn_market_comps:
//
//     and lower(vl.model) = lower(p_model)
//
// The subject page parses as model "NX 350". The crawled listings are stored
// as model "NX" with "NX 350" in the TRIM, because that is how the dealer
// pages name them. "NX 350" never equals "NX", so the candidate set came back
// empty and every card downstream correctly reported having nothing -- which a
// buyer reads as "there are none out there".
//
// Same shape as the trim-name fork fixed on 2026-09-16: an identity built on a
// name that two sides spell differently.
//
// WHAT THIS FUNCTION IS FOR, AND WHAT IT IS NOT FOR. It returns a WIDER
// candidate key for a second fetch, used only when the exact match found
// nothing. It never decides what is comparable -- likeForLikePool() does that,
// and it still applies the powertrain wall and the trim scope to whatever
// comes back. Widening the fetch cannot therefore blur a hybrid into a gas
// set: dropping the marker here only puts the row in front of the wall.
//
// Returns "" when there is nothing safe to widen to.

// An engine designation: 2-3 digits, optionally carrying a hybrid/EV suffix
// and optionally prefixed by a drive-system word. Lexus "NX 350", "RX 350h",
// "NX 450h+"; BMW "X3 xDrive30i"; Mercedes "GLC 300".
//
// TWO AND THREE DIGITS, NEVER FOUR, and the difference is load-bearing:
// "Silverado 1500", "Sierra 1500" and "Ram 2500" are SEPARATE TRUCKS, not
// engine variants of one line. Stripping those would put a 2500 in a 1500's
// comparison set, and the trim scope downstream has no idea they differ.
const ENGINE_DESIGNATION = /^(?:[a-z]*\d{2,3}[a-z]*\+?)$/i;

// A remainder that names no vehicle. "Model 3" must not widen to "Model" --
// and it does not reach here anyway, because "3" is one digit, not two.
// These are the words that would survive the strip and mean nothing.
const EMPTY_NAMEPLATES = new Set(["model", "series", "class", "type", "grand", "the"]);

export function baseNameplate(model) {
  const raw = String(model || "").trim();
  if (!raw) return "";
  const words = raw.split(/\s+/).filter(Boolean);
  // A single token is the nameplate itself. "RAV4", "Mazda3", "CX-5", "F-150"
  // and "Q50" all carry their digits inside the name and must never be cut.
  if (words.length < 2) return "";

  // Drop trailing engine designations and powertrain markers, in any order:
  // "NX 350h" and "NX Hybrid 350" both widen to "NX".
  const kept = [...words];
  let dropped = 0;
  while (kept.length > 1) {
    const last = kept[kept.length - 1];
    const isEngine = ENGINE_DESIGNATION.test(last);
    const isPowertrain = powertrainMarkers(last).size > 0;
    if (!isEngine && !isPowertrain) break;
    kept.pop();
    dropped++;
  }
  if (!dropped) return "";                       // nothing to widen to

  const out = kept.join(" ");
  if (out.toLowerCase() === raw.toLowerCase()) return "";
  if (EMPTY_NAMEPLATES.has(out.toLowerCase())) return "";
  if (out.replace(/[^a-z0-9]/gi, "").length < 2) return "";
  return out;
}
