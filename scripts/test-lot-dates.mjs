// GATE: the four dates a dealer keeps about its own listing.
//
// Vic, 2026-09-12, looking at a live Go Kia South listing whose page carries
// date_on_lot, date_added, date_updated and date_sold side by side: "i want
// this added to report". We were reading one of the four.
//
// WHAT EACH GUARD IS FOR:
//
//   ZERO DATES. "0000-00-00" is MySQL's zero date and reaches these blobs
//   routinely. Parsed naively it dates a car to the year zero — and on
//   date_sold it would flag EVERY unsold car as sold, which is the worst
//   possible false positive this file can produce: a claim that a car may
//   already be gone, on every listing, from a platform default.
//
//   THE SALE FLAG IS A QUESTION, NOT A CLAIM. A sale date on a live listing
//   usually means the record has not caught up, or a deal fell through. Neither
//   is anyone's fault and the copy must say so. A buyer-side product that
//   implies bait-advertising from a stale database field has invented
//   misconduct out of a data-entry artefact. [[no-accusation-language]]
//
//   DAYS ON LOT IS THE BUYER'S ADVANTAGE WHEN IT IS LONG. A car sitting 90+
//   days costs the dealer money. The tone must not treat that as a defect in
//   the car — it is leverage for the person reading the report.
//
// Offline. No network, no database. Clock is injected so the numbers are fixed.
//
// Run: npm run test:lot-dates

import { parseLotDate, readLotDates, lotDateLines } from "../supabase/functions/_shared/lot-dates.js";

let failed = 0;
const fail = (m, d) => { failed++; console.error(`FAIL  ${m}`); if (d) console.error(`      ${d}`); };
const pass = (m) => console.log(`ok    ${m}`);
const NOW = Date.parse("2026-09-12T12:00:00Z");
const lines = (raw) => lotDateLines(readLotDates(raw, NOW));
const find = (raw, label) => lines(raw).find((l) => l.label === label);

// ---- 1. THE REAL LISTING -------------------------------------------------
{
  const REAL = { date_on_lot: "2026-09-01 04:19:41", date_added: "2026-09-01 04:46:40", date_updated: "2026-09-12 04:36:41", date_sold: "" };
  const d = readLotDates(REAL, NOW);
  if (!d) fail("the real Go Kia blob produced nothing");
  else if (d.daysOnLot !== 11) fail(`days on lot is ${d.daysOnLot}, expected 11`, "listed 2026-09-01, read 2026-09-12");
  else if (d.daysSinceUpdate !== 0) fail(`days since update is ${d.daysSinceUpdate}, expected 0`);
  else if (d.sold !== null) fail(`an empty date_sold parsed as ${JSON.stringify(d.sold)}`);
  else pass("the real listing reads 11 days on lot, updated today, not sold");

  if (find(REAL, "Sale flag on this listing")) fail("an unsold car got a sale flag");
  else pass("an unsold car gets no sale flag");

  // 11 days must not be sold as leverage the buyer does not have.
  const dol = find(REAL, "Days on lot");
  if (!/fresh inventory/i.test(dol.line)) fail("11 days is not described as fresh inventory");
  else if (!/do not expect|belongs to cars that have sat/i.test(dol.line)) {
    fail("the report does not tell the buyer this lever is not theirs here");
  } else pass("fresh inventory is named as such, and the buyer is told not to lean on it");
}

// ---- 2. MYSQL ZERO DATES AND OTHER SENTINELS -----------------------------
for (const v of ["0000-00-00", "0000-00-00 00:00:00", "", "   ", "0", "null", "N/A", "-", null, undefined]) {
  if (parseLotDate(v) !== null) { fail(`the sentinel ${JSON.stringify(v)} parsed as a real date`); break; }
}
if (!failed) pass("MySQL zero dates and empty sentinels never parse");
{
  const allZero = { date_on_lot: "0000-00-00 00:00:00", date_added: "0000-00-00", date_updated: "", date_sold: "0000-00-00 00:00:00" };
  if (readLotDates(allZero, NOW) !== null) fail("a blob of zero dates produced a reading");
  else pass("a blob of zero dates produces nothing at all");
  // The critical one: a zero date_sold must NEVER raise the sale flag.
  const zeroSold = { date_on_lot: "2026-06-01", date_added: "2026-06-01", date_updated: "2026-09-10", date_sold: "0000-00-00 00:00:00" };
  if (find(zeroSold, "Sale flag on this listing")) {
    fail("a MySQL zero date_sold raised the sale flag",
      "this would tell every buyer of every car on that platform it may already be sold");
  } else pass("a zero date_sold never raises the sale flag");
}

// ---- 3. IMPOSSIBLE DATES -------------------------------------------------
{
  if (parseLotDate("2031-01-01") !== null) fail("a future date parsed");
  else if (parseLotDate("1999-01-01") !== null) fail("a pre-platform date parsed");
  else if (parseLotDate("not a date") !== null) fail("junk parsed");
  else pass("future, pre-2008 and junk dates are all rejected");
}

// ---- 4. THE SALE FLAG, AND ITS TONE --------------------------------------
{
  const SOLD = { date_on_lot: "2026-06-01 08:00:00", date_added: "2026-06-01 08:00:00", date_updated: "2026-09-10 08:00:00", date_sold: "2026-09-08 14:00:00" };
  const f = find(SOLD, "Sale flag on this listing");
  if (!f) fail("a recorded sale date on a live listing raised nothing");
  else {
    if (f.tone !== "flag") fail(`the sale flag tone is "${f.tone}", expected "flag"`);
    else pass("a recorded sale date raises a flag");

    // It must offer the innocent explanation FIRST and name no wrongdoing.
    if (!/has not caught up|fell through/i.test(f.line)) {
      fail("the sale-flag copy does not offer the likely innocent explanation");
    } else pass("the sale flag leads with the likely innocent explanation");

    if (/bait|deceptive|misleading|dishonest|scam|illegal|conceal/i.test(f.line)) {
      fail("the sale-flag copy accuses the dealer", "a stale database field is not misconduct");
    } else pass("the sale flag accuses nobody");

    if (!/in writing/i.test(f.line)) fail("the sale flag does not tell the buyer to get the answer in writing");
    else pass("it tells the buyer to get availability confirmed in writing");
  }
}

// ---- 5. A STALE PRICE IS NAMED -------------------------------------------
{
  const STALE = { date_on_lot: "2026-05-15", date_added: "2026-05-15", date_updated: "2026-07-14", date_sold: "" };
  const d = readLotDates(STALE, NOW);
  if (d.daysOnLot !== 120) fail(`expected 120 days on lot, got ${d.daysOnLot}`);
  else pass("120 days on lot computes correctly");

  const dol = find(STALE, "Days on lot");
  if (dol.tone !== "pass") fail(`90+ days is toned "${dol.tone}" — a long-sitting car is the BUYER's advantage, not a defect`);
  else pass("90+ days is toned as the buyer's advantage");
  if (!/holding cost/i.test(dol.line)) fail("the 90+ line never mentions holding cost");
  else pass("the 90+ line names the holding cost");

  const upd = find(STALE, "Listing last updated");
  if (!/stale/i.test(upd.line)) fail("a listing untouched for 60 days is not described as stale");
  else pass("a 60-day-old price is named as stale");
}

// ---- 6. DISAGREEING ARRIVAL DATES ----------------------------------------
{
  const SPLIT = { date_on_lot: "2026-08-01", date_added: "2026-06-10", date_updated: "2026-09-11", date_sold: "" };
  const a = find(SPLIT, "Arrival date");
  if (!a) fail("two arrival dates 52 days apart raised nothing");
  else if (!/2026-08-01/.test(a.line) || !/2026-06-10/.test(a.line)) fail("the arrival line does not show BOTH dates");
  else if (!/rather than picking one silently/i.test(a.line)) fail("it does not say which one we used and why");
  else pass("disagreeing arrival dates are shown, both of them, with the choice stated");

  // One day apart is not a disagreement worth a line.
  const CLOSE = { date_on_lot: "2026-09-01 04:19:41", date_added: "2026-09-01 04:46:40", date_updated: "2026-09-12", date_sold: "" };
  if (find(CLOSE, "Arrival date")) fail("27 minutes apart raised a disagreement line");
  else pass("arrival dates minutes apart raise nothing");
}

// ---- 7. junk in, nothing out ---------------------------------------------
for (const v of [null, undefined, {}, [], "string", 42]) {
  if (readLotDates(v, NOW) !== null) { fail(`junk input ${JSON.stringify(v)} produced a reading`); break; }
}
if (!failed) pass("junk in, nothing out");

console.log("");
if (failed) { console.error(`${failed} check(s) failed.`); process.exitCode = 1; }
else console.log("lot dates: four fields read, zero dates refused, the sale flag asks rather than accuses.");
