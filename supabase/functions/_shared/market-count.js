// "Of N other <year make model trim> listings LotCheck read from Alberta
// dealers' own pages, M advertised below this one when read on <date>." A
// COUNT of listings LotCheck itself read, never a percentile, rank or score
// (design-must-be-self-explanatory).
//
// Plain ES module so it runs in Deno and in the Node test suite. Pure: the
// caller fetches the rows (fn_market_comps, exact model year) and passes them
// in with the subject; nothing here touches the network or the clock.
//
// WHAT COUNTS.
//   * Same powertrain only. Crawl rows carry the powertrain in the TRIM as
//     often as in the model ("XSE AWD Hybrid"), so a gas RAV4 subject is
//     checked against every row with powertrainCompatible (model-identity.js)
//     before anything is counted -- a hybrid never lands in a gas set or the
//     reverse. [[powertrain-identity-rule]]
//   * Trim scope, in order: the SAME trim (full normalised string, engine,
//     drivetrain and body tokens dropped: "Sport AWD SUV" = "Sport", but
//     "Sport" != "Sport Touring"); then the trim FAMILY (first word, so
//     "Sport Touring" groups with "Sport" and the sentence says so); then the
//     whole model, labelled "(all trims)". Never a family count labelled as
//     the exact trim.
//   * Rows older than the window are dropped: delisting only runs on a clean
//     full crawl, so an old row may be a sold car. The line is dated by the
//     rows' own last-seen dates and speaks in the past tense ("advertised ...
//     when read"), never "currently".
//   * Ties are not below. A row at the same price is reported separately.
//   * The dealer count comes from the rows' own dealer field; when the rows
//     carry none it is null and the sentence names no number.
//
// FOUR STATES:
//   confirmed   -- rows read, subject price verified, M counted.
//   not_counted -- rows read, but no below-count is made (price missing,
//                  unverified, contingent on financing, or the pool was
//                  truncated by the RPC cap), and the line says which.
//   absent      -- the read succeeded and found no priced row in the window.
//   unchecked   -- the read never happened (RPC error, province unknown or
//                  not served, identity missing); no claim either way.

import { powertrainCompatible, powertrainMarkers, stripPowertrain } from "./model-identity.js";

export const GENERIC_TRIMS = new Set(["other", "unknown", "unknwn", "na", "don", "n", "base", ""]);
export const MARKET_COUNT_WINDOW_DAYS = 30;
export const TRIM_SCOPE_MIN = 3;
export const POOL_CAP = 500; // fn_market_comps' hard limit; a pool this big was truncated

// "2.0T", "2.5", "1.5T", "3.5L" are engines, not trims; AWD/SUV/CVT are
// drivetrain, body and gearbox tokens dealers append at random.
const ENGINE_TOKEN = /^\d+(\.\d+)?[lt]?$/i;
const DROP_TOKENS = new Set(["awd", "2wd", "4wd", "fwd", "rwd", "4x4", "4x2", "suv", "sedan", "hatchback", "hatch", "coupe", "wagon", "cvt", "ecvt", "e-cvt", "at", "mt", "auto", "automatic", "manual", "pkg", "package"]);

function trimTokens(t) {
  return stripPowertrain(String(t || "")).toLowerCase().replace(/[^a-z0-9.+\- ]/g, " ").split(/\s+/)
    .filter((w) => w && !ENGINE_TOKEN.test(w) && !DROP_TOKENS.has(w));
}

// Family key: the first real word of the trim ("Sport Touring" -> "sport").
export function normTrim(t) {
  return trimTokens(t).find((w) => w.length > 1) || "";
}

// Exact key: every surviving token, joined ("Sport AWD SUV" -> "sport",
// "Sport Touring" -> "sporttouring").
export function fullTrimKey(t) {
  return trimTokens(t).join("");
}

// The trim as the page wrote it, minus powertrain/engine/drivetrain/body tokens.
export function trimLabelOf(t) {
  const words = stripPowertrain(String(t || "")).split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => {
    const k = w.toLowerCase().replace(/[^a-z0-9.+\-]/g, "");
    return k && !ENGINE_TOKEN.test(k) && !DROP_TOKENS.has(k);
  });
  return kept.join(" ").replace(/[^A-Za-z0-9.+\- ]/g, "").replace(/\s+/g, " ").trim();
}

// Powertrain words the trim carries that the model name does not ("RAV4" +
// "Hybrid XSE" -> "Hybrid"), so the label can say which car was counted.
const PT_NAMES = { bev: "EV", phev: "Plug-in Hybrid", hybrid: "Hybrid" };
export function powertrainLabel(model, trim) {
  const inModel = powertrainMarkers(String(model || ""));
  const all = powertrainMarkers(`${model || ""} ${trim || ""}`);
  return [...all].filter((m) => !inModel.has(m)).map((m) => PT_NAMES[m] || m).join(" ");
}

// Dealers (and JSON-LD vehicleConfiguration) often repeat the model inside the
// trim -- "RX 350 Luxury AWD" for model "RX" -- which keyed the trim family to
// "rx" and made every RX row one family. Model words are dropped from a trim
// before it is keyed or labelled; a trim that was only the model degrades to
// no trim, i.e. the model scope.
export function dropModelWords(trim, model) {
  const words = new Set(String(model || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  if (trim == null) return null;
  if (!words.size) return String(trim);
  return String(trim).split(/\s+/).filter((w) => w && !words.has(w.toLowerCase().replace(/[^a-z0-9]/g, ""))).join(" ");
}

// The page's own fuel-type declaration as a powertrain word the wall can read
// ("Hybrid", "Plug-in Hybrid", "EV"), so a page-declared hybrid whose model and
// trim strings carry no marker never lands in a gas set. Empty when unknown.
export function fuelPowertrainHint(fuelType) {
  const f = String(fuelType || "").toLowerCase();
  if (!f) return "";
  if (/plug|phev/.test(f)) return "Plug-in Hybrid";
  if (/hybrid|hev/.test(f)) return "Hybrid";
  if (/\belectric\b|\bev\b|\bbev\b|battery/.test(f)) return "EV";
  return "";
}

// Today in the market's own time zone (Alberta): both cards on one report --
// the count line and the comparison -- must take their 30-day window from the
// same clock, or a row last seen exactly 30 days ago is in one and out of the
// other for six hours a day.
export function todayLocal(tz = "America/Edmonton") {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch { return new Date().toISOString().slice(0, 10); }
}

function isoDay(d) { return d.toISOString().slice(0, 10); }
function dayMinus(isoToday, days) {
  const d = new Date(`${isoToday}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - days);
  return isoDay(d);
}

export function emptyMarketCount(fields = {}) {
  return {
    state: "unchecked", scope: null, n: 0, below: 0, same: 0, dealers: null,
    seenMin: null, seenMax: null, province: null, year: null, make: null, model: null,
    trimKey: null, trimLabel: null, powertrain: null, modelN: 0, modelBelow: 0, modelSame: 0, unpriced: 0,
    price: null, priceVerified: false, subjectExcluded: false, windowDays: MARKET_COUNT_WINDOW_DAYS, asOf: null,
    truncated: false, reason: null,
    ...fields,
  };
}

function stats(set, hasPrice, price) {
  const named = set.filter((r) => r.dealerName || r.city);
  const dealers = named.length
    ? new Set(named.map((r) => String(r.dealerName || r.city).trim().toLowerCase().replace(/\s+/g, " "))).size
    : null;
  return {
    n: set.length,
    below: hasPrice ? set.filter((r) => Number(r.price) < price).length : 0,
    same: hasPrice ? set.filter((r) => Number(r.price) === price).length : 0,
    dealers,
    seenMin: set.reduce((mn, r) => (r.asOf && (!mn || String(r.asOf) < mn) ? String(r.asOf) : mn), null),
    seenMax: set.reduce((mx, r) => (r.asOf && (!mx || String(r.asOf) > mx) ? String(r.asOf) : mx), null),
  };
}

// rows: [{price, trim, year, asOf:'YYYY-MM-DD', dealerName?, city?}] from
// fn_market_comps (p_year_span 0, subject VIN excluded when known).
export function computeMarketCount(rows, ctx = {}) {
  const today = ctx.today || null;
  const windowDays = ctx.windowDays ?? MARKET_COUNT_WINDOW_DAYS;
  const price = Number(ctx.price);
  const hasPrice = Number.isFinite(price) && price > 0;
  const model = ctx.model ?? null;
  const trim = dropModelWords(ctx.trim ?? null, model);
  const hint = ctx.powertrainHint || "";
  const out = emptyMarketCount({
    province: ctx.province || null, year: ctx.year ?? null, make: ctx.make ?? null, model,
    price: hasPrice ? price : null, priceVerified: !!ctx.priceVerified, subjectExcluded: !!ctx.subjectExcluded,
    windowDays, asOf: today, truncated: !!ctx.truncated,
    powertrain: powertrainLabel(model, `${ctx.trim || ""} ${hint}`) || null,
  });
  if (!Array.isArray(rows)) { out.reason = "rows_unavailable"; return out; }

  const cutoff = today ? dayMinus(today, windowDays) : null;
  const subjectPt = `${model || ""} ${ctx.trim || ""} ${hint}`;
  const inWindow = rows.filter((r) => r && (!cutoff || !r.asOf || String(r.asOf) >= cutoff));
  const compatible = inWindow.filter((r) => powertrainCompatible(subjectPt, `${model || ""} ${r.trim || ""}`));
  out.unpriced = compatible.filter((r) => !(Number(r.price) > 0)).length;
  const pool = compatible.filter((r) => Number(r.price) > 0);

  const family = normTrim(trim);
  const trimOk = family && !GENERIC_TRIMS.has(family);
  const exactKey = trimOk ? fullTrimKey(trim) : "";
  out.trimKey = trimOk ? family : null;
  out.trimLabel = trimOk ? trimLabelOf(trim) : null;

  const modelStats = stats(pool, hasPrice, price);
  out.modelN = modelStats.n; out.modelBelow = modelStats.below; out.modelSame = modelStats.same;
  if (pool.length === 0) { out.state = "absent"; out.reason = "no_rows_in_window"; return out; }

  const exactPool = exactKey ? pool.filter((r) => fullTrimKey(dropModelWords(r.trim, model)) === exactKey) : [];
  const familyPool = trimOk ? pool.filter((r) => normTrim(dropModelWords(r.trim, model)) === family) : [];
  let chosen = modelStats;
  if (exactPool.length >= TRIM_SCOPE_MIN) { out.scope = "trim"; chosen = stats(exactPool, hasPrice, price); }
  else if (familyPool.length >= TRIM_SCOPE_MIN) { out.scope = "trim_family"; chosen = stats(familyPool, hasPrice, price); }
  else out.scope = "model";
  Object.assign(out, { n: chosen.n, below: chosen.below, same: chosen.same, dealers: chosen.dealers, seenMin: chosen.seenMin, seenMax: chosen.seenMax });

  if (out.truncated) { out.state = "not_counted"; out.reason = "pool_truncated"; return out; }
  if (!hasPrice) { out.state = "not_counted"; out.reason = "no_price"; return out; }
  if (!ctx.priceVerified) { out.state = "not_counted"; out.reason = "price_unverified"; return out; }
  if (ctx.contingent) { out.state = "not_counted"; out.reason = "price_contingent"; return out; }
  out.state = "confirmed";
  return out;
}

// ---------------------------------------------------------------------------
// LIKE-FOR-LIKE POOL for a price comparison ("how this price compares").
//
// The old band compared a 2026 RX 350 Luxury (12k km) with 2024 base and
// hybrid RXs at up to 80k km and called the result "the local middle value"
// (report LC-0F75-A93, 2026-09-02). This is the one place the comparison set
// is chosen, and it tightens in this order, stopping at the first set with at
// least `minRows` rows:
//   powertrain  -- always the subject's (a hybrid never sits in a gas set);
//   year        -- the subject's model year first, then one year either side;
//   mileage     -- for a used subject with a known odometer, rows within
//                  40% of its reading plus 20,000 km (the Cheaper-Lot rule);
//   trim        -- the same trim, then the trim family, then all trims of the
//                  model, each labelled as what it is.
// Anything looser is not like-for-like and returns `insufficient` with how
// many rows WERE read, so the card can say so instead of printing a number.
export function likeForLikePool(rows, ctx = {}) {
  const { model, trim: rawTrim, year, condition, odometerKm, minRows = 5, yearSteps = [0, 1], today = null, windowDays = MARKET_COUNT_WINDOW_DAYS, powertrainHint = "" } = ctx;
  const trim = dropModelWords(rawTrim ?? null, model);
  const subjectPt = `${model || ""} ${rawTrim || ""} ${powertrainHint || ""}`;
  // The count line's recency window (30 days to `today`), applied here too: a
  // row last seen months ago may be a car that sold without a delisting, and
  // the two cards on one report must read the same market.
  const cutoff = today ? dayMinus(today, windowDays) : null;
  const compatible = (Array.isArray(rows) ? rows : []).filter((r) => r && Number(r.price) > 0
    && (!cutoff || !r.asOf || String(r.asOf) >= cutoff)
    && powertrainCompatible(subjectPt, `${model || ""} ${r.trim || ""}`));
  const y = Number(year);
  const used = String(condition || "").toLowerCase() === "used";
  // An odometer that was never read (null) or reads 0 -- which the pipeline
  // itself treats as "not read" -- is NOT a 0 km car: Number(null) is 0, and
  // that once built a 0-20,000 km window around a car that may have 150,000.
  const odo = odometerKm == null ? NaN : Number(odometerKm);
  const odoKnown = Number.isFinite(odo) && odo > 0;
  const kmHalf = used && odoKnown ? Math.round(odo * 0.4 + 20000) : null;
  const inKm = (r) => kmHalf == null || (r.odometerKm != null && Math.abs(Number(r.odometerKm) - odo) <= kmHalf);
  const family = normTrim(trim);
  const trimOk = !!family && !GENERIC_TRIMS.has(family);
  const exactKey = trimOk ? fullTrimKey(trim) : "";
  const out = {
    // `rows` is the set chosen for the comparison (empty when insufficient);
    // `read` is every like-for-like row in the last year window tried -- what
    // nRead counts, and the ONLY rows a dealer count or a read date may come
    // from. (Reading those off the whole RPC pool printed "2 listings at 3
    // dealers", dated by a hybrid that was never one of the two.)
    rows: [], read: [], scope: null, yearFrom: null, yearTo: null, insufficient: true, nRead: 0, need: minRows, reason: null,
    trimLabel: trimOk ? trimLabelOf(trim) : null, powertrain: powertrainLabel(model, `${rawTrim || ""} ${powertrainHint || ""}`) || null,
    kmLow: kmHalf == null ? null : Math.max(0, odo - kmHalf), kmHigh: kmHalf == null ? null : odo + kmHalf,
    condition: used ? "used" : (String(condition || "").toLowerCase() || null),
  };
  if (!(y > 0)) { out.reason = "year_missing"; return out; }
  // A used subject with no odometer cannot be given similar-mileage listings,
  // and a light on an unwindowed used set is a similarity claim never checked.
  // Missing beats wrong: no comparison, and the card says why.
  if (used && !odoKnown) { out.reason = "odometer_missing"; return out; }
  const yearsOf = (set, span) => {
    const ys = set.map((r) => Number(r.year)).filter((v) => v > 0);
    // The printed window is the years actually read; when nothing was read it
    // is the window tried, capped at the subject's own model year (a "2027"
    // that does not exist yet must never be printed).
    return ys.length ? [Math.min(...ys), Math.max(...ys)] : [y - span, y];
  };
  for (const span of yearSteps) {
    const yr = compatible.filter((r) => Number(r.year) >= y - span && Number(r.year) <= y + span && inKm(r));
    [out.yearFrom, out.yearTo] = yearsOf(yr, span);
    out.nRead = yr.length;
    out.read = yr;
    const ladder = [
      ["trim", exactKey ? yr.filter((r) => fullTrimKey(dropModelWords(r.trim, model)) === exactKey) : []],
      ["trim_family", trimOk ? yr.filter((r) => normTrim(dropModelWords(r.trim, model)) === family) : []],
      ["model", yr],
    ];
    for (const [scope, set] of ladder) {
      if (set.length >= minRows) {
        const [yf, yt] = yearsOf(set, span);
        return { ...out, rows: set, read: yr, scope, insufficient: false, nRead: yr.length, yearFrom: yf, yearTo: yt };
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// OLDER MODEL YEARS ("What older model years ask today").
//
// The market page's model-year ladder, brought to the report with the same
// like-for-like rules as the comparison card: same powertrain (page fuel type
// read too), the same 30-day window, one scope for every rung (same trim, then
// the trim family, then all trims of the model), at least `minRows` listings
// per rung, the price-outlier trim within each rung. Every rung is a used
// listing one to `maxRungs` model years older than the subject. Mileage is
// NOT windowed (an older car has more kilometres); each rung prints the
// kilometre range it actually holds instead.
//
// rows: fn_market_comps rows for years (subject - maxRungs) .. (subject - 1),
// condition "used". Returns rungs newest-first, each with the figures the card
// prints, or `insufficient` with how many like-for-like rows were read.
function medianOf(sorted) {
  const n = sorted.length;
  if (!n) return 0;
  return n % 2 ? sorted[(n - 1) / 2] : Math.round((sorted[n / 2 - 1] + sorted[n / 2]) / 2);
}
function dealersOfRows(set) {
  const named = set.filter((r) => r.dealerName || r.city);
  return named.length ? new Set(named.map((r) => String(r.dealerName || r.city).trim().toLowerCase().replace(/\s+/g, " "))).size : null;
}
function seenOf(set) {
  return {
    seenMin: set.reduce((mn, r) => (r.asOf && (!mn || String(r.asOf) < mn) ? String(r.asOf) : mn), null),
    seenMax: set.reduce((mx, r) => (r.asOf && (!mx || String(r.asOf) > mx) ? String(r.asOf) : mx), null),
  };
}
export function olderYearsLadder(rows, ctx = {}) {
  const { model, trim: rawTrim, year, minRows = 5, maxRungs = 3, today = null, windowDays = MARKET_COUNT_WINDOW_DAYS, powertrainHint = "", lowerMult = 0.4, upperMult = 2.0, truncated = false } = ctx;
  const y = Number(year);
  const trim = dropModelWords(rawTrim ?? null, model);
  const subjectPt = `${model || ""} ${rawTrim || ""} ${powertrainHint || ""}`;
  const out = {
    state: "insufficient", reason: null, subjectYear: y > 0 ? y : null, condition: "used",
    scope: null, trimLabel: null, powertrain: powertrainLabel(model, `${rawTrim || ""} ${powertrainHint || ""}`) || null,
    nRead: 0, need: minRows, rungs: [], missing: [], truncated: !!truncated, asOf: null, seenMin: null, seenMax: null,
  };
  if (!(y > 0)) { out.reason = "year_missing"; return out; }
  const cutoff = today ? dayMinus(today, windowDays) : null;
  const compatible = (Array.isArray(rows) ? rows : []).filter((r) => r && Number(r.price) > 0
    && Number(r.year) > 0 && Number(r.year) < y && Number(r.year) >= y - maxRungs
    && (!cutoff || !r.asOf || String(r.asOf) >= cutoff)
    && powertrainCompatible(subjectPt, `${model || ""} ${r.trim || ""}`));
  out.nRead = compatible.length;
  Object.assign(out, seenOf(compatible));
  out.asOf = out.seenMax;
  // The RPC returns the CHEAPEST rows first and caps at POOL_CAP, so a pool at
  // the cap is missing its dearest listings and every middle would print low.
  // Refuse, the way the count line refuses a truncated pool.
  if (truncated) { out.reason = "pool_truncated"; return out; }
  const family = normTrim(trim);
  const trimOk = !!family && !GENERIC_TRIMS.has(family);
  const exactKey = trimOk ? fullTrimKey(trim) : "";
  out.trimLabel = trimOk ? trimLabelOf(trim) : null;
  const scopes = [
    ["trim", exactKey ? compatible.filter((r) => fullTrimKey(dropModelWords(r.trim, model)) === exactKey) : []],
    ["trim_family", trimOk ? compatible.filter((r) => normTrim(dropModelWords(r.trim, model)) === family) : []],
    ["model", compatible],
  ];
  let best = null;
  for (const [scope, set] of scopes) {
    const rungs = [], missing = [];
    for (let d = 1; d <= maxRungs; d++) {
      const yr = set.filter((r) => Number(r.year) === y - d);
      // Every model year read at this scope is accounted for: it becomes a rung
      // or it is named as a year that could not be stated. A year that reached
      // the floor and then lost rows to the price-outlier trim must never be
      // reported as "no listings" -- that sentence was false and a dealer
      // holding those listings could show it.
      const prices0 = yr.map((r) => Number(r.price)).sort((a, b) => a - b);
      const m0 = medianOf(prices0);
      const kept = m0 > 0 ? yr.filter((r) => Number(r.price) >= m0 * lowerMult && Number(r.price) <= m0 * upperMult) : [];
      if (kept.length >= minRows) {
        const prices = kept.map((r) => Number(r.price)).sort((a, b) => a - b);
        const kms = kept.map((r) => Number(r.odometerKm)).filter((v) => Number.isFinite(v) && v > 0);
        rungs.push({
          year: y - d, n: kept.length, nRead: yr.length, median: medianOf(prices), low: prices[0], high: prices[prices.length - 1],
          // The kilometre range is of the listings that SHOW a reading; how many
          // did is carried so the sentence can never attribute it to the rest.
          kmKnown: kms.length, kmLow: kms.length ? Math.min(...kms) : null, kmHigh: kms.length ? Math.max(...kms) : null,
          dealers: dealersOfRows(kept), ...seenOf(kept),
        });
      } else if (yr.length > 0) {
        missing.push({ year: y - d, nRead: yr.length, nKept: kept.length });
      }
    }
    // The scope that states the most model years wins; ties go to the tightest,
    // which is scope order. A looser scope is only worth taking when it says
    // more, and whatever it cannot state is named either way. When NO scope can
    // state a year, the one that read the most rows wins, so the card names the
    // years it saw instead of falling silent on an empty tighter scope.
    const read = missing.reduce((t, m) => t + Number(m.nRead), 0);
    if (!best || rungs.length > best.rungs.length
        || (rungs.length === 0 && best.rungs.length === 0 && read > best.read)) best = { scope, rungs, missing, read };
    if (best.rungs.length === maxRungs) break;
  }
  if (!best || !best.rungs.length) {
    const m = best ? best.missing : [];
    return { ...out, missing: m, scope: best ? best.scope : null };
  }
  const all = best.rungs.flatMap((r) => [r.seenMin, r.seenMax]).filter(Boolean).sort();
  return { ...out, state: "confirmed", scope: best.scope, rungs: best.rungs, missing: best.missing,
    seenMin: all[0] || null, seenMax: all[all.length - 1] || null, asOf: all[all.length - 1] || null };
}
