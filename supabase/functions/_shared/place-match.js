// Which Google Place is actually this dealer — or none of them.
//
// WHAT THIS REPLACES. get-dealer-sentiment ran a free-text Places search
// ("<name> <city> car dealership") and took `searchData.places?.[0]`. The first
// result. No comparison of the returned business name, address or website
// against the dealer we were asked about, and the answer was then CACHED FOR 30
// DAYS and signed into the report payload.
//
// So a near-name collision -- "Auto House" against "Summit Auto House", a second
// location, a service-only listing, a closed dealership with the same name one
// town over -- attaches ANOTHER COMPANY'S star rating and its worst reviews to a
// named business, in a document the buyer carries into that business.
//
// That is a false statement of fact about an identifiable company, published for
// money. It is the exposure shape in [[ai-defamation-entity-match-lesson]], and
// it is the same defect this codebase already fixed once: AMVIC's matcher used
// to rank by a raw name and returned SEVEN different businesses across 200
// orderings of the same rows, 71% of them another company's live licence number.
// The fix there was to refuse rather than guess. Same fix, same reasoning, same
// normalisers -- imported from amvic-match.js rather than written twice.
// [[dealers-are-adversaries]] [[no-accusation-language]]
//
// THE DEALER'S OWN DOMAIN IS THE STRONGEST SIGNAL AND WE ALREADY HAVE IT. The
// scan knows the host the listing was served from. Google returns websiteUri.
// An exact domain match is identity; everything else is inference. That is
// exactly what rescued the AMVIC case (PR #445), and it costs nothing extra
// here: the search's field mask already requests rating and userRatingCount,
// which bill at the top tier, so formattedAddress and websiteUri ride along free.
//
// Pure: no network, no clock. The caller does I/O; this decides.

import { normName, normHost, nameScore } from "./amvic-match.js";

// Below this, a name is not evidence. Calibrated against the real collision
// cases: "Auto House" vs "Summit Auto House" scores 0.5 on containment alone,
// and 0.5 must NOT be enough to publish another company's reviews.
const NAME_FLOOR = 0.62;
// Two candidates this close are not distinguishable by name, and picking the
// higher one is picking a coin toss. Refuse instead.
const TIE_WINDOW = 0.08;

const displayName = (p) => String(p?.displayName?.text ?? p?.displayName ?? "");

/** The host of whatever Google says the business's website is. */
export function placeHost(p) {
  return normHost(p?.websiteUri || "");
}

/** Is the city we were given present in the address Google returned? */
export function addressHasCity(p, city) {
  const c = normName(city || "");
  if (!c) return false;
  return normName(p?.formattedAddress || "").includes(c);
}

/**
 * Pick the place that IS this dealer, or return null.
 *
 * @param {Array} places   candidates from Places Text Search, in Google's order
 * @param {{dealerName?:string, dealerCity?:string, domains?:string[]}} sig
 * @returns {{place:object, confidence:number, basis:string}|null}
 *
 * null is a real answer and the caller must treat it as one: "we could not
 * confirm which business this is" is NOT "this business has no reviews".
 */
export function matchPlace(places, sig = {}) {
  const list = Array.isArray(places) ? places.filter(Boolean) : [];
  if (!list.length) return null;

  const want = String(sig.dealerName || "").trim();
  const domains = (Array.isArray(sig.domains) ? sig.domains : [])
    .map((d) => normHost(d)).filter(Boolean);

  // 1. DOMAIN IS IDENTITY. If Google's own record for this place points at the
  //    same website the listing was served from, it is the same business, and
  //    no name comparison can improve on that.
  if (domains.length) {
    const hits = list.filter((p) => { const h = placeHost(p); return h && domains.includes(h); });
    if (hits.length === 1) {
      return { place: hits[0], confidence: 1, basis: `website matches the listing's own domain (${placeHost(hits[0])})` };
    }
    // Several places on one domain is a dealer group with multiple rooftops.
    // The city then decides; without one we cannot say which rooftop, and a
    // group's rooftops have genuinely different ratings.
    if (hits.length > 1) {
      const inCity = hits.filter((p) => addressHasCity(p, sig.dealerCity));
      if (inCity.length === 1) {
        return { place: inCity[0], confidence: 0.95, basis: `website matches, and the address is in ${sig.dealerCity}` };
      }
      return null;
    }
  }

  // 2. NAME, and only with corroboration. A name alone is how the AMVIC matcher
  //    returned seven different businesses for "Auto House".
  if (!want) return null;
  const scored = list.map((p) => {
    const s = nameScore(want, displayName(p));
    const inCity = addressHasCity(p, sig.dealerCity);
    return { p, s, inCity, rank: s + (inCity ? 0.12 : 0) };
  }).sort((a, b) => b.rank - a.rank);

  const best = scored[0];
  if (!best || best.s < NAME_FLOOR) return null;

  // A NAME ALONE IS NEVER ENOUGH. Corroboration is required: either the website
  // matched above, or the address is in the city we were told. Without a city we
  // have one unverified string against another, which is exactly how the AMVIC
  // matcher returned seven different businesses for "Auto House". The most
  // likely collision in this data is the same brand name in a different town,
  // and the cost of getting it wrong is publishing someone else's reviews
  // against a named company. Missing beats wrong. [[dealers-are-adversaries]]
  if (!sig.dealerCity || !best.inCity) return null;

  const second = scored[1];
  if (second && best.rank - second.rank < TIE_WINDOW) return null;

  return {
    place: best.p,
    confidence: Math.min(0.9, best.s),
    basis: `name matches "${displayName(best.p)}"${best.inCity ? ` and the address is in ${sig.dealerCity}` : ""}`,
  };
}

/**
 * Why we are not attributing a rating. Separate from the match so the caller
 * cannot accidentally render a refusal as an absence.
 */
export const NO_CONFIDENT_MATCH = "no_confident_match";

/**
 * What each refusal reason MEANS, in one place.
 *
 * get-dealer-sentiment already had this map and it was already right -- its own
 * comment says "a Places API failure is a miss, and collapsing those is how a
 * broken lookup would read as a clean bill". It was used for the verification
 * checkpoint telemetry and NOWHERE ELSE: analyze-listing-url read the HTTP
 * status, spread away the reason, and hard-set checked:true under a comment
 * reading "A 200 IS a completed check". It is not -- this function answers 200
 * with a reason on its own failures. The knowledge existed, was written down,
 * was even logged, and the report ignored it. [[two-authors-per-fact]]
 *
 *   checked_no_match  we looked and this business genuinely has no listing
 *   unconfirmed       we looked, found candidates, could not confirm which is
 *                     them -- we make NO claim about their reputation
 *   error             OUR lookup failed; says nothing about the dealer
 *   not_attempted     there was nothing to look up
 */
export const REPUTATION_OUTCOME = {
  no_dealer_name: "not_attempted",
  no_places_match: "checked_no_match",
  [NO_CONFIDENT_MATCH]: "unconfirmed",
  search_failed: "error",
  details_failed: "error",
  threw: "error",
};

/**
 * Did the lookup actually COMPLETE? Only a completed check may be rendered as
 * an absence ("no reviews found"); everything else is our own gap and must say
 * so. This is the single line analyze-listing-url was missing.
 */
export function reputationChecked(reason) {
  if (!reason) return true;                       // a rating came back
  return REPUTATION_OUTCOME[reason] === "checked_no_match";
}
