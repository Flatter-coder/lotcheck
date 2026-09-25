// The thirteen report cards (Hub & Spoke redesign). Pins that cards 01-10 are
// the canonical bands unchanged, that cards 11-13 only ever state a figure a
// source stated, and that no card copy assumes the buyer will sign.
//
// Run: node --experimental-strip-types scripts/test-report-cards.mjs
import { reportCards, cardTally, daysCard, aprCard, usedVsNewCard, freightCard, firstSentence } from "../supabase/functions/_shared/report-cards.js";
import { reportBands } from "../supabase/functions/_shared/report-bands.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log("  PASS " + name); } else { fail++; console.log("  FAIL " + name + (detail ? "  -- " + detail : "")); } };

const NEW = {
  year: 2026, make: "Toyota", model: "RAV4", trim: "XLE", vehicleCondition: "new", fuelType: "Hybrid",
  quotedPrice: 46480, msrp: 41300, msrpAllIn: 45161.4, allInPricing: true, msrpBasis: "exact", msrpPriceBasis: "excl_freight",
  priceVerified: true, feesRead: true,
  recalls: { checked: true, count: 1, items: [{ system: "Lights And Instruments" }] },
  addOns: [{ verdict: "flagged", price: 1847 }], totalFlaggedCost: 1847,
  dealerLicence: { status: "Issued", state: "valid", registration_number: "B2036047" },
  financingCheck: { checked: true, consistent: true },
  odometerKm: 8, odometerCheck: { checked: true, km: 8, flag: false },
  vinCheck: { present: true, valid: true, vin: "2T3P1RFV5TW123456" },
  standardWarranty: { coverage: "3-year/60,000 km comprehensive, 5-year/100,000 km powertrain, 5-year/unlimited corrosion" },
  dealerLineItems: { fees: [{ label: "Freight & PDI", amount: 2295 }] },
};
const USED = { ...NEW, year: 2024, vehicleCondition: "used", fuelType: "Gas", quotedPrice: 43500, msrp: null, msrpAllIn: null, msrpBasis: null, odometerKm: 48210, odometerCheck: { checked: true, km: 48210, flag: false }, dealerLineItems: null };

console.log("cards 01-10 are the canonical bands");
{
  const cards = reportCards(NEW), bands = reportBands(NEW);
  check("thirteen cards, numbered 01-13 in fixed order", cards.length === 13 && cards.map((c) => c.n).join() === "01,02,03,04,05,06,07,08,09,10,11,12,13", cards.map((c) => c.n).join());
  check("each of cards 01-10 carries its band's state and value unchanged", bands.every((b, i) => cards[i].state === b.state && cards[i].value === b.value));
  check("a card's summary is the first sentence of its band's note", cards[1].short === firstSentence(bands[1].note) && cards[1].short.length > 0);
  check("every card has a suggestion", cards.every((c) => typeof c.suggestion === "string" && c.suggestion.length > 0), cards.filter((c) => !c.suggestion).map((c) => c.n).join());
  check("no card assumes the buyer will sign", !cards.some((c) => /before (you )?sign|before signing/i.test(`${c.short} ${c.suggestion}`)), cards.filter((c) => /sign/i.test(`${c.short} ${c.suggestion}`)).map((c) => c.n).join());
  check("a used car's point 01 is titled against the market, a new car's against MSRP", reportCards(USED)[0].title === "Price vs market" && cards[0].title === "Price vs MSRP");
  const t = cardTally(cards);
  check("the tally counts states across all thirteen", t.raise + t.clear + t.noted + t.unchecked === 13, JSON.stringify(t));
}

console.log("card 11 -- days on lot");
{
  check("no stated source: not checked, never a number", daysCard(NEW).state === "unchecked" && daysCard(NEW).value === "NOT STATED");
  const feed = { ...NEW, daysOnLot: { days: 96, since: "2026-06-20", source: "sm360_feed", sourceLabel: "the dealer's own inventory feed" } };
  check("96 days from the dealer's own feed: raise, with the source named", daysCard(feed).state === "raise" && daysCard(feed).value === "96 DAYS" && /the dealer's own inventory feed/.test(daysCard(feed).short));
  const short = { ...feed, daysOnLot: { ...feed.daysOnLot, days: 41 } };
  check("41 days: noted, nothing to raise yet", daysCard(short).state === "noted" && /Nothing to raise/.test(daysCard(short).suggestion));
  const once = { ...NEW, daysOnLot: { days: null, since: "2026-08-18", state: "single_sighting", sourceLabel: "LotCheck's own inventory tracking" } };
  check("a single sighting of our own is never a duration", daysCard(once).state === "noted" && !/DAYS/.test(daysCard(once).value), JSON.stringify(daysCard(once)));
}

console.log("card 12 -- APR vs the maker (new) / used vs new (used)");
{
  const bm = { apr: 5.99, lender: "Toyota Financial Services", capturedOn: "2026-09-20", termMin: 60, termMax: 84 };
  const over = { ...NEW, aprCheck: { checked: true, comparable: true, why: null, quotedApr: 6.49, benchmark: bm, loan: 46480, termMonths: 72, overByPts: 0.5, extraOverTerm: 734, extraPerMonth: 10.19 } };
  const c = aprCard(over);
  check("a rate over the maker's: raise, both rates and the lender named", c.state === "raise" && c.value === "6.49% VS 5.99%" && /Toyota Financial Services publishes 5.99%/.test(c.short) && /\$734/.test(c.short), JSON.stringify(c));
  const at = aprCard({ ...over, aprCheck: { ...over.aprCheck, quotedApr: 5.99, overByPts: 0, extraOverTerm: 0 } });
  check("at the maker's rate: verified, and it names its source", at.state === "clear" && /Toyota Financial Services/.test(at.source));
  check("no comparable rate: not compared, and the reason is the product's own", aprCard({ ...NEW, aprCheck: { checked: true, comparable: false, why: "no_quoted_rate" } }).state === "unchecked");
  check("a used car gets 'used vs new', not APR", reportCards(USED)[11].key === "used_vs_new");
  check("without a sealed new-car price, used vs new is not checked -- never a number", usedVsNewCard(USED).state === "unchecked" && !/\$/.test(usedVsNewCard(USED).value));
  const nf = { ...USED, newFrom: { year: 2026, trim: "LE", fuel: "Hybrid", allIn: 41361.4, source: "Toyota Canada Build & Price" } };
  check("with it: the gap, and the cheapest new car named", usedVsNewCard(nf).state === "raise" && usedVsNewCard(nf).value === "$2,139 MORE THAN NEW" && /2026 RAV4 LE Hybrid/.test(usedVsNewCard(nf).short), JSON.stringify(usedVsNewCard(nf)));
}

console.log("card 05 -- what the loan costs");
{
  // The real 2025 HR-V listing, 2026-09-25: 416 weekly payments of $111.28 at
  // 7.99% over 96 months printed RECONCILES in green, nothing about interest.
  const hrv = { ...USED, year: 2025, make: "Honda", model: "HR-V", quotedPrice: 33995,
    financing: { paymentAmount: 111.28, termMonths: 96, paymentFrequency: "weekly", totalObligation: 48605.44, rate: 7.99, source: "page_text" },
    financingCheck: { checked: true, consistent: true, note: "416 payments of $111.28 (about $46,292 before tax) reconcile with the disclosed total of $48,605.44 once sales tax is added." } };
  const c = reportCards(hrv)[4];
  check("a 96-month loan is raised, with its interest in dollars", c.state === "raise" && c.value === "$12,107 INTEREST", `${c.state} ${c.value}`);
  check("...worked out from the listing's own payment, rate and term", /416 weekly payments of \$111\.28 at 7\.99% come to \$46,292/.test(c.short), c.short);
  check("...and the suggestion is a shorter term, not an accusation", /shorter term/.test(c.suggestion) && !/overcharg|rip|gouge|predator/i.test(`${c.short} ${c.suggestion}`), c.suggestion);
  const sixty = { ...hrv, financing: { ...hrv.financing, termMonths: 60, paymentAmount: 158 } };
  const s = reportCards(sixty)[4];
  check("a 60-month loan that reconciles stays verified, and still states its interest", s.state === "clear" && /^About \$[\d,]+ of this loan is interest/.test(s.short), `${s.state} ${s.short}`);
  const guess = { ...hrv, financing: { ...hrv.financing, source: "llm" } };
  check("a rate a model guessed never prints a dollar figure", reportCards(guess)[4].value === "RECONCILES" && !/interest/i.test(reportCards(guess)[4].short));
  const noTotal = { ...hrv, financingCheck: null };
  check("payment, rate and term with no total: the cost still stands", reportCards(noTotal)[4].value === "$12,107 INTEREST" && reportCards(noTotal)[4].state === "raise");
  const bad = { ...hrv, financingCheck: { checked: true, consistent: false, note: "does not reconcile" } };
  check("payments that do not add up still say so first", reportCards(bad)[4].value === "DOESN'T ADD UP" && /amortisation/.test(reportCards(bad)[4].suggestion));
}

console.log("card 13 -- freight & PDI");
{
  const f = freightCard(NEW);
  check("a listing above the maker's published freight: raise, both figures stated", f.state === "raise" && /\$365/.test(f.value) && /\$1,930/.test(f.short) && /\$2,295/.test(f.short), JSON.stringify(f));
  check("it never says the dealer added anything", !/dealer (added|padded|marked)/i.test(`${f.short} ${f.suggestion}`));
  const none = freightCard({ ...NEW, dealerLineItems: null });
  check("the listing states no freight line: noted, the published figure given", none.state === "noted" && /\$1,930/.test(none.short));
  check("a used car: noted as a new-car charge", freightCard(USED).state === "noted" && freightCard(USED).value === "NEW-CAR CHARGE");
  check("a used listing that DOES charge freight: raise", freightCard({ ...USED, dealerLineItems: { fees: [{ label: "Freight & PDI", amount: 1995 }] } }).state === "raise");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
