// The single rule for whether an MSRP figure may support a CLAIM.
//
// WHY THIS EXISTS. `src/App.jsx` has always got this right: `isExactMsrp()`
// requires `msrpBasis === "exact"` before it will print an over/under figure,
// and it renders explicit refusal copy for every other basis. The EMAIL did
// not. `coverCard` special-cased only "starting_at", and the deck's
// "Price vs MSRP" card checked nothing at all -- so a used vehicle carrying
// `original_when_new` rendered "▼ $28,400 under MSRP" on the emailed cover
// while the PDF *inside the same email* refused to make that claim.
//
// The email is the artifact that reaches the buyer's inbox and gets forwarded
// to the dealer. It is the publication. Two surfaces of one signed report
// disagreeing about the same number is the single easiest thing for an
// adversary to hold up, and they would be right.
//
// So the rule lives in ONE place and every surface imports it. A surface that
// wants to show a delta must ask this module; it may not do the subtraction.
//
// The four bases, and why only one qualifies:
//   exact             a verified manufacturer MSRP for THIS trim, this config.
//                     The only basis a comparison can stand on.
//   starting_at       the model's base-trim floor. This unit's options sit on
//                     top of it, so any "over" is partly just the options.
//   original_when_new what a USED vehicle cost new. Real context, but not a
//                     sticker to measure today's asking price against.
//   dealer_stated     the number the DEALER put on their own page, unverified.
//                     Making a claim from it is exactly how the IONIQ 9 false
//                     accusation happened -- we would be quoting the dealer to
//                     themselves and calling it verification.

export type MsrpBasis = "exact" | "starting_at" | "original_when_new" | "dealer_stated";

export type MsrpClaim = {
  /** May a surface print an over/under-MSRP figure at all? */
  comparable: boolean;
  /** Signed delta (asking - reference) when comparable, else null. NEVER recompute this. */
  delta: number | null;
  /**
   * WHICH figure the delta was measured against, and the figure itself.
   *
   * An AMVIC all-in advertised price must be compared against the
   * manufacturer's ALL-IN figure, never against the ex-freight MSRP — that
   * comparison invents roughly $3,000 of markup that does not exist and is the
   * single largest source of a wrong over/under claim. Toyota publishes both,
   * so there is nothing to estimate: msrp_catalog.all_in_price holds theirs.
   *
   * Live example (Okotoks, 2026-08-15): $85,995 all-in was being measured
   * against a $57,500 ex-freight MSRP. The honest reference is the $60,564
   * all-in for that trim.
   */
  comparedAgainst: "all_in" | "ex_freight" | null;
  reference: number | null;
  /** True when comparable AND the vehicle is priced above MSRP. */
  over: boolean;
  /** The MSRP figure itself, which is often still worth SHOWING even when it cannot be compared. */
  msrp: number | null;
  basis: MsrpBasis | null;
  /** Label for the MSRP figure, so every surface names it the same way. */
  label: string;
  /**
   * Why no comparison is being made, in buyer-facing words. Present exactly
   * when `comparable` is false and an MSRP exists. Surfaces must render this
   * INSTEAD of a delta -- silence would read as "no gap", which is a claim.
   */
  refusal: string | null;
};

const n = (v: unknown): number | null => {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : null;
};

/**
 * THE CEILING CLAIM — the finding that needs no trim.
 *
 * Pinning a trim is normally the precondition for any over/under claim, and it
 * often fails: a 50%+ gap trips the implausibility guard, which exists because a
 * MISSING catalog row once produced a false $18,900 accusation (IONIQ 9). That
 * guard is right to fire on trim-level claims.
 *
 * But it has nothing to say about this: the model's MOST EXPENSIVE trim, priced
 * all-in with the maximum dealer fee, is the most generous possible assumption
 * in the dealer's favour. A listing above THAT is marked up whichever trim it
 * is, because there is no higher grade left to name — so "the catalog is
 * missing a row" cannot explain it. It is the one comparison a missing row
 * cannot poison.
 *
 * Worked live (Okotoks Toyota, 2026-08-15): a 2026 RAV4 Plug-in Hybrid
 * advertised at $85,995 all-in. Top trim is the XSE Technology Package at
 * $62,414 all-in. $23,581 above the ceiling, and the trim never had to be
 * pinned. The trim-level card correctly declined; this one does not have to.
 */
export type CeilingClaim = {
  /** True only when the asking price provably exceeds every trim in the line. */
  exceeds: boolean;
  /**
   * The model's CHEAPEST all-in figure. Together with `ceiling` this is the
   * range the manufacturer actually charges, and it is the only MSRP figure
   * that belongs beside an all-in asking price.
   *
   * An ex-freight MSRP does not: $57,500 is a real number for the GR SPORT, but
   * it is not a price any customer can pay and Toyota publishes it nowhere as
   * one. Printing it as "MSRP · STARTING AT" next to an $85,995 all-in ask
   * invites exactly the comparison it cannot support.
   */
  floor: number | null;
  /** The model's highest all-in figure. */
  ceiling: number | null;
  /** Which trim that ceiling belongs to. */
  trim: string | null;
  /** asking − ceiling, when it exceeds. */
  over: number | null;
  /** How many trims the ceiling was taken across — 1 is not a ladder. */
  trimsConsidered: number;
};

export function qualifyCeilingClaim(analysis: any): CeilingClaim {
  const a = analysis ?? {};
  const none: CeilingClaim = { exceeds: false, floor: null, ceiling: null, trim: null, over: null, trimsConsidered: 0 };

  const c = a.msrpCeiling;
  const ceiling = n(c?.allIn);
  const floor = n(c?.floorAllIn);
  const asking = n(a.quotedPrice);
  const trims = Number(c?.trimsConsidered) || 0;

  // Needs a real ladder. A "ceiling" taken across ONE row is just that row, and
  // the missing-catalog-row explanation is wide open again.
  if (!ceiling || !asking || trims < 2) return none;

  // Only meaningful against an ALL-IN advertised price. Comparing an ex-freight
  // quote to an all-in ceiling would understate the gap and, worse, could
  // manufacture one where none exists.
  if (!a.allInPricing) return { ...none, floor, ceiling, trim: c?.trim ?? null, trimsConsidered: trims };

  if (asking <= ceiling) return { exceeds: false, floor, ceiling, trim: c?.trim ?? null, over: null, trimsConsidered: trims };
  return { exceeds: true, floor, ceiling, trim: c?.trim ?? null, over: asking - ceiling, trimsConsidered: trims };
}

/**
 * Did this figure come from the MANUFACTURER, or from the dealer?
 *
 * A separate question from `comparable`, and needed because some copy names the
 * manufacturer out loud -- "Ford's MSRP for this model starts at $X". Saying
 * that over a `dealer_stated` number hands the buyer the DEALER's own figure
 * relabelled as Ford's, inside a report that is criticising that dealer's
 * pricing. The rebuttal writes itself, and it lands.
 *
 * `original_when_new` IS a manufacturer figure but describes a car that is no
 * longer new, so it is excluded from "starts at" phrasing on purpose.
 */
export function isManufacturerFigure(basis: unknown): boolean {
  return basis === "exact" || basis === "starting_at";
}

/**
 * Pure. The one place that decides whether an MSRP comparison may be published.
 *
 * `analysis` is the finished analysis object from either analyze function.
 */
export function qualifyMsrpClaim(analysis: any): MsrpClaim {
  const a = analysis ?? {};
  const msrp = n(a.msrp);
  const asking = n(a.quotedPrice);
  const basis = (typeof a.msrpBasis === "string" ? a.msrpBasis : null) as MsrpBasis | null;
  const make = a.make || "the manufacturer";

  const allIn = n(a.msrpAllIn);
  // An AMVIC all-in advertised price is compared against the manufacturer's own
  // all-in figure. Anything else is a basis mismatch worth roughly $3,000.
  const useAllIn = !!a.allInPricing && !!allIn;
  const reference = useAllIn ? allIn : msrp;
  const comparedAgainst: "all_in" | "ex_freight" | null = msrp ? (useAllIn ? "all_in" : "ex_freight") : null;

  const base = { msrp, basis, comparable: false, delta: null, over: false,
                 comparedAgainst, reference: msrp ? reference : null } as MsrpClaim;

  if (!msrp) {
    return { ...base, label: "MSRP", refusal: null };
  }

  // An MSRP with NO recorded basis is not a verified one. Treating an unlabelled
  // figure as exact is how an unverified number acquires authority by default;
  // absence of a basis is absence of verification, so it refuses like the rest.
  if (basis !== "exact") {
    const refusals: Record<string, string> = {
      starting_at:
        `That is ${make}'s base price for this model — this unit's options and drivetrain sit on top of it, so no over/under-MSRP claim is made from it.`,
      original_when_new:
        `That is what this vehicle cost when new — useful context, but not a sticker to measure a used asking price against, so no over/under-MSRP claim is made.`,
      dealer_stated:
        `That MSRP is the figure this dealer states on their own page — we could not verify it against ${make}'s published price, so no over/under-MSRP claim is made from it. Ask for the factory build sheet showing how it is made up.`,
    };
    return {
      ...base,
      label: labelFor(basis, a),
      refusal: refusals[basis ?? ""] ??
        `We could not confirm which trim this MSRP belongs to, so no over/under-MSRP claim is made from it.`,
    };
  }

  // Basis is exact. A comparison still needs a price to compare against, and
  // that price has to be one we actually verified -- comparing a verified MSRP
  // against a number we guessed is not a verified comparison.
  const priceVerified = a.priceVerified !== undefined ? !!a.priceVerified : !!asking;
  if (!asking || !priceVerified) {
    return {
      ...base,
      label: labelFor(basis, a),
      refusal: asking
        ? `The asking price could not be verified, so it is not measured against MSRP.`
        : null,
    };
  }

  // WE MUST KNOW WHICH BASIS THE ASKING PRICE IS ON. If the jurisdiction never
  // resolved, `allInPricing` is null — and null used to fall through to the
  // ex-freight branch, i.e. "we don't know" silently became "not all-in".
  //
  // That produced "$11,173 over MSRP" on a Charlesglen RAV4 PHEV GR SPORT whose
  // real gap is $8,095: Alberta advertises all-in, the city failed to extract,
  // and Toyota's own $3,078 of freight and levies was printed as the dealer's
  // markup. The error only ever runs in the direction that accuses the dealer,
  // which is the direction that gets the report discredited.
  // Fires only on a POSITIVE finding that resolution was ATTEMPTED AND FAILED
  // (analyze-listing-url sets basisUnknown). An absent field is not evidence —
  // that conflation is the bug this whole change exists to remove.
  if (a.basisUnknown === true && !allIn) {
    return {
      ...base,
      label: labelFor(basis, a),
      refusal: `We could not establish which province this dealer advertises in, and that decides whether the asking price already includes freight and fees. Comparing across bases would misstate the gap by roughly $3,000, so no over/under-MSRP claim is made.`,
    };
  }

  // An all-in asking price with NO all-in reference cannot be compared soundly:
  // measuring it against the ex-freight MSRP invents the freight as markup.
  // Refuse rather than overstate — the ceiling claim still has something to say.
  if (a.allInPricing && !allIn) {
    return {
      ...base,
      label: labelFor(basis, a),
      refusal: `This price is advertised all-in, but we hold only ${make}'s ex-freight MSRP for this trim — comparing the two would count freight and fees as markup, so no over/under-MSRP claim is made.`,
    };
  }

  const delta = asking - reference;
  return {
    msrp,
    basis,
    comparable: true,
    delta,
    over: delta > 0,
    comparedAgainst,
    reference,
    label: labelFor(basis, a),
    refusal: null,
  };
}

function labelFor(basis: MsrpBasis | null, a: any): string {
  if (basis === "original_when_new") return "MSRP when new";
  if (basis === "dealer_stated") return "MSRP · as stated by dealer";
  if (basis === "starting_at") {
    const my = a?.msrpYear && a.msrpYear !== a.year ? ` (${a.msrpYear} MY)` : "";
    return `MSRP · starting at${my}`;
  }
  if (a?.msrpTrim) return `MSRP · ${String(a.msrpTrim).toUpperCase()}`;
  return "MSRP";
}
