// Build & Price summary gate — decides whether a captured Toyota summary may
// become an msrp_catalog row, and refuses when it cannot.
//
// WHY THIS IS CODE AND NOT A COMMENT. The same defect landed three times on
// three nameplates, and each time the response was a warning in a migration
// header, which stopped nothing:
//
//   RAV4 Limited     $52,350  carried $350   Ruby Flare Pearl
//   Land Cruiser     $80,850  carried $390   Heritage Blue with Light Grey Roof
//   Crown Signia     $59,460  carried $905   Oxygen White with Black Roof
//
// A configurator summary describes a CAR — one specific build, with one
// specific colour. A catalog row must hold a TRIM. If the buyer's colour is
// left inside the figure, every over/under claim computed against it is wrong
// by that colour, and MSRP is the denominator of nearly every other number on
// the report.
//
// TWO WAYS THE COLOUR GETS IN, AND A GATE MUST CHECK BOTH.
//
//  1. Folded into the PACKAGE line. Toyota appends "with Premium Paint" to the
//     package label — "Platinum with Premium Paint $6,272.00". The suffix is
//     present only when a paid colour is bundled: the 4Runner Hybrid
//     Trailhunter's line is bare ("Trailhunter $16,447.00") because Everest is
//     free on that trim.
//
//  2. Folded into the MSRP LINE, with no package line and no paint line
//     anywhere in the document. This is the one that got past the first
//     version of this gate. The Crown Signia Limited prints MSRP $59,460 for a
//     two-tone build and $58,555 for a single-tone one — same trim, $905 apart,
//     and nothing in the first document says "paint".
//
// So "no package suffix" does NOT mean safe. The exterior has to be known
// no-cost, and the only honest way to know that is evidence: either a second
// build of the same trim priced lower, or an explicit record that the colour is
// free. Absent that, refuse. Missing beats wrong.

// Alberta line items. ONLY the ones that have held on every summary captured so
// far live here — and this list shrank once already, which is the point.
//
// delivery_destination WAS in this object at $1,930. The 2026 Crown prints
// $1,860, so every Crown figure computed from the constant was $70 wrong. It is
// now a REQUIRED per-summary input with no default: an absent freight figure
// refuses instead of quietly substituting another model's.
//
// The block heater was never a constant and has seven values across seven
// models ($682 / $702 / $707 / $709 / $712 / $717 / $797.40), plus none at all
// on a plug-in, which ships with a cord.
//
// Treat the four below as observed-stable, not guaranteed. If a summary prints
// a different A/C charge or dealer-fee cap, reconciles() will fail rather than
// silently absorb it — which is how the freight difference surfaced.
export const AB_STATUTORY = { dealer_fees_max: 999, air_conditioning: 100, tire_levy: 25, amvic: 10 };

// PPSA applies only to a leased or financed deal, never to cash.
export const PPSA_FINANCE_BASIS = 14 + 4;

function addsOf(fees, delivery) {
  const d = Number(delivery);
  if (!Number.isFinite(d)) return null; // caller must refuse
  return Object.values(fees).reduce((a, b) => a + b, 0) + d;
}

export const PAINT_SUFFIX_RE = /\bwith\s+Premium\s+Paint\s*$/i;

/** A package label bundles paint when Toyota suffixes it. Bare label = free colour. */
export function packageBundlesPaint(packageLine) {
  return PAINT_SUFFIX_RE.test(String(packageLine ?? "").trim());
}

/**
 * A two-tone exterior is never free on any Toyota line captured so far, and it
 * is the shape that produced the two largest misses ($390, $905). Treat it as
 * paid unless proven otherwise. Single-tone names are NOT assumed free — they
 * fall to the evidence check below.
 */
export function looksTwoTone(exterior) {
  return /\bwith\s+.*\bRoof\b/i.test(String(exterior ?? ""));
}

/**
 * MSRP + package + accessories + Alberta adds must equal the printed subtotal.
 * `delivery` is REQUIRED — it varies by model ($1,930 on most, $1,860 on the
 * Crown) and guessing it silently shifts every figure downstream.
 */
export function reconciles({ msrpLine, packagePrice = 0, blockHeater = 0, fees = AB_STATUTORY, delivery, printedSubtotal }) {
  const adds = addsOf(fees, delivery);
  if (adds === null) return { ok: false, calc: null, reason: "no delivery/destination charge captured — it varies by model and must be read from the summary" };
  const calc = Number(msrpLine) + Number(packagePrice) + Number(blockHeater) + adds;
  return { ok: Math.abs(calc - Number(printedSubtotal)) < 0.02, calc };
}

/**
 * The gate. Returns { seedable, msrp, allIn, reason }.
 *
 * `noCostExterior` must be a POSITIVE FINDING — a second build of the same trim
 * that prices lower, or a recorded free-colour list. It is never a default, and
 * `undefined` means "unknown", which refuses.
 */
export function assessSummary(s) {
  const refuse = (reason) => ({ seedable: false, msrp: null, allIn: null, reason });

  if (!Number.isFinite(Number(s.msrpLine))) return refuse("no MSRP line parsed");
  if (Number.isFinite(Number(s.printedSubtotal))) {
    const r = reconciles(s);
    if (!r.ok) return refuse(`does not reconcile: computed ${r.calc} vs printed ${s.printedSubtotal} — parse is wrong, do not seed`);
  }

  if (s.packageLine && packageBundlesPaint(s.packageLine)) {
    return refuse(`package line "${s.packageLine}" bundles the paint — package price cannot be separated from the colour`);
  }
  if (looksTwoTone(s.exterior)) {
    return refuse(`exterior "${s.exterior}" is two-tone, which is paid on every line captured so far — the MSRP line carries it`);
  }
  if (s.noCostExterior !== true) {
    return refuse(`exterior "${s.exterior ?? "unknown"}" is not confirmed no-cost — capture this trim in a free colour, or price a second build to separate the paint`);
  }

  const msrp = Number(s.msrpLine) + Number(s.packagePrice ?? 0);
  const allIn = Number.isFinite(Number(s.printedSubtotal)) ? Number(s.printedSubtotal) : null;
  return { seedable: true, msrp, allIn, reason: "MSRP line reconciles and the colour is confirmed free" };
}

/**
 * Two builds of ONE trim differing only in colour: the lower MSRP line is the
 * trim price and the difference is the paint. This is a DIRECT READ of the base
 * from Toyota's own MSRP line, not an inference — it is how the Land Cruiser
 * ($80,460 + $390) and the Crown Signia ($58,555 + $905) were recovered.
 */
export function deriveBaseFromPair(a, b) {
  const [lo, hi] = [Number(a.msrpLine), Number(b.msrpLine)].sort((x, y) => x - y);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { ok: false, reason: "unparsed MSRP line" };
  if (lo === hi) return { ok: false, reason: "both builds state the same MSRP line — no paint charge is isolated" };
  return { ok: true, baseMsrp: lo, paintPremium: hi - lo };
}

// ---------------------------------------------------------------------------
// THE LINEUP PAGE IS A SECOND SOURCE, and it is the one that was missing.
//
// toyota.ca's model grid prints "From $X" under every vehicle. That figure is
// the model's CHEAPEST trim, all-in, on the FINANCE basis — Toyota's own
// published formula plus PPSA:
//
//     From$ = base trim MSRP + block heater + Alberta statutory adds + $18 PPSA
//
// Verified to the cent on two independently-derived bases:
//     Crown Signia Limited   58,555 + 717 + 3,064 + 18 = 62,354  = page
//     Land Cruiser 1958      71,670 + 702 + 3,064 + 18 = 75,454  = page
//
// Why this matters more than another PDF: a Build & Price summary SUPPLIES a
// number, so a mis-parse produces a confident wrong answer with nothing to
// catch it. The lineup page CHECKS the number, from a different Toyota surface,
// for every model at once. That is corroboration rather than repetition — and
// it is what lets a base survive a dealer disputing it.
//
// It also RESOLVES withheld trims: if a summary's MSRP line agrees with the
// page, its colour was free; if it exceeds it, the difference is the paint.
//
// LIMIT: it prices the cheapest trim only. Everything above base still needs a
// summary. Page checks the floor, summary supplies the ladder.
export function corroborateWithLineup({ baseMsrp, blockHeater = 0, lineupFrom, delivery, fees = AB_STATUTORY, surface = "lineup" }) {
  // SURFACE MATTERS, and getting this wrong is how a $34 mismatch got recorded
  // as "unexplained". The formula was validated on TWO figures, both from the
  // LINEUP GRID (Crown Signia $62,354, Land Cruiser $75,454) — both exact. It
  // was then applied to a TRIM CARD (Crown Limited $58,914) and missed by $34.
  //
  // A trim card is a different Toyota surface describing a slightly different
  // build: its weekly lease reads $203.06 against the pricing table's $203.19,
  // and over 260 payments that is $33.80 — the same gap, consistently. So the
  // card is internally coherent; it simply is not the figure this formula
  // models. Refuse rather than pretend otherwise.
  if (surface !== "lineup") {
    return { agrees: false, delta: null,
      verdict: `this figure came from a ${surface}, and the formula is only validated against the lineup grid — no corroboration is claimed` };
  }
  const adds = addsOf(fees, delivery);
  if (adds === null) return { agrees: false, delta: null, verdict: "no delivery/destination charge captured — cannot corroborate without it" };
  const expected = Number(baseMsrp) + Number(blockHeater) + adds + PPSA_FINANCE_BASIS;
  const delta = Number(lineupFrom) - expected;
  if (Math.abs(delta) < 0.02) return { agrees: true, delta: 0, verdict: "confirmed by a second Toyota surface" };
  // Below the floor has TWO possible causes and this check cannot separate them:
  // the MSRP line may carry paint, or a cheaper trim may exist that we have not
  // captured. Say both. Naming one would be a guess wearing the badge of a check.
  if (delta < 0) {
    return { agrees: false, delta,
      verdict: `sits $${(-delta).toFixed(2)} ABOVE Toyota's published floor — either this MSRP line carries paint, or a cheaper trim exists that we have not captured. Do not seed as the model's base until which one is established.` };
  }
  // Above the floor should be impossible: nothing can be cheaper than the
  // cheapest trim. Our figure or our block heater is wrong.
  return { agrees: false, delta,
    verdict: `sits $${delta.toFixed(2)} BELOW Toyota's published floor, which cannot be true of any real trim — the MSRP or the block-heater figure is wrong.` };
}
