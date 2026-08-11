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
export function resolveMsrpAuthority({ statedMsrp, ref, make = null }) {
  const stated = Number(statedMsrp);
  const hasStated = Number.isFinite(stated) && stated > 0;
  const hasRef = !!ref && Number(ref.msrp) > 0;

  // No catalog figure at all -> the dealer's number stands, clearly labelled.
  if (!hasRef) {
    return { msrp: hasStated ? stated : 0, basis: "dealer_stated", source: "listing", trim: null, sourceUrl: null, dealerStatedMsrp: null, inflation: null, reference: null };
  }

  // EXACT trim match -> the manufacturer's figure is the MSRP, full stop.
  if (ref.basis === "exact") {
    const materiallyHigher = hasStated && stated > Number(ref.msrp) * 1.03 && stated - Number(ref.msrp) > 800;
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
      inflation: materiallyHigher ? { dealerStated: stated, manufacturer: Number(ref.msrp), overBy: Math.round(stated - Number(ref.msrp)) } : null,
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
