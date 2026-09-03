// A MISSING NUMBER IS NOT ZERO.
//
// `Number(null)` is 0. `Number("")` is 0. `Number([])` is 0. And 0 is a legal
// odometer reading, a legal interest rate, a legal review count, a legal price
// and a legal model year -- so for those fields nothing downstream can tell
// "we read zero" from "we read nothing".
//
// That single fact produced four separate defects in three days (2026-09-01 to
// 09-03), each of which looked like a different bug:
//   - a used car with no odometer became a 0 km car, was called NEW, and was
//     handed a present-tense MSRP claim it had no right to (ad477ed);
//   - the same 0 built a 0-20,000 km "similar mileage" window around a vehicle
//     that might have 150,000 (2a1506d);
//   - a null calculator rate would have printed "this page's payment
//     calculator opens at 0%" over a page showing no rate (19242f1);
//   - "Odometer 0 km -- consistent with a new vehicle (delivery distance)"
//     printed on a real customer report for a page that published no odometer
//     at all (LC-FE77-C58).
//
// Every guard that would have caught these was written in the CONSUMER, and
// every coercion happens in the PRODUCER, so the guards were correct and
// unreachable. This helper belongs at the producer boundary: read the field,
// keep the absence, and let the consumer decide what an absence means.
//
// Use it for any field where 0 is a meaningful reading. For a field where 0 is
// impossible (a count of listings, a page length) plain Number() is fine.

/**
 * The number this field holds, or null when it holds nothing.
 * Never turns an absence into 0.
 * @param {unknown} x
 * @returns {number | null}
 */
export function readNum(x) {
  if (x === null || x === undefined) return null;
  if (typeof x === "string" && x.trim() === "") return null;
  if (typeof x === "boolean" || Array.isArray(x)) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/**
 * The same, for a schema.org-style value that may be a bare number or a
 * QuantitativeValue object: `{ value, unitCode }`. The old code tested the
 * CONTAINER for null and then coerced the null INSIDE it, which is how a
 * `{ value: null }` became 0 km and then "new".
 * @param {unknown} x
 * @returns {number | null}
 */
export function readNumOrValue(x) {
  if (x !== null && typeof x === "object" && !Array.isArray(x)) return readNum(/** @type {any} */ (x).value);
  return readNum(x);
}

/**
 * A vehicle's odometer reading in kilometres, or null when the listing did not
 * publish one. The single reader both scan paths and the checkpoint use, so a
 * fix cannot land on one path and miss the other.
 * @param {{ odometerKm?: unknown }} analysis
 * @returns {number | null}
 */
export function odometerReading(analysis) {
  const km = readNum(analysis?.odometerKm);
  return km != null && km >= 0 ? km : null;
}
