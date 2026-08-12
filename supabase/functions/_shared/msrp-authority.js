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

  // A dealer sticker sitting FAR above the manufacturer's trim figure is much
  // more likely a richer configuration than a padded sticker.
  //
  // Catalog rows pin a TRIM, not a configuration: Ford publishes one price per
  // Mustang Mach-E trim and sells AWD and extended range as options on top. So
  // a 2026 Mach-E Premium AWD listed with a $66,015 sticker was matched to the
  // base Premium at $49,990 and the $16,025 difference was reported to the
  // buyer as $13,018+ of dealer sticker inflation (2026-08-12, live). No dealer
  // pads a sticker by a third; that gap is a different car.
  //
  // Real padding, measured on live Alberta listings, runs single digits to low
  // double digits: 3.1% ($1,350, Escape PHEV) and 11.9% ($4,965, Bronco Sport).
  // Beyond BOTH 20% and $6,000 the configuration reading is far better
  // supported than the accusation, so we stop claiming this row describes the
  // unit: no "exact", no inflation callout. The manufacturer figure is attached
  // as a starting reference instead, which is what it actually is, and the
  // report already tells the buyer to ask which options account for the gap.
  //
  // Requires BOTH thresholds so a cheap car with a big percentage and an
  // expensive car with a big absolute gap are each still judged on the other.
  const gapOverRef = hasStated ? stated - Number(ref.msrp) : 0;
  const configMismatch = hasStated && gapOverRef > Number(ref.msrp) * 0.20 && gapOverRef > 6000;

  // EXACT trim match -> the manufacturer's figure is the MSRP, full stop.
  if (ref.basis === "exact" && !configMismatch) {
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
    // A trim row we've just judged not to describe this unit is a floor, and
    // must say so -- carrying "exact" into the reference would re-assert the
    // precision we withdrew.
    reference: hasStated ? { msrp: Number(ref.msrp), trim: ref.trim || null, basis: configMismatch ? "starting_at" : ref.basis, sourceUrl: ref.sourceUrl || null, make } : null,
  };
}
