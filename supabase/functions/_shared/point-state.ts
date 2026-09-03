// Three states, never two. A report point may say a thing is TRUE, or that we
// LOOKED AND IT WAS ABSENT, or that we NEVER LOOKED — and the last two are not
// the same sentence.
//
// WHAT THIS COST US. A Charlesglen Toyota listing produced a report reading:
//
//     Dealer reputation                                        NOT FOUND
//     No public reviews were found - not a red flag by itself,
//     but you have no track record to lean on.
//
// Charlesglen has 4.7 stars from 5,930 Google reviews.
//
// Nothing failed. `dealerSentiment` is a PROGRESSIVE-ENHANCEMENT lookup — the
// frontend fetches it separately once dealerName is known, and
// get-dealer-sentiment's own header says it "fails soft everywhere... worst
// case, the card just doesn't render". That is correct for a card. It was wired
// into the 10-point panel, where `else` meant "no reviews exist", so a lookup
// that was never performed printed as a factual finding about a named business.
//
// That is a false statement of fact about an identifiable company, published in
// a document the buyer may show that company. It is the single most quotable
// thing a dealer could screenshot to discredit the product, and it would be
// entirely fair of them. "Missing beats wrong" is not a style preference here.
//
// THE CLASS, not the instance: any point whose data can legitimately be absent
// must distinguish absence-of-data from absence-of-the-thing. `recalls` already
// did this correctly (checked / count / confirmed). Nothing else did.

export type PointState = "confirmed" | "absent" | "unchecked";

/**
 * `checked` must come from the pipeline actually having ATTEMPTED the lookup —
 * never inferred from the value being present, which is the bug this exists to
 * prevent. Undefined means unknown, and unknown means unchecked.
 */
export function pointState(checked: boolean | undefined, found: boolean): PointState {
  if (checked !== true) return "unchecked";
  return found ? "confirmed" : "absent";
}

/**
 * Dealer reputation, the point that broke. `checked` is true only when a
 * sentiment lookup actually ran for this dealer.
 */
export function dealerReputationPoint(sentiment: any | null | undefined): {
  value: string; tone: "pass" | "flag" | "muted"; explain: string; state: PointState;
} {
  const rating = Number(sentiment?.rating);
  const rc = Number(sentiment?.reviewCount);
  const reviewCount = sentiment?.reviewCount == null || !Number.isFinite(rc) || rc < 0 ? null : rc;
  const hasRating = Number.isFinite(rating) && rating > 0;
  // A sentiment object that came back with no rating IS a completed check.
  const checked = sentiment?.checked === true || hasRating;
  const state = pointState(checked, hasRating);

  if (state === "confirmed") {
    return {
      state, tone: rating >= 4 ? "pass" : "muted",
      // `reviewCount || 0` printed "4.9* / 0" -- a rating attributed to zero
      // reviews, which is a figure naming nothing. The deck card in the same
      // email already guards this correctly; one email cannot give two answers
      // about one number. No count, no count. [[read-num]]
      value: reviewCount == null ? `${rating.toFixed(1)}*` : `${rating.toFixed(1)}* / ${reviewCount.toLocaleString()}`,
      explain: "The dealer's public Google rating from real customers - how they treat people after the handshake.",
    };
  }
  if (state === "absent") {
    return {
      state, tone: "muted", value: "NONE FOUND",
      explain: "We searched and found no public reviews for this dealer - not a red flag by itself, but there's no track record to lean on.",
    };
  }
  // NEVER an assertion about the dealer. We did not look.
  return {
    state, tone: "muted", value: "NOT CHECKED",
    explain: "We didn't run a reputation check on this listing - this says nothing about the dealer. Search their name on Google to see their rating and review count yourself.",
  };
}

/**
 * Points that describe the DEALER'S PAGE rather than the world. Same trap, one
 * step milder: "NONE LISTED" asserts the dealer disclosed nothing, when the
 * truth may be that we could not read the page. Kept as separate copy so the
 * distinction is visible at the call site.
 */
export function pageAbsenceCopy(kind: "addons" | "apr" | "vin", readable: boolean): { value: string; explain: string } {
  if (!readable) {
    return {
      value: "COULDN'T READ",
      explain: "We couldn't read this section of the dealer's page, so we're not making a claim about it either way. Ask them directly.",
    };
  }
  switch (kind) {
    case "addons": return { value: "NONE LISTED", explain: "This listing discloses no add-ons or extra fees. Get that confirmed in writing before you sign - fees added later are the most common surprise." };
    case "apr":    return { value: "NONE ADVERTISED", explain: "This dealer advertises no financing rate on the listing, so there is nothing of theirs to compare." };
    case "vin":    return { value: "NOT PUBLISHED", explain: "This listing doesn't publish a VIN. Ask for it - without one you cannot check recalls or history on this exact car." };
  }
}
