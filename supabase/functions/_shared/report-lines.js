// The two report lines that speak in COUNTS and DEFAULTS, built once here and
// rendered by every surface (React scroll + sidebar, emailed HTML, emailed PDF,
// /verify). One builder per line, so the sentence a buyer reads on screen is
// the sentence in the PDF they hand to the dealer. Each builder accepts the
// analysis field (marketCount / pageDefault) OR the sealed compact form (mc /
// dflt), and the compact form carries every field the sentence depends on, so
// /verify never renders a different sentence from the report.
//
// Plain ES module: imported by src/App.jsx (Vite) and by the Deno edge
// functions alike. No network, no clock, no model -- every sentence is a
// template filled from fields code computed (market-count.js, page-default.js).
//
// COPY RULES this file is scanned against (scripts/check-copy-compliance.mjs):
// no scrape vocabulary, no guarantees, no foreign regulators, no verdict words
// (overpriced, avoid, negotiate, should), no motive attributed to the dealer.
// The one instruction any line may carry is: ask the dealer, in writing — or, where a regulator's own guidance is the point, ask your own insurer (financeCoverageLine). No other advice.
// Absence states say what was established, never more: "Not shown" only when
// the page's own data says so, "None found" for a miss, "Not read" when no
// attempt was made.

import { FREQ_LABEL, POSITIVE_ABSENCE } from "./page-default.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// 'YYYY-MM-DD' or ISO timestamp -> 'Aug 18, 2026' (en-CA short form the app
// already uses on screen). An unparseable or impossible date renders as "".
export function fmtDateEn(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "";
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return "";
  return `${MONTHS[mo - 1]} ${d}, ${y}`;
}

// Whole dollars unless the figure carries cents ($39,713.70 stays $39,713.70).
export function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  const cents = Math.round(Math.abs(v) * 100) % 100 !== 0;
  const whole = Math.floor(Math.abs(v));
  const s = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const c = cents ? "." + String(Math.round(Math.abs(v) * 100) % 100).padStart(2, "0") : "";
  return `${v < 0 ? "-" : ""}$${s}${c}`;
}

function plural(n, one, many) { return Number(n) === 1 ? one : many; }

export const provinceName = (code) => {
  const c = String(code || "").toUpperCase();
  const NAMES = { AB: "Alberta", BC: "British Columbia", SK: "Saskatchewan", MB: "Manitoba", ON: "Ontario", QC: "Quebec", NB: "New Brunswick", NS: "Nova Scotia", PE: "Prince Edward Island", NL: "Newfoundland and Labrador", YT: "Yukon", NT: "Northwest Territories", NU: "Nunavut" };
  return NAMES[c] || (c || "Alberta");
};

// Accept either the analysis field (marketCount) or the signed compact form (mc).
function normMc(x, a) {
  if (!x || typeof x !== "object") return null;
  if ("state" in x) return x;
  return {
    state: x.st || null, scope: x.sc || null, n: x.n ?? 0, below: x.b ?? 0, same: x.s ?? 0, dealers: x.d ?? null,
    seenMin: x.from || null, seenMax: x.to || null, province: x.pv || null, subjectExcluded: !!x.x, price: x.p ?? null,
    year: a?.year ?? null, make: a?.make ?? null, model: a?.model ?? null, vehicle: a?.vehicle ?? null,
    trimLabel: x.tl || null, powertrain: x.pt || null, modelN: x.mn ?? 0, modelBelow: x.mb ?? 0,
    reason: x.rs || null, windowDays: x.w ?? 30, asOf: x.as || null, truncated: !!x.tr, unpriced: x.up ?? 0,
  };
}

function normDflt(x) {
  if (!x || typeof x !== "object") return null;
  if ("state" in x) return x;
  return {
    state: x.st || null, termMonths: x.t ?? null, paymentFrequency: x.f || null, apr: x.a ?? null, downPayment: x.d ?? null,
    paymentAmount: x.p ?? null, source: x.src || null, readAt: x.at || null, checked: !!x.st, purchaseMethod: x.pm || null,
    reason: x.rs || null, qualifier: x.q || null, costOfBorrowing: x.cob ?? null,
  };
}

export function dateClause(mc) {
  const a = fmtDateEn(mc.seenMin), b = fmtDateEn(mc.seenMax);
  if (a && b && mc.seenMin !== mc.seenMax) return `between ${a} and ${b}`;
  const d = b || a;
  return d ? `on ${d}` : "";
}

function vehicleLabel(mc, a, withTrim) {
  const parts = [mc.year, mc.make, mc.model, mc.powertrain, withTrim && mc.trimLabel ? mc.trimLabel : null].filter(Boolean);
  if (parts.length >= 3) return parts.join(" ");
  return String(mc.vehicle || a?.vehicle || parts.join(" ") || "this vehicle");
}

// ---------------------------------------------------------------------------
// LINE 1 -- "M of the N other listings LotCheck read ... advertised below this one when read on <date>."
export function marketCountLine(a) {
  const mc = normMc(a?.marketCount ?? a?.mc, a);
  const out = { key: "marketcount", title: "Other listings read", tone: "muted", state: "unchecked", value: "NOT READ", headline: "Not read", body: "", meta: "Not read" };
  const prov = provinceName(mc?.province);
  if (!mc || mc.state === "unchecked" || !mc.state) {
    const reason = mc?.reason || null;
    out.body = reason === "outside_province" && mc?.province
      ? `Not counted — this dealer's page places it in ${prov}, and LotCheck reads only Alberta dealers' pages today.`
      : reason === "province_unknown"
        ? "Not counted — the dealer's province could not be established from the page, so no listing set was read."
        : reason === "identity_missing"
          ? "Not counted — the listing's year, make or model could not be established, so no listing set was read."
          : reason === "condition_unknown"
            ? "Not counted — whether this listing is new or used could not be established from the page, so no listing set was read."
            : reason === "no_page"
              ? "Not counted — other listings are counted for link checks; this report was built from an uploaded quote."
              : "Not counted — no listing set was read for this report.";
    return out;
  }
  out.state = mc.state;
  const n = Number(mc.n) || 0;
  const below = Number(mc.below) || 0;
  const same = Number(mc.same) || 0;
  const d = mc.dealers == null ? null : Number(mc.dealers) || 0;
  const dealerClause = d && d > 0 ? `${d} ${prov} dealer${d === 1 ? "'s" : "s'"} own pages` : `${prov} dealers' own pages`;
  const when = dateClause(mc);
  const scope = mc.scope || "model";
  const withTrim = scope === "trim";
  const labelBase = vehicleLabel(mc, a, withTrim);
  const familyClause = scope === "trim_family" && mc.trimLabel ? ` with a trim beginning "${mc.trimLabel.split(/\s+/)[0]}"` : "";
  const allTrims = scope === "model" ? " (all trims, same powertrain)" : "";
  const other = mc.subjectExcluded ? "other " : "";
  const scopeTag = scope === "model" ? " · ALL TRIMS" : scope === "trim_family" && mc.trimLabel ? ` · ${mc.trimLabel.split(/\s+/)[0].toUpperCase()} FAMILY` : "";
  out.meta = [labelBase, prov, when ? `read ${when}` : null].filter(Boolean).join(" · ");

  if (mc.state === "absent") {
    const filed = [mc.year, mc.make, mc.model, mc.powertrain].filter(Boolean).join(" ") || labelBase;
    const window = mc.asOf ? `in the ${mc.windowDays || 30} days to ${fmtDateEn(mc.asOf)}` : `in the last ${mc.windowDays || 30} days`;
    out.value = "NONE READ";
    out.headline = "None read";
    out.meta = "None read";
    out.body = `No listings filed as "${filed}" were among those LotCheck read from ${prov} dealers' own pages ${window}, so there is nothing to count this one against.`
      + (Number(mc.unpriced) > 0 ? ` ${mc.unpriced} ${plural(mc.unpriced, "was", "were")} read without an advertised price.` : "");
    return out;
  }
  if (mc.state === "not_counted") {
    const readSentence = `${n} ${other}${labelBase} listing${plural(n, "", "s")}${familyClause}${allTrims} ${plural(n, "was", "were")} read from ${dealerClause}${when ? " " + when : ""}.`;
    const reason = mc.reason === "price_contingent"
      ? "This page's price depends on financing with the dealer, so it is not compared against other listings' advertised prices — ask the dealer for the price without financing in writing."
      : mc.reason === "no_price"
        ? "This page shows no asking price, so no below-this-one count is made — ask the dealer for the all-in price in writing."
        : mc.reason === "pool_truncated"
          ? `More than ${n} were read, more than this count can hold, so no below-this-one count is made — ask the dealer how this price compares with other units advertised in ${prov}.`
          : "This page's asking price could not be verified from the page's own data, so no below-this-one count is made — ask the dealer for the all-in price in writing.";
    out.value = "NOT COUNTED";
    out.headline = "Not counted";
    out.meta = "Not counted";
    out.body = `${readSentence} ${reason}`;
    return out;
  }
  // confirmed
  const price = fmtMoney(mc.price);
  const verb = "advertised";
  const lead = below === 0 ? `None of the ${n}` : `${below} of the ${n}`;
  let body = `${lead} ${other}${labelBase} listing${plural(n, "", "s")}${familyClause}${allTrims} LotCheck read from ${dealerClause} ${verb} below this one${price ? ` (${price})` : ""}${when ? ` when read ${when}` : ""}.`;
  if (same > 0) body += ` ${same} ${verb} the same price.`;
  if (scope === "model") body += mc.trimLabel ? " The trim on this page did not match enough listings, so the count is for the model." : " No trim was established for this page, so the count is for the model.";
  else if (Number(mc.modelN) > n) body += ` Across all ${[mc.model, mc.powertrain].filter(Boolean).join(" ")} trims read: ${Number(mc.modelBelow) || 0} of ${Number(mc.modelN)} below.`;
  body += mc.subjectExcluded ? " These are dealers' own advertised prices with this vehicle left out: a count, not a valuation." : " These are dealers' own advertised prices, and this vehicle may be among them: a count, not a valuation.";
  out.value = `${below} OF ${n} BELOW THIS PRICE${scopeTag}`;
  out.headline = below === 0 ? `None of ${n} advertised below this one` : `${below} of ${n} advertised below this one`;
  out.body = body;
  return out;
}

// ---------------------------------------------------------------------------
// LINE 2 -- "Payment starting point": where this page's payment calculator
// starts (term, payment frequency, rate, down payment), stated plainly and
// helpfully, never as a warning about the dealer.
const ASK = "It helps to have the term, payment frequency, rate and total cost of borrowing from the dealer in writing.";
export function pageDefaultLine(a) {
  const pd = normDflt(a?.pageDefault ?? a?.dflt);
  const out = { key: "pagedefault", title: "Payment starting point", tone: "muted", state: "unchecked", value: "NOT READ", headline: "Not read", body: "", meta: "Not read" };
  if (!pd || !pd.state || pd.state === "unchecked") {
    out.body = pd?.reason === "no_page"
      ? `A payment starting point is read from a listing page, not from an uploaded quote. ${ASK}`
      : `No payment settings were read for this report. ${ASK}`;
    return out;
  }
  out.state = pd.state;
  if (pd.state === "absent") {
    if (POSITIVE_ABSENCE.has(String(pd.reason))) {
      out.value = "NOT SHOWN";
      out.headline = "Not shown on this page";
      out.meta = "Not shown";
      out.body = `This page's own settings show no pre-selected finance scenario, so there is no starting point to report here. ${ASK}`;
    } else {
      out.value = "NONE FOUND";
      out.headline = "None found on this page";
      out.meta = "None found";
      out.body = `LotCheck did not find a pre-selected term, payment frequency or rate in this page's own text or data. ${ASK}`;
    }
    return out;
  }
  const t = Number(pd.termMonths) > 0 ? Math.round(Number(pd.termMonths)) : null;
  const f = pd.paymentFrequency && FREQ_LABEL[pd.paymentFrequency] ? FREQ_LABEL[pd.paymentFrequency] : null;
  const apr = pd.apr != null && Number.isFinite(Number(pd.apr)) ? Number(pd.apr) : null;
  const down = pd.downPayment != null && Number.isFinite(Number(pd.downPayment)) ? Number(pd.downPayment) : null;
  const pay = Number(pd.paymentAmount) > 0 ? Number(pd.paymentAmount) : null;
  const parts = [];
  if (t) parts.push(`${t} months`);
  if (f) parts.push(`${f} payments${pay ? ` of ${fmtMoney(pay)}` : ""}`);
  else if (pay) parts.push(`payments of ${fmtMoney(pay)}`);
  if (apr != null) parts.push(`${apr}% APR`);
  if (down != null) parts.push(`${fmtMoney(down)} down`);
  const scenario = parts.length ? (parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]) : "a pre-selected payment scenario";
  const cashFirst = pd.purchaseMethod === "cash";
  const opener = cashFirst
    ? `This page opens on its cash price; its finance option starts at ${scenario}.`
    : pd.source === "edealer_js"
      ? `This page's payment calculator starts at ${scenario}.`
      : pd.source === "sm360_feed"
        ? `This listing's payment default is ${scenario}.`
        : `This page shows financing first as ${scenario}.`;
  const notes = [];
  if (pd.qualifier) {
    const q = String(pd.qualifier);
    const bits = [];
    if (/estimate/i.test(q)) bits.push("the rate is an estimate");
    if (/plus taxes and licence/i.test(q)) bits.push("taxes and licence are extra");
    if (bits.length) notes.push(`The page notes ${bits.join(" and ")}${pd.costOfBorrowing != null && Number(pd.costOfBorrowing) > 0 ? `, with a stated cost of borrowing of ${fmtMoney(pd.costOfBorrowing)}` : ""}.`);
  } else if (pd.costOfBorrowing != null && Number(pd.costOfBorrowing) > 0) {
    notes.push(`The page states a cost of borrowing of ${fmtMoney(pd.costOfBorrowing)}.`);
  }
  if (!t) notes.push("No term is pre-selected on the page.");
  if (!f) notes.push("The page does not state a payment frequency next to this figure.");
  if (apr == null) notes.push("No rate is pre-selected on the page.");
  const basis = pd.source === "sm360_feed"
    ? "the dealer's own listing data"
    : pd.source === "edealer_js"
      ? "the page's own calculator settings"
      : "the page's own text";
  const when = fmtDateEn(pd.readAt) ? ` on ${fmtDateEn(pd.readAt)}` : "";
  out.body = [opener, ...notes, `Read from ${basis}${when}.`, ASK].join(" ");
  const core = [t ? `${t} MO` : "NO TERM", f ? f.toUpperCase() : null, apr != null ? `${apr}%` : "NO RATE"].filter(Boolean).join(" · ");
  out.value = cashFirst ? `OPENS ON CASH · ${core}` : core;
  out.headline = (cashFirst ? "Opens on cash · " : "") + [t ? `${t} months` : "no term", f || null, apr != null ? `${apr}% APR` : "no rate"].filter(Boolean).join(" · ");
  out.meta = fmtDateEn(pd.readAt) ? `read ${fmtDateEn(pd.readAt)}` : "Read";
  return out;
}

export const REPORT_LINES = { marketCountLine, pageDefaultLine };

// ---------------------------------------------------------------------------
// LINE 3 -- "How this price compares": three plain lines. This car / similar
// listings (what they are, how many, read when) / the difference. Built from
// the like-for-like band (marketvalue.ts + market-count.js likeForLikePool).
// Vic, 2026-09-02: "$9,908 above the local middle value" was not easy to
// understand, and it compared a 2026 with 2024 hybrids. Every figure here
// names what it is of, or the card says there is nothing to compare.
function normMv(x) {
  if (!x || typeof x !== "object") return null;
  if ("average" in x || "insufficient" in x) return x;
  return {
    average: x.avg ?? null, below: x.below ?? null, above: x.above ?? null, low: x.lo ?? null, high: x.hi ?? null,
    mileage: x.mileage ?? null, source: x.source || null, comps: x.n ?? null, asOf: x.as || null,
    insufficient: !!x.ins, nRead: x.nr ?? null, need: x.nd ?? null, yearFrom: x.yf ?? null, yearTo: x.yt ?? null,
    trimScope: x.ts || null, trimLabel: x.tl || null, powertrain: x.pt || null, kmLow: x.kl ?? null, kmHigh: x.kh ?? null,
    condition: x.cd || null, dealers: x.d ?? null,
    make: x.mk || null, model: x.md || null, province: x.pv || null, seenMin: x.from || null, seenMax: x.to || null,
    nKept: x.nk ?? null, reason: x.rs || null,
  };
}

// A mileage window is printed so that every row in the set fits inside it:
// the floor rounds DOWN, the ceiling rounds UP (a 37,178 km ceiling is
// "38,000 km", never "37,000 km" with a 37,100 km listing inside).
function kmFloor(n) { return `${(Math.floor(Number(n) / 1000) * 1000).toLocaleString("en-CA")} km`; }
function kmCeil(n) { return `${(Math.ceil(Number(n) / 1000) * 1000).toLocaleString("en-CA")} km`; }

// "on Aug 18, 2026" when every row was last read the same day; "between Aug 3
// and Aug 18, 2026" otherwise -- the freshest row's date alone would claim
// all of them were read that day.
function readClause(mv) {
  const a = fmtDateEn(mv.seenMin), b = fmtDateEn(mv.seenMax || mv.asOf);
  if (a && b && a !== b) {
    // "between Aug 3 and Aug 18, 2026": the year once when both share it.
    const ya = a.slice(-6), yb = b.slice(-6);
    return `between ${ya === yb && /^, \d{4}$/.test(ya) ? a.slice(0, -6) : a} and ${b}`;
  }
  const d = b || a;
  return d ? `on ${d}` : "";
}

// green  = at or below the middle of similar listings
// amber  = above the middle, but not above every similar listing compared
// red    = above all of the similar listings compared
// (null when there is nothing to colour: no set, no asking price, a price the
// page's own data could not back, one that depends on financing, or a report
// sealed before the set's make-up rode along with it)
const NOTE = "These are asking prices on dealers' own listings, not sale prices.";
export function marketCompareLine(a) {
  const mv = normMv(a?.marketValue);
  const prov = provinceName(mv?.province);
  const out = { key: "marketcompare", title: `How this vehicle compares with the ${prov} market`, tone: "muted", light: null, lightLabel: null, state: "unchecked", value: "NOT COMPARED", headline: "Not compared", body: "", lines: [], meta: "Not compared", note: null, askUsed: null };
  if (!mv) {
    out.body = "No comparison set was read for this report.";
    return out;
  }
  const ask = Number(a?.quotedPrice ?? a?.price?.asking);
  const hasAsk = Number.isFinite(ask) && ask >= 1;
  // The count line's refusals, applied here too: a price the page's own data
  // could not back, or one that depends on financing, is shown but never
  // measured against other listings -- one report must not say both.
  const unverified = a?.priceVerified === false || a?.price?.verified === false;
  const contingent = !!(a?.financeContingent?.contingent || a?.fcx);
  const mk = mv.make || a?.make || null, md = mv.model || a?.model || null;
  const cond = mv.condition || a?.vehicleCondition || null;
  // The set's make-up: model years, condition, make/model. A report sealed
  // before these rode along (v4-v6 seals carry avg/lo/hi/n/as only) must never
  // be described from the subject's own vehicle string, year or freshest date
  // -- that would name eleven 2024 hybrids as "2026 RX 350 Luxury AWD".
  const hasBasis = !!(mv.yearFrom && mv.yearTo && cond && (mk || md));
  const years = mv.yearFrom && mv.yearTo ? (mv.yearFrom === mv.yearTo ? String(mv.yearFrom) : `${mv.yearFrom} to ${mv.yearTo}`) : "";
  const nameplate = [mk, md, mv.powertrain].filter(Boolean).join(" ");
  // "(all trims, same powertrain)": the RX rows carry the hybrids AS trims
  // ("RX 350h", "RX 500h") and the powertrain wall leaves them out on purpose,
  // so "all trims" alone would not be true.
  const allTrims = mv.trimScope === "model" || (mv.insufficient && !mv.trimScope && Number(mv.nRead) > 0);
  const scopeWord = mv.trimScope === "trim" && mv.trimLabel ? ` ${mv.trimLabel}` : mv.trimScope === "trim_family" && mv.trimLabel ? ` whose trim begins "${mv.trimLabel.split(/\s+/)[0]}"` : allTrims ? " (all trims, same powertrain)" : "";
  const kmClause = mv.kmLow != null && mv.kmHigh != null ? (Number(mv.kmLow) <= 0 ? ` with up to ${kmCeil(mv.kmHigh)}` : ` with ${kmFloor(mv.kmLow)} to ${kmCeil(mv.kmHigh)}`) : "";
  const when = readClause(mv);
  const what = `${cond ? cond + " " : ""}${years ? years + " " : ""}${nameplate}${scopeWord}${kmClause}`;
  const d = mv.dealers != null ? Number(mv.dealers) : 0;
  const dealersClause = d > 0 ? ` at ${d} ${prov} dealer${d === 1 ? "" : "s"}` : ` at ${prov} dealers`;
  const source = `read from the ${d === 1 ? "dealer's own page" : "dealers' own pages"}${when ? " " + when : ""}`;
  const thisLine = { k: "This vehicle", v: hasAsk ? `${fmtMoney(ask)} asking` : "no asking price shown" };
  const simK = `Similar listings in ${prov}`;

  if (mv.insufficient || mv.average == null) {
    const n = Number(mv.nRead ?? mv.comps) || 0;
    const kept = mv.nKept != null ? Number(mv.nKept) : null;
    const left = kept != null && kept < n ? n - kept : 0;
    const need = Number(mv.need) || 5;
    const were = n === 1 ? "was" : "were";
    out.state = "insufficient";
    out.value = "NOT ENOUGH TO COMPARE";
    out.headline = "Not enough similar listings to compare";
    out.meta = `${n} read, ${need} needed`;
    if (mv.reason === "odometer_missing") {
      out.value = "NOT COMPARED";
      out.headline = "Not compared: odometer not read";
      out.meta = "Odometer not read";
      out.lines = [thisLine, { k: simK, v: "not chosen: this listing's odometer was not read from the page, so similar-mileage listings could not be selected" }, { k: "Comparison", v: "not made" }];
      out.body = "This listing's odometer was not read from the page, so similar-mileage listings could not be chosen and no comparison is made here. It helps to have the odometer reading from the dealer in writing.";
      return out;
    }
    if (mv.reason === "basis_missing" || (!hasBasis && !mv.reason)) {
      // The invariant demoted a middle that could not say what it was of, or
      // a sealed set arrived without its make-up.
      out.value = "NOT COMPARED";
      out.headline = "Comparison set not recorded";
      out.meta = "Basis not recorded";
      out.lines = [thisLine, { k: simK, v: "a set was read, but what it was made of was not recorded" }, { k: "Comparison", v: "not made" }];
      out.body = "A comparison set was read for this report, but what it was made of was not recorded, so no comparison is made here.";
      return out;
    }
    const readSentence = n === 0
      ? `No ${what} were among the listings read from ${prov} dealers' own pages.`
      : `${n} ${what}${dealersClause} ${were} ${source}.`;
    const outliers = left > 0 ? ` ${left} of them ${left === 1 ? "was" : "were"} left out as ${left === 1 ? "a price outlier" : "price outliers"}.` : "";
    out.lines = [
      thisLine,
      { k: simK, v: n === 0 ? `none read: no ${what} were among the listings read from ${prov} dealers' own pages` : `${n} ${what}${dealersClause}, ${source}${left > 0 ? `; ${left} left out as ${left === 1 ? "a price outlier" : "price outliers"}` : ""}` },
      { k: "Comparison", v: `not made: ${need} similar listings are needed, ${left > 0 ? `${kept} remained` : `${n} ${were} read`}` },
    ];
    out.body = `${readSentence}${outliers} ${need} are needed for a fair comparison, so none is made here.`;
    return out;
  }

  const med = Number(mv.average), lo = Number(mv.low), hi = Number(mv.high);
  const n = Number(mv.comps) || 0;
  // A range is printed, and a light lit, only when the sealed set carries both
  // its bounds AND its make-up: a report sealed before the basis rode along
  // has the middle alone, and a missing bound is never a $0 bound nor a red.
  const hasRange = hasBasis && n > 0 && Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 && hi >= lo && med >= lo && med <= hi;
  const canCompare = hasAsk && !unverified && !contingent;
  const delta = canCompare ? Math.round(ask - med) : null;
  const light = delta == null || !hasRange ? null : delta <= 0 ? "green" : ask > hi ? "red" : "amber";
  const lightLabel = light === "green" ? "At or below the middle of similar listings" : light === "amber" ? "Above the middle, inside the range of similar listings" : light === "red" ? `Above all ${n} similar listings compared` : null;
  const diff = !hasAsk ? "no asking price is shown on this page, so no difference is worked out"
    : contingent ? "not worked out: this page's price depends on financing with the dealer — ask the dealer for the price without financing in writing"
    : unverified ? "not worked out: this page's asking price could not be verified from the page's own data — ask the dealer for the all-in price in writing"
    : delta === 0 ? "at the middle of those listings"
    : `${fmtMoney(Math.abs(delta))} ${delta > 0 ? "above" : "below"} the middle of those listings`;
  // Rows read but left out by the price-outlier trim are named, so this N and
  // the count line's N never differ on one page without a reason.
  const leftC = mv.nRead != null && Number(mv.nRead) > n ? Number(mv.nRead) - n : 0;
  const outlierC = leftC > 0 ? `; ${leftC} more ${leftC === 1 ? "was" : "were"} read and left out as ${leftC === 1 ? "a price outlier" : "price outliers"}` : "";
  const simV = hasRange
    ? `${n} ${what}${dealersClause}, ${source}: ${fmtMoney(lo)} to ${fmtMoney(hi)}, middle ${fmtMoney(med)} (the median of those ${n} asking prices)${outlierC}`
    : `middle ${fmtMoney(med)}${n > 0 ? ` across ${n} listings` : ""}; what those listings were (model year, trim, mileage) was not sealed with this report, so no range is shown`;
  out.state = "confirmed";
  out.light = light;
  out.lightLabel = lightLabel;
  out.tone = light === "red" ? "flag" : light === "green" ? "pass" : "muted";
  out.askUsed = canCompare ? ask : null;
  out.note = NOTE;
  out.value = delta == null ? `MIDDLE ${fmtMoney(med)}` : delta === 0 ? "AT THE MIDDLE" : `${fmtMoney(Math.abs(delta))} ${delta > 0 ? "ABOVE" : "BELOW"} THE MIDDLE`;
  out.headline = delta == null ? `Middle of similar listings: ${fmtMoney(med)}` : delta === 0 ? "At the middle of similar listings" : `${fmtMoney(Math.abs(delta))} ${delta > 0 ? "above" : "below"} the middle of similar listings`;
  out.meta = hasRange ? [`${n} similar listing${n === 1 ? "" : "s"}`, years || null, when ? `read ${when}` : null].filter(Boolean).join(" · ") : "Middle only";
  out.lines = [thisLine, { k: simK, v: simV }, { k: "Difference", v: diff }];
  out.body = `This vehicle: ${thisLine.v}. ${simK}: ${simV}. Difference: ${diff}.`;
  return out;
}

// ---------------------------------------------------------------------------
// LINE -- "What older model years ask today": the model-year ladder as a
// report line. This vehicle's asking price, then one line per older model
// year (used, same powertrain, one trim scope for every rung, the kilometre
// range each rung holds, dealers, read dates): the middle asking price and
// how far below this asking price it sits. Asking prices on dealers' own
// pages today -- never a forecast of what this vehicle will be worth.
function normOy(x) {
  if (!x || typeof x !== "object") return null;
  if ("state" in x && "rungs" in x) return x;
  return {
    state: x.st || null, reason: x.rs || null, subjectYear: x.sy ?? null, make: x.mk || null, model: x.md || null,
    province: x.pv || null, condition: x.cd || null, scope: x.sc || null, trimLabel: x.tl || null, powertrain: x.pt || null,
    nRead: x.nr ?? null, need: x.nd ?? null, asOf: x.as || null, seenMin: x.from || null, seenMax: x.to || null,
    rungs: Array.isArray(x.r) ? x.r.map((r) => ({ year: r.y ?? null, n: r.n ?? null, nRead: r.rd ?? null, median: r.m ?? null, low: r.lo ?? null, high: r.hi ?? null, kmKnown: r.kn ?? null, kmLow: r.kl ?? null, kmHigh: r.kh ?? null, dealers: r.d ?? null, seenMin: r.from || null, seenMax: r.to || null })) : [],
    missing: Array.isArray(x.ms) ? x.ms.map((m) => ({ year: m.y ?? null, nRead: m.rd ?? null, nKept: m.k ?? null })) : [],
  };
}
const OY_NOTE = "Middle asking prices of older ones on dealers' own pages on the dates shown, not sale prices.";
const OLDER_WORD = { 1: "One year older", 2: "Two years older", 3: "Three years older" };
const olderWord = (d) => OLDER_WORD[d] || `${d} years older`;
export function olderYearsLine(a) {
  const oy = normOy(a?.olderYears ?? a?.oy);
  const prov = provinceName(oy?.province);
  const out = { key: "olderyears", title: "What older model years ask today", tone: "muted", state: "unchecked", value: "NOT READ", headline: "Not read", body: "", lines: [], meta: "", note: null, askUsed: null };
  const ask = Number(a?.quotedPrice ?? a?.price?.asking);
  const hasAsk = Number.isFinite(ask) && ask >= 1;
  const unverified = a?.priceVerified === false || a?.price?.verified === false;
  const contingent = !!(a?.financeContingent?.contingent || a?.fcx);
  const canCompare = hasAsk && !unverified && !contingent;
  // The subject's own year is taken from the SEALED ladder only: a set that did
  // not record what it was older than describes nothing, on every surface.
  const sy = Number(oy?.subjectYear) || null;
  if (!oy || oy.state === "unchecked" || !oy.state) {
    const reason = oy?.reason || null;
    out.body = reason === "outside_province" && oy?.province
      ? `Not read — this dealer's page places it in ${prov}, and LotCheck reads only Alberta dealers' pages today.`
      : reason === "province_unknown"
        ? "Not read — the dealer's province could not be established, so no older listings were read."
        : reason === "identity_missing"
          ? "Not read — the listing's year, make or model could not be established, so no older listings were read."
          : reason === "condition_unknown"
            ? "Not read — whether this vehicle is new or used could not be established, so no older listings were read."
            : reason === "timeout"
              ? "Not read — the listing set did not come back in time, so nothing is stated per model year."
              : reason === "no_page"
                ? "Not read — older model years are read for link checks; this report was built from an uploaded quote."
                : "Not read — no older listings were read for this report.";
    return out;
  }
  const mk = oy.make || a?.make || null, md = oy.model || a?.model || null;
  const hasBasis = !!((mk || md) && sy);
  const nameplate = [mk, md, oy.powertrain].filter(Boolean).join(" ");
  const scopeWord = oy.scope === "trim" && oy.trimLabel ? ` ${oy.trimLabel}` : oy.scope === "trim_family" && oy.trimLabel ? ` whose trim begins "${oy.trimLabel.split(/\s+/)[0]}"` : " (all trims, same powertrain)";
  const when = readClause(oy);
  const thisV = !hasAsk ? `${sy ? sy + " · " : ""}no asking price shown, so no difference is worked out`
    : contingent ? `${sy ? sy + " · " : ""}${fmtMoney(ask)} asking (depends on financing with the dealer, so no difference is worked out)`
    : unverified ? `${sy ? sy + " · " : ""}${fmtMoney(ask)} asking (could not be verified from the page's own data, so no difference is worked out)`
    : `${sy ? sy + " · " : ""}${fmtMoney(ask)} asking`;
  const thisLine = { k: "This vehicle", v: thisV };
  const need = Number(oy.need) || 5;
  const missing = Array.isArray(oy.missing) ? oy.missing.filter((m) => Number(m.year) > 0 && Number(m.nRead) > 0) : [];
  const missLine = (m) => {
    const left = Number(m.nRead) - Number(m.nKept || 0);
    const d = sy ? sy - Number(m.year) : 0;
    return { k: `${d >= 1 ? olderWord(d) : "Older"} (${m.year})`, v: left > 0
      ? `${m.nRead} used ${m.year} ${nameplate}${scopeWord} were read and ${left} ${left === 1 ? "was" : "were"} left out as ${left === 1 ? "a price outlier" : "price outliers"}, leaving ${m.nKept}; ${need} are needed, so nothing is stated for that model year`
      : `${m.nRead} used ${m.year} ${nameplate}${scopeWord} ${Number(m.nRead) === 1 ? "was" : "were"} read; ${need} are needed, so nothing is stated for that model year` };
  };
  const rungs = (Array.isArray(oy.rungs) ? oy.rungs : []).map((r) => ({ ...r, d: sy ? sy - Number(r.year) : 0 }))
    .filter((r) => r.d >= 1 && r.d <= 3 && Number(r.median) > 0 && Number(r.n) > 0);

  if (oy.state !== "confirmed" || !hasBasis || !rungs.length) {
    const n = Number(oy.nRead) || 0;
    out.state = "insufficient";
    out.value = "NOT ENOUGH TO STATE";
    out.headline = "Not enough older listings to state a price per model year";
    out.meta = `${n} read, ${need} per model year needed`;
    if (oy.reason === "basis_missing" || !hasBasis) {
      out.value = "NOT COMPARED";
      out.headline = "Older-year set not recorded";
      out.meta = "Basis not recorded";
      out.lines = [thisLine, { k: "Older model years", v: "a set was read, but what it was made of was not recorded" }];
      out.body = "Older listings were read for this report, but what they were made of was not recorded, so nothing is stated per model year.";
      return out;
    }
    if (oy.reason === "pool_truncated") {
      out.meta = "More were read than this line can hold";
      out.lines = [thisLine, { k: "Older model years", v: `the listing set came back at its size limit, so the dearest listings are missing from it and nothing is stated per model year` }];
      out.body = `The set of used ${nameplate} one to three model years older than this ${sy} came back at its size limit, so the dearest listings are missing from it and nothing is stated per model year.`;
      return out;
    }
    const older = `used ${nameplate}${n > 0 ? " (all trims, same powertrain)" : ""} one to three model years older than this ${sy}`.replace(/\s+/g, " ").trim();
    const anyOutliers = missing.some((m) => Number(m.nRead) > Number(m.nKept || 0));
    out.lines = [thisLine, ...missing.map(missLine)];
    if (!missing.length) out.lines.push({ k: "Older model years", v: n === 0 ? `none read: no ${older} were among the listings read from ${prov} dealers' own pages` : `${n} read${when ? " " + when : ""}, but no single model year had ${need} or more` });
    out.body = n === 0
      ? `No ${older} were among the listings read from ${prov} dealers' own pages, so nothing is stated per model year.`
      : `${n} ${older} ${n === 1 ? "was" : "were"} read from ${prov} dealers' own pages${when ? " " + when : ""}. ${anyOutliers ? `No single model year had ${need} or more once price outliers were left out` : `No single model year had ${need} or more listings`}, so nothing is stated per model year.`;
    return out;
  }

  const lines = [thisLine];
  for (const r of rungs) {
    const n = Number(r.n), med = Number(r.median);
    const d = Number(r.dealers) || 0;
    const known = r.kmKnown == null ? n : Number(r.kmKnown);
    const range = r.kmLow != null && r.kmHigh != null && known > 0
      ? (Number(r.kmLow) < 1000 ? `up to ${kmCeil(r.kmHigh)}` : `${kmFloor(r.kmLow)} to ${kmCeil(r.kmHigh)}`)
      : null;
    const km = range ? `, ${range}${known < n ? ` on the ${known} of ${n} that show a reading` : ""}` : ", no odometer reading on those pages";
    const dealersClause = d > 0 ? ` at ${d} ${prov} dealer${d === 1 ? "" : "s"}` : ` at ${prov} dealers`;
    const rWhen = readClause(r) || when;
    const delta = canCompare ? Math.round(ask - med) : null;
    const diff = delta == null ? "" : delta > 0 ? `, ${fmtMoney(delta)} less than this asking price` : delta < 0 ? `, ${fmtMoney(-delta)} more than this asking price` : ", the same as this asking price";
    const left = r.nRead != null && Number(r.nRead) > n ? Number(r.nRead) - n : 0;
    const outlier = left > 0 ? `; ${left} more ${left === 1 ? "was" : "were"} read and left out as ${left === 1 ? "a price outlier" : "price outliers"}` : "";
    lines.push({ k: `${olderWord(r.d)} (${r.year})`, v: `${n} used ${r.year} ${nameplate}${scopeWord}${km}${dealersClause}${rWhen ? `, read ${rWhen}` : ""}: middle ${fmtMoney(med)}${diff}${outlier}` });
  }
  for (const m of missing) lines.push(missLine(m));
  // The tile and the /verify row carry ONE figure -- the nearest model year --
  // and every model year is in the lines below them.
  const first = rungs[0];
  const fd = canCompare ? Math.round(ask - Number(first.median)) : null;
  out.state = "confirmed";
  out.askUsed = canCompare ? ask : null;
  out.note = OY_NOTE;
  out.value = `${olderWord(first.d).toUpperCase()} ${fd == null ? `MIDDLE ${fmtMoney(first.median)}` : fd > 0 ? `${fmtMoney(fd)} LESS` : fd < 0 ? `${fmtMoney(-fd)} MORE` : "THE SAME"}`;
  out.headline = fd == null ? `${olderWord(first.d)}: middle ${fmtMoney(first.median)}` : `${olderWord(first.d)} asks ${fd > 0 ? `${fmtMoney(fd)} less` : fd < 0 ? `${fmtMoney(-fd)} more` : "the same"}`;
  out.meta = [`${rungs.length} model year${rungs.length === 1 ? "" : "s"} stated`, oy.scope === "model" ? "all trims, same powertrain" : oy.scope === "trim" ? "same trim" : oy.scope === "trim_family" ? "trim family" : null, when ? `read ${when}` : null].filter(Boolean).join(" · ");
  out.lines = lines;
  out.body = `${thisLine.k}: ${thisLine.v}. ${lines.slice(1).map((l) => `${l.k}: ${l.v}`).join(". ")}.`;
  return out;
}

// ---------------------------------------------------------------------------
// LINE -- "Insurance before you sign".
//
// Not a figure and not a check: a SEQUENCING warning, from Alberta's own
// insurance regulator, about the order in which a buyer does two things.
//
// A lender or lessor requires collision and comprehensive -- the coverage that
// pays to repair or replace THIS vehicle. Alberta's "Take All Comers" rule
// (Insurance Act s. 555) obliges every insurer to quote and write the
// MANDATORY coverages for any Albertan, and the AIRB reports it does not
// extend to the OPTIONAL ones. So the contract signed at the dealership
// requires coverage no insurer is obliged to sell, and the contract is signed
// before the insurance is bound.
//
// Two halves, and they always ship together: the AIRB reports insurers applied
// this from early 2024 to drivers with an at-fault claim in six years or a
// serious conviction in four, AND that since October 2025 it regulates those
// underwriting rules and insurers are removing the restrictions. Printing the
// first without the second would describe a 2024 world in 2026.
//
// What it must never say: that a buyer may be unable to insure the vehicle.
// The AIRB's own sentence is that such drivers "would not accept the basic-only
// policy and look for another insurer" -- the outcome it describes is having to
// shop, under time pressure, already committed. That is the warning.
//
// Alberta only: it cites Alberta statute and an Alberta regulator, so the
// surfaces gate on financeCoverageApplies() and print nothing elsewhere.
// Source: AIRB, 2026 Annual Market and Trends Report, page 8, published 2026.
const AIRB_CITE = "Alberta Automobile Insurance Rate Board, 2026 Annual Market and Trends Report, pages 8 and 22, published 2026. Read 2026-09-03; quoted in docs/airb-2026-capture.md.";
// Province comes from the DEALER's page (resolveJurisdiction), never from a
// user-typed field: it decides whether an Alberta statute is printed at all.
export function provinceOf(a) {
  return a?.marketCount?.province || a?.mc?.pv || a?.olderYears?.province || a?.oy?.pv
    || a?.marketValue?.province || a?.marketValue?.pv || null;
}
// Alberta statute and an Alberta regulator: printed only where they apply.
export function financeCoverageApplies(a) {
  return String(provinceOf(a) || "").toUpperCase() === "AB";
}
// True when the LISTING ITSELF shows financing: the page's own pre-selected
// payment scenario (read from the page by page-default.js) or a price that
// depends on financing. A dealer APR is deliberately NOT a trigger -- that
// field carries the model's own unconfirmed read on some paths, and it once
// stated a 25% rate for a page that disclosed none (2026-08-19). The guidance
// holds either way, so a page with no financing signal still gets the card,
// worded conditionally.
function financingShown(a) {
  const pd = normDflt(a?.pageDefault ?? a?.dflt);
  const hasScenario = !!pd && pd.state === "confirmed"
    && (Number(pd.termMonths) > 0 || Number(pd.paymentAmount) > 0 || (pd.apr != null && Number.isFinite(Number(pd.apr))));
  const contingent = !!(a?.financeContingent?.contingent || a?.fcx);
  // The payment-starting-point card words a cash-first page as opening on cash;
  // this one must not call the same page a financing payment.
  const cashFirst = !!pd && pd.purchaseMethod === "cash";
  return { any: hasScenario || contingent, hasScenario, contingent, cashFirst };
}
export function financeCoverageLine(a) {
  const f = financingShown(a);
  const out = {
    key: "financecover", title: "Insurance before you sign", tone: "muted",
    state: f.any ? "confirmed" : "general",
    value: "CONFIRM COVER BEFORE SIGNING", headline: "Confirm your cover before you sign",
    body: "", lines: [], meta: "", note: AIRB_CITE, explain: "",
  };
  const lead = f.contingent ? "This page's price depends on financing with the dealer. "
    : f.hasScenario && f.cashFirst ? "This page opens on its cash price and also shows a financing option. "
    : f.hasScenario ? "This page shows a financing payment. " : "";
  out.meta = f.any ? "Financing shown on this page · Alberta" : "Alberta rules · applies whether or not you finance";
  out.lines = [
    { k: "If you finance or lease", v: `${lead}The AIRB reports that optional coverages — collision and comprehensive, which pay to repair or replace this vehicle — may be required for a leased or financed vehicle.` },
    { k: "The gap", v: "The AIRB reports that insurers are typically required, under section 555 of the Insurance Act — colloquially the Take All Comers rule — to provide a quote and write the business for any Albertan, but that this only applies to mandatory coverages, so insurers could deny access to the optional ones." },
    { k: "Who it reached", v: "The AIRB reports that starting in early 2024 insurers began to deny those coverages to drivers with an at-fault claim in the past six years or a serious traffic conviction within the past four years, or at least forced them to choose a deductible such as $2,000 or more." },
    { k: "Where it stands", v: "The AIRB reports that as of October 2025 AR 227/2025 gave it authority over those underwriting rules, that Bulletin 08-2025 advises insurers they will not receive any approval to increase rates until the rules are relaxed, and that with the implementation of Care-First many insurers are increasing their risk appetite and removing these restrictions (page 22)." },
    { k: "Before you sign", v: "Ask your own insurer to confirm they will write collision and comprehensive on this vehicle, at the deductible your contract requires. A finance or lease contract is typically signed at the dealership, before the insurance is bound." },
  ];
  // One sentence for surfaces that show a short "what this means" panel. Worded
  // HERE so it sweeps with the rest and says the same thing everywhere.
  out.explain = "The AIRB reports that collision and comprehensive may be required for a leased or financed vehicle, and that Alberta's Take All Comers rule covers only the mandatory coverages. Confirm your own insurer will write them, at the deductible your contract requires, before you sign.";
  out.body = out.lines.map((l) => l.v).join(" ");
  return out;
}
