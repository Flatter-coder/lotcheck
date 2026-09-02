// Regression suite for the two count/default report lines:
//   "M of the N other listings LotCheck read ... advertised below this one"  (market-count.js)
//   "If you do nothing, this page shows N months ..."                        (page-default.js)
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
import { computeMarketCount, normTrim, fullTrimKey, trimLabelOf } from "../supabase/functions/_shared/market-count.js";
import { readPageDefault, readSm360PageDefault, readPageTextDefault, readEdealerPageDefault, parseAmount } from "../supabase/functions/_shared/page-default.js";
import { marketCountLine, pageDefaultLine, fmtDateEn, fmtMoney } from "../supabase/functions/_shared/report-lines.js";

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
    l.body === "None of the 12 other 2027 Honda HR-V Sport listings LotCheck read from 3 Alberta dealers' own pages advertised below this one ($39,713.70) when read on Aug 18, 2026. Across all HR-V trims read: 9 of 32 below. Counts of dealers' own advertised prices, this vehicle excluded; not a valuation.", l.body);
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
  check("LINE 2 confirmed body carries the page's own qualifiers and the one instruction", l.body === "If you do nothing, this page shows 84 months, bi-weekly payments of $267 at 5.99% APR with $0 down (the page calls the rate an estimate; plus taxes and licence; cost of borrowing $8,951.19 as stated) — the finance figure this page shows first, from its own text, read Sep 2, 2026. Ask the dealer for the term, frequency, rate and total cost of borrowing in writing.", l.body);
  check("LINE 2 meta", l.meta === "read Sep 2, 2026", l.meta);
  const sm = pageDefaultLine({ pageDefault: readSm360PageDefault(SM360_LIVE, "2026-09-02") });
  check("LINE 2 SM360 cash-first page leads with it in value, headline and body", sm.value === "OPENS ON CASH · 84 MO · WEEKLY · 2.99%" && /^Opens on cash · 84 months · weekly · 2\.99% APR$/.test(sm.headline) && /^This page opens on its cash price\. Its finance option, if you change nothing else, shows 84 months, weekly payments of \$196\.48 at 2\.99% APR with \$0 down — from the dealer's own listing data, read Sep 2, 2026\./.test(sm.body), sm.body + " | " + sm.value);
  const partial = pageDefaultLine({ pageDefault: { checked: true, state: "confirmed", termMonths: 84, apr: 5.99, source: "page_text", readAt: "2026-09-02" } });
  check("LINE 2 partial: missing frequency is said, not guessed", /84 months at 5\.99% APR/.test(partial.body) && /does not state a payment frequency/.test(partial.body) && partial.value === "84 MO · 5.99%", partial.body + " | " + partial.value);
  const noDown = pageDefaultLine({ pageDefault: { checked: true, state: "confirmed", termMonths: 72, paymentFrequency: "biweekly", apr: 4.99, downPayment: null, source: "sm360_feed", readAt: "2026-09-02" } });
  check("LINE 2 never prints '$0 down' when no down payment was read", !/down/.test(noDown.body.split("—")[0]), noDown.body);
  const notShown = pageDefaultLine({ pageDefault: { checked: true, state: "absent", reason: "panel_hidden" } });
  check("LINE 2 absent by the page's own settings -> NOT SHOWN", notShown.value === "NOT SHOWN" && /own settings show no pre-selected finance scenario/.test(notShown.body), notShown.body);
  const noneFound = pageDefaultLine({ pageDefault: { checked: true, state: "absent", reason: "none_found" } });
  check("LINE 2 a miss -> NONE FOUND, a statement about the reader", noneFound.value === "NONE FOUND" && /LotCheck did not find/.test(noneFound.body), noneFound.body);
  const un = pageDefaultLine({});
  check("LINE 2 unchecked never claims an attempt failed", un.value === "NOT READ" && un.body === "Not read — no payment settings were read for this report. Ask the dealer for the term, payment frequency and rate in writing.", un.body);
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

// ── 4. every emitted sentence passes the copy gate's own rules ───────────────
console.log("\n-- copy sweep (every state x both lines) --");
{
  const FORBIDDEN = [
    /FTC/, /CARS Rule/i, /Federal Trade Commission/i, /in the US/i, /Magnuson[- ]Moss/i,
    /\bscrap(e|es|ed|ing)\b/i, /(?<!(?:can't|cannot|never|not|no)\s+(?:be\s+)?)guarantee(d|s)?/i,
    /100% (accurate|correct|reliable)/i, /always (saves|beats|wins)/i, /never wrong/i,
    /10[-\s]point/, /(never|nothing|not) stored/i,
    // neutral-language + no-accusation memory rules (not yet in the gate)
    /\b(avoid|overpriced|best value|negotiate|should|lowball|steer|steers|hidden by|designed to|to make the payment look|nearby|gives you)\b/i,
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
  let hits = 0;
  for (const t of texts) for (const re of FORBIDDEN) if (re.test(t)) { hits++; console.log(`    banned: ${re} in "${t}"`); }
  check(`${texts.length} strings, 0 banned-word hits`, hits === 0, `${hits} hit(s)`);
  check("every state renders a non-empty string", texts.every((t) => typeof t === "string" && t.length > 0));
}

console.log(`\n${pass} passed, ${fail} failed${fail ? `\n  ${failures.join("\n  ")}` : ""}`);
process.exit(fail ? 1 : 0);
