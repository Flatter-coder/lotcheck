// Who wins when the LISTING states an MSRP and we also hold a catalog figure?
//
// Plain ES module so it can be regression-tested in Node (same pattern as
// trim-match.js / amvic-match.js / apr-extract.js).
//
// THE RULE (Vic, 2026-08-11): the manufacturer's published price beats the
// dealer's stated one whenever we can pin the exact trim.
//
// It used to override only when the dealer's number was INFLATED, which meant a
// dealer-stated figure survived untouched in every other case -- the dealer's
// claim became the report's MSRP by default (Buick Envista, Ford Escape and two
// Hyundai listings in the 20-listing benchmark). Direction of the difference is
// not what decides authority; provenance is. An exact-trim manufacturer figure
// is verifiable and linkable, a dealer's is neither.
//
// Still never guesses: a "starting_at" floor is NOT this unit's sticker, so it
// cannot displace the dealer's number -- it is attached as a reference instead.

/**
 * @param {{statedMsrp:number, ref:{msrp:number,trim:string|null,basis:string,sourceUrl:string|null,priceBasis?:string|null}|null, make?:string|null}} input
 * @returns {{msrp:number, basis:string, source:string, trim:string|null, sourceUrl:string|null,
 *            priceBasis?:string|null, dealerStatedMsrp:number|null,
 *            inflation:{dealerStated:number,manufacturer:number,overBy:number}|null,
 *            reference:{msrp:number,trim:string|null,basis:string,sourceUrl:string|null,make:string|null}|null}}
 */
/**
 * Are two price figures measured the same way, so that subtracting one from the
 * other means anything?
 *
 * WHY THIS GUARDS THE ACCUSATION. The inflated-sticker callout used to be a bare
 * `stated > msrp * 1.03 && stated - msrp > 800`. `ref.priceBasis` was received
 * and passed through, and never consulted. In Alberta, Ontario, BC and Quebec an
 * advertised price is ALL-IN by law, while half the catalogue is ex-freight or
 * carries no declared basis at all — so a dealer obeying the advertising rules
 * to the letter was accused of padding the sticker, by exactly the freight:
 *
 *   BMW      msrp 68,000 ex-freight vs all-in 71,470 -> "overBy 3,470"
 *   Chevrolet msrp 36,899 ex-freight vs all-in 40,042 -> "overBy 3,143"
 *
 * $3,470 is BMW Alberta's own published Freight & PDI, to the dollar. Both
 * thresholds sat below this market's freight range (CA$2,000–4,400), so the test
 * could not distinguish a padded sticker from a legally-required one. That text
 * is printed verbatim in a signed report naming the dealer.
 *
 * So: no comparison without a known, matching basis on BOTH sides. An unknown
 * basis is not a match — it is the reason there is no claim. We do not repair it
 * by adding freight to the MSRP ourselves; a basis is declared by the source or
 * it is absent.
 */
function basesComparable(refBasis, statedBasis) {
  const a = refBasis == null ? null : String(refBasis).trim().toLowerCase();
  const b = statedBasis == null ? null : String(statedBasis).trim().toLowerCase();
  const known = (x) => x === "excl_freight" || x === "incl_freight";
  if (!known(a) || !known(b)) return false;
  return a === b;
}

export function resolveMsrpAuthority({ statedMsrp, ref, make = null, statedBasis = null }) {
  const stated = Number(statedMsrp);
  const hasStated = Number.isFinite(stated) && stated > 0;
  const hasRef = !!ref && Number(ref.msrp) > 0;

  // No catalog figure at all -> the dealer's number stands, clearly labelled.
  if (!hasRef) {
    return { msrp: hasStated ? stated : 0, basis: "dealer_stated", source: "listing", trim: null, sourceUrl: null, dealerStatedMsrp: null, inflation: null, reference: null };
  }

  // EXACT trim match -> the manufacturer's figure is the MSRP, full stop.
  if (ref.basis === "exact") {
    // The size of the gap is necessary but never sufficient. Comparability comes
    // first, because a gap between two figures measured differently is not a gap.
    const comparable = basesComparable(ref.priceBasis, statedBasis);
    const gap = hasStated ? stated - Number(ref.msrp) : 0;
    const gapIsMaterial = hasStated && stated > Number(ref.msrp) * 1.03 && gap > 800;
    const materiallyHigher = comparable && gapIsMaterial;
    // Computed HERE, beside the guard, rather than inline in the returned
    // object twenty lines below. A subtraction that sits far from the check
    // that authorises it is a subtraction someone will later reuse without it.
    const overBy = materiallyHigher ? Math.round(gap) : null;
    // An absence is NOTED, never green: when the gap is material but we cannot
    // compare, say so rather than staying silent or accusing.
    const inflationRefused = !comparable && gapIsMaterial
      ? {
          why: ref.priceBasis == null ? "no_basis_on_catalog_row"
             : statedBasis == null ? "no_basis_on_stated_figure"
             : "basis_mismatch",
          catalogBasis: ref.priceBasis || null,
          statedBasis: statedBasis || null,
        }
      : null;
    return {
      msrp: Number(ref.msrp),
      basis: "exact",
      source: "catalog",
      trim: ref.trim || null,
      sourceUrl: ref.sourceUrl || null,
      priceBasis: ref.priceBasis || null,
      // Keep the dealer's claim visible even when it isn't inflated -- the buyer
      // should see both numbers and which one we trust.
      dealerStatedMsrp: hasStated && stated !== Number(ref.msrp) ? stated : null,
      // Only an inflated sticker gets NAMED as a tactic.
      inflation: materiallyHigher ? { dealerStated: stated, manufacturer: Number(ref.msrp), overBy } : null,
      inflationRefused,
      reference: null,
    };
  }

  // A floor ("starting_at") is not this unit's sticker: the dealer's number
  // stays, with the manufacturer's published starting price alongside it.
  return {
    msrp: hasStated ? stated : Number(ref.msrp),
    basis: hasStated ? "dealer_stated" : ref.basis,
    source: hasStated ? "listing" : "catalog",
    trim: hasStated ? null : (ref.trim || null),
    sourceUrl: hasStated ? null : (ref.sourceUrl || null),
    dealerStatedMsrp: null,
    inflation: null,
    reference: hasStated ? { msrp: Number(ref.msrp), trim: ref.trim || null, basis: ref.basis, sourceUrl: ref.sourceUrl || null, make } : null,
  };
}
