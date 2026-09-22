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

/**
 * Delivery kilometres: the most a genuinely new car has on it from transport,
 * dealer trade and test drives. Above this, a car labelled "new" has been
 * driven, whatever the badge says.
 *
 * MEASURED, not chosen. 2026-09-21, 8,281 odometer readings across 221
 * year/make/model combinations of dealer-labelled NEW Alberta listings
 * (fn_market_comps, live and undamaged):
 *
 *     0 km          8.8%  |  cumulative   8.8%
 *     1-50         72.5%  |              81.3%
 *     51-100       12.0%  |              93.3%
 *     101-250       1.1%  |              94.4%
 *     251-500       0.7%  |              95.1%
 *     501-1000      0.3%  |              95.4%   <- the valley
 *     1001-2000     0.7%  |              96.1%
 *     2001-5000     2.1%  |              98.2%   <- second population
 *     5001-10000    1.1%  |              99.2%
 *     10001+        0.8%  |             100.0%
 *
 * p50 10 km, p90 90 km. The distribution is BIMODAL: real new cars pile up
 * under 100 km, the middle empties out, and a second population appears above
 * 2,000 km. 1,000 sits at the floor of that valley — the emptiest band, just
 * before the second hump starts — so the line separates two real populations
 * instead of cutting through one. Re-measure with
 * scripts/measure-new-odometer.mjs before changing it.
 *
 * Exported so msrp-basis.ts uses this exact value. It previously kept its own
 * copy, which meant "is this car new" had two authors that could disagree.
 */
export const DELIVERY_KM = 1000;

const norm = (s: unknown): string => String(s ?? "").trim().toLowerCase();

export function deriveSaleCondition(input: {
  vehicleCondition?: string | null;   // the binary "new" | "used" | null
  saleCondition?: string | null;      // an explicit 4-way value (LLM/extractor), wins if valid
  isCertified?: boolean | null;       // structured flag (d2c)
  isDemo?: boolean | null;            // structured flag (d2c)
  saleClass?: string | null;          // free text (convertus sale_class, a listing badge)
  odometerKm?: number | null;         // the reading itself — a demo signal no badge can hide
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

  // THE ODOMETER IS ITSELF A DEMO SIGNAL. Every other input here is a word
  // somebody chose to write. A 2026 Defender advertised as "New" at 6,675 km
  // carried no demo flag, no sale_class and no hint, so this returned "new" —
  // and "new" is what drives the new-only dealer-fee ceiling and a warranty
  // clock the report assumes has not started. The kilometres were printed
  // directly beside the word "New" on the page the whole time.
  //
  // Unknown stays unknown: a missing or unparseable reading is not zero.
  const km = typeof input.odometerKm === "number" ? input.odometerKm : Number(input.odometerKm);
  const driven = Number.isFinite(km) && km > DELIVERY_KM;

  // A demo may still be titled "new" by the dealer; a demo signal downgrades it.
  if (vc === "new") return (demo || driven) ? "demo" : "new";
  if (vc === "used") return demo ? "demo" : (certified ? "certified" : "used");

  // vehicleCondition unknown: infer only from a signal, else we don't know.
  if (demo) return "demo";
  if (certified) return "certified";
  // No condition at all: kilometres alone cannot tell a demo from a used car,
  // so this stays unknown rather than guessing between them.
  return null;
}
