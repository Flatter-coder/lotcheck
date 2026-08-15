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

// Alberta line items, captured per summary. Never assume a constant: the block
// heater alone has six values across six models ($682 / $702 / $707 / $712 /
// $717 / $797.40) and a plug-in ships with a cord instead.
export const AB_STATUTORY = { delivery_destination: 1930, dealer_fees_max: 999, air_conditioning: 100, tire_levy: 25, amvic: 10 };

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

/** MSRP + package + accessories + Alberta adds must equal the printed subtotal. */
export function reconciles({ msrpLine, packagePrice = 0, blockHeater = 0, fees = AB_STATUTORY, printedSubtotal }) {
  const adds = Object.values(fees).reduce((a, b) => a + b, 0);
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
