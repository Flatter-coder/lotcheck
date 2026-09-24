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
 * cars: one row per car from fn_listing_once(p_day) -- { dealer_id, dealer_ids,
 * condition }. dealer_id is null when more than one dealer lists the car.
 *
 * Returns { counts, disputed }: counts in the shape aggregateDailyCounts and
 * aggregateByCity take. A car listed by more than one dealer counts ONCE, in a
 * `shared` row credited to no dealer (and so outside the per-dealer cap, which
 * exists to catch one feed carrying a group), and to a city only when every
 * dealer listing it is in that city. A car whose dealers disagree on new vs
 * used has a null condition: it is counted in `disputed`, in neither total.
 */
export function countCars(cars, dealerCityKey, dealerName = new Map()) {
  const byKey = new Map();
  let disputed = 0;
  for (const c of cars) {
    if (!c.condition) { disputed++; continue; }
    const shared = c.dealer_id == null;
    const ids = c.dealer_ids || [];
    const cities = shared ? new Set(ids.map((id) => dealerCityKey.get(id) ?? null)) : null;
    const cityKey = cities?.size === 1 ? [...cities][0] : null;
    const k = shared ? `shared|${cityKey ?? ""}|${c.condition}` : `${c.dealer_id}|${c.condition}`;
    if (!byKey.has(k)) {
      byKey.set(k, shared
        ? { dealerId: null, dealerName: null, shared: true, cityKey, dealerIds: new Set(), condition: c.condition, n: 0 }
        : { dealerId: c.dealer_id, dealerName: dealerName.get(c.dealer_id), condition: c.condition, n: 0 });
    }
    const row = byKey.get(k);
    row.n++;
    if (shared) for (const id of ids) row.dealerIds.add(id);
  }
  return { counts: [...byKey.values()], disputed };
}

/**
 * counts: [{dealerId, dealerName, condition: "new"|"used", n: number}, ...]
 * one row per (dealer, condition) pair seen this day, plus countCars' shared
 * rows (cars more than one dealer lists).
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
    if (!row.shared && n > PLAUSIBLE_MAX_PER_DEALER_PER_CONDITION) {
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
    const ck = c.shared ? c.cityKey : dealerCityKey.get(c.dealerId);
    if (!ck) continue;
    if (!byCity.has(ck)) byCity.set(ck, []);
    byCity.get(ck).push(c);
  }
  const out = [];
  for (const [ck, cityCounts] of byCity) {
    const agg = aggregateDailyCounts(cityCounts);
    const dealersSeen = new Set(cityCounts.flatMap((c) => (c.shared ? [...c.dealerIds] : [c.dealerId]))).size;
    out.push({ cityKey: ck, dealersSeen, ...agg });
  }
  return out;
}
