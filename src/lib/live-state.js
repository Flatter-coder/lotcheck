// A LIT DOT IS A CLAIM. This is the single decision behind every "Live"
// indicator in the product, kept in its own module so it can be tested and so
// there is exactly one place the rule lives.
//
// The standing rule already existed — "the dot lights only AFTER the data read
// succeeds, never during loading and never on an error state" — and it was
// still broken in three places at once, because every surface hand-rolled its
// own boolean and each one picked a proxy that was cheaper than the truth:
//
//   alberta.html   `class="pill live"` in static markup. Nothing to evaluate at
//                  all, over a frozen count array reading 527 dealers against a
//                  real 405, and Grande Prairie 24 where OSM finds 2 (7979db0).
//   ledger         `loaded = !apiUsageLoading`. A FAILED read clears the loading
//                  flag too — useApiUsage catches, warns, and clears it in
//                  `finally` — so the badge lit green over data it never got.
//   LiveTicker     `listings.length > 0`. Never false: useListings SEEDS its
//                  state with DEMO_LISTINGS, so the demo array arrives through
//                  the same prop and answers "live" for fourteen invented cars.
//
// Every one of those is the same substitution: something merely CORRELATED with
// a successful read, standing in for the read itself. So the input here is not a
// loading flag, not a length, not a truthy payload — it is `readAt`, a timestamp
// that only a response can produce. There is deliberately no argument that
// forces a lit result.
//
// Three states, never two. `aged` matters because a stale read is not a failure:
// hiding it is as wrong as claiming "Live" over it. Say when it last worked.

export const LIVE_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * @param {number|Date|null|undefined} readAt  when a read last SUCCEEDED
 * @param {number} [maxAgeMs]                  older than this is aged, not live
 * @returns {"live"|"aged"|"unavailable"}
 */
export function liveState(readAt, maxAgeMs = LIVE_MAX_AGE_MS, now = Date.now()) {
  const t = readAt instanceof Date ? readAt.getTime() : Number(readAt);
  // Rejects null, undefined, "", NaN, 0 and negatives. A falsy or nonsense
  // timestamp is the shape a failed read leaves behind, and it must never read
  // as live — including a future timestamp from a skewed clock, which would
  // otherwise pass an "age <= max" test forever.
  if (!Number.isFinite(t) || t <= 0) return "unavailable";
  const age = now - t;
  if (age < 0) return "unavailable";
  return age <= maxAgeMs ? "live" : "aged";
}
