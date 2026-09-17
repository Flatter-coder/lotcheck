// CAN THIS MSRP CARRY A SUBTRACTION? One function, because the answer was being
// decided in three places and they did not agree.
//
// WHAT BROKE. On 2026-09-17 a report on the 4Runner shape -- an Alberta all-in
// advertised price of $72,371 against the $69,207 ex-freight figure in
// msrp_catalog, exact trim match, no captured all_in_price -- produced this as
// the HERO band, the first number in the report:
//
//     +$3,164 OVER
//     "$72,371 asking against the $69,207 this configuration carries from
//      the manufacturer."
//
// Toyota's own Alberta page prices that vehicle with $1,930 delivery, $100 A/C,
// $20 tire levy, $10 AMVIC and up to $999 retailer admin INSIDE the advertised
// figure. Nearly the whole $3,164 is those mandatory lines. The dealer had not
// marked the car up, and the report said in writing that they had.
// [[no-accusation-language]] [[amvic-all-in-pricing]]
//
// WHY IT SURVIVED A FIX THAT WAS WRITTEN FOR IT. report-bands.js already
// carried a careful paragraph about this exact defect, and a `sameBasis` guard
// implementing it -- in the branch that says "We could not pin this listing to
// an exact manufacturer configuration". The branch that prints "+$X OVER" is a
// different branch, thirty lines earlier, and it went straight from
// `msrpBasis === "exact"` to `qp - ms` without consulting the basis at all. The
// fix landed in the path that declines to make a claim and not in the path that
// makes one. A ONE-SURFACE FIX, on the headline number.
//
// msrp-claim.ts refused correctly, and deal.ts:135 guards its counter-script
// move on msrpPriceBasis -- so a single report could show "+$3,164 OVER" on the
// hero card while the counter-script stayed silent and the MSRP card declined
// to claim anything. Three authors, three answers. [[two-authors-per-fact]]
//
// THE RULE. A subtraction needs both sides on one basis:
//
//   all-in province + captured all_in_price   -> compare, all-in vs all-in
//   all-in province + no all_in_price         -> REFUSE (this is the defect above)
//   elsewhere + price_basis "excl_freight"    -> compare, ex-freight vs ex-freight
//   elsewhere + price_basis "incl_freight"    -> REFUSE (freight already inside)
//   elsewhere + no price_basis recorded       -> REFUSE (we never captured what it means)
//
// The last line matters more than it looks: 854 of the 1,497 rows in the live
// catalogue carry NO price_basis, because writeCatalogs() stamps one only when
// a scraper passes opts.priceBasis and just 5 of 31 sources do. catalog-io.mjs
// says of an unstamped row that "silence is honest" because the report shows a
// freight caveat instead. No caveat existed. This is where that becomes true.
// [[msrp-100-percent-accuracy]] [[reference-point-model]] [[archived-msrp-gap]]
//
// Losing a claim is the cheap failure here. Missing beats wrong, and a false
// markup accusation is the single worst thing this product can print.
// [[dealers-are-adversaries]]

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/**
 * @param {any} a  the finished analysis object
 * @returns {{comparable:boolean, compareTo:number|null, mode:"all_in"|"ex_freight"|null, why:null|"no_all_in"|"incl_freight"|"unknown_basis"}}
 */
export function referenceBasis(a) {
  const msrp = num(a?.msrp);
  const allIn = num(a?.msrpAllIn);
  const inAllInProvince = !!(a?.allInPricing);
  const pb = typeof a?.msrpPriceBasis === "string" && a.msrpPriceBasis.trim()
    ? a.msrpPriceBasis.trim() : null;

  if (inAllInProvince) {
    return allIn > 0
      ? { comparable: true, compareTo: allIn, mode: "all_in", why: null }
      : { comparable: false, compareTo: null, mode: null, why: "no_all_in" };
  }
  if (pb === "excl_freight") return { comparable: true, compareTo: msrp, mode: "ex_freight", why: null };
  if (pb === "incl_freight") return { comparable: false, compareTo: null, mode: null, why: "incl_freight" };
  return { comparable: false, compareTo: null, mode: null, why: "unknown_basis" };
}

/**
 * Why we are not subtracting, in the buyer's words. Never blames the dealer:
 * every one of these is a limit of OUR catalogue, and says so.
 * @param {"no_all_in"|"incl_freight"|"unknown_basis"} why
 * @param {string} make
 */
export function basisRefusal(why, make) {
  const m = String(make || "").trim() || "the manufacturer";
  if (why === "no_all_in") {
    return `Advertised prices here are all-in — freight, levies and the dealer fee are already inside the number — and the ${m} figure we hold for this trim is before those. Subtracting one from the other would count about $3,000 of mandatory fees as markup, so no over/under-MSRP claim is made. That is a gap in our catalogue, not a finding about the price.`;
  }
  if (why === "incl_freight") {
    return `The ${m} figure we hold for this trim already includes freight and PDI, and this listing does not state whether its price does — so no over/under-MSRP claim is made. That is a gap in our catalogue, not a finding about the price.`;
  }
  return `We hold a ${m} MSRP for this trim but never recorded whether that figure includes freight and PDI, and the difference is roughly $2,000 — so no over/under-MSRP claim is made. That is a gap in our catalogue, not a finding about the price.`;
}
