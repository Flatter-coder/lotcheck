// Regression suite for the two count/default report lines:
//   "M of the N other listings LotCheck read ... advertised below this one"  (market-count.js)
//   "This page's payment default is N months ..."                          (page-default.js)
// and the one shared sentence builder every surface renders (report-lines.js).
// Run: node scripts/test-report-lines.mjs
//
// Pinned here, on purpose:
//   1. the arithmetic and the states (four for the count, three for the default),
//      including the powertrain wall (a gas subject never counts hybrids) and
//      the trim scopes (same trim, then trim family, then model -- each labelled
//      as what it is);
//   2. the page readers against REAL captured dealer pages (a live SM360 feed
//      shape, the Okotoks Honda finance block, two EDealer fixtures), including
//      the template-placeholder trap, the sibling-vehicle trap and the
//      text-only trap (absence cannot be established without the html);
//   3. that the sealed compact form renders the SAME sentence as the full form;
//   4. that NO sentence the builder can emit, in any state, contains a word the
//      copy gate forbids -- so a state no surface exercises today cannot ship a
//      banned word tomorrow.
import { readFileSync } from "node:fs";
import { computeMarketCount, normTrim, fullTrimKey, trimLabelOf, likeForLikePool, dropModelWords, fuelPowertrainHint, olderYearsLadder } from "../supabase/functions/_shared/market-count.js";
import { readPageDefault, readSm360PageDefault, readPageTextDefault, readEdealerPageDefault, parseAmount } from "../supabase/functions/_shared/page-default.js";
import { marketCountLine, pageDefaultLine, marketCompareLine, olderYearsLine, financeCoverageLine, financeCoverageApplies, albertaRulesApply, insurancePremiumLine, financingAprNote, financingAprValue, pageDefaultApr, provinceOf, fmtDateEn, fmtMoney } from "../supabase/functions/_shared/report-lines.js";

let pass = 0, fail = 0;
const failures = [];
function check(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; failures.push(label); console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ""}`); }
}
const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

// ── 1. market count ──────────────────────────────────────────────────────────
console.log("\n-- computeMarketCount --");
const TODAY = "2026-09-02";
// fn_market_comps row shape (20260828 migration): price, odometerKm, trim, year, asOf, certified, dealerName, city.
const hrv = (trim, price, dealer, asOf = "2026-08-18") => ({ price, odometerKm: 5, trim, year: 2027, asOf, certified: false, dealerName: dealer, city: "Edmonton" });
const ROWS = [
  ...Array.from({ length: 7 }, () => hrv("Sport", 40343, "AUDI EDMONTON NORTH")),
  hrv("Sport", 40673, "Alberta Honda"), hrv("Sport", 40680, "Alberta Honda"),
  hrv("Sport", 40681, "HONDA MAGIC"), hrv("Sport", 40681, "HONDA MAGIC"), hrv("Sport", 40681, "Alberta Honda"),
  ...Array.from({ length: 11 }, () => hrv("EX-L", 43500, "Alberta Honda")),
  hrv("LX", 34531, "AUDI EDMONTON NORTH"), hrv("LX", 34531, "AUDI EDMONTON NORTH"), hrv("LX", 34714, "Alberta Honda"),
  hrv("LX", 34714, "Alberta Honda"), hrv("LX", 35081, "HONDA MAGIC"), hrv("LX", 37014, "Alberta Honda"),
  hrv("LX", 37381, "AUDI EDMONTON NORTH"), hrv("LX", 37381, "AUDI EDMONTON NORTH"), hrv("LX", 37381, "Alberta Honda"),
];
const SUBJ = { year: 2027, make: "Honda", model: "HR-V", trim: "Sport AWD SUV", price: 39713.7, priceVerified: true, province: "AB", subjectExcluded: true, today: TODAY };
{
  const mc = computeMarketCount(ROWS, SUBJ);
  check("same-trim scope chosen when >= 3 rows share the full trim", mc.scope === "trim" && mc.n === 12, JSON.stringify(mc));
  check("none of the 12 Sport rows are below $39,713.70", mc.below === 0 && mc.same === 0);
  check("dealers counted distinctly from the rows' own dealer field", mc.dealers === 3, String(mc.dealers));
  check("model-wide totals carried for the 'across all trims' clause", mc.modelN === 32 && mc.modelBelow === 9, `${mc.modelN}/${mc.modelBelow}`);
  check("dated by the rows' own last-seen dates and the count's own as-of day", mc.seenMin === "2026-08-18" && mc.seenMax === "2026-08-18" && mc.asOf === TODAY);
  check("state confirmed with a verified price", mc.state === "confirmed");
  check("trim label is the subject's trim as written, minus drivetrain/body tokens", mc.trimLabel === "Sport", mc.trimLabel);
}
{
  const bare = ROWS.map(({ dealerName, city, ...r }) => r);
  const mc = computeMarketCount(bare, SUBJ);
  check("rows without a dealer field -> dealers null, never 1", mc.dealers === null && mc.state === "confirmed", String(mc.dealers));
  const l = marketCountLine({ year: 2027, make: "Honda", model: "HR-V", marketCount: mc });
  check("... and the sentence names no dealer number", /from Alberta dealers' own pages/.test(l.body) && !/\d Alberta dealer/.test(l.body), l.body);
}
{
  const mc = computeMarketCount(ROWS, { ...SUBJ, trim: "Other/Don't Know" });
  check("generic trim -> model scope, all 32 rows", mc.scope === "model" && mc.n === 32 && mc.below === 9 && mc.trimLabel === null, JSON.stringify(mc));
  const mc2 = computeMarketCount(ROWS, { ...SUBJ, trim: "Touring" });
  check("a trim with no rows falls back to the model, not to an empty count", mc2.scope === "model" && mc2.n === 32);
}
{
  // Honda Civic: Sport vs Sport Touring must not be labelled "Sport".
  const civ = (trim, price) => ({ price, trim, year: 2026, asOf: "2026-08-27", dealerName: "A", city: "Calgary" });
  const rows = [civ("Sport Touring", 41000), civ("Sport Touring", 41500), civ("Sport Touring", 42000), civ("Sport", 33500), civ("LX", 29000)];
  const mc = computeMarketCount(rows, { ...SUBJ, year: 2026, model: "Civic", trim: "Sport", price: 33000 });
  check("Sport vs Sport Touring: only 1 exact Sport row -> trim FAMILY scope, not 'Sport'", mc.scope === "trim_family" && mc.n === 4, JSON.stringify(mc));
  const l = marketCountLine({ year: 2026, make: "Honda", model: "Civic", marketCount: mc });
  check("... and the sentence says the family, with the exact-trim word quoted", /listings with a trim beginning "Sport"/.test(l.body) && /SPORT FAMILY/.test(l.value), l.body + " | " + l.value);
}
{
  // Powertrain wall: a gas RAV4 XSE never counts hybrid rows; a hybrid never counts gas rows.
  const rav = (trim, price) => ({ price, trim, year: 2026, asOf: "2026-08-27", dealerName: "A", city: "Calgary" });
  const rows = [rav("XSE AWD Hybrid", 52000), rav("XSE AWD Hybrid", 51000), rav("XSE", 46000), rav("XSE", 46500), rav("XSE", 47500), rav("LE", 39000), rav("Hybrid LE AWD", 44000)];
  const gas = computeMarketCount(rows, { ...SUBJ, year: 2026, make: "Toyota", model: "RAV4", trim: "XSE", price: 47000 });
  check("gas XSE subject: hybrids excluded (3 XSE rows, 2 below), model pool 4", gas.scope === "trim" && gas.n === 3 && gas.below === 2 && gas.modelN === 4, JSON.stringify(gas));
  const hyb = computeMarketCount(rows, { ...SUBJ, year: 2026, make: "Toyota", model: "RAV4", trim: "Hybrid XSE AWD", price: 52500 });
  check("hybrid XSE subject: gas rows excluded (3 hybrid rows), powertrain named; only 2 share the trim so the count is model-wide", hyb.powertrain === "Hybrid" && hyb.modelN === 3 && hyb.scope === "model" && hyb.n === 3 && hyb.below === 3 && hyb.trimLabel === "XSE", JSON.stringify(hyb));
  const l = marketCountLine({ year: 2026, make: "Toyota", model: "RAV4", marketCount: hyb });
  check("... and the sentence says 'RAV4 Hybrid'", /2026 Toyota RAV4 Hybrid/.test(l.body), l.body);
}
{
  const mc = computeMarketCount(ROWS, { ...SUBJ, priceVerified: false });
  check("unverified price -> not_counted, rows still described", mc.state === "not_counted" && mc.reason === "price_unverified" && mc.n === 12);
  const mc2 = computeMarketCount(ROWS, { ...SUBJ, price: null });
  check("no price -> not_counted (no_price)", mc2.state === "not_counted" && mc2.reason === "no_price");
  const mc3 = computeMarketCount(ROWS, { ...SUBJ, contingent: true });
  check("finance-contingent price -> not_counted (price_contingent)", mc3.state === "not_counted" && mc3.reason === "price_contingent");
  const mc4 = computeMarketCount(ROWS, { ...SUBJ, truncated: true });
  check("a truncated pool -> not_counted (pool_truncated), never a biased count", mc4.state === "not_counted" && mc4.reason === "pool_truncated" && mc4.truncated === true);
}
{
  const old = ROWS.map((r) => ({ ...r, asOf: "2026-07-01" }));
  const mc = computeMarketCount(old, SUBJ);
  check("rows older than the 30-day window are dropped -> absent", mc.state === "absent" && mc.n === 0, JSON.stringify(mc));
  const unpriced = ROWS.map((r) => ({ ...r, price: null }));
  const mc2 = computeMarketCount(unpriced, SUBJ);
  check("rows without a price -> absent, and the unpriced count is kept", mc2.state === "absent" && mc2.unpriced === 32, JSON.stringify(mc2));
  const mc3 = computeMarketCount(null, SUBJ);
  check("rows unavailable -> unchecked", mc3.state === "unchecked");
}
{
  const mc = computeMarketCount(ROWS, { ...SUBJ, price: 40343 });
  check("ties are not below: 7 rows at $40,343 count as same, not below", mc.below === 0 && mc.same === 7);
  const mc2 = computeMarketCount(ROWS, { ...SUBJ, price: 40680 });
  check("strictly-below count at $40,680: 8 below, 1 same", mc2.below === 8 && mc2.same === 1, `${mc2.below}/${mc2.same}`);
}
check("normTrim groups 'XLT SuperCrew' with 'XLT'", normTrim("XLT SuperCrew 4WD") === "xlt" && normTrim("Sport AWD SUV") === "sport");
check("normTrim skips engine tokens: '2.0T Sport' keys as 'sport', label keeps '2.0T' out", normTrim("2.0T Sport") === "sport" && trimLabelOf("2.0T Sport AWD") === "Sport", trimLabelOf("2.0T Sport AWD"));
check("fullTrimKey separates Sport from Sport Touring and equates 'Sport AWD SUV' with 'Sport'", fullTrimKey("Sport AWD SUV") === fullTrimKey("Sport") && fullTrimKey("Sport Touring") !== fullTrimKey("Sport"));
check("'Type R' keeps its key", normTrim("Type R") === "type" && fullTrimKey("Type R") === "typer");

// ── 2. page default readers ───────────────────────────────────────────────────
console.log("\n-- readPageDefault --");
const SM360_LIVE = { // shape of a live SM360 feed unit (tazaparkvw.com, 2026-09-02)
  vehicleId: 1, paymentOptions: { purchaseMethod: "cash", paymentFrequency: 0, term: 0, cashDown: 0,
    finance: { paymentFrequency: 52, cashDown: 0, sellingPrice: 64489, term: { term: 84, apr: 2.99, payment: 196.48, aprDetails: { totalObligation: 75093.2 } } } } };
{
  const r = readSm360PageDefault(SM360_LIVE, "2026-09-02");
  check("SM360 feed (cash-first): 84 mo, weekly, 2.99%, $0 down, opens on cash", r.state === "confirmed" && r.termMonths === 84 && r.paymentFrequency === "weekly" && r.apr === 2.99 && r.downPayment === 0 && r.purchaseMethod === "cash" && r.source === "sm360_feed", JSON.stringify(r));
  check("SM360 feed: payment amount carried", r.paymentAmount === 196.48);
  const sel = readSm360PageDefault({ paymentOptions: { purchaseMethod: "finance", paymentFrequency: 12, term: 60, cashDown: 5000, finance: { paymentFrequency: 52, cashDown: 0, term: { term: 84, apr: 2.99, payment: 196.48 } } } }, "2026-09-02");
  check("SM360 feed (finance-first): the unit's SELECTED scenario wins (60 mo monthly $5,000 down), rate unknown for a different term", sel.state === "confirmed" && sel.termMonths === 60 && sel.paymentFrequency === "monthly" && sel.downPayment === 5000 && sel.apr === null, JSON.stringify(sel));
  const none = readSm360PageDefault({ paymentOptions: { purchaseMethod: "cash", finance: {} } }, "2026-09-02");
  check("SM360 feed without a finance term -> absent (feed_no_term), still checked", none.state === "absent" && none.reason === "feed_no_term" && none.checked === true);
  const nothing = readSm360PageDefault({}, "2026-09-02");
  check("SM360 unit without paymentOptions -> unchecked", nothing.state === "unchecked");
  const noDown = readSm360PageDefault({ paymentOptions: { purchaseMethod: "cash", finance: { paymentFrequency: 26, term: { term: 72, apr: 4.99 } } } }, "2026-09-02");
  check("SM360 feed without cashDown -> downPayment null, never 0", noDown.state === "confirmed" && noDown.downPayment === null);
}
{
  const html = fx("okotoks-hrv-finance-block.html");
  const r = readPageDefault({ html, price: 39713.7, readAt: "2026-09-02" });
  check("Okotoks Honda block: 84 months @ 5.99% with $0 down, $267 bi-weekly, source page_text",
    r.state === "confirmed" && r.termMonths === 84 && r.apr === 5.99 && r.downPayment === 0 && r.paymentAmount === 267 && r.paymentFrequency === "biweekly" && r.source === "page_text", JSON.stringify(r));
  check("Okotoks Honda block: the page's own qualifiers are carried (estimate; plus taxes and licence; cost of borrowing)", /estimate/.test(r.qualifier || "") && /plus taxes and licence/.test(r.qualifier || "") && r.costOfBorrowing === 8951.19, `${r.qualifier} | ${r.costOfBorrowing}`);
  const rInt = readPageDefault({ html, price: 39713, readAt: "2026-09-02" });
  check("Okotoks Honda block: JSON-LD integer price (39713) still matches the $39,713.70 sentence (< $1 apart)", rInt.state === "confirmed" && rInt.termMonths === 84);
  const rWrong = readPageDefault({ html, price: 28890, readAt: "2026-09-02" });
  check("a sentence about a different principal is not this car's default -> absent (none_found)", rWrong.state === "absent" && rWrong.reason === "none_found", JSON.stringify(rWrong));
  const rNoPrice = readPageDefault({ html, price: null, readAt: "2026-09-02" });
  check("no known price -> unchecked (price_unknown): a sentence cannot be tied to this vehicle", rNoPrice.state === "unchecked" && rNoPrice.reason === "price_unknown", JSON.stringify(rNoPrice));
  const leaseOnly = readPageTextDefault("Lease from $231 $39,713.70 x 60 months @ 5.49% APR with $0.00 down payment (12,000 km/yr lease allowance). / Biweekly", { price: 39713.7 });
  check("the lease sentence alone never counts as the finance default", leaseOnly.state === "absent");
  const leaseLabelFar = readPageTextDefault("Lease from $231 " + "x ".repeat(150) + "financing available $39,713.70 x 60 months @ 5.49% APR (estimated rate) / Monthly", { price: 39713.7 });
  check("a sentence under a distant 'Lease from' label with a bare 'financing' word is not a finance default", leaseLabelFar.state === "absent", JSON.stringify(leaseLabelFar));
  const textOnly = readPageDefault({ text: "2027 Honda HR-V Sport. Finance from $267 $39,713.70 x 84 months @ 5.99% APR with $0.00 down payment (estimated financing rate). / Biweekly", price: 39713.7, readAt: "2026-09-02" });
  check("markdown text alone CAN confirm when the sentence is there", textOnly.state === "confirmed" && textOnly.paymentFrequency === "biweekly");
  const textMiss = readPageDefault({ text: "2027 Honda HR-V Sport. Call for details.", price: 39713.7, readAt: "2026-09-02" });
  check("markdown text alone with no sentence -> unchecked (html_unavailable), never 'none found'", textMiss.state === "unchecked" && textMiss.reason === "html_unavailable", JSON.stringify(textMiss));
}
{
  // Frequency must be THIS block's suffix, never a neighbour's.
  const nextVehicle = readPageTextDefault("Finance from $267 $39,713.70 x 84 months @ 5.99% APR with $0.00 down payment (estimated financing rate). Plus taxes and licence. Similar vehicles 2026 Honda Civic Finance from $199 $31,990.00 x 84 months @ 6.99% APR / Monthly", { price: 39713.7 });
  check("a neighbouring vehicle's '/ Monthly' is not taken as this block's frequency", nextVehicle.state === "confirmed" && nextVehicle.paymentFrequency === null, JSON.stringify(nextVehicle));
  const banner = readPageTextDefault("Monthly Specials! Ask us about weekly payments. Finance from $267 $39,713.70 x 84 months @ 5.99% APR with $0.00 down payment (estimated financing rate).", { price: 39713.7 });
  check("banner words before the block are not a frequency", banner.state === "confirmed" && banner.paymentFrequency === null, JSON.stringify(banner));
  // A sibling unit within 1% of price on the same page.
  const sibling = readPageTextDefault("Recently viewed: 2027 Honda HR-V Sport Finance from $270 $39,995.00 x 72 months @ 7.49% APR with $0.00 down payment. Finance from $267 $39,713.70 x 84 months @ 5.99% APR with $0.00 down payment (estimated financing rate). / Biweekly", { price: 39713.7 });
  check("a sibling unit at $39,995 never wins over this listing's own $39,713.70 sentence", sibling.state === "confirmed" && sibling.termMonths === 84 && sibling.apr === 5.99, JSON.stringify(sibling));
  const twoSame = readPageTextDefault("Finance from $267 $39,713.70 x 84 months @ 5.99% APR. Finance from $301 $39,713.70 x 72 months @ 6.49% APR.", { price: 39713.7 });
  check("two different finance sentences at this exact price -> unchecked (ambiguous)", twoSame.state === "unchecked" && twoSame.reason === "ambiguous", JSON.stringify(twoSame));
}
{
  const jc = fx("jackcarter-bolt.html");
  const r = readPageDefault({ html: jc, price: 43246, readAt: "2026-09-02" });
  check("EDealer (GM) page with the finance panel hidden -> absent (panel_hidden), source edealer_js, never the '$19.988 x 84 Months' template", r.state === "absent" && r.reason === "panel_hidden" && r.source === "edealer_js" && r.termMonths == null, JSON.stringify(r));
  // Flip the panel on: the offers array (with nested stackable_offers) must parse, and the
  // sentinel default term (1) is not offered, so nothing is confirmed until a captured page pins the fallback.
  const flipped = jc.replace(/financePaymentIntervalShort\s*=\s*'none'/, "financePaymentIntervalShort = 'bw'");
  const r2 = readEdealerPageDefault(flipped, "2026-09-02");
  check("EDealer (GM) with the panel shown: offers parse past the nested arrays and the unpinned default term lands unchecked, never absent", r2 && r2.state === "unchecked" && r2.reason === "default_term_unpinned" && /offered terms \[\d/.test(r2.evidence || ""), JSON.stringify(r2));
  const pinned = flipped.replace(/default_finance_term\s*=\s*parseInt\('1'\)/, "default_finance_term = parseInt('84')");
  const r3 = readEdealerPageDefault(pinned, "2026-09-02");
  check("EDealer (GM) with a pinned default term: 84 mo bi-weekly at the offer's rate with the page's $3,800 down", r3 && r3.state === "confirmed" && r3.termMonths === 84 && r3.paymentFrequency === "biweekly" && r3.downPayment === 3800 && r3.apr != null, JSON.stringify(r3));
  const rf = fx("rainbowford-bronco.html");
  const r4 = readPageDefault({ html: rf, price: 39765, readAt: "2026-09-02" });
  check("EDealer (Ford) JSON-key form: \"financePaymentIntervalShort\":\"none\" -> absent (panel_hidden)", r4.state === "absent" && r4.reason === "panel_hidden" && r4.source === "edealer_js", JSON.stringify(r4));
  const rfOn = rf.replace(/"financePaymentIntervalShort":"none"/, '"financePaymentIntervalShort":"bw"');
  const r5 = readEdealerPageDefault(rfOn, "2026-09-02");
  check("EDealer (Ford) with the panel on but no offers array -> unchecked (offers_unparsed), never 'hidden'", r5 && r5.state === "unchecked" && r5.reason === "offers_unparsed", JSON.stringify(r5));
  const textOnlyEdealer = readPageDefault({ text: "2027 Chevrolet Bolt RS $43,246. Finance For (2.99%) $19.988 x 84 Months @ 6.49% APR (estimated financing rate)", price: 43246, readAt: "2026-09-02" });
  check("an EDealer page seen as text only (no html) -> unchecked, not 'none found'", textOnlyEdealer.state === "unchecked", JSON.stringify(textOnlyEdealer));
}
{
  const tmpl = "Finance For (2.99%) $19,988 x 84 Months @ 6.49% APR (estimated financing rate, cost of borrowing $4,907). Plus taxes and license.";
  const r = readPageTextDefault(tmpl, { price: 28890 });
  check("template placeholder ($19,988) against the real price -> absent, rejected by the price guard", r.state === "absent");
  check("parseAmount reads EDealer's dotted thousands: $19.988 -> 19988", parseAmount("$19.988") === 19988 && parseAmount("$39,713.70") === 39713.7);
  const r2 = readPageTextDefault("Finance from $99/wk on select models. " + tmpl, { price: null });
  check("template text with an unrelated 'Finance from' banner and NO known price -> unchecked (price_unknown)", r2.state === "unchecked" && r2.reason === "price_unknown");
  const r3 = readPageDefault({ readAt: "2026-09-02" });
  check("nothing handed in -> unchecked", r3.state === "unchecked" && r3.checked === false);
}

// ── 3. the shared sentence builder ───────────────────────────────────────────
console.log("\n-- report-lines --");
{
  const a = { year: 2027, make: "Honda", model: "HR-V", marketCount: computeMarketCount(ROWS, SUBJ) };
  const l = marketCountLine(a);
  check("LINE 1 confirmed value names what it is below", l.value === "0 OF 12 BELOW THIS PRICE", l.value);
  check("LINE 1 confirmed headline (past tense)", l.headline === "None of 12 advertised below this one", l.headline);
  check("LINE 1 confirmed body names count, vehicle, reader, dealers, price with cents, date and the model-wide clause",
    l.body === "None of the 12 other 2027 Honda HR-V Sport listings LotCheck read from 3 Alberta dealers' own pages advertised below this one ($39,713.70) when read on Aug 18, 2026. Across all HR-V trims read: 9 of 32 below. These are dealers' own advertised prices with this vehicle left out: a count, not a valuation.", l.body);
  check("LINE 1 meta line", l.meta === "2027 Honda HR-V Sport · Alberta · read on Aug 18, 2026", l.meta);
  const one = marketCountLine({ marketCount: { ...a.marketCount, n: 1, below: 1, same: 0, dealers: 1, modelN: 1, modelBelow: 1 } });
  check("LINE 1 singular grammar", /1 of the 1 other 2027 Honda HR-V Sport listing LotCheck read from 1 Alberta dealer's own pages advertised below this one/.test(one.body), one.body);
  const notEx = marketCountLine({ marketCount: { ...a.marketCount, subjectExcluded: false } });
  check("LINE 1 without VIN exclusion drops 'other' and says the vehicle may be among them", !/other 2027/.test(notEx.body) && /may be among them/.test(notEx.body), notEx.body);
  const nc = marketCountLine({ marketCount: computeMarketCount(ROWS, { ...SUBJ, priceVerified: false }) });
  check("LINE 1 not_counted says why and asks the dealer", nc.value === "NOT COUNTED" && /12 other 2027 Honda HR-V Sport listings were read/.test(nc.body) && /could not be verified/.test(nc.body) && /ask the dealer/.test(nc.body), nc.body);
  const cont = marketCountLine({ marketCount: computeMarketCount(ROWS, { ...SUBJ, contingent: true }) });
  check("LINE 1 price_contingent has its own sentence", /depends on financing with the dealer/.test(cont.body), cont.body);
  const ab = marketCountLine({ marketCount: computeMarketCount([], SUBJ) });
  check("LINE 1 absent names what was filed, the reader, and the dated window", ab.value === "NONE READ" && ab.body === 'No listings filed as "2027 Honda HR-V" were among those LotCheck read from Alberta dealers\' own pages in the 30 days to Sep 2, 2026, so there is nothing to count this one against.', ab.body);
  const abUnpriced = marketCountLine({ marketCount: computeMarketCount(ROWS.slice(0, 2).map((r) => ({ ...r, price: 0 })), SUBJ) });
  check("LINE 1 absent with unpriced rows says so", /2 were read without an advertised price/.test(abUnpriced.body), abUnpriced.body);
  const un = marketCountLine({});
  check("LINE 1 unchecked renders 'not read', without claiming an attempt failed", un.value === "NOT READ" && un.body === "Not counted — no listing set was read for this report.", un.body);
  const outside = marketCountLine({ marketCount: { state: "unchecked", reason: "outside_province", province: "BC" } });
  check("LINE 1 outside Alberta names the province the page placed the dealer in", /places it in British Columbia/.test(outside.body), outside.body);
  const unknownProv = marketCountLine({ marketCount: { state: "unchecked", reason: "province_unknown", province: null } });
  check("LINE 1 province unknown never says 'outside Alberta'", /could not be established/.test(unknownProv.body) && !/outside/.test(unknownProv.body), unknownProv.body);
  const noPage = marketCountLine({ marketCount: { state: "unchecked", reason: "no_page" } });
  check("LINE 1 upload path says the count is for link checks", /uploaded quote/.test(noPage.body), noPage.body);
  const cond = marketCountLine({ marketCount: { state: "unchecked", reason: "condition_unknown" } });
  check("LINE 1 condition unknown has its own sentence", /new or used/.test(cond.body), cond.body);
  const compact = marketCountLine({ mc: { st: "confirmed", sc: "trim", n: 12, b: 0, s: 0, d: 3, from: "2026-08-18", to: "2026-08-18", pv: "AB", x: true, p: 39713.7, tl: "Sport", pt: null, mn: 32, mb: 9, rs: null, w: 30, as: "2026-09-02", tr: false, up: 0 }, year: 2027, make: "Honda", model: "HR-V" });
  check("LINE 1 sealed compact form renders the SAME sentence as the full form", compact.body === l.body && compact.value === l.value, compact.body);
  const compactNc = marketCountLine({ mc: { st: "not_counted", sc: "trim", n: 12, b: 0, s: 0, d: 3, from: "2026-08-18", to: "2026-08-18", pv: "AB", x: true, p: 39713.7, tl: "Sport", rs: "price_contingent" }, year: 2027, make: "Honda", model: "HR-V" });
  check("LINE 1 compact form carries the reason (price_contingent)", compactNc.body === cont.body, compactNc.body);
  const sealedOnly = marketCountLine({ vehicle: "2027 Honda HR-V Sport AWD", mc: { st: "confirmed", sc: "model", n: 5, b: 1, s: 0, d: null, to: "2026-08-18", pv: "AB", x: true, p: 39713.7 } });
  check("LINE 1 from the sealed form with only a vehicle string still names the vehicle", /2027 Honda HR-V Sport AWD listings/.test(sealedOnly.body), sealedOnly.body);
}
{
  const html = fx("okotoks-hrv-finance-block.html");
  const pd = readPageDefault({ html, price: 39713.7, readAt: "2026-09-02" });
  const l = pageDefaultLine({ pageDefault: pd });
  check("LINE 2 confirmed value", l.value === "84 MO · BI-WEEKLY · 5.99%", l.value);
  check("LINE 2 confirmed body carries the page's own qualifiers and the one instruction", l.body === "This page shows financing first as 84 months, bi-weekly payments of $267, 5.99% APR and $0 down. The page notes the rate is an estimate and taxes and licence are extra, with a stated cost of borrowing of $8,951.19. Read from the page's own text on Sep 2, 2026. It helps to have the term, payment frequency, rate and total cost of borrowing from the dealer in writing.", l.body);
  check("LINE 2 meta", l.meta === "read Sep 2, 2026", l.meta);
  const sm = pageDefaultLine({ pageDefault: readSm360PageDefault(SM360_LIVE, "2026-09-02") });
  check("LINE 2 SM360 cash-first page leads with it in value, headline and body", sm.value === "OPENS ON CASH · 84 MO · WEEKLY · 2.99%" && /^Opens on cash · 84 months · weekly · 2\.99% APR$/.test(sm.headline) && /^This page opens on its cash price; its finance option starts at 84 months, weekly payments of \$196\.48, 2\.99% APR and \$0 down\. Read from the dealer's own listing data on Sep 2, 2026\./.test(sm.body), sm.body + " | " + sm.value);
  const partial = pageDefaultLine({ pageDefault: { checked: true, state: "confirmed", termMonths: 84, apr: 5.99, source: "page_text", readAt: "2026-09-02" } });
  check("LINE 2 partial: missing frequency is said, not guessed", /84 months and 5\.99% APR/.test(partial.body) && /does not state a payment frequency/.test(partial.body) && partial.value === "84 MO · 5.99%", partial.body + " | " + partial.value);
  const noDown = pageDefaultLine({ pageDefault: { checked: true, state: "confirmed", termMonths: 72, paymentFrequency: "biweekly", apr: 4.99, downPayment: null, source: "sm360_feed", readAt: "2026-09-02" } });
  check("LINE 2 never prints '$0 down' when no down payment was read", !/down/.test(noDown.body.split("—")[0]), noDown.body);
  const notShown = pageDefaultLine({ pageDefault: { checked: true, state: "absent", reason: "panel_hidden" } });
  check("LINE 2 absent by the page's own settings -> NOT SHOWN", notShown.value === "NOT SHOWN" && /own settings show no pre-selected finance scenario/.test(notShown.body), notShown.body);
  const noneFound = pageDefaultLine({ pageDefault: { checked: true, state: "absent", reason: "none_found" } });
  check("LINE 2 a miss -> NONE FOUND, a statement about the reader", noneFound.value === "NONE FOUND" && /LotCheck did not find/.test(noneFound.body), noneFound.body);
  const un = pageDefaultLine({});
  check("LINE 2 unchecked never claims an attempt failed", un.value === "NOT READ" && /^No payment settings were read for this report\./.test(un.body), un.body);
  const noPage = pageDefaultLine({ pageDefault: { checked: false, state: "unchecked", reason: "no_page" } });
  check("LINE 2 upload path says a page is needed", /uploaded quote/.test(noPage.body), noPage.body);
  const compact = pageDefaultLine({ dflt: { st: "confirmed", t: 84, f: "biweekly", a: 5.99, d: 0, p: 267, src: "page_text", at: "2026-09-02", pm: null, rs: null, q: "the page calls the rate an estimate; plus taxes and licence", cob: 8951.19 } });
  check("LINE 2 sealed compact form renders the SAME sentence as the full form", compact.body === l.body && compact.value === l.value, compact.body);
  const compactCash = pageDefaultLine({ dflt: { st: "confirmed", t: 84, f: "weekly", a: 2.99, d: 0, p: 196.48, src: "sm360_feed", at: "2026-09-02", pm: "cash" } });
  check("LINE 2 compact form keeps the cash-first wording", compactCash.body === sm.body, compactCash.body);
  const compactNull = pageDefaultLine({ dflt: { st: "confirmed", t: 72, f: "biweekly", a: 4.99, d: null, p: null, src: "sm360_feed", at: "2026-09-02" } });
  check("LINE 2 compact form with null down/payment prints neither", !/\$0 down/.test(compactNull.body) && !/payments of/.test(compactNull.body), compactNull.body);
  const compactNotShown = pageDefaultLine({ dflt: { st: "absent", rs: "panel_hidden" } });
  check("LINE 2 compact form keeps the not-shown split", compactNotShown.value === "NOT SHOWN");
  check("LINE 2 rejects a primitive without throwing", pageDefaultLine({ pageDefault: "yes" }).value === "NOT READ" && marketCountLine({ marketCount: 3 }).value === "NOT READ");
}
check("fmtDateEn", fmtDateEn("2026-08-18") === "Aug 18, 2026" && fmtDateEn("2026-09-02T10:00:00Z") === "Sep 2, 2026" && fmtDateEn("2026-02-31") === "" && fmtDateEn("nope") === "");
check("fmtMoney keeps cents only when present", fmtMoney(39713.7) === "$39,713.70" && fmtMoney(0) === "$0" && fmtMoney(196.48) === "$196.48" && fmtMoney(40343) === "$40,343");

// ── 3b. like-for-like pool + the comparison card ──────────────────────────────
console.log("\n-- likeForLikePool + marketCompareLine --");
{
  // The eleven rows behind LC-0F75-A93 (fn_market_comps, Lexus RX, used, AB, 2026-09-02).
  const RX = [[2024, "RX 350", 80308, 49251, "A"], [2024, "RX 350", 40654, 53489, "B"], [2024, "RX 350", 34033, 57389, "B"], [2024, "350", 25847, 57999, "C"],
    [2025, "RX 350", 11223, 58700, "A"], [2024, "RX 350h", 15305, 59990, "A"], [2024, "RX 350", 11294, 62700, "A"], [2024, "RX 350h", 28970, 65995, "A"],
    [2024, "RX 500h", 24095, 70998, "A"], [2025, "RX 350", 23580, 72995, "B"], [2024, "RX 500h", 53993, 77988, "B"]]
    .map(([year, trim, odometerKm, price, dealerName]) => ({ year, trim, odometerKm, price, dealerName, asOf: "2026-08-18" }));
  const rx26 = likeForLikePool(RX, { model: "RX", trim: "350 Luxury AWD", year: 2026, condition: "used", odometerKm: 12270 });
  check("2026 RX 350 Luxury, 12,270 km: no like-for-like set (2 read within a year and 37,000 km), so no comparison", rx26.insufficient && rx26.nRead === 2 && rx26.rows.length === 0 && rx26.kmHigh === 37178, JSON.stringify({ ...rx26, rows: undefined, read: undefined }));
  check("... the rows it reports as read are the like-for-like two, never the whole pool (2 listings cannot sit at 3 dealers)", rx26.read.length === 2 && rx26.read.every((r) => r.year === 2025 && r.trim === "RX 350"), JSON.stringify(rx26.read));
  check("... printed years never include a model year that was not read", rx26.yearFrom === 2025 && rx26.yearTo === 2025, `${rx26.yearFrom}-${rx26.yearTo}`);
  const rx24 = likeForLikePool(RX, { model: "RX", trim: "350 Luxury AWD", year: 2024, condition: "used", odometerKm: 30000 });
  check("2024 RX 350, 30,000 km: 6 gas rows within a year and 62,000 km, all trims, no hybrid", rx24.scope === "model" && rx24.rows.length === 6 && rx24.rows.every((r) => !/h$/.test(r.trim)) && rx24.kmHigh === 62000, JSON.stringify({ scope: rx24.scope, n: rx24.rows.length }));
  const stale = likeForLikePool(RX.map((r, i) => (i === 1 ? { ...r, asOf: "2026-07-01" } : r)), { model: "RX", trim: "350 Luxury AWD", year: 2024, condition: "used", odometerKm: 30000, today: "2026-09-02" });
  check("the count line's 30-day window applies here too: a row last seen before it is not read", stale.rows.length === 5 && stale.nRead === 5, `${stale.rows.length}`);
  const hyb = likeForLikePool(RX, { model: "RX", trim: "350h Luxury", year: 2024, condition: "used", odometerKm: 20000, minRows: 2 });
  check("a hybrid subject sees only hybrid rows", hyb.rows.length > 0 && hyb.rows.every((r) => /h$/.test(r.trim)), JSON.stringify(hyb.rows.map((r) => r.trim)));
  const hinted = likeForLikePool(RX, { model: "RX", trim: "Luxury", year: 2024, condition: "used", odometerKm: 20000, minRows: 2, powertrainHint: fuelPowertrainHint("Hybrid Electric") });
  check("a page-declared hybrid (fuelType) whose trim carries no marker still sees only hybrid rows", hinted.rows.length > 0 && hinted.rows.every((r) => /h$/.test(r.trim)) && fuelPowertrainHint("Plug-in Hybrid") === "Plug-in Hybrid" && fuelPowertrainHint("Gasoline") === "", JSON.stringify(hinted.rows.map((r) => r.trim)));
  const newCar = likeForLikePool(RX.map((r) => ({ ...r, odometerKm: 5 })), { model: "RX", trim: "350 Luxury AWD", year: 2024, condition: "new", odometerKm: 5 });
  check("a new subject applies no mileage window", newCar.kmLow == null && newCar.kmHigh == null);
  const noOdo = likeForLikePool(RX, { model: "RX", trim: "350 Luxury AWD", year: 2024, condition: "used", odometerKm: null });
  const zeroOdo = likeForLikePool(RX, { model: "RX", trim: "350 Luxury AWD", year: 2024, condition: "used", odometerKm: 0 });
  check("a used subject with no odometer (null or 0) is never a 0 km car: no 0-20,000 km window, no set, reason odometer_missing", noOdo.insufficient && noOdo.reason === "odometer_missing" && noOdo.kmLow == null && noOdo.kmHigh == null && noOdo.rows.length === 0 && zeroOdo.reason === "odometer_missing" && zeroOdo.kmHigh == null, JSON.stringify({ noOdo: [noOdo.reason, noOdo.kmHigh], zeroOdo: [zeroOdo.reason, zeroOdo.kmHigh] }));
  const noYear = likeForLikePool(RX, { model: "RX", trim: "350", year: null, condition: "used" });
  check("no model year -> insufficient, never a pool", noYear.insufficient && noYear.rows.length === 0 && noYear.reason === "year_missing");
  check("model words are dropped from a trim before keying: 'RX 350 Luxury AWD' keys like '350 Luxury AWD' for model RX", dropModelWords("RX 350 Luxury AWD", "RX") === "350 Luxury AWD" && fullTrimKey(dropModelWords("RX 350 Luxury AWD", "RX")) === fullTrimKey("350 Luxury AWD") && normTrim(dropModelWords("RX 350", "RX")) === "" && dropModelWords("Sport AWD SUV", "HR-V") === "Sport AWD SUV");
  const sameTrim = likeForLikePool(RX.map((r) => ({ ...r, trim: "RX 350 Luxury AWD" })).slice(0, 6), { model: "RX", trim: "350 Luxury AWD", year: 2024, condition: "used", odometerKm: 30000 });
  check("... so six 'RX 350 Luxury AWD' rows match a '350 Luxury AWD' subject at the trim scope, not a meaningless 'RX' family", sameTrim.scope === "trim" && sameTrim.trimLabel === "Luxury", `${sameTrim.scope} ${sameTrim.trimLabel}`);
  const mcModelInTrim = computeMarketCount(RX.map((r) => ({ ...r, year: 2024 })), { year: 2024, make: "Lexus", model: "RX", trim: "RX 350 Luxury AWD", price: 59900, priceVerified: true, province: "AB" });
  check("the count line keys the same way (no 'RX' trim family)", mcModelInTrim.scope === "model" && mcModelInTrim.trimLabel === "Luxury", `${mcModelInTrim.scope} ${mcModelInTrim.trimLabel}`);

  const A = { year: 2024, make: "Lexus", model: "RX", vehicleCondition: "used", priceVerified: true };
  const mv6 = { average: 57999, low: 53489, high: 72995, comps: 6, asOf: "2026-08-18", seenMin: "2026-08-03", seenMax: "2026-08-18", yearFrom: 2024, yearTo: 2025, trimScope: "model", trimLabel: "Luxury", kmLow: 0, kmHigh: 62000, condition: "used", dealers: 2, make: "Lexus", model: "RX", province: "AB" };
  const SIM = "6 used 2024 to 2025 Lexus RX (all trims, same powertrain) with up to 62,000 km at 2 Alberta dealers, read from the dealers' own pages between Aug 3 and Aug 18, 2026: $53,489 to $72,995, middle $57,999 (the median of those 6 asking prices)";
  const g = marketCompareLine({ ...A, quotedPrice: 56000, marketValue: mv6 });
  check("GREEN: at or below the middle", g.light === "green" && g.tone === "pass" && g.value === "$1,999 BELOW THE MIDDLE" && g.askUsed === 56000, `${g.light} ${g.value}`);
  check("three plain lines: this vehicle / similar listings / difference, every figure named", g.lines.length === 3 && g.lines[0].k === "This vehicle" && g.lines[0].v === "$56,000 asking" && g.lines[1].k === "Similar listings in Alberta" && g.lines[1].v === SIM && g.lines[2].v === "$1,999 below the middle of those listings", JSON.stringify(g.lines));
  const bc = marketCompareLine({ ...A, quotedPrice: 56000, marketValue: { ...mv6, province: "BC" } });
  check("the title, the line and the dealers clause name the province the rows were read in", g.title === "How this vehicle compares with the Alberta market" && bc.title === "How this vehicle compares with the British Columbia market" && bc.lines[1].k === "Similar listings in British Columbia" && /at 2 British Columbia dealers/.test(bc.lines[1].v), bc.lines[1].v);
  const am = marketCompareLine({ ...A, quotedPrice: 59900, marketValue: mv6 });
  check("AMBER: above the middle, inside the range", am.light === "amber" && am.tone === "muted" && am.headline === "$1,901 above the middle of similar listings", `${am.light} ${am.headline}`);
  const r = marketCompareLine({ ...A, quotedPrice: 76000, marketValue: mv6 });
  check("RED: above all of the listings compared (bounded to the printed set, never 'every listing read')", r.light === "red" && r.tone === "flag" && r.lightLabel === "Above all 6 similar listings compared", `${r.light} ${r.lightLabel}`);
  const atMid = marketCompareLine({ ...A, quotedPrice: 57999, marketValue: mv6 });
  check("boundaries: at the middle is green, at the top of the range is amber, one dollar above it is red", atMid.light === "green" && atMid.value === "AT THE MIDDLE" && marketCompareLine({ ...A, quotedPrice: 72995, marketValue: mv6 }).light === "amber" && marketCompareLine({ ...A, quotedPrice: 72996, marketValue: mv6 }).light === "red");
  const one = marketCompareLine({ ...A, quotedPrice: 59900, marketValue: { ...mv6, dealers: 1, comps: 1, nRead: 1, seenMin: "2025-12-28", seenMax: "2026-01-03", kmLow: 40000, kmHigh: 160500 } });
  check("grammar: one dealer, one listing, a floored/ceiled window, and read dates across a year change", /with 40,000 km to 161,000 km at 1 Alberta dealer, read from the dealer's own page between Dec 28, 2025 and Jan 3, 2026/.test(one.lines[1].v) && /^1 similar listing ·/.test(one.meta), `${one.lines[1].v} | ${one.meta}`);
  const trimS = marketCompareLine({ ...A, quotedPrice: 59900, marketValue: { ...mv6, trimScope: "trim", trimLabel: "Luxury" } });
  const famS = marketCompareLine({ ...A, quotedPrice: 59900, marketValue: { ...mv6, trimScope: "trim_family", trimLabel: "Luxury Executive" } });
  const newS = marketCompareLine({ ...A, vehicleCondition: "new", quotedPrice: 59900, marketValue: { ...mv6, condition: "new", kmLow: null, kmHigh: null } });
  check("scopes: same trim / trim family (no double 'with') / a new set with no mileage window", /^6 used 2024 to 2025 Lexus RX Luxury with up to 62,000 km/.test(trimS.lines[1].v) && /^6 used 2024 to 2025 Lexus RX whose trim begins "Luxury" with up to 62,000 km/.test(famS.lines[1].v) && /^6 new 2024 to 2025 Lexus RX \(all trims, same powertrain\) at 2 Alberta dealers/.test(newS.lines[1].v), [trimS.lines[1].v, famS.lines[1].v, newS.lines[1].v].join(" | "));
  const outC = marketCompareLine({ ...A, quotedPrice: 59900, marketValue: { ...mv6, nRead: 8, comps: 6 } });
  check("a confirmed set names the rows the price-outlier trim left out, so its N and the count line's N never disagree in silence", /\(the median of those 6 asking prices\); 2 more were read and left out as price outliers$/.test(outC.lines[1].v), outC.lines[1].v);
  const MVN = { average: null, insufficient: true, nRead: 2, need: 5, yearFrom: 2025, yearTo: 2025, kmLow: 0, kmHigh: 37178, condition: "used", dealers: 2, asOf: "2026-08-18", seenMin: "2026-08-18", seenMax: "2026-08-18", make: "Lexus", model: "RX", province: "AB" };
  const none = marketCompareLine({ ...A, quotedPrice: 69898, year: 2026, marketValue: MVN });
  check("NOT ENOUGH: says how many were read (mileage ceiling rounded UP) and that none is made", none.state === "insufficient" && none.light === null && none.value === "NOT ENOUGH TO COMPARE" && none.body === "2 used 2025 Lexus RX (all trims, same powertrain) with up to 38,000 km at 2 Alberta dealers were read from the dealers' own pages on Aug 18, 2026. 5 are needed for a fair comparison, so none is made here.", none.body);
  const oneRead = marketCompareLine({ ...A, quotedPrice: 69898, year: 2026, marketValue: { ...MVN, nRead: 1, dealers: 1 } });
  check("... one row: 'was read', 'the dealer's own page'", oneRead.body.startsWith("1 used 2025 Lexus RX (all trims, same powertrain) with up to 38,000 km at 1 Alberta dealer was read from the dealer's own page on Aug 18, 2026."), oneRead.body);
  const zero = marketCompareLine({ ...A, quotedPrice: 69898, year: 2026, marketValue: { ...MVN, nRead: 0, dealers: null, asOf: null, seenMin: null, seenMax: null, yearFrom: 2025, yearTo: 2026 } });
  check("NONE READ: no dealer count and no date are attributed to an empty set", zero.state === "insufficient" && zero.body === "No used 2025 to 2026 Lexus RX with up to 38,000 km were among the listings read from Alberta dealers' own pages. 5 are needed for a fair comparison, so none is made here.", zero.body);
  const outl = marketCompareLine({ ...A, quotedPrice: 59900, marketValue: { ...MVN, nRead: 6, nKept: 4, trimScope: "model", yearFrom: 2024, yearTo: 2025, kmHigh: 62000 } });
  check("OUTLIERS: '6 read, 5 needed, none made' can never appear -- the rows left out are named", outl.body === "6 used 2024 to 2025 Lexus RX (all trims, same powertrain) with up to 62,000 km at 2 Alberta dealers were read from the dealers' own pages on Aug 18, 2026. 2 of them were left out as price outliers. 5 are needed for a fair comparison, so none is made here.", outl.body);
  const sameN = marketCompareLine({ ...A, quotedPrice: 59900, marketValue: { ...MVN, nRead: 2, nKept: 2 } });
  check("... and no outlier clause when nothing was left out", !/left out/.test(sameN.body), sameN.body);
  const noOdoLine = marketCompareLine({ ...A, quotedPrice: 59900, marketValue: { average: null, insufficient: true, nRead: 0, reason: "odometer_missing", yearFrom: 2024, yearTo: 2024, condition: "used", make: "Lexus", model: "RX", province: "AB" } });
  check("ODOMETER NOT READ: not compared, says why, never 'No ... were read'", noOdoLine.value === "NOT COMPARED" && noOdoLine.headline === "Not compared: odometer not read" && /odometer was not read from the page/.test(noOdoLine.body) && !/were among/.test(noOdoLine.body) && noOdoLine.lines[2].v === "not made", noOdoLine.body);
  const noAsk = marketCompareLine({ ...A, quotedPrice: null, marketValue: mv6 });
  check("no asking price: middle stated, no difference worked out, no light", noAsk.light === null && /no asking price is shown/.test(noAsk.lines[2].v) && noAsk.value === "MIDDLE $57,999" && noAsk.askUsed === null, noAsk.value);
  const unv = marketCompareLine({ ...A, priceVerified: false, quotedPrice: 59900, marketValue: mv6 });
  check("an unverified price is shown but never measured (the count line's refusal): no light, no difference", unv.light === null && unv.askUsed === null && /^not worked out: this page's asking price could not be verified/.test(unv.lines[2].v) && unv.value === "MIDDLE $57,999", unv.lines[2].v);
  const fc = marketCompareLine({ ...A, quotedPrice: 59900, financeContingent: { contingent: true }, marketValue: mv6 });
  check("a finance-contingent price is shown but never measured", fc.light === null && fc.askUsed === null && /depends on financing with the dealer/.test(fc.lines[2].v), fc.lines[2].v);
  // /verify builds its argument with this exact expression (src/App.jsx, pinned by check:parity).
  const verifyArg = (o) => ({ price: o.price, marketValue: o.marketValue, fcx: o.fcx, vehicle: (o.marketValue.yf && o.marketValue.yt) ? String(o.vehicle || "").replace(/^\s*(?:19|20)\d{2}\s+/, "") : o.vehicle });
  const V4 = { avg: 59990, below: 55000, above: 65000, lo: 49251, hi: 77988, mileage: 12270, source: "LotCheck market · all trims · 11 comparable listings", n: 11, as: "2026-08-18" };
  const v4 = marketCompareLine(verifyArg({ price: { asking: 69898, verified: true }, marketValue: V4, vehicle: "2026 Lexus RX 350 Luxury AWD", fcx: null }));
  check("a link sealed before the basis rode along (the real v4 keys, fed as /verify feeds them): never named, never dated, never lit", v4.state === "confirmed" && v4.light === null && !/Lexus|2026|Aug 18|dealers/.test(v4.lines[1].v) && /^middle \$59,990 across 11 listings; what those listings were \(model year, trim, mileage\) was not sealed with this report/.test(v4.lines[1].v) && v4.value === "$9,908 ABOVE THE MIDDLE" && !/\$0\b/.test(JSON.stringify(v4)), JSON.stringify(v4.lines));
  const legacy = marketCompareLine({ price: { asking: 59900, verified: true }, vehicle: "Lexus RX 350 Luxury AWD", marketValue: { avg: 57999, below: 55000, above: 60000, l: 50000, h: 65000, s: "LotCheck market", n: "note" } });
  check("... and a v3 seal (no range at all): the middle alone, no $0, no light", legacy.state === "confirmed" && legacy.light === null && !/\$0\b/.test(JSON.stringify(legacy)) && /^middle \$57,999; what those listings were/.test(legacy.lines[1].v), JSON.stringify(legacy.lines));
  const compact = marketCompareLine(verifyArg({ price: { asking: 59900, verified: true }, vehicle: "2024 Lexus RX 350 Luxury AWD", fcx: null, marketValue: { avg: 57999, lo: 53489, hi: 72995, n: 6, as: "2026-08-18", from: "2026-08-03", to: "2026-08-18", yf: 2024, yt: 2025, ts: "model", tl: "Luxury", kl: 0, kh: 62000, cd: "used", d: 2, mk: "Lexus", md: "RX", pv: "AB" } }));
  check("sealed compact form (the /verify shape: no make/model on the analysis) renders the SAME lines as the full form", JSON.stringify(compact.lines) === JSON.stringify(am.lines) && compact.light === am.light && compact.title === am.title, JSON.stringify(compact.lines));
  const hybC = marketCompareLine({ price: { asking: 40000, verified: true }, vehicle: "Toyota RAV4 Hybrid XSE", marketValue: { avg: 41000, lo: 38000, hi: 45000, n: 5, as: "2026-08-18", yf: 2025, yt: 2025, ts: "model", pt: "Hybrid", cd: "used", mk: "Toyota", md: "RAV4", pv: "AB" } });
  const phevC = marketCompareLine({ price: { asking: 50000, verified: true }, vehicle: "Toyota RAV4 Plug-in Hybrid XSE", marketValue: { avg: 51000, lo: 48000, hi: 55000, n: 5, as: "2026-08-18", yf: 2025, yt: 2025, ts: "model", pt: "Plug-in Hybrid", cd: "used", mk: "Toyota", md: "RAV4", pv: "AB" } });
  check("a hybrid or plug-in subject's set is named make + model + powertrain, never a bare 'Hybrid'", /^5 used 2025 Toyota RAV4 Hybrid \(all trims, same powertrain\)/.test(hybC.lines[1].v) && /^5 used 2025 Toyota RAV4 Plug-in Hybrid \(all trims/.test(phevC.lines[1].v), hybC.lines[1].v + " | " + phevC.lines[1].v);
  const hybNoMk = marketCompareLine({ price: { asking: 40000, verified: true }, vehicle: "Toyota RAV4 Hybrid XSE", marketValue: { avg: 41000, lo: 38000, hi: 45000, n: 5, as: "2026-08-18", yf: 2025, yt: 2025, ts: "model", pt: "Hybrid", cd: "used" } });
  check("... and without a sealed make/model the set is not named at all (never the subject's trim, never 'Hybrid' alone)", hybNoMk.light === null && !/Hybrid|XSE|2025/.test(hybNoMk.lines[1].v) && /was not sealed with this report/.test(hybNoMk.lines[1].v), hybNoMk.lines[1].v);
  const basisMissing = marketCompareLine({ ...A, quotedPrice: 59900, marketValue: { average: null, insufficient: true, reason: "basis_missing" } });
  check("a set whose basis was not recorded says exactly that -- never '0 were read', never 'not enough'", basisMissing.state === "insufficient" && basisMissing.value === "NOT COMPARED" && basisMissing.headline === "Comparison set not recorded" && /what it was made of was not recorded/.test(basisMissing.body) && !/\b0\b/.test(basisMissing.body), basisMissing.body);
  check("no marketValue at all -> not compared, never a number", marketCompareLine({ ...A }).value === "NOT COMPARED");
  // Round trip through the SERVER canonical: the sealed projection, fed to the
  // builder the way /verify feeds it, words the same three lines as the report.
  const { canonicalReport } = await import("../supabase/functions/_shared/report-sign.ts");
  const full = { ...A, vehicle: "2024 Lexus RX 350 Luxury AWD", quotedPrice: 59900, marketValue: mv6 };
  const c = canonicalReport(full);
  check("the canonical is v10 and seals the basis keys", c.v === 10 && c.marketValue.mk === "Lexus" && c.marketValue.pv === "AB" && c.marketValue.from === "2026-08-03", JSON.stringify(c.marketValue));
  const viaVerify = marketCompareLine(verifyArg(c));
  check("the signed canonical round-trips the FULL sentence (make, model, province, dates, dealers)", JSON.stringify(viaVerify.lines) === JSON.stringify(am.lines) && viaVerify.light === am.light && viaVerify.title === am.title, JSON.stringify(viaVerify.lines));
  const cNone = canonicalReport({ ...A, year: 2026, vehicle: "2026 Lexus RX 350 Luxury AWD", quotedPrice: 69898, marketValue: MVN });
  check("... and the not-enough state round-trips too", marketCompareLine(verifyArg(cNone)).body === none.body, marketCompareLine(verifyArg(cNone)).body);
  const cFcx = canonicalReport({ ...A, vehicle: "2024 Lexus RX 350 Luxury AWD", quotedPrice: 59900, financeContingent: { contingent: true, reasons: ["payment shown depends on dealer financing"] }, marketValue: mv6 });
  const vFcx = marketCompareLine(verifyArg(cFcx));
  check("/verify (the app's own call shape) refuses a finance-contingent price exactly as the report does", vFcx.light === null && vFcx.askUsed === null && /depends on financing/.test(vFcx.lines[2].v), JSON.stringify(vFcx.lines[2]));
  const cOdo = canonicalReport({ ...A, vehicle: "2024 Lexus RX 350 Luxury AWD", quotedPrice: 59900, marketValue: { average: null, insufficient: true, nRead: 0, reason: "odometer_missing", yearFrom: 2024, yearTo: 2024, condition: "used", make: "Lexus", model: "RX", province: "AB" } });
  check("... and the odometer-not-read reason round-trips (rs sealed)", marketCompareLine(verifyArg(cOdo)).headline === "Not compared: odometer not read");
  const old = ["local middle value", "middle value", "band", "comparable used", "every similar listing read", "half asked"];
  const texts = [g, am, r, none, zero, outl, noAsk, unv, fc, legacy, compact, hybC, one, trimS, famS, newS, outC, noOdoLine, v4].flatMap((l) => [l.body, l.headline, l.value, l.lightLabel || "", ...l.lines.map((x) => x.v)]);
  check("the retired phrasing is gone", !texts.some((t) => old.some((w) => t.toLowerCase().includes(w))), texts.filter((t) => old.some((w) => t.toLowerCase().includes(w))).join(" | "));
}

// ── 3c. older model years: the ladder + the line ──────────────────────────────
console.log("\n-- olderYearsLadder + olderYearsLine --");
{
  const mk = (rows) => rows.map(([year, trim, odometerKm, price, dealerName, asOf]) => ({ year, trim, odometerKm, price, dealerName, asOf: asOf || (year === 2023 ? "2026-08-03" : "2026-08-18") }));
  // The eleven real RX rows (LC-0F75-A93) plus nine shaped like them, as
  // fn_market_comps returns them for a 2026 subject (p_year 2024, span 1, used).
  const RX = mk([[2024, "RX 350", 80308, 49251, "A"], [2024, "RX 350", 40654, 53489, "B"], [2024, "RX 350", 34033, 57389, "B"], [2024, "350", 25847, 57999, "C"],
    [2025, "RX 350", 11223, 58700, "A"], [2024, "RX 350h", 15305, 59990, "A"], [2024, "RX 350", 11294, 62700, "A"], [2024, "RX 350h", 28970, 65995, "A"],
    [2024, "RX 500h", 24095, 70998, "A"], [2025, "RX 350", 23580, 72995, "B"], [2024, "RX 500h", 53993, 77988, "B"],
    [2025, "RX 350", 30100, 61500, "C"], [2025, "RX 350", 18000, 60900, "A"], [2025, "RX 350", 41000, 55900, "B"],
    [2023, "RX 350", 60000, 47900, "A"], [2023, "RX 350", 71000, 45500, "B"], [2023, "RX 350", 52000, 49900, "C"], [2023, "RX 350", 88000, 41900, "A"], [2023, "RX 350h", 50000, 52900, "B"], [2023, "RX 350", 95000, 39900, "B"]]);
  const lad = olderYearsLadder(RX, { model: "RX", trim: "350 Luxury AWD", year: 2026, today: "2026-09-02" });
  check("2026 RX 350: three rungs (2025, 2024, 2023), gas only, all trims, newest first", lad.state === "confirmed" && lad.scope === "model" && lad.rungs.map((r) => r.year).join(",") === "2025,2024,2023" && lad.rungs.every((r) => r.n >= 5), JSON.stringify(lad.rungs.map((r) => [r.year, r.n])));
  check("... each rung carries what it read, what it kept, how many showed mileage, its own range, dealers and dates", lad.rungs[0].n === 5 && lad.rungs[0].nRead === 5 && lad.rungs[0].kmKnown === 5 && lad.rungs[0].kmLow === 11223 && lad.rungs[0].kmHigh === 41000 && lad.rungs[0].dealers === 3 && lad.rungs[0].median === 60900 && lad.rungs[0].seenMax === "2026-08-18", JSON.stringify(lad.rungs[0]));
  check("... the 2024 rung leaves the four hybrids out (5 gas of 9 RX rows)", lad.rungs[1].n === 5 && lad.rungs[1].median === 57389, JSON.stringify(lad.rungs[1]));
  check("... the 2023 rung is dated by its own rows (Aug 3), the ladder by all of them (Aug 3 to Aug 18)", lad.rungs[2].seenMax === "2026-08-03" && lad.seenMin === "2026-08-03" && lad.seenMax === "2026-08-18", `${lad.seenMin}..${lad.seenMax}`);
  const stale = olderYearsLadder(RX, { model: "RX", trim: "350 Luxury AWD", year: 2026, today: "2026-09-10" });
  check("the 30-day window applies per rung: on Sep 10 the Aug 3 rows (2023) drop out and that rung is gone", stale.rungs.map((r) => r.year).join(",") === "2025,2024", JSON.stringify(stale.rungs.map((r) => r.year)));
  const hybLad = olderYearsLadder(RX, { model: "RX", trim: "350h Luxury", year: 2026, minRows: 2 });
  check("a hybrid subject's rungs hold only hybrid rows", hybLad.rungs.length > 0 && hybLad.rungs.every((r) => r.n <= 4) && hybLad.rungs[0].low === 59990, JSON.stringify([hybLad.scope, hybLad.rungs.map((r) => [r.year, r.n])]));
  const hybModel = olderYearsLadder(RX, { model: "RX", trim: "Luxury", year: 2026, minRows: 2, powertrainHint: fuelPowertrainHint("Hybrid") });
  check("... and a page-declared hybrid with no marker in its trim sees the four 2024 hybrids, none of the gas ones", hybModel.rungs.length >= 1 && hybModel.rungs[0].n === 4 && hybModel.rungs[0].low === 59990 && hybModel.rungs[0].high === 77988, JSON.stringify(hybModel.rungs.map((r) => [r.year, r.n])));
  check("no subject year -> reason year_missing; a subject-year or newer row is never a rung", olderYearsLadder(RX, { model: "RX", trim: "350", year: null }).reason === "year_missing" && olderYearsLadder(RX, { model: "RX", trim: "350", year: 2024 }).rungs.every((r) => r.year < 2024));
  // A pool at the RPC's size limit is the CHEAPEST rows: every middle would print low.
  const trunc = olderYearsLadder(RX, { model: "RX", trim: "350 Luxury AWD", year: 2026, today: "2026-09-02", truncated: true });
  check("a truncated pool states nothing, with its own reason -- never a middle built from the cheapest rows", trunc.state === "insufficient" && trunc.reason === "pool_truncated" && trunc.rungs.length === 0, JSON.stringify({ st: trunc.state, rs: trunc.reason }));

  const A = { year: 2026, make: "Lexus", model: "RX", priceVerified: true };
  const OY = { ...lad, make: "Lexus", model: "RX", province: "AB" };
  const c = olderYearsLine({ ...A, quotedPrice: 69898, olderYears: OY });
  check("CONFIRMED: this vehicle, then one line per older year with count, mileage range, dealers, dates, middle and the difference", c.state === "confirmed" && c.lines.length === 4 && c.lines[0].v === "2026 · $69,898 asking" && c.lines[1].k === "One year older (2025)" && c.lines[1].v === "5 used 2025 Lexus RX (all trims, same powertrain), 11,000 km to 41,000 km at 3 Alberta dealers, read on Aug 18, 2026: middle $60,900, $8,998 less than this asking price", JSON.stringify(c.lines));
  check("... the tile and the verify row carry ONE short figure; every model year is in the lines", c.value === "ONE YEAR OLDER $8,998 LESS" && c.value.length <= 32 && c.headline === "One year older asks $8,998 less" && c.meta === "3 model years stated · all trims, same powertrain · read between Aug 3 and Aug 18, 2026" && c.askUsed === 69898, `${c.value} | ${c.headline}`);
  check("... the note names asking prices and dates, and claims nothing about this vehicle's value", c.note === "Middle asking prices of older ones on dealers' own pages on the dates shown, not sale prices.");
  // A rung that reached the floor and then lost rows to the price-outlier trim
  // must never be reported as "no listings" -- the dealer can show those rows.
  const out6 = mk([[2025, "RX 350", 20000, 1000, "A"], [2025, "RX 350", 21000, 500000, "B"], [2025, "RX 350", 22000, 50000, "C"], [2025, "RX 350", 23000, 51000, "A"], [2025, "RX 350", 24000, 52000, "B"], [2025, "RX 350", 25000, 53000, "C"]]);
  const lo = olderYearsLadder(out6, { model: "RX", trim: "350", year: 2026, today: "2026-09-02" });
  check("six read in one year, four kept after the outlier trim: the year is NAMED, not silently dropped", lo.state === "insufficient" && lo.rungs.length === 0 && JSON.stringify(lo.missing) === JSON.stringify([{ year: 2025, nRead: 6, nKept: 4 }]), JSON.stringify(lo.missing));
  const lol = olderYearsLine({ ...A, quotedPrice: 69898, olderYears: { ...lo, make: "Lexus", model: "RX", province: "AB" } });
  check("... and the sentence says so, never 'no single model year had 5 or more listings'", lol.lines[1].v === "6 used 2025 Lexus RX (all trims, same powertrain) were read and 2 were left out as price outliers, leaving 4; 5 are needed, so nothing is stated for that model year" && /No single model year had 5 or more once price outliers were left out/.test(lol.body) && !/had 5 or more listings/.test(lol.body), lol.body);
  // A mileage range covers only the listings that show a reading.
  const part = mk([[2025, "RX 350", null, 50000, "A"], [2025, "RX 350", 21000, 51000, "B"], [2025, "RX 350", 0, 52000, "C"], [2025, "RX 350", 22000, 53000, "A"], [2025, "RX 350", null, 54000, "B"]]);
  const lp = olderYearsLadder(part, { model: "RX", trim: "350", year: 2026, today: "2026-09-02" });
  const lpl = olderYearsLine({ ...A, quotedPrice: 69898, olderYears: { ...lp, make: "Lexus", model: "RX", province: "AB" } });
  check("a kilometre range is never attributed to listings that show no reading", lp.rungs[0].kmKnown === 2 && /21,000 km to 22,000 km on the 2 of 5 that show a reading/.test(lpl.lines[1].v), lpl.lines[1].v);
  const noKm = olderYearsLadder(mk([[2025, "RX 350", null, 50000, "A"], [2025, "RX 350", null, 51000, "B"], [2025, "RX 350", null, 52000, "C"], [2025, "RX 350", null, 53000, "A"], [2025, "RX 350", null, 54000, "B"]]), { model: "RX", trim: "350", year: 2026 });
  const noKmL = olderYearsLine({ ...A, quotedPrice: 69898, olderYears: { ...noKm, make: "Lexus", model: "RX", province: "AB" } });
  check("... and when none shows one, the line says so instead of a range", /no odometer reading on those pages/.test(noKmL.lines[1].v) && !/km to/.test(noKmL.lines[1].v), noKmL.lines[1].v);
  const trl = olderYearsLine({ ...A, quotedPrice: 69898, olderYears: { ...trunc, make: "Lexus", model: "RX", province: "AB" } });
  check("a truncated set says the dearest listings are missing, and states nothing", trl.state === "insufficient" && /came back at its size limit, so the dearest listings are missing from it/.test(trl.body) && !/middle \$/.test(trl.body), trl.body);
  const noAsk = olderYearsLine({ ...A, quotedPrice: null, olderYears: OY });
  check("no asking price: middles stated per year, no differences", noAsk.state === "confirmed" && noAsk.askUsed === null && /no asking price shown/.test(noAsk.lines[0].v) && !/less than/.test(noAsk.lines[1].v) && noAsk.value === "ONE YEAR OLDER MIDDLE $60,900", noAsk.value);
  const unv = olderYearsLine({ ...A, priceVerified: false, quotedPrice: 69898, olderYears: OY });
  const fc = olderYearsLine({ ...A, quotedPrice: 69898, financeContingent: { contingent: true }, olderYears: OY });
  check("an unverified or finance-contingent price is shown but never measured", unv.askUsed === null && /could not be verified/.test(unv.lines[0].v) && !/less than/.test(unv.lines[1].v) && fc.askUsed === null && /depends on financing/.test(fc.lines[0].v), unv.lines[0].v + " | " + fc.lines[0].v);
  const cheaper = olderYearsLine({ ...A, quotedPrice: 50000, olderYears: OY });
  check("an older year asking MORE than this vehicle says so, never a negative 'less'", /\$10,900 more than this asking price/.test(cheaper.lines[1].v) && /MORE/.test(cheaper.value), cheaper.lines[1].v);
  const thin = olderYearsLadder(RX.filter((r) => r.year === 2023).slice(0, 3), { model: "RX", trim: "350", year: 2026 });
  const ins = olderYearsLine({ ...A, quotedPrice: 69898, olderYears: { ...thin, make: "Lexus", model: "RX", province: "AB", seenMin: "2026-08-03", seenMax: "2026-08-03" } });
  check("NOT ENOUGH: names the powertrain scope, how many were read and that nothing is stated per year", ins.state === "insufficient" && ins.value === "NOT ENOUGH TO STATE" && ins.body === "3 used Lexus RX (all trims, same powertrain) one to three model years older than this 2026 were read from Alberta dealers' own pages on Aug 3, 2026. No single model year had 5 or more listings, so nothing is stated per model year.", ins.body);
  const zero = olderYearsLine({ ...A, quotedPrice: 69898, olderYears: { state: "insufficient", nRead: 0, need: 5, subjectYear: 2026, make: "Lexus", model: "RX", province: "AB", rungs: [], missing: [] } });
  check("NONE READ: no date attributed to an empty set", /^No used Lexus RX one to three model years older than this 2026 were among the listings read from Alberta dealers' own pages/.test(zero.body) && !/Aug/.test(zero.body), zero.body);
  for (const [reason, needle] of [["outside_province", /British Columbia/], ["province_unknown", /province could not be established/], ["identity_missing", /year, make or model/], ["condition_unknown", /new or used/], ["timeout", /did not come back in time/], ["no_page", /uploaded quote/], [null, /no older listings were read/]]) {
    const l = olderYearsLine({ ...A, quotedPrice: 69898, olderYears: { state: "unchecked", reason, province: reason === "outside_province" ? "BC" : null, rungs: [] } });
    check(`unchecked (${reason}) says why, and prints no meta beside the same words`, l.state === "unchecked" && l.value === "NOT READ" && needle.test(l.body) && !l.meta, l.body);
  }
  check("no olderYears at all -> not read, never a number", olderYearsLine({ ...A }).value === "NOT READ");
  const bm = olderYearsLine({ ...A, quotedPrice: 69898, olderYears: { state: "insufficient", reason: "basis_missing", rungs: [] } });
  check("basis not recorded says exactly that", bm.value === "NOT COMPARED" && /was not recorded/.test(bm.body), bm.body);
  const noSy = olderYearsLine({ ...A, quotedPrice: 69898, olderYears: { ...OY, subjectYear: null } });
  check("a ladder that did not record what it is older than describes nothing (never the subject's own year)", noSy.value === "NOT COMPARED" && !/2025|2024|2023/.test(noSy.body), noSy.body);
  // The scope that states the most model years wins; whatever it cannot state is named.
  const sc = mk([...Array(5).fill(0).map((_, i) => [2025, "350 Luxury AWD", 20000 + i * 1000, 60000 + i * 100, "A"]), ...Array(3).fill(0).map((_, i) => [2024, "350 Luxury AWD", 40000 + i * 1000, 55000 + i * 100, "B"]), ...Array(8).fill(0).map((_, i) => [2024, "350 Premium", 45000 + i * 1000, 52000 + i * 100, "C"])]);
  const ls = olderYearsLadder(sc, { model: "RX", trim: "350 Luxury AWD", year: 2026, today: "2026-09-02" });
  check("one scope for every rung: the scope that states the most model years wins", ls.scope === "model" && ls.rungs.map((r) => [r.year, r.n]).flat().join(",") === "2025,5,2024,11", JSON.stringify([ls.scope, ls.rungs.map((r) => [r.year, r.n])]));
  // Sealed round trip through the SERVER canonical, fed as /verify feeds it.
  const { canonicalReport } = await import("../supabase/functions/_shared/report-sign.ts");
  const cc = canonicalReport({ ...A, vehicle: "2026 Lexus RX 350 Luxury AWD", quotedPrice: 69898, olderYears: OY });
  check("the canonical is v10 and seals every rung with its basis", cc.v === 10 && cc.oy && cc.oy.st === "confirmed" && cc.oy.r.length === 3 && cc.oy.r[0].kl === 11223 && cc.oy.r[0].kn === 5 && cc.oy.r[0].rd === 5 && cc.oy.r[0].to === "2026-08-18" && cc.oy.mk === "Lexus" && cc.oy.from === "2026-08-03", JSON.stringify(cc.oy).slice(0, 300));
  const viaVerify = olderYearsLine({ price: cc.price, oy: cc.oy, fcx: cc.fcx });
  check("the signed canonical round-trips the SAME lines (make, model, province, dates, dealers, ranges)", JSON.stringify(viaVerify.lines) === JSON.stringify(c.lines) && viaVerify.value === c.value && viaVerify.headline === c.headline && viaVerify.meta === c.meta, JSON.stringify(viaVerify.lines));
  const ccOut = canonicalReport({ ...A, quotedPrice: 69898, olderYears: { ...lo, make: "Lexus", model: "RX", province: "AB" } });
  check("... and the outlier-named state round-trips (the years it could not state ride along)", olderYearsLine({ price: ccOut.price, oy: ccOut.oy }).lines[1].v === lol.lines[1].v, JSON.stringify(ccOut.oy.ms));
  const ccFcx = canonicalReport({ ...A, quotedPrice: 69898, financeContingent: { contingent: true, reasons: ["x"] }, olderYears: OY });
  check("... and the finance-contingent refusal round-trips through fcx", olderYearsLine({ price: ccFcx.price, oy: ccFcx.oy, fcx: ccFcx.fcx }).askUsed === null);
  const ccIns = canonicalReport({ ...A, quotedPrice: 69898, olderYears: { ...thin, make: "Lexus", model: "RX", province: "AB", seenMin: "2026-08-03", seenMax: "2026-08-03" } });
  check("... and the not-enough state round-trips", olderYearsLine({ price: ccIns.price, oy: ccIns.oy }).body === ins.body, olderYearsLine({ price: ccIns.price, oy: ccIns.oy }).body);
  const texts = [c, noAsk, unv, fc, cheaper, ins, zero, bm, lol, lpl, trl, noKmL].flatMap((l) => [l.body, l.headline, l.value, l.note || "", l.meta || "", ...l.lines.map((x) => x.v)]);
  check("nothing empty in any state", texts.every((t) => typeof t === "string"));
}

// ── 3d. insurance before you sign ─────────────────────────────────────────────
console.log("\n-- financeCoverageLine --");
{
  const AB = { marketCount: { province: "AB" } };
  const fin = financeCoverageLine({ ...AB, pageDefault: { state: "confirmed", termMonths: 84, apr: 5.99, paymentAmount: 267 } });
  check("a page showing a financing payment leads with that fact", fin.state === "confirmed" && /^This page shows a financing payment\. The AIRB reports that optional coverages/.test(fin.lines[0].v) && fin.meta === "Financing shown on this page · Alberta", fin.lines[0].v);
  const gen = financeCoverageLine({ ...AB });
  check("a page with no financing signal still carries the warning, worded conditionally", gen.state === "general" && /^The AIRB reports that optional coverages/.test(gen.lines[0].v) && gen.lines.length === 5 && gen.meta === "Alberta rules · applies whether or not you finance", gen.meta);
  const fcx = financeCoverageLine({ ...AB, financeContingent: { contingent: true } });
  check("a finance-contingent price counts as financing shown", fcx.state === "confirmed" && /^This page's price depends on financing with the dealer\./.test(fcx.lines[0].v));
  check("a finance-contingent flag that is FALSE does not", financeCoverageLine({ ...AB, financeContingent: { contingent: false } }).state === "general");
  const cash = financeCoverageLine({ ...AB, pageDefault: { state: "confirmed", purchaseMethod: "cash", termMonths: 84, apr: 2.99, paymentAmount: 196 } });
  check("a cash-first page is worded as the payment card words it, never as 'shows a financing payment'", /^This page opens on its cash price and also shows a financing option\./.test(cash.lines[0].v), cash.lines[0].v);
  // The dealer APR field carries the model's own unconfirmed read on some paths
  // (it once stated 25% for a page that disclosed none). It is never a trigger.
  const aprOnly = financeCoverageLine({ ...AB, financeRates: { dealer: { apr: 25, source: "llm" } } });
  const sealedAprOnly = financeCoverageLine({ mc: { pv: "AB" }, finance: { dealer: 25 } });
  check("an untrusted dealer APR never makes the card claim the page shows financing", aprOnly.state === "general" && !/advertises a financing rate/.test(JSON.stringify(aprOnly)) && sealedAprOnly.state === "general", `${aprOnly.state}/${sealedAprOnly.state}`);
  const quote = financeCoverageLine({ marketCount: { state: "unchecked", reason: "no_page", province: "AB" }, pageDefault: { state: "unchecked", reason: "no_page" }, financeRates: { dealer: { apr: 25, source: "llm" } } });
  check("an uploaded quote with no page never says 'this page' anything", quote.state === "general" && !/This page/.test(quote.body), quote.lines[0].v);
  const zeroApr = financeCoverageLine({ ...AB, pageDefault: { state: "confirmed", apr: 0 } });
  check("a real 0% promotional rate on the page still counts as financing shown", zeroApr.state === "confirmed");
  const sealed = financeCoverageLine({ mc: { pv: "AB" }, dflt: { st: "confirmed", t: 84, a: 5.99, p: 267 }, fcx: null });
  const sealedGen = financeCoverageLine({ mc: { pv: "AB" } });
  check("the sealed compact form (the /verify shape) renders the SAME lines in both states", JSON.stringify(sealed.lines) === JSON.stringify(fin.lines) && sealed.meta === fin.meta && JSON.stringify(sealedGen.lines) === JSON.stringify(gen.lines) && sealedGen.meta === gen.meta, JSON.stringify(sealed.lines[0]));
  check("Alberta statute is printed only where it applies, and a user-typed province never arms it", financeCoverageApplies({ marketCount: { province: "AB" } }) === true
    && financeCoverageApplies({ marketCount: { province: "BC" } }) === false
    && financeCoverageApplies({ marketValue: { province: "AB" } }) === true
    && financeCoverageApplies({ oy: { pv: "AB" } }) === true
    && financeCoverageApplies({ province: "AB" }) === false
    && financeCoverageApplies({ marketCount: { province: "ab" } }) === true
    && financeCoverageApplies({ marketCount: { province: " AB " } }) === false
    && financeCoverageApplies({}) === false
    && financeCoverageApplies(null) === false
    && provinceOf({ mc: { pv: "AB" } }) === "AB");
  check("a province conflict fails to the dealer page's own reading", financeCoverageApplies({ marketCount: { province: "BC" }, olderYears: { province: "AB" } }) === false
    && financeCoverageApplies({ marketCount: { state: "unchecked", reason: "outside_province", province: "BC" } }) === false);
  check("both halves always ship together: the 2024 restriction and the October 2025 correction", /starting in early 2024/.test(fin.lines[2].v) && /as of October 2025 AR 227\/2025/.test(fin.lines[3].v) && /removing these restrictions/.test(fin.lines[3].v));
  check("it never says a buyer may be unable to insure the vehicle", ![...fin.lines.map((l) => l.v), fin.body, fin.headline, fin.explain].some((t) => /unable to insure|cannot insure|can't insure|uninsurable|refused insurance|no insurer will/i.test(t)));
  check("every clause is attributed to the AIRB, never asserted in our own voice", fin.lines.slice(0, 4).every((l) => /The AIRB reports/.test(l.v)), JSON.stringify(fin.lines.map((l) => l.v.slice(0, 40))));
  check("it names its source, both pages, and the date it was read", /pages 8 and 22, published 2026\. Read 2026-09-03/.test(fin.note) && /docs\/airb-2026-capture\.md/.test(fin.note), fin.note);
  check("the only dollar figure names what it is a deductible OF, and keeps the regulator's 'such as'", (fin.body.match(/\$[\d,]+/g) || []).join(",") === "$2,000" && /forced them to choose a deductible such as \$2,000 or more/.test(fin.lines[2].v), fin.lines[2].v);
  check("the action names the buyer's own insurer, and the sequence is stated as the general case", /Ask your own insurer to confirm/.test(fin.lines[4].v) && /A finance or lease contract is typically signed at the dealership, before the insurance is bound\./.test(fin.lines[4].v));
  check("the one-sentence explain is worded by the builder, carries the hedge and the attribution, and is no stronger than the lines", /^The AIRB reports that collision and comprehensive may be required/.test(fin.explain) && /Take All Comers rule covers only the mandatory coverages/.test(fin.explain) && fin.explain === gen.explain, fin.explain);
  check("the tile value is short enough for a rail tile and a verify row", fin.value.length <= 32 && fin.headline.length <= 48, `${fin.value.length}/${fin.headline.length}`);
}

// ── 3e. your premium after this purchase ──────────────────────────────────────
console.log("\n-- insurancePremiumLine --");
{
  const l = insurancePremiumLine({ marketCount: { province: "AB" } });
  check("four lines, on the same Alberta gate as its sibling", l.state === "confirmed" && l.lines.length === 4 && albertaRulesApply({ marketCount: { province: "AB" } }) === true && albertaRulesApply({ marketCount: { province: "BC" } }) === false && financeCoverageApplies === albertaRulesApply);
  check("it never asserts the reader HAS a policy or that this is a change: the claim is conditional, then attributed", /^If this vehicle replaces one on your own policy, that is a change of vehicle\. The AIRB reports that premiums also changed if, since the last renewal, a driver had a new at-fault claim, conviction, changed vehicles, or changed their home address\.$/.test(l.lines[0].v) && !/(excluded|lost|removed)/i.test(l.lines[0].v), l.lines[0].v);
  check("the headline and tile hedge too -- neither asserts this reader's situation", l.headline === "Changing vehicles can change a premium" && l.value === "CHANGING VEHICLES CAN CHANGE IT");
  check("the cap figures are dated and the missing 2026 figure is stated, so 2025 never reads as current", /greater than 3\.7% in 2024 and 7\.5% in 2025, and it gives no figure for 2026/.test(l.lines[1].v), l.lines[1].v);
  check("the cap's scope keeps the regulator's own qualifier (PPV), never a wider one", /an insurer's PPV \(private passenger vehicle\) rating program/.test(l.lines[1].v), l.lines[1].v);
  check("no unattributed generalisation about what a cap limits -- the report's own two sentences instead", !/A cap applies to the increases/.test(l.lines[1].v) && /moving to a new insurer means drivers are no longer protected by the 7\.5% cap/.test(l.lines[1].v), l.lines[1].v);
  check("the quoted sentence is not silently truncated", /did not mean Alberta drivers did not see increases in their auto insurance premiums in 2023/.test(l.lines[1].v));
  check("the buyer is never invited to decide whether they are a 'Good Driver'", !/if you are a good driver|you qualify|your cap|you are capped/i.test(l.body) && /airbfordrivers\.ca/.test(l.note), l.note);
  check("9.0% is stated as the third-party liability part, never the whole premium, and never multiplied out", /typically increases third-party liability premiums by approximately 9\.0%/.test(l.lines[2].v) && /That is the third-party liability part of a premium, across Alberta, not a quote for this vehicle\./.test(l.lines[2].v) && !/58\.2|of your total|whole premium by/i.test(l.body), l.lines[2].v);
  check("the take-up figures keep their own halves and dates", /rose from 45\.6% in the second half of 2024 to 47\.1% twelve months later/.test(l.lines[2].v));
  check("every figure is attributed to the AIRB", l.lines.slice(0, 3).every((x) => /The AIRB reports/.test(x.v)));
  check("the only figures printed are the ones the report carries", [...new Set(l.body.match(/\d+\.\d+%/g) || [])].sort().join(",") === ["0.0%", "3.7%", "45.6%", "47.1%", "7.5%", "9.0%"].sort().join(","), (l.body.match(/\d+\.\d+%/g) || []).join(","));
  check("it names its source, both pages and the date it was read", /pages 5 and 16, published 2026\. Read 2026-09-03/.test(l.note) && /docs\/airb-2026-capture\.md/.test(l.note));
  check("the action names the buyer's own insurer and both questions", /Ask your own insurer what this specific vehicle does to your renewal, and what the two-million-dollar limit costs on your policy\./.test(l.lines[3].v));
  check("the one-sentence explain is worded by the builder, attributed throughout, and no stronger than the lines", /^The AIRB reports that a premium also changed when a driver changed vehicles/.test(l.explain) && /no longer protected by the 7\.5% Good Driver cap/.test(l.explain) && /about 9\.0% to the third-party liability part/.test(l.explain));
  check("the tile value fits a rail tile and a verify row", l.value.length <= 32 && l.headline.length <= 48, `${l.value.length}/${l.headline.length}`);
  check("it says nothing about this listing -- it is regulator copy, identical for every Alberta report", JSON.stringify(insurancePremiumLine({ marketCount: { province: "AB" }, quotedPrice: 69898, pageDefault: { state: "confirmed", termMonths: 84 } })) === JSON.stringify(l));
}

// ── 3f. the financing APR note never contradicts the payment card ─────────────
console.log("\n-- financingAprNote --");
{
  // The real report that exposed this: LC-FE77-C58, 2026 Lexus RX 350 at Lexus
  // of Royal Oak. The page's calculator opened at 3.9%; the advertised-rate
  // reader did not credit the source; page 1 said no rate was advertised.
  const RX = { pageDefault: { state: "confirmed", termMonths: 72, paymentFrequency: "biweekly", apr: 3.9, paymentAmount: 535, source: "edealer_js" } };
  const note = financingAprNote(RX, null);
  check("a page whose calculator opens at a rate is never told it advertises none", !/No financing rate is advertised/.test(note) && /This page's payment calculator opens at 3\.9%/.test(note), note);
  check("... and the rate is still not presented as the dealer's advertised APR", /not the same as a rate confirmed from the page's own listing data/.test(note) && !/This dealer advertises/.test(note), note);
  check("... nor is the tile allowed to say NONE ADVERTISED", financingAprValue(RX, null, null, false) === "3.9% ON THIS PAGE" && financingAprValue(RX, null, 3.9, false) === "3.9% OEM REF", financingAprValue(RX, null, null, false));
  const trusted = financingAprNote(RX, 6.99);
  check("a trusted dealer rate still leads, and names no motive", /^APR is the yearly interest rate on the loan\. This dealer advertises 6\.99%/.test(trusted) && /often carry a markup/.test(trusted) && !/hidden/.test(trusted), trusted);
  check("the trusted tile keeps its HIGH flag", financingAprValue(RX, 6.99, 3.9, true) === "6.99% HIGH" && financingAprValue(RX, 6.99, 3.9, false) === "6.99%");
  for (const pd of [undefined, null, { state: "absent", reason: "none_found" }, { state: "unchecked" }, { state: "confirmed", apr: null }, { state: "confirmed", apr: "abc" }]) {
    const l = financingAprNote({ pageDefault: pd }, null);
    check(`no page rate (${JSON.stringify(pd)}) -> the original sentence stands`, /^No financing rate is advertised\./.test(l) && financingAprValue({ pageDefault: pd }, null, null, false) === "NONE ADVERTISED", l);
  }
  check("a real 0% promotional rate on the page is a rate, not an absence", pageDefaultApr({ pageDefault: { state: "confirmed", apr: 0 } }) === 0 && financingAprValue({ pageDefault: { state: "confirmed", apr: 0 } }, null, null, false) === "0% ON THIS PAGE");
  check("the sealed compact form reads the same rate", pageDefaultApr({ dflt: { st: "confirmed", a: 3.9 } }) === 3.9 && pageDefaultApr({ dflt: { st: "absent" } }) === null);
  // The regression this locks: the two cards on ONE report must agree.
  const pd = pageDefaultLine(RX);
  check("on one report, the payment card and the APR note tell the same story", /3\.9%/.test(pd.body) && /3\.9%/.test(note) && !(/3\.9%/.test(pd.body) && /No financing rate is advertised/.test(note)), `${pd.body.slice(0, 60)} | ${note.slice(0, 60)}`);
}

// ── 4. every emitted sentence passes the copy gate's own rules ───────────────
console.log("\n-- copy sweep (every state x both lines) --");
{
  const FORBIDDEN = [
    /FTC/, /CARS Rule/i, /Federal Trade Commission/i, /in the US/i, /Magnuson[- ]Moss/i,
    /\bscrap(e|es|ed|ing)\b/i, /(?<!(?:can't|cannot|never|not|no)\s+(?:be\s+)?)guarantee(d|s)?/i,
    /100% (accurate|correct|reliable)/i, /always (saves|beats|wins)/i, /never wrong/i,
    /10[-\s]point/, /(never|nothing|not) stored/i,
    // neutral-language + no-accusation memory rules (not yet in the gate)
    /\b(avoid|overpriced|best value|negotiate|should|lowball|steer|steers|hidden by|designed to|to make the payment look|nearby|gives you|if you do nothing|if you change nothing)\b/i,
    /\bworth\b|\bforecast\b|\bdepreciat/i,
    /\p{Extended_Pictographic}/u,
  ];
  const mcStates = [
    computeMarketCount(ROWS, SUBJ), computeMarketCount(ROWS, { ...SUBJ, trim: "Other" }),
    computeMarketCount(ROWS, { ...SUBJ, priceVerified: false }), computeMarketCount(ROWS, { ...SUBJ, price: null }),
    computeMarketCount(ROWS, { ...SUBJ, contingent: true }), computeMarketCount(ROWS, { ...SUBJ, truncated: true }),
    computeMarketCount([], SUBJ), computeMarketCount(null, SUBJ),
    { state: "unchecked", reason: "outside_province", province: "BC" }, { state: "unchecked", reason: "province_unknown" },
    { state: "unchecked", reason: "identity_missing" }, { state: "unchecked", reason: "condition_unknown" }, { state: "unchecked", reason: "no_page" },
    { ...computeMarketCount(ROWS, SUBJ), subjectExcluded: false, same: 2, n: 1, below: 1 },
    { ...computeMarketCount(ROWS, SUBJ), scope: "trim_family" },
  ];
  const pdStates = [
    readPageDefault({ html: fx("okotoks-hrv-finance-block.html"), price: 39713.7, readAt: "2026-09-02" }),
    readSm360PageDefault(SM360_LIVE, "2026-09-02"),
    { checked: true, state: "confirmed", termMonths: 84, apr: 5.99, source: "page_text", readAt: "2026-09-02" },
    { checked: true, state: "confirmed", paymentFrequency: "weekly", source: "edealer_js", readAt: "2026-09-02" },
    { checked: true, state: "confirmed", termMonths: 72, paymentFrequency: "monthly", apr: 0, downPayment: 3800, paymentAmount: 571, source: "edealer_js", readAt: "2026-09-02" },
    { checked: true, state: "absent", reason: "panel_hidden" }, { checked: true, state: "absent", reason: "none_found" },
    { checked: false, state: "unchecked" }, { checked: false, state: "unchecked", reason: "no_page" }, undefined,
  ];
  const texts = [];
  for (const m of mcStates) { const l = marketCountLine({ year: 2027, make: "Honda", model: "HR-V", marketCount: m }); texts.push(l.value, l.headline, l.body, l.title, l.meta); }
  for (const p of pdStates) { const l = pageDefaultLine({ pageDefault: p }); texts.push(l.value, l.headline, l.body, l.title, l.meta); }
  const mv6 = { average: 57999, low: 53489, high: 72995, comps: 6, asOf: "2026-08-18", seenMin: "2026-08-03", seenMax: "2026-08-18", yearFrom: 2024, yearTo: 2025, trimScope: "model", trimLabel: "Luxury", kmLow: 0, kmHigh: 62000, condition: "used", dealers: 2, make: "Lexus", model: "RX", province: "AB" };
  for (const extra of [{ quotedPrice: 56000 }, { quotedPrice: 59900 }, { quotedPrice: 76000 }, { quotedPrice: null }, { quotedPrice: 59900, priceVerified: false }, { quotedPrice: 59900, financeContingent: { contingent: true } }]) { const l = marketCompareLine({ year: 2024, make: "Lexus", model: "RX", ...extra, marketValue: mv6 }); texts.push(l.value, l.headline, l.body, l.title, l.meta, ...(l.lightLabel ? [l.lightLabel] : []), ...(l.note ? [l.note] : []), ...l.lines.map((x) => `${x.k}: ${x.v}`)); }
  for (const mv of [{ average: null, insufficient: true, nRead: 2, need: 5, yearFrom: 2025, yearTo: 2025, kmLow: 0, kmHigh: 37178, condition: "used", dealers: 2, asOf: "2026-08-18", make: "Lexus", model: "RX", province: "AB" }, { average: null, insufficient: true, nRead: 0, need: 5, yearFrom: 2025, yearTo: 2026, kmLow: 0, kmHigh: 37178, condition: "used" }, { average: null, insufficient: true, nRead: 6, nKept: 4, need: 5, trimScope: "model", yearFrom: 2024, yearTo: 2025, condition: "used", asOf: "2026-08-18" }, { average: null, insufficient: true, reason: "basis_missing" }, { average: null, insufficient: true, reason: "odometer_missing", yearFrom: 2026, yearTo: 2026, condition: "used" }, { avg: 57999, below: 55000, above: 60000 }, { avg: 59990, lo: 49251, hi: 77988, n: 11, as: "2026-08-18" }, undefined]) { const l = marketCompareLine({ year: 2026, make: "Lexus", model: "RX", quotedPrice: 69898, marketValue: mv }); texts.push(l.value, l.headline, l.body, l.title, l.meta, ...(l.lightLabel ? [l.lightLabel] : []), ...l.lines.map((x) => `${x.k}: ${x.v}`)); }
  {
    const OYC = { state: "confirmed", subjectYear: 2026, make: "Lexus", model: "RX", province: "AB", condition: "used", scope: "model", seenMin: "2026-08-03", seenMax: "2026-08-18", rungs: [{ year: 2025, n: 5, median: 60900, low: 55900, high: 72995, kmLow: 11223, kmHigh: 41000, dealers: 3 }, { year: 2024, n: 6, median: 57694, low: 49251, high: 62700, kmLow: 11294, kmHigh: 80308, dealers: 3 }] };
    for (const extra of [{ quotedPrice: 69898 }, { quotedPrice: null }, { quotedPrice: 69898, priceVerified: false }, { quotedPrice: 69898, financeContingent: { contingent: true } }, { quotedPrice: 50000 }]) { const l = olderYearsLine({ year: 2026, make: "Lexus", model: "RX", priceVerified: true, ...extra, olderYears: OYC }); texts.push(l.value, l.headline, l.body, l.title, ...(l.meta ? [l.meta] : []), ...(l.note ? [l.note] : []), ...l.lines.map((x) => `${x.k}: ${x.v}`)); }
    for (const oy of [{ state: "insufficient", nRead: 3, need: 5, make: "Lexus", model: "RX", province: "AB", subjectYear: 2026, seenMax: "2026-08-03", rungs: [] }, { state: "insufficient", nRead: 0, need: 5, make: "Lexus", model: "RX", province: "AB", subjectYear: 2026, rungs: [] }, { state: "insufficient", reason: "basis_missing", rungs: [] }, { state: "unchecked", reason: "outside_province", province: "BC", rungs: [] }, { state: "unchecked", reason: "no_page", rungs: [] }, undefined]) { const l = olderYearsLine({ year: 2026, make: "Lexus", model: "RX", quotedPrice: 69898, olderYears: oy }); texts.push(l.value, l.headline, l.body, l.title, ...(l.meta ? [l.meta] : []), ...l.lines.map((x) => `${x.k}: ${x.v}`)); }
  }
  for (const extra of [{ pageDefault: { state: "confirmed", termMonths: 84, apr: 5.99 } }, { pageDefault: { state: "confirmed", purchaseMethod: "cash", termMonths: 84, apr: 2.99 } }, { financeContingent: { contingent: true } }, {}]) {
    const l = financeCoverageLine({ marketCount: { province: "AB" }, ...extra });
    texts.push(l.value, l.headline, l.body, l.title, l.meta, l.note, l.explain, ...l.lines.map((x) => `${x.k}: ${x.v}`));
  }
  {
    const l = insurancePremiumLine({ marketCount: { province: "AB" } });
    texts.push(l.value, l.headline, l.body, l.title, l.meta, l.note, l.explain, ...l.lines.map((x) => `${x.k}: ${x.v}`));
  }
  for (const d of [null, 6.99]) texts.push(financingAprNote({ pageDefault: { state: "confirmed", apr: 3.9 } }, d));
  texts.push(financingAprNote({}, null));
  let hits = 0;
  for (const t of texts) for (const re of FORBIDDEN) if (re.test(t)) { hits++; console.log(`    banned: ${re} in "${t}"`); }
  check(`${texts.length} strings, 0 banned-word hits`, hits === 0, `${hits} hit(s)`);
  check("every state renders a non-empty string", texts.every((t) => typeof t === "string" && t.length > 0), texts.filter((t) => typeof t !== "string" || !t.length).length + " empty");
}

console.log(`\n${pass} passed, ${fail} failed${fail ? `\n  ${failures.join("\n  ")}` : ""}`);
process.exit(fail ? 1 : 0);
