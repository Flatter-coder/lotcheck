// Hand-maintained corrections for Toyota/Lexus catalog rows the auto-scraper
// derives WRONG, applied to the scrape output before it is written. This is the
// "hand-seed" half of the fix — durable because it runs on every refresh, unlike
// a migration that replaceRows() wipes within a day.
//
// WHY THIS EXISTS (2026-08-26). tci-stack.mjs tags fuel at the SERIES level
// (inferFuel), so a multi-powertrain line like the Lexus TX — TX 350 (gas) and
// TX 500h (hybrid) under one "TX" series tagged "Hybrid Available" — stored every
// TX 350 gas trim as "Hybrid", and named the base by Lexus's internal grade
// ("Premium") instead of the Canadian trim ("Luxury"). A 2026 TX 350 Luxury
// listing then matched no row and resolved to $81,484 (the F SPORT 3 row).
//
// THE PROPER FIX is per-model fuel + grade->trim reconciliation in tci-stack
// (tracked separately, needs a live-feed test pass). Until then these overrides
// keep the served catalog correct. Every MSRP here is ex-freight, matching the
// column: the TX 350 gas figures are the scraper's own cross-province-verified
// values (only their fuel/base-name were wrong); the TX 500h figures come from
// Lexus Canada's Build & Price all-in "From" prices minus the identical $3,351.18
// Alberta fee stack that closes the TX 350 arithmetic to the cent.

// One entry per make/model/year we override. `rows` REPLACES every scraped row
// for that (make, model, year) — trim, msrp and fuel together.
export const TCI_OVERRIDES = [
  {
    make: "Lexus", model: "TX", year: 2026,
    reason: "series-level fuel tag stored gas TX 350 trims as Hybrid; base grade 'Premium' not the 'Luxury' trim; TX 500h hybrids missing",
    rows: [
      // TX 350 — gasoline
      { trim: "Luxury",                    msrp: 69855, fuel_type: "Gas" },
      { trim: "Ultra Luxury",              msrp: 72608, fuel_type: "Gas" },
      { trim: "Executive 7-Pass",          msrp: 80861, fuel_type: "Gas" },
      { trim: "F SPORT 3",                 msrp: 81484, fuel_type: "Gas" },
      { trim: "Executive 6-Pass",          msrp: 81611, fuel_type: "Gas" },
      { trim: "F SPORT 3 + Towing Hitch",  msrp: 82631, fuel_type: "Gas" },
      // TX 500h — hybrid
      { trim: "F SPORT Performance 2",                 msrp: 85400, fuel_type: "Hybrid" },
      { trim: "F SPORT Performance 2 + Towing Hitch",  msrp: 86546, fuel_type: "Hybrid" },
      { trim: "F SPORT Performance 3",                 msrp: 91399, fuel_type: "Hybrid" },
      { trim: "F SPORT Performance 3 + Towing Hitch",  msrp: 92546, fuel_type: "Hybrid" },
    ],
  },
];

const key = (make, model, year) => `${String(make).toLowerCase()}|${String(model).toLowerCase()}|${year}`;

/** Replace scraped rows for any overridden (make, model, year) with the
 *  hand-maintained set. Rows for models with no override pass through untouched.
 *  Pure; returns { rows, replaced: [{key, dropped, inserted}] }. */
export function applyTciOverrides(scrapedRows, makeName, overrides = TCI_OVERRIDES) {
  const byKey = new Map();
  for (const o of overrides) {
    if (String(o.make).toLowerCase() !== String(makeName).toLowerCase()) continue;
    byKey.set(key(o.make, o.model, o.year), o);
  }
  if (!byKey.size) return { rows: scrapedRows || [], replaced: [] };

  const replaced = [];
  const dropped = new Map();
  const kept = (scrapedRows || []).filter((r) => {
    const k = key(r.make, r.model, r.year);
    if (byKey.has(k)) { dropped.set(k, (dropped.get(k) || 0) + 1); return false; }
    return true;
  });

  const injected = [];
  const now = "2026-08-26T00:00:00.000Z";
  for (const [k, o] of byKey) {
    for (const row of o.rows) {
      injected.push({ year: o.year, make: o.make, model: o.model, trim: row.trim, msrp: row.msrp, fuel_type: row.fuel_type, fetched_at: now });
    }
    replaced.push({ key: k, dropped: dropped.get(k) || 0, inserted: o.rows.length });
  }
  return { rows: [...kept, ...injected], replaced };
}

// Guard: a multi-powertrain series should never come back tagged all one
// non-gas fuel. Returns the offending (make|model|year) groups so the caller can
// warn (and the override, if any, has already corrected them). Conservative:
// only flags groups of >=4 trims that are 100% Hybrid/PHEV/BEV — a genuine
// hybrid-only nameplate is small, a whole gas+hybrid line mis-tagged is not.
export function flagAllOnePowertrain(rows, { minTrims = 4 } = {}) {
  const groups = new Map();
  for (const r of rows || []) {
    const k = `${r.make}|${r.model}|${r.year}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  // A SIBLING NAMEPLATE IS THE PROOF. "all rows one non-gas fuel" alone is a
  // false positive on genuinely single-powertrain lines (Sienna is hybrid-only
  // and its nameplate carries no marker), and dropping those would cost real
  // coverage. But when the SAME make/year also lists a sibling model whose
  // name extends this one with a powertrain marker -- Lexus shipping "NX",
  // "NX Hybrid" AND "NX Plug-in Hybrid" -- then the bare nameplate is the GAS
  // line by construction, and tagging all of its trims "Hybrid" is provably a
  // series-level mis-tag. Confirmed live 2026-08-27: every gasoline Lexus 'NX'
  // row was stored fuel_type 'Hybrid', which is what let a gas ladder be
  // offered to a hybrid buyer. Same defect a migration hand-fixed for the
  // Lexus TX on 2026-08-26 and left unfixed for the NX.
  const nameplates = new Set((rows || []).map((r) => `${r.make}|${r.year}|${String(r.model || "").toLowerCase()}`));
  const hasPowertrainSibling = (make, year, model) => {
    const base = String(model || "").toLowerCase();
    return ["hybrid", "plug-in hybrid", "plug in hybrid", "phev", "ev", "prime", "recharge"]
      .some((sfx) => nameplates.has(`${make}|${year}|${base} ${sfx}`));
  };
  const flagged = [];
  for (const [k, rs] of groups) {
    if (rs.length < minTrims) continue;
    const fuels = new Set(rs.map((r) => r.fuel_type));
    if (fuels.size === 1 && !fuels.has("Gas") && !fuels.has(null)) {
      const r0 = rs[0];
      flagged.push({
        key: k, trims: rs.length, fuel: [...fuels][0],
        // Only a proven mis-tag may be refused; the rest stay a warning.
        proven: hasPowertrainSibling(r0.make, r0.year, r0.model),
      });
    }
  }
  return flagged;
}
