// report-bands.js — the ten points as Traffic Column bands, built ONCE.
//
// Vic chose Traffic Column on 2026-09-13 to replace Price Terrain. The visible
// change is ten colour-railed rows. The change that matters is underneath it.
//
// ── WHY THIS MODULE EXISTS ────────────────────────────────────────────────
//
// 1. TWO AUTHORS, ONE FACT. The ten points were assembled TWICE — once in
//    src/App.jsx (the on-screen grid) and once in email-quote-report's
//    tenPoints() — from the same analysis object by two different pieces of
//    code. They already disagree in production. The 2026-09-13 audit found the
//    same check rendering differently on the two surfaces four times over; the
//    sharpest is the EV rebate, where an unread drivetrain prints "NOT
//    DETERMINED" on screen and "N/A (GAS)" in the emailed PDF — one of those
//    is a fabricated fact about the car, in the document the buyer carries into
//    the dealership. Traffic Column's whole premise is that the printed page
//    and the phone show the SAME document, so the model has to be built once.
//    [[two-authors-per-fact]] [[report-features-all-views]]
//
// 2. THREE STATES, AND THE THIRD IS NOT A COLOUR. `tone: flag|pass|muted`
//    could not say "we could not check". `muted` meant N/A, and neutral, and
//    unread, all at once — so a failed lookup rendered in the same grey as a
//    genuine not-applicable. In Traffic Column a rail IS a verdict, which makes
//    that conflation visible: the design refuses to draw an honest rail for it.
//    `unchecked` is its own state here, and it is drawn as a HATCH, never a
//    fill. [[supervised-correctness-is-not-correctness]]
//
// ── THE RULE EVERY BRANCH BELOW OBEYS ─────────────────────────────────────
//
//    A band is `unchecked` unless the check DEMONSTRABLY RAN. An unchecked
//    band's value and note name OUR limitation. They may never assert anything
//    about the dealer's document, the dealer's page, the dealer's conduct, or
//    the car — because from where the buyer sits, none of those is
//    distinguishable from our own lookup having failed.
//
// The difference between "we looked and there is none" and "we could not look"
// is carried by a POSITIVE signal every time, never inferred from a value being
// missing:
//    recalls.checked      the registry answered
//    feesRead             a real priced page was read (a bot wall clears 500
//                         chars; a four-figure dollar amount does not)
//    financingCheck.checked, odometerCheck.checked, dealerSentiment.checked
//    vehicleCondition     read off the page, so "N/A (NEW)" is backed
//    evapRebate.ineligibleReason   a computed reason, not an absence
//
// Absence of the signal is absence of the check. Never the other way round.
//
// Offline and pure: no network, no clock, no model. Imported by src/App.jsx
// (Vite) and by the Deno edge functions alike.

import { REPORT_POINTS } from "./report-points.js";
import { fmtMoney, warrantyLine } from "./report-lines.js";
import { dealerReputationPoint, pageAbsenceCopy } from "./point-state.ts";

// FOUR STATES, because green is a claim.
//
// Vic, 2026-09-13: "putting pass in green on report without any data or factual
// evindence is not acceptble."
//
// He is right, and it was live in six bands of this very module. GREEN is the
// strongest mark on the page -- a buyer skimming the rail reads it as "LotCheck
// checked this and it is good" -- and three different things were wearing it:
//
//   a real verification   VIN decodes, AMVIC reads licensed        <- earned
//   a NOT-APPLICABLE      "N/A (GAS)", "N/A (NEW)", "NOT ELIGIBLE" <- not earned
//   an ABSENCE            "NONE LISTED", "NONE FOUND"              <- not earned
//
// and one band was green for arithmetic WE did precisely because the dealer
// published nothing to check against ("$312/MO REF") -- the opposite of a
// verified figure.
//
// An absence is not evidence and a not-applicable is not a pass. Both are true,
// both are worth printing, and neither is a green check. They are NOTED: a
// solid neutral rail, no accent, no tick.
//
// THE RULE IS STRUCTURAL, NOT A CONVENTION. A CLEAR band must name the source it
// was verified against, and reportBands() THROWS if one does not -- so green
// cannot be constructed without its evidence attached.
// [[make-it-dispute-proof]] [[claims-must-stay-backed]]
export const RAISE = "raise", CLEAR = "clear", NOTED = "noted", UNCHECKED = "unchecked";

/** The word printed beside every band, so the verdict survives greyscale. */
export const STATE_WORD = {
  [RAISE]: "Raise it",
  [CLEAR]: "Verified",
  [NOTED]: "Noted",
  [UNCHECKED]: "Not checked",
};

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const title = (key) => (REPORT_POINTS.find((p) => p.key === key) || {}).title || key;

/** A band that names our own gap. The only way to produce an unchecked band. */
const gap = (key, n, value, note) => ({ n, key, title: title(key), state: UNCHECKED, value, note });
const band = (key, n, state, value, note, extra) =>
  Object.assign({ n, key, title: title(key), state, value, note }, extra || null);

/* ── 01 price ─────────────────────────────────────────────────────────────
 * The hero band. It is the only one that carries a scale, because the money is
 * why the report was bought.
 *
 * The over/under CLAIM needs an exact-basis MSRP. A "starting at" figure or a
 * dealer's own stated sticker is a real number we hold and NOT a baseline we
 * may measure against — comparing to it manufactures a discount out of the
 * dealer's own marketing. So a non-exact basis is `unchecked` with the figure
 * we hold stated in the note, never a silent comparison.
 * [[msrp-exact-must-pin-config]] [[no-llm-generated-valuation-numbers]]
 */
function priceBand(a) {
  const qp = num(a?.quotedPrice), ms = num(a?.msrp);
  const pv = a?.priceVerified !== undefined ? !!a.priceVerified : qp > 0;
  const exact = ms > 0 && a?.msrpBasis === "exact";
  const comps = num(a?.marketValue?.median ?? a?.comps?.average);
  const scale = ms > 0 && qp > 0 ? { msrp: ms, asking: qp, comps: comps > 0 ? comps : null } : null;

  if (!qp && a?.priceDisclosure === "contact_for_price") {
    return band("price_vs_msrp", "01", RAISE, "HIDDEN BY DEALER",
      "This listing does not publish a price — the page says to contact the dealer. You cannot compare what you cannot see; ask for the all-in price in writing before you go in.",
      { hero: true });
  }
  if (exact && qp > 0) {
    const d = qp - ms;
    if (d > 0) return band("price_vs_msrp", "01", RAISE, `+${fmtMoney(d)} OVER`,
      `${fmtMoney(qp)} asking against the ${fmtMoney(ms)} this configuration carries from the manufacturer.`,
      { hero: true, scale });
    if (d < 0) return band("price_vs_msrp", "01", CLEAR, `${fmtMoney(-d)} UNDER`,
      `${fmtMoney(qp)} asking, below the ${fmtMoney(ms)} manufacturer figure for this configuration.`,
      { hero: true, scale, source: "the manufacturer's published price for this exact configuration" });
    return band("price_vs_msrp", "01", CLEAR, "AT MSRP",
      `${fmtMoney(qp)} asking, level with the manufacturer's figure for this configuration.`,
      { hero: true, scale, source: "the manufacturer's published price for this exact configuration" });
  }
  if (ms > 0 && qp > 0) {
    // We hold a figure but not one we may measure against.
    return gap("price_vs_msrp", "01", "NO EXACT MSRP MATCH",
      `We could not pin this listing to an exact manufacturer configuration, so we are not making an over-or-under claim. The nearest figure we hold is ${fmtMoney(ms)}, and this listing asks ${fmtMoney(qp)} — the two may not describe the same trim or drivetrain. Ask the dealer which configuration this is.`);
  }
  if (qp > 0 && pv) {
    return gap("price_vs_msrp", "01", "MSRP NOT MATCHED",
      `This listing asks ${fmtMoney(qp)}. We hold no manufacturer figure for this year, make and model, so we have not compared it to one. That is a gap in our catalogue, not a finding about the price.`);
  }
  return gap("price_vs_msrp", "01", "PRICE READ ONCE",
    "We read a price only once on this page and could not confirm it a second way, so we have not compared it to anything. Ask the dealer for the all-in price in writing.");
}

/* ── 02 recalls ── the one point that already had three states. */
function recallsBand(a) {
  const r = a?.recalls;
  if (!r?.checked) return gap("recalls", "02", "COULDN'T REACH REGISTRY",
    "We could not reach Transport Canada's recall database for this vehicle. This is not a clean bill — check it yourself at recalls-rappels.canada.ca before you take delivery.");
  if (num(r.count) > 0) {
    const f = (r.items || [])[0];
    return band("recalls", "02", RAISE, `${num(r.count)} OPEN`,
      `${num(r.count) === 1 ? "One recall is" : `${num(r.count)} recalls are`} on record for this vehicle with Transport Canada${f?.system ? ` — ${f.system}` : ""}. Recall work is free; get it completed before delivery, in writing.`);
  }
  if (r.confirmed === false) return gap("recalls", "02", "MODEL NOT CONFIRMED",
    "Transport Canada's database returned no match we could confirm for this exact year, make and model, so we cannot say whether recalls are open. Search it yourself at recalls-rappels.canada.ca.");
  return band("recalls", "02", CLEAR, "NONE OPEN",
    "Transport Canada records no open recall for this year, make and model at the time of this scan.",
    { source: "Transport Canada's recall database, which answered for this vehicle" });
}

/* ── 03 add-ons & fees ── "we looked" is not "we could not look". */
function feesBand(a) {
  const list = Array.isArray(a?.addOns) ? a.addOns : [];
  const flagged = list.filter((x) => x?.verdict === "flagged");
  const dli = a?.dealerLineItems;
  const dliTotal = dli && Array.isArray(dli.fees) ? dli.fees.reduce((t, f) => t + num(f?.amount), 0) : 0;

  if (flagged.length) {
    const total = num(a?.totalFlaggedCost) || flagged.reduce((s, x) => s + num(x.price), 0);
    return band("fees", "03", RAISE, `${flagged.length} flagged · ${fmtMoney(total)}`,
      `${flagged.length === 1 ? "One line item" : `${flagged.length} line items`} on this quote ${flagged.length === 1 ? "is" : "are"} worth questioning at the table.`);
  }
  if (list.length) return band("fees", "03", CLEAR, "TRANSPARENT",
    "The extras on this listing are itemised and nothing in them was flagged.",
    { source: "the dealer's own itemised list of extras, audited line by line" });
  if (dliTotal > 0) return band("fees", "03", CLEAR, "ITEMIZED",
    `The dealer publishes their own breakdown, totalling ${fmtMoney(dliTotal)}. Check it against the final bill of sale.`,
    { source: "the dealer's own published fee breakdown" });
  if (a?.feesRead === true) {
    // We read a priced page and saw no itemised extras. That is an ABSENCE, and
    // an absence is not a verification -- a fee box we failed to parse looks
    // exactly like a page that has no fees. Noted, never green.
    const c = pageAbsenceCopy("addons", true);
    return band("fees", "03", NOTED, c.value, c.explain);
  }
  const c = pageAbsenceCopy("addons", false);
  return gap("fees", "03", c.value, c.explain);
}

/* ── 04 AMVIC ──────────────────────────────────────────────────────────────
 * The 2026-09-12 defect, at its source. dealerLicenceLine() has no unchecked
 * state: `!L || !L.status` renders "NOT ON QUOTE" for a Postgres error, an
 * unbuilt query, a swallowed throw, a matcher refusal, AND for every uploaded
 * quote, where the check is not implemented at all. That string asserts what
 * the dealer put on their own document — an accusation of non-disclosure
 * against a named, licensed business, manufactured by our lookup failing.
 * A URL scan does not even have a quote. [[no-accusation-language]]
 */
function amvicBand(a) {
  const L = a?.dealerLicence;
  if (!L || !L.status) return gap("dealer_licence", "04", "NOT CHECKED",
    "We did not confirm this dealer against AMVIC's public registry. That says nothing about the dealer — look them up yourself at amvic.org, and ask for their licence number in writing before any deposit.");
  if (L.state === "valid") return band("dealer_licence", "04", CLEAR, "LICENSED",
    `AMVIC is Alberta's regulator and every business selling vehicles here must hold a licence. We matched this dealer to AMVIC's public registry and it currently reads licensed${L.registration_number ? ` (${L.registration_number})` : ""}.`,
    { source: "AMVIC's public licensee registry" });
  return band("dealer_licence", "04", RAISE, String(L.status).toUpperCase(),
    `AMVIC's public registry currently lists this business as "${L.status}". That does not always mean they cannot sell you a car — records lag and businesses reapply — but it is the regulator's own wording. Ask for their current licence number in writing, then check it yourself at amvic.org.`);
}

/* ── 05 financing math ── "no terms quoted" is a claim about their paperwork. */
function financeBand(a) {
  const fc = a?.financingCheck;
  if (fc?.checked) {
    return fc.consistent
      ? band("finance_math", "05", CLEAR, "RECONCILES",
          fc.note || "The advertised payments cross-check cleanly against the total obligation shown.",
          { source: "the listing's own payment, rate, term and total" })
      : band("finance_math", "05", RAISE, "DOESN'T ADD UP",
          fc.note || "The advertised payment, rate and term do not reconcile against the total shown. Ask for the full amount financed and the total of payments, in writing.");
  }
  const rf = a?.referenceFinancing?.atAsking;
  // Arithmetic WE did because the dealer published nothing to check. Green here
  // would say their figures reconciled. There were no figures.
  if (rf) return band("finance_math", "05", NOTED, `${fmtMoney(Math.round(num(rf.monthly)))}/MO REF`,
    rf.note || "No dealer terms were published, so this is the payment computed from the manufacturer's own advertised rate at this asking price — a reference to hold them to, not their quote.");
  return gap("finance_math", "05", "NOT CHECKED",
    "We could not re-check the financing arithmetic on this listing. Ask for the rate, the term, the amount financed and the total of payments in writing, and check that they multiply out.");
}

/* ── 06 odometer ───────────────────────────────────────────────────────────
 * computeOdometerCheck returns early when the MODEL YEAR is missing, even with
 * a real reading parsed — so the emailed PDF printed "NOT LISTED", a flat false
 * statement about the dealer's page, because WE could not establish the year.
 */
/*
 * THE EXPLAINER LIVES HERE, because it is the sentence that stops a flag from
 * reading as an accusation.
 *
 * 2026-08-27, on a real report for a 2025 Mazda CX-90 reading 12 km: the
 * server's own km-aware note printed directly above a hand-written explainer
 * that branched on vehicleCondition alone and told the buyer a new car showing
 * kilometres had been driven. Both sentences were ours, on one card, and they
 * contradicted each other. The fix was to band the reading once, where it is
 * judged, and have every surface branch on the BAND instead of re-deriving the
 * story for itself.
 *
 * 2026-09-14: the render swap moved the on-screen ten onto this file, and the
 * on-screen explainer left with the JSX that used to hold it — leaving this
 * band with nothing but the server's one-line note. What that dropped was the
 * beyond-delivery sentence saying a demonstrator is a normal part of the
 * business and not a fault. The screen would have flagged a new-listed car at
 * 3,200 km red, with no sentence saying it is not wrongdoing.
 *
 * Note how it hid: every "this surface must NOT say X" assertion still passed,
 * because deleting a surface passes every negative check ever written about
 * it. Only the positive ones failed. [[no-accusation-language]]
 */
export function odometerExplain(bandName, km) {
  const kmTxt = `${num(km).toLocaleString("en-CA")} km`;
  switch (bandName) {
    case "new_delivery":
      return `New vehicles do not arrive on zero. Coming off the transport truck, moving around the lot and the pre-delivery inspection all put kilometres on the clock. ${kmTxt} is delivery distance, not use. Read the dash yourself when you see the car and confirm it still matches.`;
    case "new_beyond_delivery":
      return `A new vehicle normally shows only delivery distance. This one reads ${kmTxt}, which is further than a car gets being delivered — most often that means it was a demonstrator or a service loaner. That is a normal part of the business, not a fault. What matters to you is that the factory warranty clock starts when a vehicle goes into service, not when you buy it: ask for the in-service date in writing, and ask how the price reflects it.`;
    case "used_nearly_new":
      return `On a car this new, low kilometres usually mean a demonstrator, a loaner or a short lease return rather than anything unusual. Ask for the in-service date — the factory warranty started then, not on the day you buy.`;
    default:
      // "used" is deliberately absent. computeOdometerCheck writes a note
      // carrying this car's OWN age and typical-km figures, which is a better
      // sentence than any fixed one this switch could return.
      return null;
  }
}

function odometerBand(a) {
  const o = a?.odometerCheck;
  if (o?.checked) {
    const km = `${num(o.km).toLocaleString("en-CA")} km`;
    // Band first, server note second. The fallback matters: an analysis cached
    // before bands existed carries a note and no band, and must still explain
    // itself rather than print a generic line beside a specific number.
    const explain = odometerExplain(o.band, o.km) || o.note;
    return o.flag
      ? band("odometer", "06", RAISE, `${km} · CHECK`, explain ||
          "This reading is worth questioning against the age of the car. Read it off the dash yourself before signing — never off the paperwork alone.")
      : band("odometer", "06", CLEAR, km, explain ||
          "Read from the listing. Compare it against the dash before you sign — never off the paperwork alone.",
          { source: "the odometer reading the listing itself publishes" });
  }
  if (String(a?.vehicleCondition || "").toLowerCase() === "new") {
    return band("odometer", "06", NOTED, "N/A (NEW)",
      "The listing states this is a new vehicle. New cars still arrive with delivery kilometres on them; read the dash before you sign.");
  }
  return gap("odometer", "06", "NOT READ",
    "We did not establish an odometer reading for this vehicle. Read it off the dash yourself before signing — never off the paperwork alone.");
}

/* ── 07 VIN ────────────────────────────────────────────────────────────────
 * pageAbsenceCopy() was written for exactly this and has been imported by
 * nothing but its own test since it was added. This is its first caller.
 * A page we could read that publishes no VIN IS a finding worth raising: with
 * no VIN a buyer cannot check recalls or history on this exact car. A page we
 * could NOT read is our gap, and says nothing about the listing.
 */
function vinBand(a) {
  const vc = a?.vinCheck;
  if (vc?.present) {
    return vc.valid
      ? band("vin", "07", CLEAR, "VALID",
          `The VIN decodes cleanly and matches the advertised year, make and model${vc.vin ? ` (${vc.vin})` : ""}.`,
          { source: "the VIN's own check digit, decoded against the advertised year, make and model" })
      : band("vin", "07", RAISE, "CHECK PATTERN",
          "The VIN on this listing does not decode cleanly against the advertised year, make and model. Ask the dealer to confirm it against the dash plate and the registration.");
  }
  const readable = a?.feesRead === true;
  const c = pageAbsenceCopy("vin", readable);
  return readable
    ? band("vin", "07", RAISE, c.value, c.explain)
    : gap("vin", "07", c.value, c.explain);
}

/* ── 08 EV / PHEV rebate ───────────────────────────────────────────────────
 * The final `else` used to read "N/A (GAS)" — a fabricated vehicle attribute
 * whenever the drivetrain never extracted, and one that can cost a buyer the
 * federal rebate outright. A drivetrain we did not read is not a gas car.
 */
function rebateBand(a) {
  const ev = a?.evapRebate;
  if (ev?.eligible) return band("rebate", "08", CLEAR, `${fmtMoney(num(ev.total))} ELIGIBLE`,
    `${fmtMoney(num(ev.federal))} federal${num(ev.provincial) > 0 ? ` plus ${fmtMoney(num(ev.provincial))} provincial` : ""}. Confirm the dealer applies it to your price rather than keeping it.`,
    { source: "the federal rebate programme's published eligibility terms" });
  if (ev?.ineligibleReason) return band("rebate", "08", NOTED, "NOT ELIGIBLE", String(ev.ineligibleReason));
  const fuel = String(a?.fuelType || "").toUpperCase();
  if (fuel === "BEV" || fuel === "PHEV") return gap("rebate", "08", "CHECK ELIGIBILITY",
    "This is an electric or plug-in vehicle, but we could not establish whether it qualifies for the federal rebate. Check the current programme terms yourself before you count on it.");
  if (fuel) return band("rebate", "08", NOTED, `N/A (${fuel})`,
    `The listing states this is a ${fuel.toLowerCase()} vehicle. The federal rebate applies to electric and plug-in vehicles only.`);
  return gap("rebate", "08", "DRIVETRAIN NOT READ",
    "We could not establish this vehicle's drivetrain from the listing, so we have not checked rebate eligibility. If it is electric or plug-in there may be money on the table — ask the dealer, and check the federal programme terms.");
}

/* ── 09 warranty ── warrantyLine already refuses on a hedged catalogue row. */
function warrantyBand(a) {
  const w = warrantyLine(a);
  if (!w || w.value === "SEE FACTORY TERMS" || w.value === "CANNOT STATE") {
    return gap("warranty", "09", "NOT CONFIRMED", (w && w.line) ||
      "We could not confirm the factory warranty terms for this vehicle. Ask exactly what is covered, for how long, and from what date — in writing — before considering any paid coverage.");
  }
  // "LIKELY EXPIRED" comes back tone:"muted" because it accuses nobody -- but it
  // is a backed finding the buyer must act on, and the moment they act on it is
  // when the finance office pitches cover that overlaps nothing. Muted would
  // bury it. Nothing here is a claim against the dealer; it is a fact about the
  // car, which is exactly what a raise band is for. [[no-accusation-language]]
  const act = w.tone === "flag" || w.value === "LIKELY EXPIRED" || w.value === "CORROSION ONLY";
  return band("warranty", "09", act ? RAISE : CLEAR, w.value, w.line,
    { source: "the manufacturer's own published warranty terms for this make" });
}

/* ── 10 dealer reputation ── the point that named the class. */
function reputationBand(a) {
  const r = dealerReputationPoint(a?.dealerSentiment);
  if (r.state === "unchecked") return gap("reputation", "10", r.value, r.explain);
  // "NONE FOUND" is the ABSENT state: we searched and there were no reviews.
  // True, backed, and not a pass -- a dealer with no track record has not
  // passed anything. Only a real rating earns green.
  if (r.state === "absent") return band("reputation", "10", NOTED, r.value, r.explain);
  return band("reputation", "10", r.tone === "flag" ? RAISE : CLEAR, r.value, r.explain,
    { source: "the dealer's public Google rating, read at the time of this scan" });
}

/**
 * The ten bands, in fixed canonical order. Never re-sorted by severity: two
 * reports on two cars have to stay comparable line for line, and the rail
 * colour already does the visual sorting.
 */
export function reportBands(a) {
  const out = [priceBand(a), recallsBand(a), feesBand(a), amvicBand(a), financeBand(a),
    odometerBand(a), vinBand(a), rebateBand(a), warrantyBand(a), reputationBand(a)];
  // The canonical ten is a contract, not a convention. If this ever returns a
  // different count or order, the surfaces silently render a different report.
  if (out.length !== REPORT_POINTS.length) {
    throw new Error(`report-bands: built ${out.length} bands, canonical ten is ${REPORT_POINTS.length}`);
  }
  // GREEN IS A CLAIM AND MUST CARRY ITS EVIDENCE. Not a lint and not a
  // convention: a CLEAR band with no named source cannot leave this function.
  // Each of the six bands that were green for an absence or a not-applicable
  // was one line of code away from looking exactly like a verification, and no
  // reader of the report could have told them apart. [[make-it-dispute-proof]]
  for (const b of out) {
    if (b.state === CLEAR && !b.source) {
      throw new Error(`report-bands: band ${b.n} ${b.title} is CLEAR with no source. Green must name what it was verified against, or it is not green.`);
    }
  }
  return out;
}

/**
 * The counter above the column. STATES, never a total.
 *
 * "10 / 10 backed" was true by construction — ten unconditional pushes into an
 * array, then the array's own length printed as the count — so it read ten over
 * a report where five checks never ran. A number that cannot be anything but
 * ten is not a measurement. [[claims-must-stay-backed]]
 */
export function bandTally(bands) {
  const t = { raise: 0, clear: 0, noted: 0, unchecked: 0 };
  for (const b of bands || []) if (t[b?.state] !== undefined) t[b.state]++;
  return t;
}
