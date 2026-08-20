// ============================================================================
// S3 — Deal reconciliation ("advertised → real"). Splits a quote's line items
// into three buckets and totals each, so the report can show the real
// out-the-door build-up and, crucially, how much is NEGOTIABLE dealer markup:
//   - fee      = unavoidable pass-through (doc, registration, freight/PDI, tax)
//   - addon    = dealer markup, negotiable/REMOVABLE (protection pkgs, etch,
//                nitrogen, pulse light, tint, Zbart) — even when framed as
//                "mandatory" / a "dealer addendum"
//   - discount = a price reduction (usually already in the selling price)
//
// Classification uses keyword rules first (catches addendums the dealer labels
// "required"), then falls back to the LLM's own add-on verdict. Pure + defensive
// — a missing field never throws. See dealer-tactics-safeguards.md (S3/S4/S5).
// ============================================================================

const num = (x: unknown): number | null => { const v = Number(x); return Number.isFinite(v) ? v : null; };
const norm = (s: unknown): string => (typeof s === "string" ? s : "").toLowerCase();

// A dealer APR may only power a claim -- a counter-script line, a savings
// estimate -- when the page/feed itself carries it (sm360_feed, convertus_vms,
// page_text: all evidence-checked, see _shared/apr-extract.js). "llm" (or no
// source at all, the pre-2026-08-19 shape) means only the model's own read of
// the page, unconfirmed -- and the model can be wrong even when told not to
// guess. Confirmed live: a report told a buyer to say "I'd want that, not
// 25%" to a dealer whose page discloses no APR anywhere (easytermauto.ca).
// Mirrors isManufacturerFigure's role for MSRP -- one gate, not one per call
// site. Duplicated in App.jsx (client can't import a Deno module); keep both
// in sync.
export const TRUSTED_APR_SOURCES = new Set(["sm360_feed", "convertus_vms", "page_text"]);
const trustedDealerApr = (analysis: any): number | null => {
  const d = analysis?.financeRates?.dealer;
  return d?.apr != null && TRUSTED_APR_SOURCES.has(d.source) ? num(d.apr) : null;
};

// Guards the deterministic backstops in analyze-listing-url (page-text regex,
// Convertus VMS gap-fill): they should run whenever there is NOT already a
// TRUSTED rate, so they can upgrade or correct an unproven guess. The bug this
// closes: both backstops used to skip whenever analysis.financing.rate was
// simply already a positive number, regardless of source -- so an untrusted
// LLM guess landing first (same field, same shape) permanently blocked the
// deterministic extractor from ever running, even on pages that plainly state
// the rate in their own visible text. Confirmed live 2026-08-20
// (legacyautogroup.ca 2026 Explorer): "5.49% financing for 84 months ... @
// 5.49% APR O.A.C." sits in the page's own description text --
// extractAdvertisedApr finds it correctly given that text -- but the guard
// never let it run, because the LLM had already set financing.rate first.
export function hasTrustedFinanceRate(financing: any): boolean {
  return Number(financing?.rate) > 0 && TRUSTED_APR_SOURCES.has(financing?.source);
}

// Unavoidable government / logistics pass-throughs.
const FEE_RE = /\b(doc(ument(ation)?)?|registration|licen[sc]e|title|freight|pdi|destination|delivery|a\/?c (levy|tax)|air ?conditioning|tire (levy|tax|fee|recycl)|environment|omvic|amvic|govern|filing|excise|luxury tax|green levy|gst|pst|hst|qst|sales tax)\b/;
// Dealer-markup add-ons: negotiable / removable, however they're framed.
const ADDON_RE = /\b(protection|paint|fabric|leather|etch|nitrogen|pulse|tint|z[ie]bart|gold shield|wheel lock|appearance|under(coat|body|carriage)|rust ?proof|\bgap\b|theft|lojack|3m|ceramic|clear ?coat|addendum|accessor|admin|dealer prep|prep (fee|charge)|recon(dition(ing)?)?|vin (etch|engrav)|key (replace|protect)|road hazard|maintenance package|fabric|scotchgard)\b/;
const DISCOUNT_RE = /\b(discount|rebate|savings|incentive|loyalty|conquest)\b/;

// Whether an MSRP may back a claim is decided in ONE place. This file used to
// answer it twice, differently, and both answers were wrong.
import { qualifyMsrpClaim, isManufacturerFigure } from "./msrp-claim.ts";

export type LineClass = "fee" | "addon" | "discount";

export function classifyLine(name: unknown, price: unknown, verdict?: unknown): LineClass {
  const p = num(price);
  const n = norm(name);
  if ((p != null && p < 0) || (DISCOUNT_RE.test(n) && (p == null || p <= 0))) return "discount";
  if (ADDON_RE.test(n)) return "addon";
  if (FEE_RE.test(n)) return "fee";
  if (verdict === "flagged") return "addon";
  if (verdict === "standard" || verdict === "good") return "fee";
  return "addon"; // unknown line item on a quote -> worth questioning
}

export interface Reconciliation {
  sellingPrice: number | null;
  fees: { name: string | null; price: number | null }[];
  addons: { name: string | null; price: number | null }[];
  discounts: { name: string | null; price: number | null }[];
  feesTotal: number;
  addonsTotal: number;      // = removableTotal, the negotiable dealer markup
  discountsTotal: number;
  addedOnTop: number;       // fees + add-ons stacked on the selling price
  realPreTax: number | null;
}

// ── Counter-script: aggregate every safeguard's "say this" into one ordered
// script the buyer reads off during the call — money first. Green-when-clean:
// if nothing's flagged, it's just "confirm the out-the-door in writing." Pure;
// reads the safeguard outputs already on `analysis`. See Deal Decoder scope.
export interface CounterScript { moves: { topic: string; say: string }[]; clean: boolean; }

export function buildCounterScript(analysis: any): CounterScript {
  const money = (n: unknown) => `$${Math.round(Number(n) || 0).toLocaleString()}`;
  const moves: { topic: string; say: string }[] = [];

  const rec = analysis?.reconciliation;
  if (rec && rec.addonsTotal > 0) {
    const names = (rec.addons || []).map((a: any) => a.name).filter(Boolean).slice(0, 3);
    moves.push({ topic: "Add-ons", say: `Please take off the ${money(rec.addonsTotal)} in dealer add-ons${names.length ? ` (${names.join(", ")})` : ""} — I don't want them.` });
  }
  const qp = num(analysis?.quotedPrice), msrp = num(analysis?.msrp);
  // msrp > 0 (not just != null): a missing MSRP reads as 0, and "$X over MSRP ($0)"
  // is nonsense — skip the price move entirely when we don't have a real MSRP.
  // Also require an EXACT trim basis: a "starting_at" floor (base trim / adjacent
  // model year) is NOT this unit's MSRP — an option-loaded car above the base
  // floor is not "over MSRP", and saying so at the table would be wrong.
  // Only a VERIFIED exact-trim MSRP earns a price move. A base-model floor
  // ("starting_at") or the dealer's own stated sticker ("dealer_stated") is not
  // a manufacturer figure, and quoting one at the desk would be indefensible.
  if (qp != null && msrp != null && msrp > 0 && qp > msrp + 100 && analysis?.msrpBasis === "exact") {
    // S14 — one dealer's price isn't "the market"; the market is real deals across dealers.
    moves.push({ topic: "Price", say: `This is about ${money(qp - msrp)} over MSRP (${money(msrp)}). "Market value" is set by real deals across many dealers, not one store's number — I'd need this at MSRP to move forward.` });
  }
  // Basis note: an all-in advertised price includes freight & PDI; a published
  // MSRP normally does not. Part of any "over MSRP" gap is therefore freight,
  // and the buyer should see it itemized rather than argue about a number that
  // isn't comparing like with like.
  if (analysis?.msrpBasis === "exact" && analysis?.allInPricing?.body && analysis?.msrpPriceBasis !== "incl_freight" && qp != null && msrp != null && msrp > 0 && qp > msrp + 100) {
    moves.push({ topic: "Freight & PDI", say: `Your advertised price is all-in and ${analysis?.make || "the manufacturer"}'s MSRP normally excludes freight and PDI — so show me freight and PDI as their own line, and what's left after that.` });
  }

  // S26 — inflated-MSRP tactic. The dealer's advertised MSRP is padded above the
  // manufacturer's real MSRP so the "saving" looks bigger. Name it with the real
  // number so the discount is measured against the true sticker (dispute-proof).
  const infl = analysis?.msrpInflation;
  if (infl && infl.dealerStated && infl.manufacturer) {
    moves.push({ topic: "Inflated MSRP", say: `You list MSRP at ${money(infl.dealerStated)}, but ${analysis?.make || "the manufacturer"}'s MSRP for this trim is ${money(infl.manufacturer)} — the sticker is ${money(infl.overBy)} high, so the advertised saving is against an inflated number. What's the real discount off the true ${money(infl.manufacturer)} MSRP?` });
  }
  if (analysis?.financingTrap) {
    moves.push({ topic: "Financing", say: `Is this price "in lieu of special financing"? I want the discount AND the promo APR — not one or the other.` });
  }
  // S37 — the advertised price is conditional on financing with the dealer. The
  // cash buyer and the buyer with their own bank approval are the ones who lose
  // it, and they are exactly the buyers who think they're in the strongest
  // position. Ask before the desk gets to reprice at signing.
  if (analysis?.financeContingent) {
    moves.push({ topic: "Finance-contingent price", say: `Your own listing says this price depends on financing through you. Confirm in writing: what is the price if I pay cash or use my own bank — and if it changes, by exactly how much?` });
  }
  // S35 — disclaimer escape hatch. The page's own fine print hedges the
  // advertised price; in an all-in province the regulator has ruled such
  // disclaimers are not a defence. The buyer quotes the dealer's own words.
  const dchk = analysis?.disclaimerCheck;
  if (dchk && (dchk.escapeHatch || dchk.contradiction)) {
    moves.push({ topic: "Fine print", say: dchk.contradiction
      ? `Your website's fine print says prices include all fees AND that they may not — both can't be true. Which applies to this car? Put the answer, and the all-in price, in writing.`
      : `Your website's fine print says the advertised price "may change" or "can't be guaranteed" — so confirm it: send me this car's exact all-in price in writing today${analysis?.allInPricing?.body ? `, as ${analysis.allInPricing.body}'s all-in rule requires` : ""}.` });
  }
  // S28 — price-gating ("Contact Us For Price"). The dealer deliberately
  // withholds the number to force a lead capture where their salespeople run
  // the conversation. Detection comes from the page's own call-to-action text
  // (priceDisclosure = "contact_for_price"), so the claim is literally true.
  // The buyer's move: refuse to negotiate blind — demand the all-in number in
  // writing first, anchored to the manufacturer's MSRP when we have it.
  if (analysis?.priceDisclosure === "contact_for_price" && !(num(analysis?.quotedPrice) > 0)) {
    // Only a MANUFACTURER figure may be attributed to the manufacturer by name.
    // Anchoring on a `dealer_stated` MSRP would hand the buyer this dealer's own
    // number, relabelled as Ford's, to argue against this dealer with — inside
    // the report naming their price-gating tactic.
    const anchor = isManufacturerFigure(analysis?.msrpBasis) ? num(analysis?.msrp) : null;
    moves.push({ topic: "Hidden price", say: `Your listing doesn't show a price — it says to contact you. I don't negotiate blind: please send your full all-in price in writing before I come in.${anchor ? ` For reference, ${analysis?.make || "the manufacturer"}'s MSRP for this model starts at ${money(anchor)} — I'll be comparing your number against that.` : ""}` });
  }
  // S27 — days on lot (motivated-seller). Only from real dealer-platform /
  // observed data, never estimated; ≥30 days is when carrying cost starts to
  // bite and the line lands. The buyer is quoting the dealer's own inventory
  // clock — dispute-proof.
  const dol = num(analysis?.daysOnLot?.days);
  if (dol != null && dol >= 30) {
    const stretch = dol >= 90 ? `over ${Math.floor(dol / 30)} months` : `${dol} days`;
    moves.push({ topic: "Days on lot", say: `This unit has been on your lot ${stretch}${analysis?.daysOnLot?.since ? ` (listed ${analysis.daysOnLot.since})` : ""} — every week it sits costs you money. What can you do on price today to move it?` });
  }
  // S36 -- trade-in instant-offer widget (capture + claw-back). The listing
  // embeds a "value your trade" appraisal tool anchored to wholesale data; the
  // number is non-binding lead capture, and the trade line is where a visible
  // discount gets clawed back. Fires only when the widget was actually detected.
  const tiw = analysis?.tradeInWidget;
  if (tiw && tiw.detected) {
    moves.push({ topic: "Trade-in", say: `If I trade in: we settle this vehicle's price first, then I want your trade offer in writing on its own line — not one blended payment. ${tiw.vendor ? `Your ${tiw.vendor} tool quotes` : "Those instant-offer tools quote"} the wholesale side of the market, so I'll be comparing against retail listings for my car.` });
  }
  // #11 -- AMVIC licence status. Only fires on a confident registry match and
  // quotes the regulator's own wording; a valid licence produces no move (it is
  // reassurance, not leverage). Never an accusation -- the buyer asks.
  const lic = analysis?.dealerLicence;
  if (lic && lic.status && (lic.state === "expired" || lic.state === "closed" || lic.state === "action")) {
    moves.push({ topic: "Dealer licence", say: `AMVIC's public registry currently shows this business${lic.legalName ? ` (${lic.legalName})` : ""} as "${lic.status}"${lic.expiryDate ? `, expiry ${lic.expiryDate}` : ""}. Before any deposit, please confirm your current AMVIC licence number and status in writing.` });
  }
  const df = analysis?.docFeeCheck;
  if (df) {
    if (df.kind === "allin") moves.push({ topic: "Doc fee", say: `${df.jurisdiction} requires all-in advertised pricing — why is the ${money(df.docFee)} doc fee separate? It should already be in the advertised price.` });
    else if (df.kind === "over_cap") moves.push({ topic: "Doc fee", say: `Your ${money(df.docFee)} doc fee is above ${df.jurisdiction}'s ~${money(df.benchmark)} cap — please bring it down.` });
    else if (df.kind === "over_norm") moves.push({ topic: "Doc fee", say: `A ${money(df.docFee)} doc fee is on the high side — can you reduce it?` });
  }
  // S24 — all-in advertised price. Non-tax fees stacked on the price mean the
  // advertised number wasn't all-in. Name the authority so it's dispute-proof
  // (the AMVIC/OMVIC-specific doc-fee move above already covers the CA all-in case).
  //
  // NAME ONE REGULATOR — THE BUYER'S. This line used to read "(the FTC CARS Rule
  // in the US; AMVIC/OMVIC in Canada)", which hands a Calgary buyer a US statute
  // and an Ontario regulator to read aloud in an Alberta showroom. A salesperson
  // only has to say "that's American" and the whole line is discredited — and
  // the line is otherwise correct, which makes the damage worse. A script is
  // read out loud; every word in it has to survive being read out loud.
  //
  // The authority comes from the same jurisdiction resolution the price basis
  // uses, so it is never hardcoded per locale ([[locale-abstraction-rule]]).
  if (rec && rec.addedOnTop > 100 && !(df && df.kind === "allin")) {
    const body = String((analysis as any)?.allInPricing?.body || "").trim();
    const authority = body
      ? `under ${body}'s all-in advertising rules`
      : `under all-in advertising rules`;   // jurisdiction unknown -> claim no regulator
    moves.push({ topic: "All-in price", say: `The advertised price should already include every non-tax fee — ${authority}, only tax is added after. Quote me the true all-in out-the-door up front.` });
  }
  // S25 — all-in safeguard (Canada). In an all-in-advertising province the posted
  // price ALREADY includes every mandatory fee, so the only things that can legally
  // appear at signing are GST, licensing, and insurance. State it plainly — it's the
  // buyer's dispute-proof anchor even when the listing is clean (no fee to flag).
  // Suppressed when the doc-fee move already challenged a separate fee (avoids a
  // duplicate all-in line). See dealer-tactics-safeguards.md.
  const ai = analysis?.allInPricing;
  if (ai && ai.body && !(df && df.kind === "allin") && !moves.some((m) => m.topic === "All-in price")) {
    moves.push({ topic: `All-in (${ai.body})`, say: `${ai.body} all-in advertising means the posted price is the full price — the only things that can be added at signing are GST, licensing, and insurance. Ask them to confirm in writing there are no other mandatory fees.` });
  }
  // S16 — finance office pre-empt. GAP / protection products get re-pitched in
  // the box after price is agreed; they're optional. (Rate markup + extended
  // warranty have their own moves below.)
  const backOffice = (rec?.addons || []).map((a: any) => norm(a?.name))
    .some((n: string) => /\bgap\b|theft|etch|lojack|key (replace|protect)|road hazard|tire.*(wheel|rim)|protection|appearance|ceramic|paint/.test(n));
  if (backOffice) {
    moves.push({ topic: "Finance office", say: `In the finance office they'll re-pitch GAP and protection products after we agree on price — they're all optional. Present my out-the-door with none of them added.` });
  }
  if (analysis?.warranty?.offered) {
    const sw = analysis?.standardWarranty?.coverage;
    // "The factory coverage is plenty for now" is only true advice when the
    // factory coverage is actually still active on THIS car. On a high-
    // mileage/older used vehicle it usually isn't -- caught live on a 2022
    // RAV4 at 106,000 km (Toyota's basic coverage ends at 60,000 km, its
    // powertrain coverage at 100,000): the generic line would have told a
    // buyer whose factory warranty had already run out that it was "plenty,"
    // a blanket "pass on it" that's actively bad advice for exactly the
    // buyer who might most want the extended plan. Gated on remainingWarranty
    // (analyze-listing-url's applyRemainingWarranty, computeRemainingWarranty
    // in _shared/warranty.ts) when it's available; unknown coverage status
    // keeps the original framing rather than asserting either way.
    const rw = (analysis as any)?.remainingWarranty;
    const factoryExpired = rw && rw.basic?.active === false && rw.powertrain?.active === false;
    moves.push(factoryExpired
      ? { topic: "Warranty", say: `The factory warranty on this one has already run out — worth actually comparing what an extended plan costs against the repairs most likely on a car this age/mileage before deciding, not an automatic pass.` }
      : { topic: "Warranty", say: `I'll pass on the extended warranty${sw ? ` — the ${sw} factory coverage is plenty for now` : ""}. It's optional.` });
  }
  const r = analysis?.recalls;
  if (r && r.checked && r.count > 0) {
    moves.push({ topic: "Recalls", say: `There ${r.count > 1 ? "are" : "is"} ${r.count} open recall${r.count > 1 ? "s" : ""} on this VIN — please have ${r.count > 1 ? "them" : "it"} fixed before delivery.` });
  }
  const dApr = trustedDealerApr(analysis), pApr = num(analysis?.financeRates?.manufacturer?.apr);
  if (dApr != null && pApr != null && dApr > pApr + 0.1 && !analysis?.financingTrap) {
    moves.push({ topic: "Rate", say: `I see a ${pApr}% promo rate advertised — I'd want that, not ${dApr}%.` });
  }

  const clean = moves.length === 0;
  // S19 — a first "no discount" from a BDC/salesperson isn't the floor; the price
  // comes from whoever runs the desk. Get it in writing from them.
  moves.push({ topic: "In writing", say: `Please send the full out-the-door total in writing — from whoever actually sets the price (the desk/sales manager). A first "no" from the front desk isn't the final number.` });
  // S30 — worksheet ≠ bill of sale. Real case: a signed worksheet + $1,000
  // deposit was treated by the regulator as "still in negotiation," so a
  // $2,400 pickup-day increase stood. The price only becomes real on a signed
  // bill of sale carrying the VIN. Always-on closing warning, factual framing.
  moves.push({ topic: "Bill of sale", say: `A worksheet is not a bill of sale — regulators have treated signed worksheets WITH deposits as "still negotiating," and buyers have eaten pickup-day price increases. Don't consider the price final until it's on a signed bill of sale with this exact VIN.` });
  return { moves, clean };
}

// Total interest paid on an amortizing loan (principal, annual % rate, months).
function totalInterest(principal: number, annualPct: number, months: number): number {
  const r = (annualPct / 100) / 12;
  if (!(principal > 0) || !(months > 0)) return 0;
  if (r <= 0) return 0;
  const pmt = principal * r / (1 - Math.pow(1 + r, -months));
  return Math.max(0, pmt * months - principal);
}

export interface FinancingTrap {
  mode: "quantified" | "awareness";
  discount: number;
  dealerApr: number | null;
  promoApr: number | null;
  term: number | null;
  loan: number | null;
  extraInterest: number | null; // extra interest at the dealer rate vs the promo rate
  net: number | null;           // discount minus extra interest (negative = you lose)
  isTrap: boolean | null;       // extra interest exceeds the discount
}

// S11 — "in lieu of special financing" trap. When a deal carries a discount AND
// the OEM promo APR is lower than the quote's rate, a discount that's contingent
// on taking dealer financing can cost MORE in interest than it saves. We can't
// always know a discount is financing-contingent, so we frame it as a counter-
// question and quantify the trade-off when the rate data is there. Never throws.
export function computeFinancingTrap(analysis: any): FinancingTrap | null {
  const rec = analysis?.reconciliation as Reconciliation | undefined;
  const msrp = num(analysis?.msrp), selling = num(analysis?.quotedPrice);
  // Discount = explicit discount line items, else price below MSRP.
  let discount = rec && rec.discountsTotal ? Math.abs(rec.discountsTotal) : 0;
  // An IMPLIED discount -- price below MSRP -- is only real if the MSRP is one
  // we verified for this exact trim. Derived from a `dealer_stated` figure it is
  // just the gap between the dealer's own sticker and their own asking price:
  // LotCheck computing the dealer's marketing claim and handing it back as a
  // finding. On a used car's `original_when_new` it is a five-figure phantom.
  // The number does not merely display -- it feeds `net` and the `isTrap`
  // verdict, so a fabricated discount flips the whole card's headline.
  if (!discount) {
    const claim = qualifyMsrpClaim(analysis);
    if (claim.comparable && claim.delta !== null && claim.delta < 0) discount = -claim.delta;
  }
  if (!(discount > 0)) return null; // S11 only applies when there IS a discount

  const dealerApr = trustedDealerApr(analysis);
  const promoApr = num(analysis?.financeRates?.manufacturer?.apr);
  const term = num(analysis?.financing?.termMonths);
  const loan = selling; // full price proxy (down payment unknown)

  if (promoApr != null && dealerApr != null && dealerApr > promoApr + 0.1 && loan != null && term != null) {
    const extraInterest = Math.round(totalInterest(loan, dealerApr, term) - totalInterest(loan, promoApr, term));
    return {
      mode: "quantified", discount, dealerApr, promoApr, term, loan,
      extraInterest, net: Math.round(discount - extraInterest), isTrap: extraInterest > discount,
    };
  }
  // Rates incomplete: still surface the counter-question.
  return { mode: "awareness", discount, dealerApr, promoApr, term, loan, extraInterest: null, net: null, isTrap: null };
}

export function computeReconciliation(analysis: any): Reconciliation | null {
  const selling = num(analysis?.quotedPrice);
  const items: any[] = Array.isArray(analysis?.addOns) ? analysis.addOns : [];
  if (!items.length && selling == null) return null;
  const fees: any[] = [], addons: any[] = [], discounts: any[] = [];
  for (const it of items) {
    const entry = { name: it?.name ?? null, price: num(it?.price) };
    switch (classifyLine(it?.name, it?.price, it?.verdict)) {
      case "discount": discounts.push(entry); break;
      case "addon": addons.push(entry); break;
      default: fees.push(entry);
    }
  }
  const sum = (a: any[]) => a.reduce((s, x) => s + (x.price || 0), 0);
  const feesTotal = sum(fees), addonsTotal = sum(addons), discountsTotal = sum(discounts);
  const addedOnTop = feesTotal + addonsTotal; // discounts already reflected in `selling`
  return {
    sellingPrice: selling,
    fees, addons, discounts,
    feesTotal, addonsTotal, discountsTotal,
    addedOnTop,
    realPreTax: selling != null ? selling + addedOnTop : null,
  };
}
