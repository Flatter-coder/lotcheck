// National, published Toyota/Lexus MSRP -- and the proof that it is one.
//
// WHY THIS EXISTS. The scraper used to read pkg.vehicleStartPrice from
// price_calculation/prices.json and store it as MSRP. That field is a
// province-CALCULATED price: the same 2026 Land Cruiser returns twelve distinct
// values across thirteen provinces (ON 74681.92, AB 75335, BC 74648, QC
// 74559.5 ...). MSRP is national, so it is definitionally not that field. The
// old whole-dollar filter did not save us either -- AB, BC, NL, YT and NT all
// return whole dollars that disagree with each other, so at province=ON it
// ADMITTED 7 of 76 rows as manufacturer prices.
//
// THE REAL SOURCE. The Build & Price client assembles this URL at runtime,
// which is why it does not appear anywhere in the served HTML:
//
//   /bin/api/price_calculation/from_prices.<BRAND>.<PROVINCE>.json
//
//   <SERIES>.<YEAR>.<MODELCODE>[] -> the element whose .name === "MSRP"
//                                 -> .finance.amount   (label en "MSRP", fr "PDSF")
//
// It is national: PRD/2027/BLCAJA returns 71670 for ON, AB, BC, QC and NS
// alike. The same payload itemises the fee stack, and the arithmetic closes --
// SUBTOTAL = MSRP + PACKAGE + DRF + FPD + AC + levies -- which is what makes the
// basis knowable: the MSRP line is EX-FREIGHT.
//
// COVERAGE, AND HOW THE REST IS OBTAINED HONESTLY. from_prices carries exactly
// one model per series: the base "From" trim. Every other trim is reached by
// difference, and the province fees cancel because they are identical for every
// trim within a province:
//
//   MSRP(model,pkg) = MSRP_base + PACKAGE_base
//                   + [ startPrice(model,pkg,P) - startPrice(base,basePkg,P) ]
//
// A derived number is only allowed here because it VERIFIES ITSELF: the same
// derivation is run independently in several provinces, and the result is
// accepted only if every province produces the identical whole-dollar figure.
// Agreement is the evidence that the fee stack cancelled; disagreement means
// something province-specific survived and the row is refused rather than
// published. That is the difference between a derivation and a guess.
//
// Checked against Toyota's own Build & Price PDFs for the 2026 RAV4 Plug-in
// Hybrid, whose values were seeded by hand in
// supabase/migrations/20260815_seed_rav4_phev_msrp.sql:
//
//   SERAPC/A -> 48,750  = SE                       (PDF 48,750)  ✓
//   XERAPC/A -> 56,400  = XSE                      (PDF 56,400)  ✓
//   GRRAPC/A -> 57,500  = GR SPORT                 (PDF 57,500)  ✓
//   XERAPC/B -> 59,350  = XSE Technology Package   (PDF 59,350)  ✓

// Three provinces is enough to prove cancellation and keeps the request count
// sane. QC is deliberately included: its fee stack differs most, so it is the
// strongest disagreement detector.
export const CROSS_CHECK_PROVINCES = ["ON", "AB", "QC"];

/** Pull one named line item (MSRP, PACKAGE, ...) out of a from_prices entry. */
export function lineAmount(fromPrices, series, year, modelCode, name) {
  const entry = fromPrices?.[series]?.[String(year)]?.[modelCode];
  if (!Array.isArray(entry)) return null;
  const item = entry.find((x) => x && x.name === name);
  const amt = item?.finance?.amount;
  return Number.isFinite(amt) ? amt : null;
}

/** The single base model code from_prices publishes for a series/year. */
export function baseModelCode(fromPrices, series, year) {
  const byModel = fromPrices?.[series]?.[String(year)];
  const codes = byModel ? Object.keys(byModel) : [];
  return codes.length ? codes[0] : null;
}

/**
 * Derive national MSRP for every (modelCode, packageCode) of one series/year.
 *
 * @param {object} a
 * @param {object} a.fromPricesByProv  province -> from_prices payload
 * @param {object} a.pricesByProv      province -> prices.json series map
 * @param {string} a.series
 * @param {number|string} a.year
 * @returns {{ msrp: Map<string,number>, refused: Array<{key:string, reason:string}> }}
 */
export function deriveSeriesMsrp({ fromPricesByProv, pricesByProv, series, year }) {
  const provinces = Object.keys(fromPricesByProv);
  const msrp = new Map();
  const refused = [];
  if (!provinces.length) return { msrp, refused };

  const base = baseModelCode(fromPricesByProv[provinces[0]], series, year);
  if (!base) return { msrp, refused: [{ key: `${series}/${year}`, reason: "series absent from from_prices" }] };

  // province -> { baseAnchor, startPrices: Map<key, amount> }
  const perProv = {};
  for (const p of provinces) {
    const baseMsrp = lineAmount(fromPricesByProv[p], series, year, base, "MSRP");
    const basePkg = lineAmount(fromPricesByProv[p], series, year, base, "PACKAGE") ?? 0;
    const byModel = pricesByProv[p] || {};
    const basePkgs = byModel[base] || [];
    const baseEntry = basePkgs.find((x) => x.basePackage) || basePkgs[0];
    const baseStart = baseEntry?.vehicleStartPrice?.amount;
    if (!Number.isFinite(baseMsrp) || !Number.isFinite(baseStart)) continue;
    const startPrices = new Map();
    for (const [mc, pkgs] of Object.entries(byModel)) {
      for (const pk of pkgs || []) {
        const amt = pk?.vehicleStartPrice?.amount;
        if (Number.isFinite(amt)) startPrices.set(`${mc}/${pk.packageCode}`, amt);
      }
    }
    perProv[p] = { anchor: baseMsrp + basePkg, baseStart, startPrices };
  }

  const usable = Object.keys(perProv);
  // One province cannot prove cancellation -- there is nothing to agree with.
  if (usable.length < 2) {
    return { msrp, refused: [{ key: `${series}/${year}`, reason: `only ${usable.length} province(s) returned usable data; cross-province agreement is what makes this publishable` }] };
  }

  const keys = new Set();
  for (const p of usable) for (const k of perProv[p].startPrices.keys()) keys.add(k);

  for (const key of keys) {
    const values = [];
    for (const p of usable) {
      const { anchor, baseStart, startPrices } = perProv[p];
      const start = startPrices.get(key);
      if (!Number.isFinite(start)) { values.push(null); continue; }
      values.push(Math.round((anchor + (start - baseStart)) * 100) / 100);
    }
    if (values.some((v) => v === null)) {
      refused.push({ key, reason: "not present in every province" });
      continue;
    }
    const distinct = [...new Set(values)];
    if (distinct.length !== 1) {
      refused.push({ key, reason: `provinces disagree (${usable.map((p, i) => `${p}=${values[i]}`).join(", ")}) — a province-specific amount survived the subtraction` });
      continue;
    }
    const v = distinct[0];
    if (!Number.isInteger(v) || v <= 0) {
      refused.push({ key, reason: `derived ${v}, which is not a whole-dollar price` });
      continue;
    }
    msrp.set(key, v);
  }
  return { msrp, refused };
}
