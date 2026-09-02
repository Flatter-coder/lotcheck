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
// The one instruction any line may carry is: ask the dealer, in writing.
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
  const allTrims = scope === "model" ? " (all trims)" : "";
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
  body += mc.subjectExcluded ? " Counts of dealers' own advertised prices, this vehicle excluded; not a valuation." : " Counts of dealers' own advertised prices; this vehicle may be among them; not a valuation.";
  out.value = `${below} OF ${n} BELOW THIS PRICE${scopeTag}`;
  out.headline = below === 0 ? `None of ${n} advertised below this one` : `${below} of ${n} advertised below this one`;
  out.body = body;
  return out;
}

// ---------------------------------------------------------------------------
// LINE 2 -- "If you do nothing, this page shows N months, <freq> payments at X%."
export function pageDefaultLine(a) {
  const pd = normDflt(a?.pageDefault ?? a?.dflt);
  const out = { key: "pagedefault", title: "If you do nothing", tone: "muted", state: "unchecked", value: "NOT READ", headline: "Not read — ask the dealer", body: "", meta: "Not read" };
  if (!pd || !pd.state || pd.state === "unchecked") {
    out.body = pd?.reason === "no_page"
      ? "Not read — a pre-selected payment scenario is read from a listing page, not from an uploaded quote. Ask the dealer for the term, payment frequency and rate in writing."
      : "Not read — no payment settings were read for this report. Ask the dealer for the term, payment frequency and rate in writing.";
    return out;
  }
  out.state = pd.state;
  if (pd.state === "absent") {
    if (POSITIVE_ABSENCE.has(String(pd.reason))) {
      out.value = "NOT SHOWN";
      out.headline = "Not shown — ask the dealer";
      out.meta = "Not shown";
      out.body = "Not shown — this page's own settings show no pre-selected finance scenario, so no default is reported. Ask the dealer for the term, payment frequency and rate in writing.";
    } else {
      out.value = "NONE FOUND";
      out.headline = "None found — ask the dealer";
      out.meta = "None found";
      out.body = "None found — LotCheck did not find a pre-selected term, payment frequency or rate in this page's own text or data, so no default is reported. Ask the dealer for all three in writing.";
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
  if (apr != null) parts.push(`at ${apr}% APR`);
  if (down != null) parts.push(`with ${fmtMoney(down)} down`);
  const shows = parts.length ? parts.join(", ").replace(", at ", " at ").replace(", with ", " with ") : "a pre-selected payment scenario";
  const quals = [];
  if (pd.qualifier) quals.push(pd.qualifier);
  if (pd.costOfBorrowing != null && Number(pd.costOfBorrowing) > 0) quals.push(`cost of borrowing ${fmtMoney(pd.costOfBorrowing)} as stated`);
  const qual = quals.length ? ` (${quals.join("; ")})` : "";
  const basis = pd.source === "sm360_feed"
    ? "from the dealer's own listing data"
    : pd.source === "edealer_js"
      ? "the page's own calculator settings"
      : "the finance figure this page shows first, from its own text";
  const when = fmtDateEn(pd.readAt) ? `, read ${fmtDateEn(pd.readAt)}` : "";
  const cashFirst = pd.purchaseMethod === "cash";
  let body = cashFirst
    ? `This page opens on its cash price. Its finance option, if you change nothing else, shows ${shows}${qual} — ${basis}${when}.`
    : `If you do nothing, this page shows ${shows}${qual} — ${basis}${when}.`;
  if (!t) body += " No term is pre-selected on the page.";
  if (!f) body += " The page does not state a payment frequency next to this figure.";
  if (apr == null) body += " No rate is pre-selected on the page.";
  body += " Ask the dealer for the term, frequency, rate and total cost of borrowing in writing.";
  out.body = body;
  const core = [t ? `${t} MO` : "NO TERM", f ? f.toUpperCase() : null, apr != null ? `${apr}%` : "NO RATE"].filter(Boolean).join(" · ");
  out.value = cashFirst ? `OPENS ON CASH · ${core}` : core;
  out.headline = (cashFirst ? "Opens on cash · " : "") + [t ? `${t} months` : "no term", f || null, apr != null ? `${apr}% APR` : "no rate"].filter(Boolean).join(" · ");
  out.meta = fmtDateEn(pd.readAt) ? `read ${fmtDateEn(pd.readAt)}` : "Read";
  return out;
}

export const REPORT_LINES = { marketCountLine, pageDefaultLine };
