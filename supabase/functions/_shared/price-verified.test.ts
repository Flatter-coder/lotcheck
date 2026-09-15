// Truth table for resolvePriceVerified — pinned, because the point of the
// module is that there is exactly one of these and it does not drift.
//
// The cases that matter are the last two: they are the ones where the five
// loose call sites and captureMarketCount used to disagree, and where the
// signed record made the looser claim.
//
// Run: node --experimental-strip-types supabase/functions/_shared/price-verified.test.ts
import { resolvePriceVerified, isVerifiedPriceSource, priceUsableForComparison } from "./price-verified.ts";

let pass = 0;
const fails: string[] = [];

function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fails.push(`${name}\n    got  ${g}\n    want ${w}`);
}

// ── the source list ─────────────────────────────────────────────────────────
for (const s of ["structured_data", "sm360_feed", "sm360_feed_fallback", "convertus_vms", "d2c_vdp"]) {
  eq(`isVerifiedPriceSource("${s}")`, isVerifiedPriceSource(s), true);
}
for (const s of ["page_text", "vision", "", null, undefined, "STRUCTURED_DATA"]) {
  eq(`isVerifiedPriceSource(${JSON.stringify(s)})`, isVerifiedPriceSource(s), false);
}

// ── a recorded verdict wins, either way ─────────────────────────────────────
eq("recorded true beats everything",
  resolvePriceVerified({ priceVerified: true, quotedPrice: 0, quotedPriceSource: "page_text" }),
  { verified: true, sourceVerified: false, dealerPublished: true, basis: "recorded", unknown: false });

eq("recorded false beats a verified source",
  resolvePriceVerified({ priceVerified: false, quotedPrice: 50000, quotedPriceSource: "d2c_vdp" }),
  { verified: false, sourceVerified: true, dealerPublished: false, basis: "recorded", unknown: false });

// ── no price is not a verdict about verification ────────────────────────────
eq("no price at all",
  resolvePriceVerified({ quotedPrice: 0 }),
  { verified: false, sourceVerified: false, dealerPublished: false, basis: "no_price", unknown: false });

eq("a negative price is not a price (never renders as verified)",
  resolvePriceVerified({ quotedPrice: -1, quotedPriceSource: "d2c_vdp" }),
  { verified: false, sourceVerified: false, dealerPublished: false, basis: "no_price", unknown: false });

eq("a non-numeric price is not a price",
  resolvePriceVerified({ quotedPrice: "call for pricing" }),
  { verified: false, sourceVerified: false, dealerPublished: false, basis: "no_price", unknown: false });

// ── unset verdict, price from the dealer's own data: both readings agree ────
eq("unset + verified source",
  resolvePriceVerified({ quotedPrice: 42475, quotedPriceSource: "convertus_vms" }),
  { verified: true, sourceVerified: true, dealerPublished: true, basis: "source_checked", unknown: false });

// ── THE DIVERGENCE. Unset verdict, a price, no source we recognise. ─────────
// This is every Quote Check report (analyze-quote sets neither field) and any
// price read out of page text. `verified` is true because that is what has
// always shipped and what the signed record carries; `sourceVerified` is false
// because nothing checked it; `unknown` says so out loud.
eq("unset + unverified source -- the Quote Check case",
  resolvePriceVerified({ quotedPrice: 30990, quotedPriceSource: "page_text" }),
  { verified: true, sourceVerified: false, dealerPublished: false, basis: "presence_only", unknown: true });

eq("unset + NO source at all -- analyze-quote",
  resolvePriceVerified({ quotedPrice: 30990 }),
  { verified: true, sourceVerified: false, dealerPublished: false, basis: "presence_only", unknown: true });

// ── junk in ─────────────────────────────────────────────────────────────────
eq("null analysis", resolvePriceVerified(null),
  { verified: false, sourceVerified: false, dealerPublished: false, basis: "no_price", unknown: false });
eq("empty analysis", resolvePriceVerified({}),
  { verified: false, sourceVerified: false, dealerPublished: false, basis: "no_price", unknown: false });

// dealerPublished must reproduce captureMarketCount's old expression EXACTLY:
//   a.priceVerified === true || (a.priceVerified == null && price > 0 && isVerifiedPriceSource(src))
for (const pv of [true, false, undefined, null]) {
  for (const src of ["d2c_vdp", "page_text", undefined]) {
    for (const price of [0, 30990]) {
      const a = { priceVerified: pv, quotedPrice: price, quotedPriceSource: src };
      const old = a.priceVerified === true
        || (a.priceVerified == null && price > 0 && isVerifiedPriceSource(src));
      eq(`dealerPublished matches the old rule (pv=${pv} src=${src} price=${price})`,
        resolvePriceVerified(a).dealerPublished, old);
    }
  }
}

// THE ROUTING, pinned. On the Quote Check shape -- a price, no recorded
// verdict, no source -- the two readings must DISAGREE, because that is the
// whole point of keeping both: the seal says "not verified" while the MSRP
// comparison still has a price to measure.
{
  const quote = { quotedPrice: 30990 };
  const v = resolvePriceVerified(quote);
  eq("quote: the SEAL must not claim verified", v.sourceVerified, false);
  eq("quote: there IS a price to measure against MSRP", v.verified, true);
  eq("quote: and it is not countable against other listings", v.dealerPublished, false);
  eq("quote: flagged as unchecked", v.unknown, true);
}
{
  // A listing read from the dealer's own published data: everything agrees.
  const listing = { quotedPrice: 42475, quotedPriceSource: "convertus_vms" };
  const v = resolvePriceVerified(listing);
  eq("listing: seal may claim verified", v.sourceVerified, true);
  eq("listing: measurable", v.verified, true);
  eq("listing: countable", v.dealerPublished, true);
  eq("listing: nothing unknown", v.unknown, false);
}

// BOTH SHAPES MUST ANSWER THE SAME. A report and its own seal rendering
// different sentences is what CI caught when this question was asked by
// sniffing a provenance field in two shapes at once.
eq("live quote has a usable price", priceUsableForComparison({ quotedPrice: 56000 }), true);
eq("its sealed form agrees", priceUsableForComparison({ price: { asking: 56000, verified: false } }), true);
eq("sealed with no asking price", priceUsableForComparison({ price: { asking: 0, verified: false } }), false);
eq("sealed with a null asking price", priceUsableForComparison({ price: { asking: null, verified: true } }), false);
eq("live with no price", priceUsableForComparison({ quotedPrice: 0 }), false);
eq("a strict-unverified seal still has a usable price",
  priceUsableForComparison({ price: { asking: 30990, verified: false } }), true);

if (fails.length) {
  console.error(`price-verified: ${fails.length} FAILED, ${pass} passed\n`);
  for (const f of fails) console.error(`  ${f}\n`);
  process.exit(1);
}
console.log(`price-verified: ${pass}/${pass} pass — one author, truth table pinned.`);
