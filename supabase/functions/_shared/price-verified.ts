// ============================================================================
// "Is this price verified?" — asked in one place, answered once.
//
// WHY THIS EXISTS. check:lineage found `priceVerified` with four authors, and
// they did not agree. Five surfaces carried this:
//
//     a.priceVerified !== undefined ? !!a.priceVerified : (a.quotedPrice > 0)
//
// while captureMarketCount carried this:
//
//     a.priceVerified === true || (a.priceVerified == null && price > 0 &&
//       isVerifiedPriceSource(a.quotedPriceSource))
//
// Same question, two answers. On a report where the field is unset and the
// price came out of page text, the SIGNED record says `price.verified: true`
// while the market-count card refuses the same listing as `price_unverified`.
// The seal is the looser of the two — a claim in the sealed record that the
// card beside it declines to stand behind.
//
// THEY ARE ACTUALLY TWO DIFFERENT QUESTIONS, and conflating them is what let
// them drift:
//
//   1. Did we verify this price against the dealer's OWN published data?
//   2. Do we have a price at all?
//
// The authority in analyze-listing-url answers (1) and records it:
//   `priceVerified = quotedPrice > 0 && isVerifiedPriceSource(quotedPriceSource)`
// with the stated intent "anything read out of page text is priceVerified:
// false". When that has run, the recorded value is the answer and nothing here
// second-guesses it.
//
// WHEN IT HAS NOT RUN is where the two rules diverged. analyze-quote never sets
// priceVerified and never sets quotedPriceSource, so EVERY Quote Check report
// lands here with both absent. Under the loose rule those read "verified";
// under the strict rule they would all read "price not verified".
//
// THIS MODULE DOES NOT PICK. Changing what a buyer is told about a paid quote
// is a product decision, not a refactoring one, and making it silently inside a
// deduplication would be the worst way to make it. So this preserves today's
// behaviour exactly, names both answers, and hands each caller the one it
// means. The divergence is now a pinned truth table (price-verified.test.ts)
// instead of two expressions that happened to differ.
//
// THE DECISION, taken 2026-09-15: STRICT, but only where "verified" is a CLAIM.
//
// A quote whose price we never checked against the dealer's published data is
// no longer called verified. The signed record, the PDF badge and every surface
// that prints "price verified" now read `sourceVerified`, so the seal asserts
// only what we can point at. Every Quote Check report says "price not verified",
// because analyze-quote sets no source and nothing checked one.
//
// WHAT WAS DELIBERATELY NOT MADE STRICT, and why it matters more than it looks:
// qualifyMsrpClaim gates on `verified`, and its false branch does not relabel
// anything -- it REFUSES to measure the asking price against MSRP at all and
// returns "The asking price could not be verified, so it is not measured
// against MSRP." Pointing that at sourceVerified would delete the price-vs-MSRP
// line from every Quote Check report, which is the paid product's central
// output, because a buyer's uploaded quote is precisely the case we cannot
// check against a dealer's page.
//
// So the two readings are routed by what the caller MEANS. A claim about
// provenance takes `sourceVerified`. A precondition that asks "is there a real
// asking price here" takes `verified`. That distinction is the whole reason
// this module returns a verdict instead of a boolean.
//
// Run tests (Node 24+, from repo root):
//   node --experimental-strip-types supabase/functions/_shared/price-verified.test.ts
// ============================================================================

// The price sources we accept as the dealer's own published data. Kept here
// with the rule that uses it, so a new platform extractor cannot add a source
// without meeting the definition of "verified".
const VERIFIED_SOURCES = new Set([
  "structured_data",
  "sm360_feed",
  "sm360_feed_fallback",
  "convertus_vms",
  "d2c_vdp",
]);

export function isVerifiedPriceSource(src: unknown): boolean {
  return VERIFIED_SOURCES.has(String(src || ""));
}

export interface PriceVerdict {
  /** What the surfaces render today. Preserves the long-standing behaviour. */
  verified: boolean;
  /** The strict reading: the price came from the dealer's own published data. */
  sourceVerified: boolean;
  /**
   * A recorded verdict if there is one, otherwise the source check. This is
   * what captureMarketCount required, and it is the reading a caller wants
   * before COUNTING a listing against others — an unverified number must not
   * quietly become a data point. Neither `verified` nor `sourceVerified` alone
   * reproduces it, which is precisely how it drifted into its own expression.
   */
  dealerPublished: boolean;
  /** How `verified` was arrived at — never guess from the boolean alone. */
  basis: "recorded" | "source_checked" | "presence_only" | "no_price";
  /** True when nothing recorded a verdict and no source was carried. */
  unknown: boolean;
}

/**
 * The single author. Every surface reads its answer from here.
 *
 * `verified` is deliberately the permissive reading, because that is what has
 * always shipped; `sourceVerified` is the strict one. A caller that means "the
 * dealer published this price" must read `sourceVerified`, and a caller that
 * means "there is a price here" must read `verified` — and now has to say which.
 */
export function resolvePriceVerified(a: any): PriceVerdict {
  const price = Number(a?.quotedPrice);
  const hasPrice = Number.isFinite(price) && price > 0;
  const sourceVerified = hasPrice && isVerifiedPriceSource(a?.quotedPriceSource);

  // A recorded verdict wins outright: something already asked the question with
  // more context than we have here, and overriding it would be a second author
  // by another name.
  if (a?.priceVerified === true) return { verified: true, sourceVerified, dealerPublished: true, basis: "recorded", unknown: false };
  if (a?.priceVerified === false) return { verified: false, sourceVerified, dealerPublished: false, basis: "recorded", unknown: false };

  if (!hasPrice) return { verified: false, sourceVerified: false, dealerPublished: false, basis: "no_price", unknown: false };
  if (sourceVerified) return { verified: true, sourceVerified: true, dealerPublished: true, basis: "source_checked", unknown: false };

  // No recorded verdict, a price, and no source we recognise. This is the
  // Quote Check path. `verified` stays true to preserve shipped behaviour;
  // `unknown` says out loud that nothing actually checked it.
  return { verified: true, sourceVerified: false, dealerPublished: false, basis: "presence_only", unknown: true };
}
