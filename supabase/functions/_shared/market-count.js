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
  const trim = ctx.trim ?? null;
  const out = emptyMarketCount({
    province: ctx.province || null, year: ctx.year ?? null, make: ctx.make ?? null, model,
    price: hasPrice ? price : null, priceVerified: !!ctx.priceVerified, subjectExcluded: !!ctx.subjectExcluded,
    windowDays, asOf: today, truncated: !!ctx.truncated,
    powertrain: powertrainLabel(model, trim) || null,
  });
  if (!Array.isArray(rows)) { out.reason = "rows_unavailable"; return out; }

  const cutoff = today ? dayMinus(today, windowDays) : null;
  const subjectPt = `${model || ""} ${trim || ""}`;
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

  const exactPool = exactKey ? pool.filter((r) => fullTrimKey(r.trim) === exactKey) : [];
  const familyPool = trimOk ? pool.filter((r) => normTrim(r.trim) === family) : [];
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
