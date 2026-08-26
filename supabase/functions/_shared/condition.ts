// ============================================================================
// condition.ts — sale-condition granularity: new / demo / certified / used.
//
// WHY. The pipeline has only a binary vehicleCondition ("new" | "used"), and the
// platform extractors collapse demo and certified into "used" (see d2c-vdp.js,
// convertus-vms.js). But those are different buys with different fee/warranty
// questions: a CERTIFIED car carries an OEM CPO premium worth verifying (cpo.ts);
// a DEMO was dealer-registered and its warranty clock already started. This adds
// a finer saleCondition ALONGSIDE vehicleCondition (which is left untouched, so
// nothing that keys off "new"/"used" — e.g. the new-only dealer-fee ceiling —
// changes behaviour).
//
// Pure + deterministic so it unit-tests cleanly. Returns null only when we truly
// cannot tell (no vehicleCondition and no signal): granularity is additive, never
// a guess.
// ============================================================================

export type SaleCondition = "new" | "demo" | "certified" | "used";

const norm = (s: unknown): string => String(s ?? "").trim().toLowerCase();

export function deriveSaleCondition(input: {
  vehicleCondition?: string | null;   // the binary "new" | "used" | null
  saleCondition?: string | null;      // an explicit 4-way value (LLM/extractor), wins if valid
  isCertified?: boolean | null;       // structured flag (d2c)
  isDemo?: boolean | null;            // structured flag (d2c)
  saleClass?: string | null;          // free text (convertus sale_class, a listing badge)
}): SaleCondition | null {
  // An explicit, valid 4-way value from the extractor/LLM wins.
  const explicit = norm(input.saleCondition);
  if (explicit === "new" || explicit === "demo" || explicit === "certified" || explicit === "used") {
    return explicit as SaleCondition;
  }

  const sc = norm(input.saleClass);
  const demo = input.isDemo === true || /\bdemo\b|demonstrat/.test(sc);
  // "certified pre-owned" / "cpo" / "certified". Guard against "non-certified".
  const certified = input.isCertified === true || (/certified|\bcpo\b/.test(sc) && !/non[-\s]?certified|not certified/.test(sc));

  const vc = norm(input.vehicleCondition);

  // A demo may still be titled "new" by the dealer; a demo signal downgrades it.
  if (vc === "new") return demo ? "demo" : "new";
  if (vc === "used") return demo ? "demo" : (certified ? "certified" : "used");

  // vehicleCondition unknown: infer only from a signal, else we don't know.
  if (demo) return "demo";
  if (certified) return "certified";
  return null;
}
