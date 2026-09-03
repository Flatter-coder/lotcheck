// ============================================================================
// msrp-basis.ts — ONE place decides whether a manufacturer MSRP may be read as
// THIS car's sticker today, or only as "what it cost when it was new".
//
// WHY THIS FILE EXISTS. The rule used to live as a copy-pasted expression:
//
//     const isUsed = String(vehicleCondition||"").toLowerCase() === "used"
//       || (Number(odometerKm) > 5000 && ...!== "new");
//
// written out twice in analyze-listing-url (the catalog branch and the
// manufacturer-site branch), once more in analyze-quote, and NOT AT ALL in
// analyze-listing-url's third branch — the one that runs whenever the dealer's
// own page states an MSRP. That branch re-decided the basis from
// resolveMsrpAuthority and stored it unguarded, so a used listing whose page
// printed a sticker came back with basis "exact" and the report told the buyer
// a years-old vehicle was thousands "under MSRP".
//
// That is a fabricated bargain claim, and it flatters the dealer at the buyer's
// expense — the exact inversion of what this product is for. Copying a guard to
// a fourth site would leave the same shape behind, so the guard now has one
// home and every branch calls it (fix-means-structural-fix).
//
// WHAT COUNTS AS PRESENT TENSE:
//   new       — obviously.
//   demo      — a demo is sold as new inventory at a discount off its OWN
//               sticker. "$4,000 off MSRP" is exactly the frame a demo buyer
//               needs, so the comparison stays on. Its warranty clock is a
//               separate question (see cpo.ts / condition.ts).
//   certified — CPO is a used car with a premium. The catalog figure is the
//               original sticker, not today's.
//   used      — likewise.
//
// UNKNOWN FAILS CLOSED. If nothing tells us the car is new, we do not publish a
// number that only makes sense for a new car. The old heuristic failed OPEN: a
// 3,800 km unit with no condition flag was "not used" because 3,800 is not
// greater than 5,000, so it kept a present-tense sticker. Missing beats wrong —
// the figure is still shown, labelled as the original MSRP; only the over/under
// CLAIM switches off.
// ============================================================================

import { deriveSaleCondition } from "./condition.ts";

export type MsrpBasis = "exact" | "starting_at" | "dealer_stated" | "original_when_new";

/** Delivery kilometres. Above this, a car with no condition flag is not "new". */
const DELIVERY_KM = 1000;

export interface ConditionCtx {
  vehicleCondition?: string | null;   // binary "new" | "used" | null
  saleCondition?: string | null;      // finer new | demo | certified | used | null
  saleConditionHint?: string | null;  // extractor hint, same 4-way vocabulary
  odometerKm?: number | string | null;
}

/**
 * May this vehicle's MSRP be compared against its asking price today?
 *
 * Pure and deterministic — the gate imports this exact function rather than
 * re-implementing it, so editing the rule cannot leave a test asserting the old
 * one (which is how the previous regression test stayed green on changed code).
 */
export function msrpIsPresentTense(ctx: ConditionCtx): boolean {
  const sale = deriveSaleCondition({
    vehicleCondition: ctx.vehicleCondition ?? null,
    saleCondition: ctx.saleCondition ?? ctx.saleConditionHint ?? null,
  });

  if (sale === "new" || sale === "demo") return true;
  if (sale === "certified" || sale === "used") {
    // deriveSaleCondition lets ANY valid 4-way value outrank vehicleCondition,
    // which is right for cpo.ts and marketvalue.ts but wrong here: a bare
    // extractor "used" beside an explicit vehicleCondition "new" and delivery
    // kilometres is more likely a mislabel than a used car, and suppressing on
    // it would silently kill the comparison on genuinely new listings. Require
    // corroboration before the finer value overrides an explicit "new".
    const explicitlyNew = String(ctx.vehicleCondition ?? "").trim().toLowerCase() === "new";
    const km = Number(ctx.odometerKm);
    const deliveryKm = Number.isFinite(km) && km >= 0 && km <= DELIVERY_KM;
    if (explicitlyNew && deliveryKm) return true;
    return false;
  }

  // Nothing classified it. Accept only positive evidence of newness: an
  // explicit "new", or an odometer still on delivery kilometres. Everything
  // else — including no odometer at all — is unknown, and unknown is not new.
  if (String(ctx.vehicleCondition ?? "").trim().toLowerCase() === "new") return true;

  // COERCE NOTHING. Number(null) and Number("") are both 0, which sits inside
  // the delivery window — so the first version of this function answered "new"
  // for a car whose odometer the page never showed, contradicting the paragraph
  // directly above it and re-opening the defect it was written to close. An
  // absent reading is unknown; only a reading we actually have can be small.
  const raw = ctx.odometerKm;
  if (raw === null || raw === undefined || String(raw).trim() === "") return false;
  const km = Number(raw);
  return Number.isFinite(km) && km >= 0 && km <= DELIVERY_KM;
}

export interface DecidedMsrp {
  msrp?: number | null;
  basis?: string | null;
  trim?: string | null;
  sourceUrl?: string | null;
  inflation?: unknown | null;
}

export interface BasisOutcome {
  /** The basis to store. "original_when_new" whenever the claim must stay off. */
  basis: MsrpBasis;
  /** Set when the figure is the ORIGINAL sticker: the report shows it as context. */
  originalMsrp: { msrp: number; trim: string | null; year: number | null; sourceUrl: string | null } | null;
  /** Whether an inflated-sticker accusation may be named. */
  inflation: unknown | null;
  presentTense: boolean;
}

/**
 * Fold sale condition into a resolved MSRP decision.
 *
 * Also gates the inflated-sticker accusation, which is condition-dependent for
 * the same reason the comparison is: a used car's stated MSRP is its ORIGINAL
 * as-optioned sticker, and the catalog row is a base trim. Calling that gap
 * "the dealer padded the sticker" is an accusation built out of a data gap, on
 * a number the dealer did not invent (no-accusation-language).
 */
export function applyConditionToMsrp(
  decided: DecidedMsrp,
  ctx: ConditionCtx & { year?: number | null },
): BasisOutcome {
  const presentTense = msrpIsPresentTense(ctx);
  const incoming = String(decided.basis ?? "") as MsrpBasis;

  if (presentTense) {
    return { basis: incoming, originalMsrp: null, inflation: decided.inflation ?? null, presentTense: true };
  }

  // A dealer-stated figure is already unable to carry an over/under claim
  // (msrp-claim.ts refuses anything that is not "exact"), and relabelling it
  // would lose the fact that the DEALER said it. Leave the label, drop the
  // accusation.
  if (incoming === "dealer_stated") {
    return { basis: "dealer_stated", originalMsrp: null, inflation: null, presentTense: false };
  }

  const msrp = Number(decided.msrp);
  return {
    basis: "original_when_new",
    originalMsrp: Number.isFinite(msrp) && msrp > 0
      ? { msrp, trim: decided.trim ?? null, year: ctx.year ?? null, sourceUrl: decided.sourceUrl ?? null }
      : null,
    inflation: null,
    presentTense: false,
  };
}
