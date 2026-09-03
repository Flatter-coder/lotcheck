// The page's own DEFAULT payment scenario: "this page's payment default is
// N months, <frequency> payments at X% APR with $D down".
//
// Plain ES module so it runs in Deno and in the Node test suite.
//
// WHY. A dealer page's payment widget opens on a pre-selected term, payment
// frequency and rate. That default is the page's choice, not the buyer's, and
// it is what makes the first payment figure a buyer sees the smallest one on
// the page (longest term, most frequent payments). Stating the default as a
// plain fact -- read from the page's own data, dated -- lets the buyer see the
// setting before they see the payment. It is a description of the page, never
// a motive: no wording here may say WHY the dealer chose it.
//
// CODE, NEVER THE MODEL. Every field below is copied from the page's own feed,
// embedded settings or visible sentence by a regular expression or a JSON
// read. The model-extracted `analysis.financing` object is NOT a source: it
// cannot say whether what it read was the pre-selected scenario. Anything this
// module cannot read stays null and the line says so.
//
// THREE STATES, and the reason that picks the wording (see point-state.ts):
//   confirmed  -- a default was read; every printed field names its source.
//   absent     -- reason "panel_hidden" / "feed_no_term": the PAGE'S OWN data
//                 says no finance scenario is pre-selected ("Not shown");
//                 reason "none_found": the html was read and no recognisable
//                 default was found ("None found" -- a miss, never "not
//                 published").
//   unchecked  -- nothing readable was handed in, only text without the html
//                 (absence of a <script>-held setting cannot be established
//                 from text), the price is unknown (a sentence cannot be tied
//                 to this vehicle), the settings could not be parsed, or two
//                 candidates disagree. No claim either way.
//
// TEMPLATE-PLACEHOLDER GUARD. EDealer (GM) pages carry a literal
// "$19.988 x 84 Months @ 6.49% APR" template string in their static HTML for
// EVERY vehicle (scripts/fixtures/jackcarter-bolt.html:1955). A sentence only
// counts as THIS page's default when its principal equals the listing's own
// advertised price to the dollar; without a known price nothing is confirmed.

export const PAGE_DEFAULT_SOURCES = new Set(["sm360_feed", "edealer_js", "page_text"]);
export const POSITIVE_ABSENCE = new Set(["panel_hidden", "feed_no_term"]);

export const FREQ_LABEL = { weekly: "weekly", biweekly: "bi-weekly", monthly: "monthly" };

// "$39,713.70" -> 39713.7; "$19.988" (EDealer's dotted thousands) -> 19988.
export function parseAmount(x) {
  if (x == null || x === "") return null;
  let s = String(x).replace(/[$\s]/g, "");
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  s = s.replace(/,/g, "");
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}
const num = parseAmount;

function freqFromPerYear(n) {
  const v = Number(n);
  if (v === 52) return "weekly";
  if (v === 26) return "biweekly";
  if (v === 12) return "monthly";
  return null;
}

export function freqFromWord(w) {
  const s = String(w || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!s) return null;
  if (s === "biweekly" || s === "bw" || s === "bi") return "biweekly";
  if (s === "weekly" || s === "wk" || s === "w") return "weekly";
  if (s === "monthly" || s === "mo" || s === "m") return "monthly";
  return null;
}

function base(readAt) {
  return { checked: false, state: "unchecked", termMonths: null, paymentFrequency: null, apr: null, downPayment: null, paymentAmount: null, purchaseMethod: null, qualifier: null, costOfBorrowing: null, source: null, evidence: null, readAt: readAt || null, reason: null };
}

// ---------------------------------------------------------------------------
// SM360 inventory feed. paymentOptions.{purchaseMethod, term, paymentFrequency,
// cashDown} is the unit's SELECTED scenario when set (term > 0); when the page
// opens on cash those are 0 and paymentOptions.finance.{paymentFrequency,
// cashDown, term.{term, apr, payment}} is the finance scenario the site
// computes for the listing card ("from $196/wk"). paymentFrequency is payments
// per year (52/26/12).
export function readSm360PageDefault(v, readAt) {
  const out = base(readAt);
  const po = v?.paymentOptions;
  if (!po || typeof po !== "object") return out;
  out.checked = true;
  out.source = "sm360_feed";
  out.purchaseMethod = typeof po.purchaseMethod === "string" && po.purchaseMethod ? po.purchaseMethod : null;
  const fin = po.finance || {};
  const t = fin.term || {};
  const topTerm = num(po.term), topFreq = freqFromPerYear(po.paymentFrequency);
  if (topTerm != null && topTerm > 0 && topFreq) {
    // The unit's own selected scenario. The rate is only known when the feed's
    // finance term is the same term.
    out.state = "confirmed";
    out.termMonths = Math.round(topTerm);
    out.paymentFrequency = topFreq;
    out.apr = num(t.term) === topTerm && num(t.apr) != null ? num(t.apr) : null;
    out.downPayment = num(po.cashDown);
    out.paymentAmount = num(t.term) === topTerm && num(t.payment) > 0 ? Math.round(num(t.payment) * 100) / 100 : null;
    out.evidence = `paymentOptions: term ${po.term}, paymentFrequency ${po.paymentFrequency} per year, cashDown ${po.cashDown ?? "?"}, purchaseMethod ${po.purchaseMethod ?? "?"}`;
    return out;
  }
  const apr = num(t.apr);
  const term = num(t.term);
  if (!(apr != null && apr >= 0 && apr <= 30) || !(term != null && term > 0)) {
    out.state = "absent";
    out.reason = "feed_no_term";
    out.evidence = "paymentOptions.finance carries no term";
    return out;
  }
  out.state = "confirmed";
  out.termMonths = Math.round(term);
  out.apr = apr;
  out.paymentFrequency = freqFromPerYear(fin.paymentFrequency);
  out.downPayment = num(fin.cashDown);
  const pay = num(t.payment);
  out.paymentAmount = pay != null && pay > 0 ? Math.round(pay * 100) / 100 : null;
  out.evidence = `paymentOptions.finance: term ${term}, apr ${apr}, paymentFrequency ${fin.paymentFrequency ?? "?"} per year, cashDown ${fin.cashDown ?? "?"}, purchaseMethod ${po.purchaseMethod ?? "?"}`;
  return out;
}

// ---------------------------------------------------------------------------
// EDealer family, recognised by its widget token (never by the asset host --
// many dealer themes load static.edealer.ca without the V3 payment widget).
//   financePaymentIntervalShort = 'none' / "financePaymentIntervalShort":"none"
//     -> the finance panel is hidden: the page shows NO default payment.
//   default_finance_term = parseInt('N') -> the pre-selected term when N is
//     one of the offered terms. When it is not, the widget's fallback has not
//     been pinned by a captured page, so nothing is confirmed (missing beats
//     wrong).
//   "finance_incentives":[{term, interestRate, weeklyPayment, biweeklyPayment,
//     monthlyPayment, stackable_offers:[...]}] -> the offers the widget draws
//     from (nested arrays inside, so the array is found by bracket depth).
//   "down_payment":"3800" -> the pre-filled down payment.
const INTERVAL_RE = /financePaymentIntervalShort\s*(?:=\s*|["']?\s*:\s*)['"]([^'"]*)['"]/;

function sliceJsonArray(s, from) {
  // from = index of '[' ; returns the balanced slice or null.
  let depth = 0, inStr = false, esc = false, quote = "";
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
    if (c === "[") depth++;
    else if (c === "]") { depth--; if (depth === 0) return s.slice(from, i + 1); }
  }
  return null;
}

export function readEdealerPageDefault(html, readAt) {
  const s = typeof html === "string" ? html : "";
  if (!/financePaymentIntervalShort/.test(s)) return null;
  const out = base(readAt);
  out.checked = true;
  out.source = "edealer_js";
  const im = s.match(INTERVAL_RE);
  const interval = im ? im[1].trim().toLowerCase() : null;
  if (!im) { out.reason = "interval_not_found"; out.evidence = "financePaymentIntervalShort present but unreadable"; return out; }
  if (interval === "" || interval === "none") {
    out.state = "absent";
    out.reason = "panel_hidden";
    out.evidence = im[0];
    return out;
  }
  const key = s.indexOf('"finance_incentives"');
  const open = key >= 0 ? s.indexOf("[", key) : -1;
  const arrText = open >= 0 ? sliceJsonArray(s, open) : null;
  let offers = [];
  if (arrText) {
    try {
      const arr = JSON.parse(arrText.replace(/\\"/g, '"'));
      offers = (Array.isArray(arr) ? arr : []).map((o) => ({ term: num(o.term), apr: num(o.interestRate ?? o.effectiveInterestRate), weekly: num(o.weeklyPayment), biweekly: num(o.biweeklyPayment), monthly: num(o.monthlyPayment) })).filter((o) => o.term > 0);
    } catch { out.reason = "offers_unparsed"; out.evidence = im[0]; return out; }
  }
  if (!offers.length) { out.reason = "offers_unparsed"; out.evidence = `${im[0]}; no finance_incentives array`; return out; }
  const dm = s.match(/default_finance_term\s*=\s*parseInt\(['"]?(-?\d+)['"]?\)/) || s.match(/"default_finance_term"\s*:\s*"?(-?\d+)"?/);
  const sentinel = dm ? Number(dm[1]) : null;
  const terms = offers.map((o) => o.term);
  if (sentinel == null || !terms.includes(sentinel)) {
    out.reason = "default_term_unpinned";
    out.evidence = `${im[0]}; default_finance_term ${sentinel ?? "unset"} not among offered terms [${terms.join(",")}]`;
    return out;
  }
  const offer = offers.find((o) => o.term === sentinel);
  const freq = freqFromWord(interval);
  const downM = s.match(/"down_payment"\s*:\s*"?([\d,.]+)"?/);
  out.state = "confirmed";
  out.termMonths = sentinel;
  out.apr = offer && offer.apr != null ? offer.apr : null;
  out.paymentFrequency = freq;
  out.downPayment = downM ? num(downM[1]) : null;
  out.paymentAmount = offer ? (freq === "weekly" ? offer.weekly : freq === "biweekly" ? offer.biweekly : freq === "monthly" ? offer.monthly : null) : null;
  out.evidence = `${im[0]}; default_finance_term ${sentinel} of [${terms.join(",")}]`;
  return out;
}

// ---------------------------------------------------------------------------
// Visible sentence, the "Finance from $267 ... $39,713.70 x 84 months @ 5.99%
// APR with $0.00 down payment (estimated financing rate, cost of borrowing
// $8,951.19). Plus taxes and licence. / Biweekly" shape (okotokshonda.com, live
// read 2026-09-02). Only the sentence under the LAST "Finance from" label
// before it counts (the lease sentence sits beside it with the same shape),
// and only when its principal is this listing's price to the dollar.
const AMOUNT = "\\$\\s*(\\d{1,3}(?:[.,]\\d{3})*(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)";
const SENTENCE = new RegExp(`${AMOUNT}\\s*x\\s*(\\d{2,3})\\s*months?\\s*@\\s*(\\d{1,2}(?:\\.\\d{1,2})?)\\s*%\\s*APR(?:\\s*with\\s*${AMOUNT}\\s*down\\s*payment)?`, "gi");

export function stripHtml(html) {
  return String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
}

function lastIndexOfRe(s, re) {
  let last = -1, m;
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  while ((m = g.exec(s))) { last = m.index; if (m[0].length === 0) g.lastIndex++; }
  return last;
}

export function readPageTextDefault(text, opts = {}) {
  const s = typeof text === "string" ? text : "";
  const out = base(opts.readAt);
  if (!s.trim()) return out;
  out.checked = true;
  out.source = "page_text";
  const price = num(opts.price);
  if (!(price != null && price > 0)) { out.reason = "price_unknown"; return out; }
  SENTENCE.lastIndex = 0;
  let m;
  const candidates = [];
  while ((m = SENTENCE.exec(s))) {
    const prefix = s.slice(0, m.index);
    const lastFinance = lastIndexOfRe(prefix, /finance\s+from/i);
    const lastLease = Math.max(lastIndexOfRe(prefix, /lease\s+from/i), lastIndexOfRe(prefix, /\blease\s+(?:payment|payments|offer|offers)\b/i));
    const after = s.slice(m.index + m[0].length, Math.min(s.length, m.index + m[0].length + 260));
    const paren = after.match(/^\s*\(([^)]*)\)/);
    const isLease = lastLease > lastFinance || (paren ? /lease/i.test(paren[1]) : false);
    if (lastFinance < 0 || isLease) continue;
    const principal = num(m[1]);
    if (principal == null || Math.abs(principal - price) >= 1) continue;
    const lead = s.slice(lastFinance, m.index);
    const payM = lead.match(/finance\s+from\s*\$\s*(\d[\d,]*(?:\.\d{1,2})?)/i);
    // Frequency: only the "/ Biweekly" suffix of THIS block -- within 90
    // characters of the sentence, before the next dollar figure or lease word.
    const tailStart = paren ? paren[0].length : 0;
    let tail = after.slice(tailStart, tailStart + 160);
    const stop = tail.search(/\$|\blease\b/i);
    if (stop >= 0) tail = tail.slice(0, stop);
    const freqM = tail.match(/\/\s*(bi-?weekly|weekly|monthly)\b/i);
    const qual = [];
    let cob = null;
    if (paren) {
      if (/estimated/i.test(paren[1])) qual.push("the page calls the rate an estimate");
      const c = paren[1].match(/cost of borrowing\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i);
      if (c) cob = num(c[1]);
    }
    if (/plus taxes and licen[cs]e/i.test(after.slice(0, 120))) qual.push("plus taxes and licence");
    candidates.push({
      termMonths: num(m[2]), apr: num(m[3]), downPayment: m[4] != null ? num(m[4]) : null,
      paymentAmount: payM ? num(payM[1]) : null,
      paymentFrequency: freqM ? freqFromWord(freqM[1]) : null,
      qualifier: qual.length ? qual.join("; ") : null, costOfBorrowing: cob,
      exact: principal === price,
      evidence: s.slice(Math.max(0, m.index - 40), Math.min(s.length, m.index + m[0].length + 60)).trim(),
    });
  }
  if (!candidates.length) { out.state = "absent"; out.reason = "none_found"; return out; }
  const exact = candidates.filter((c) => c.exact);
  const pick = exact.length ? exact : candidates;
  const distinct = new Set(pick.map((c) => `${c.termMonths}|${c.apr}|${c.downPayment}`));
  if (distinct.size > 1) { out.reason = "ambiguous"; out.evidence = `${distinct.size} different finance sentences at this price`; return out; }
  // The same sentence is often printed twice (a desktop and a mobile copy) and
  // only one copy sits next to the "/ Biweekly" suffix: merge identical copies,
  // keeping every field any copy carried.
  const merged = pick.reduce((acc, c) => {
    for (const k of Object.keys(c)) if (acc[k] == null && c[k] != null) acc[k] = c[k];
    return acc;
  }, { ...pick[0] });
  const { exact: _e, ...c } = merged;
  Object.assign(out, c, { state: "confirmed" });
  return out;
}

// ---------------------------------------------------------------------------
// One entry point. Order: the platform's own structured data first (exact),
// then the page's embedded widget settings, then the visible sentence.
// `readAt` is stamped by the caller (no clock here). `text` is plain text or
// markdown, never raw html (html goes in `html`, where <script> is dropped).
export function readPageDefault({ sm360Vehicle = null, html = null, text = null, price = null, readAt = null } = {}) {
  let best = null;
  if (sm360Vehicle) {
    const r = readSm360PageDefault(sm360Vehicle, readAt);
    if (r.state === "confirmed") return r;
    if (r.checked) best = r;
  }
  const h = typeof html === "string" && html ? html : null;
  if (h) {
    const e = readEdealerPageDefault(h, readAt);
    if (e) {
      if (e.state === "confirmed" || e.state === "absent") return e;
      best = best && best.state === "absent" ? best : e; // unparsed widget: keep looking in the text
    }
  }
  const plain = typeof text === "string" && text.trim() && !/^\s*</.test(text) ? text : "";
  const corpus = [plain, h ? stripHtml(h) : ""].filter(Boolean).join(" \n ");
  if (corpus.trim()) {
    const t = readPageTextDefault(corpus, { price, readAt });
    if (t.state === "confirmed") return t;
    if (best) return best;
    if (!h) { t.state = "unchecked"; t.reason = t.reason === "price_unknown" ? "price_unknown" : "html_unavailable"; }
    return t;
  }
  return best || base(readAt);
}
