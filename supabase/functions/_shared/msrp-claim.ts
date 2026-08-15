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
  /** Signed delta (asking - msrp) when comparable, else null. NEVER recompute this. */
  delta: number | null;
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

  const base = { msrp, basis, comparable: false, delta: null, over: false } as MsrpClaim;

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

  const delta = asking - msrp;
  return {
    msrp,
    basis,
    comparable: true,
    delta,
    over: delta > 0,
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
