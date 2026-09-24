// THE REPORT'S THIRTEEN CARDS (2026-09-24, the Hub & Spoke redesign).
//
// Cards 01-10 are the canonical ten bands, unchanged: this module reads
// reportBands() and never re-decides a state, so a card can never disagree with
// the band it shows. [[two-authors-per-fact]] Cards 11-13 are the three Vic
// added to the design:
//
//   11  Days on lot       -- only where a source states it; never estimated.
//   12  Used vs new (used) / APR vs the maker (new)
//   13  Freight & PDI     -- what the listing charges against what the maker
//                            publishes, via freightLine().
//
// What this module adds is COPY, never a figure: the card's one-line summary
// (the band's own first sentence) and its "Suggestion:" line. Every number on a
// card comes from a builder that already owns it. The suggestions never assume
// the buyer will sign ([[no-assume-the-client-signs]]) and never accuse the
// dealer ([[no-accusation-language]]).
import { reportBands, RAISE, CLEAR, NOTED, UNCHECKED } from "./report-bands.js";
import { daysOnLotLine, fmtMoney, fmtDateEn } from "./report-lines.js";
import { freightLine } from "./freight-line.ts";
import { aprRefusal } from "./apr-reference.ts";

/** The first sentence of a band note: what a card has room for. */
export function firstSentence(s) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const m = t.match(/^(.+?[.!?])(\s|$)/);
  return m ? m[1] : t;
}

const isUsed = (a) => String(a?.vehicleCondition || "").toLowerCase() !== "new";

// One suggestion per band and state. A function where the wording depends on
// the car; a string otherwise.
// A Map rather than an object literal: these keys name CARDS for copy lookup,
// not facts, and must not read as another author of `recalls` or `vin`.
const SUGGEST = new Map([
  ["price_vs_msrp", {
    raise: (a) => (isUsed(a) ? "Ask what separates this car from the listings asking less." : "Ask for the price at or under MSRP, in writing."),
    clear: "Nothing to raise on price.",
    noted: "Worth knowing, not a finding.",
    unchecked: "Ask for the all-in price in writing.",
  }],
  ["recalls", {
    raise: "Ask for the recall work to be done before delivery, in writing. It is free.",
    clear: "Nothing open on record for this vehicle.",
    noted: "Ask whether any campaign applies to this VIN.",
    unchecked: "Check the VIN on the maker's own recall page.",
  }],
  ["fees", {
    raise: "Ask what each flagged line is, and whether it is optional.",
    clear: "Nothing to raise on fees.",
    noted: "Ask for every fee itemised in writing.",
    unchecked: "Ask for every fee itemised in writing.",
  }],
  ["dealer_licence", {
    raise: "Ask the dealer about the status AMVIC's registry shows.",
    clear: "Licensed. Nothing to raise.",
    noted: "Look the dealer up on AMVIC's public registry.",
    unchecked: "Look the dealer up on AMVIC's public registry.",
  }],
  ["finance_math", {
    raise: "Ask for the amortisation schedule in writing.",
    clear: "Payments reconcile. Nothing to raise.",
    noted: "Ask for the rate, term and total cost in writing.",
    unchecked: "Ask for the rate, term and total cost in writing.",
  }],
  ["odometer", {
    raise: "Ask why the odometer reads as it does, in writing.",
    clear: (a) => (a?.odometerCheck?.km != null ? `Check the dash reads ${Number(a.odometerCheck.km).toLocaleString("en-CA")} km.` : "Check the dash reads the same."),
    noted: "Check the dash reads the same.",
    unchecked: "Read the odometer on the dash yourself.",
  }],
  ["vin", {
    raise: "Ask for the VIN and match it to the dash plate.",
    clear: "Match it to the dash plate and the registration.",
    noted: "Match it to the dash plate and the registration.",
    unchecked: "Ask for the VIN in writing.",
  }],
  ["rebate", {
    raise: "Confirm the rebate is applied to your price.",
    clear: "Confirm the dealer applies it to your price.",
    noted: "Nothing to claim here.",
    unchecked: "Check the current rebate terms before counting on it.",
  }],
  ["warranty", {
    raise: "Ask what factory cover remains, and from what date.",
    clear: "Weigh any extended plan against the factory cover.",
    noted: "Ask what factory cover remains, and from what date.",
    unchecked: "Ask what factory cover remains, and from what date, in writing.",
  }],
  ["reputation", {
    raise: "Read the reviews before going further.",
    clear: "Read the most recent reviews yourself.",
    noted: "Read the most recent reviews yourself.",
    unchecked: "Search the dealer by name for rating and reviews.",
  }],
]);

const suggestFor = (key, state, a) => {
  const s = SUGGEST.get(key)?.[state];
  return typeof s === "function" ? s(a) : (s || "");
};

// ── 11 · Days on lot ────────────────────────────────────────────────────────
// Only a stated source earns a number. LotCheck's own tracking with a single
// sighting says when we FIRST SAW the car, which is not a duration.
// [[days-on-lot-needs-real-observations]]
export function daysCard(a) {
  const base = { n: "11", key: "days_on_lot", title: "Days on lot" };
  const d = a?.daysOnLot;
  const line = daysOnLotLine(a);
  if (!d || !line) {
    return { ...base, state: UNCHECKED, value: "NOT STATED",
      short: "This listing does not state how long the car has been for sale.",
      suggestion: "Ask how long this car has been for sale." };
  }
  const days = Number(d.days);
  const since = d.since ? fmtDateEn(d.since) : null;
  const src = d.sourceLabel || "the listing";
  if (d.state === "single_sighting" || !(days > 0)) {
    return { ...base, state: NOTED, value: line.value,
      short: firstSentence(line.line),
      suggestion: "Ask how long this car has been for sale." };
  }
  const short = `Listed${d.atLeast ? " at least" : ""} since ${since}, per ${src}.`;
  return days >= 90
    ? { ...base, state: RAISE, value: `${days} DAYS`, short, source: src,
        suggestion: `Ask what comes off a car listed ${days} days.` }
    : { ...base, state: NOTED, value: `${days} DAYS`, short, source: src,
        suggestion: "Not long on the lot. Nothing to raise yet." };
}

// ── 12 · APR vs the maker (new) / used vs new (used) ───────────────────────
export function aprCard(a) {
  const make = a?.make ? String(a.make) : "the maker";
  const base = { n: "12", key: "apr_vs_maker", title: `APR vs ${make}` };
  const c = a?.aprCheck;
  if (!c || !c.checked || !c.comparable || !c.benchmark) {
    return { ...base, state: UNCHECKED, value: "NOT COMPARED",
      short: c?.why ? aprRefusal(c.why) : "We hold no rate from this listing to compare.",
      suggestion: `Ask for the rate in writing, and for ${make}'s own published rate.` };
  }
  const bm = c.benchmark, q = Number(c.quotedApr), b = Number(bm.apr);
  const term = c.termMonths ? ` for ${c.termMonths} months` : "";
  const src = `${bm.lender}, read ${fmtDateEn(bm.capturedOn)}`;
  if (Number(c.overByPts) > 0) {
    const extra = Number(c.extraOverTerm) > 0 ? ` About ${fmtMoney(c.extraOverTerm)} more over the loan.` : "";
    return { ...base, state: RAISE, value: `${q}% VS ${b}%`, source: src,
      short: `${q}% quoted; ${bm.lender} publishes ${b}%${term}.${extra}`,
      suggestion: `Ask for ${bm.lender}'s published ${b}%, in writing.` };
  }
  return { ...base, state: CLEAR, value: `${q}% VS ${b}%`, source: src,
    short: `${q}% quoted, at or under the ${b}% ${bm.lender} publishes${term}.`,
    suggestion: "The rate matches the maker's. Nothing to raise." };
}

export function usedVsNewCard(a) {
  // Needs the cheapest new same-model price sealed in the analysis
  // (a.newFrom). Until the analysis carries it, the card says it was not
  // checked -- it never falls back to a number from elsewhere.
  const base = { n: "12", key: "used_vs_new", title: "Used vs new" };
  const nf = a?.newFrom;
  const ask = Number(a?.quotedPrice);
  if (!nf || !(Number(nf.allIn) > 0) || !(ask > 0)) {
    return { ...base, state: UNCHECKED, value: "NOT CHECKED",
      short: "We did not compare this price with the same model new.",
      suggestion: "Ask what the same model costs new, all-in." };
  }
  const gap = Math.round(ask - Number(nf.allIn));
  const what = [nf.year, a.model, nf.trim, nf.fuel].filter(Boolean).join(" ");
  const short = `Cheapest new ${a.model || "one"} we hold: ${what}, ${fmtMoney(Math.round(Number(nf.allIn)))} all-in.`;
  return gap >= 0
    ? { ...base, state: RAISE, value: `${fmtMoney(gap)} MORE THAN NEW`, short, source: nf.source || null,
        suggestion: "Ask why it costs more than a new one." }
    : { ...base, state: NOTED, value: `${fmtMoney(-gap)} LESS THAN NEW`, short, source: nf.source || null,
        suggestion: "Weigh the saving against a new car's full warranty." };
}

// ── 13 · Freight & PDI ─────────────────────────────────────────────────────
export function freightCard(a) {
  const base = { n: "13", key: "freight_pdi", title: "Freight & PDI" };
  const f = freightLine(a);
  if (isUsed(a)) {
    return f.listing != null
      ? { ...base, state: RAISE, value: fmtMoney(f.listing),
          short: `This used listing charges ${fmtMoney(f.listing)} for freight and PDI, which are new-car charges.`,
          suggestion: "Ask what that line covers on a used car." }
      : { ...base, state: NOTED, value: "NEW-CAR CHARGE",
          short: "This used listing shows no freight or PDI line; both are new-car charges.",
          suggestion: "If the bill adds freight, PDI or a prep fee, ask what it is for." };
  }
  const src = f.source ? `${f.source}${f.capturedOn ? `, ${fmtDateEn(f.capturedOn)}` : ""}` : null;
  switch (f.state) {
    case "above":
      return { ...base, state: RAISE, value: `${fmtMoney(f.delta)} ABOVE ${String(f.make || "MAKER").toUpperCase()}`, source: src,
        short: `${f.make} publishes ${fmtMoney(f.published)} for freight and PDI on this model. This listing charges ${fmtMoney(f.listing)}.`,
        suggestion: `Ask what the ${fmtMoney(f.delta)} difference covers, in writing.` };
    case "compared":
      return { ...base, state: CLEAR, value: fmtMoney(f.listing), source: src,
        short: `At or below the ${fmtMoney(f.published)} ${f.make} publishes for this model.`,
        suggestion: "Freight matches the maker's figure. Nothing to raise." };
    case "published_only":
      return { ...base, state: NOTED, value: `${fmtMoney(f.published)} PUBLISHED`, source: src,
        short: `${f.make} publishes ${fmtMoney(f.published)}; this listing states no freight line.`,
        suggestion: "Ask for the freight and PDI line in writing." };
    case "listing_only":
      return { ...base, state: NOTED, value: fmtMoney(f.listing),
        short: `This listing charges ${fmtMoney(f.listing)}; we hold no published figure for this model.`,
        suggestion: "Ask the dealer where the freight figure comes from." };
    default:
      return { ...base, state: UNCHECKED, value: "NOT READ",
        short: "Neither the listing nor our catalogue states freight and PDI for this model.",
        suggestion: "Ask for the freight and PDI line in writing." };
  }
}

/** All thirteen cards, in fixed order. Never re-sorted by severity. */
export function reportCards(a) {
  const bands = reportBands(a).map((b) => ({
    n: b.n, key: b.key,
    // A used car's point 01 measures the market, not the sticker.
    title: b.key === "price_vs_msrp" && isUsed(a) && !(Number(a?.msrp) > 0 && a?.msrpBasis === "exact") ? "Price vs market" : b.title,
    state: b.state, value: b.value, source: b.source || null,
    short: firstSentence(b.note),
    suggestion: suggestFor(b.key, b.state, a),
  }));
  const cards = [...bands, daysCard(a), isUsed(a) ? usedVsNewCard(a) : aprCard(a), freightCard(a)];
  // The band rule, carried to the three new cards: green must name its source.
  for (const c of cards) {
    if (c.state === CLEAR && !c.source) throw new Error(`report-cards: card ${c.n} ${c.title} is CLEAR with no source.`);
  }
  return cards;
}

/** States, never a total. Same contract as bandTally(). */
export function cardTally(cards) {
  const t = { raise: 0, clear: 0, noted: 0, unchecked: 0 };
  for (const c of cards || []) if (t[c?.state] !== undefined) t[c.state]++;
  return t;
}
