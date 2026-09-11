// ── Pure aggregation for the Alberta daily inventory report ─────────────────
//
// Kept separate from build-alberta-inventory-daily.mjs (which only reads the
// database and writes the row) so the one number that actually matters here --
// which dealer passes get excluded from "verified" and why -- is a plain
// function scripts/test-inventory-daily.mjs can call with synthetic rows,
// with no database in the loop.
//
// THE CAP. No Alberta rooftop carries ten thousand vehicles. On the day this
// was built, one dealer pass returned 5,163 used units in a single crawl --
// 82% of everything read that day -- almost certainly a group or platform
// feed being read as one dealer's lot, not a real inventory. A public daily
// report cannot inherit that silently: any dealer/condition count above the
// cap is EXCLUDED from the verified total and folded into raw + flagged,
// with the dealer named in `notes` so nobody has to go find the log to learn
// why the two totals differ. [[no-single-point-of-failure]] -- this cap holds
// even if the upstream crawl-side fix for the same defect is not yet live.
export const PLAUSIBLE_MAX_PER_DEALER_PER_CONDITION = 1500;

/**
 * counts: [{dealerId, dealerName, condition: "new"|"used", n: number}, ...]
 * one row per (dealer, condition) pair seen this day.
 *
 * Returns { newRaw, newVerified, usedRaw, usedVerified, dealersFlagged, notes }.
 */
export function aggregateDailyCounts(counts) {
  let newRaw = 0, newVerified = 0, usedRaw = 0, usedVerified = 0;
  const flagged = [];
  for (const row of counts) {
    const n = Number(row.n) || 0;
    const isNew = row.condition === "new";
    if (isNew) newRaw += n; else usedRaw += n;
    if (n > PLAUSIBLE_MAX_PER_DEALER_PER_CONDITION) {
      flagged.push({ dealerId: row.dealerId, dealerName: row.dealerName, condition: row.condition, n });
      continue; // excluded from *_verified — see the cap comment above
    }
    if (isNew) newVerified += n; else usedVerified += n;
  }
  const dealersFlagged = new Set(flagged.map((f) => f.dealerId)).size;
  const notes = flagged.length
    ? flagged
        .map((f) => `${f.dealerName ?? "dealer " + f.dealerId} returned ${f.n.toLocaleString("en-CA")} ${f.condition} units — above the ${PLAUSIBLE_MAX_PER_DEALER_PER_CONDITION.toLocaleString("en-CA")}-unit plausibility cap, excluded from the verified total and under review.`)
        .join(" ")
    : null;
  return { newRaw, newVerified, usedRaw, usedVerified, dealersFlagged, notes };
}

/**
 * Splits the same per-(dealer,condition) counts by city and runs the SAME
 * plausibility cap within each city, so a single oversized dealer can't
 * distort one city's total any more than it can distort the province's.
 *
 * dealerCityKey: Map<dealerId, cityKey|null> -- a dealer with no known city
 * (null) is excluded here exactly as it is from city_dealer_index, rather
 * than inventing a location for it.
 *
 * Returns one row per city that had at least one observation, unsorted and
 * ungated -- the caller decides the publish threshold (city_inventory_daily
 * writes every city; fn_city_inventory_daily applies the read-time gate).
 */
export function aggregateByCity(counts, dealerCityKey) {
  const byCity = new Map();
  for (const c of counts) {
    const ck = dealerCityKey.get(c.dealerId);
    if (!ck) continue;
    if (!byCity.has(ck)) byCity.set(ck, []);
    byCity.get(ck).push(c);
  }
  const out = [];
  for (const [ck, cityCounts] of byCity) {
    const agg = aggregateDailyCounts(cityCounts);
    const dealersSeen = new Set(cityCounts.map((c) => c.dealerId)).size;
    out.push({ cityKey: ck, dealersSeen, ...agg });
  }
  return out;
}
