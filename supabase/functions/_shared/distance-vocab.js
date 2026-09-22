// The ways a manufacturer says "there is no distance limit on this coverage".
//
// WHY THIS IS ONE LIST. "Unlimited" is OUR word, not theirs. Lexus states its
// corrosion cover as "72 months, regardless of distance travelled" and the word
// unlimited appears nowhere on the page; Acura writes "Five years. No distance
// limit." as two sentences. warranty-verify.mjs already knew all of this when
// reading a MANUFACTURER'S page — and none of it when reading OUR OWN stored
// value, so Honda's "5-year/no distance limit" and Subaru's "5-year/no km
// limit" came back as "could not read our own stored value as a term".
//
// Same vocabulary, two readers, one of them ignorant of it. That is the
// two-authors shape, so the vocabulary lives here and both import it.
//
// NOT THE SAME AS SAYING NOTHING. A term that affirmatively states there is no
// distance limit is a claim the manufacturer made. A term that simply gives no
// distance — MINI's "12-year Rust Perforation Warranty" — is not. parseCoverage
// keeps those apart via kmExplicitlyUnlimited, and this list is what makes the
// first kind recognisable.

/** Regex alternatives (no anchors, no flags) matching an explicit "no limit". */
export const NO_DISTANCE_LIMIT_PATTERN =
  "(?:unlimited\\s*(?:km|kilometre|kilometer|mileage|distance)?"
  + "|regardless of (?:the )?(?:distance|mileage|kilometre|kilometer)[a-z ]*"
  + "|(?:no|without) (?:a )?(?:distance|mileage|kilometre|kilometer|km) (?:limit|restriction)"
  + "|whatever the (?:distance|mileage))";

/**
 * Does this text affirmatively state that no distance limit applies?
 * Saying nothing about distance is NOT a yes — see the note above.
 */
export function statesNoDistanceLimit(text) {
  if (text === null || text === undefined) return false;
  return new RegExp(NO_DISTANCE_LIMIT_PATTERN, "i").test(String(text));
}
