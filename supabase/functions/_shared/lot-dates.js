// lot-dates.js — the four dates a dealer platform keeps about its own listing.
//
// Vic, 2026-09-12, on a live Go Kia South listing whose page carries:
//   "date_on_lot":  "2026-09-01 04:19:41"
//   "date_added":   "2026-09-01 04:46:40"
//   "date_updated": "2026-09-12 04:36:41"
//   "date_sold":    ""
// "i want this added to report".
//
// We already read date_on_lot for days-on-lot. The other three were sitting in
// the same blob, unread, and two of them answer questions days-on-lot cannot.
//
// WHAT EACH ONE IS FOR:
//
//   date_on_lot   how long it has been for sale. The classic lever: a car
//                 carrying 90+ days is costing the dealer money and they know
//                 it. Already used; unchanged here.
//
//   date_updated  when the dealer last TOUCHED the listing. Days-on-lot alone
//                 cannot separate "priced keenly and actively managed" from
//                 "posted once and forgotten". A car 120 days on lot whose
//                 listing was edited today is being worked; one untouched for
//                 60 days is not, and the price on it is 60 days stale.
//
//   date_sold     THE ONE THAT MATTERS MOST, and the reason this file exists.
//                 If the dealer's own data records a sale date while the
//                 listing is still live and advertised, the buyer is looking at
//                 a car that may already be gone. That is exactly what a
//                 buyer-side product should notice. It is stated as what it is
//                 — their own field, quoted, with a question attached — and
//                 NEVER as an accusation: listings lag, a sale can fall
//                 through, and a stale flag is a data-entry artefact far more
//                 often than anything else. [[no-accusation-language]]
//
//   date_added    when the record was created. Normally within minutes of
//                 date_on_lot (here, 27 minutes). A large gap between them
//                 means the two dates disagree about when the car arrived, and
//                 the honest move is to say so rather than silently prefer one.
//
// EVERY ONE IS THE DEALER'S OWN DECLARATION, read from their own platform data.
// That is what makes it usable: we are not inferring, we are quoting.
// [[establish-page-before-report]] [[days-on-lot-own-engine]]

const TS = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/;

// A platform's empty/never-set sentinels. "0000-00-00" is MySQL's zero date and
// reaches these blobs regularly; treating it as a real date would date a car to
// the year zero and, for date_sold, would flag every unsold car as sold.
const EMPTY = new Set(["", "0", "0000-00-00", "0000-00-00 00:00:00", "null", "undefined", "n/a", "-"]);

export function parseLotDate(raw) {
  const s = String(raw ?? "").trim();
  if (!s || EMPTY.has(s.toLowerCase())) return null;
  const m = TS.exec(s);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  const year = Number(m[1]);
  // Reject the obviously impossible rather than publish it. 2008 predates every
  // one of these platforms; a future date is a clock or a template default.
  if (year < 2008 || t > Date.now() + 86_400_000) return null;
  return iso;
}

const dayssince = (iso, now) => (iso ? Math.floor((now - Date.parse(`${iso}T00:00:00Z`)) / 86_400_000) : null);

/**
 * @param raw  { date_on_lot, date_added, date_updated, date_sold } verbatim
 * @param now  epoch ms, injected so the gate can drive a fixed clock
 */
export function readLotDates(raw, now = Date.now()) {
  const onLot = parseLotDate(raw?.date_on_lot);
  const added = parseLotDate(raw?.date_added);
  const updated = parseLotDate(raw?.date_updated);
  const sold = parseLotDate(raw?.date_sold);
  if (!onLot && !added && !updated && !sold) return null;

  const since = onLot || added;
  return {
    onLot, added, updated, sold,
    daysOnLot: dayssince(since, now),
    daysSinceUpdate: dayssince(updated, now),
    // The two arrival dates disagreeing by more than a day is worth saying.
    arrivalDisagrees: !!(onLot && added && Math.abs(dayssince(onLot, now) - dayssince(added, now)) > 1),
    source: "the dealer's own inventory data on this page",
  };
}

/**
 * The report lines. Returns an array so a surface can render 1-3 of them; each
 * carries its own tone. Never returns a line it cannot back.
 */
export function lotDateLines(d) {
  if (!d) return [];
  const out = [];
  const plural = (n) => (n === 1 ? "day" : "days");

  // ---- 1. days on lot -----------------------------------------------------
  if (d.daysOnLot != null && d.daysOnLot >= 0) {
    const n = d.daysOnLot;
    const lever = n >= 90
      ? `At ${n} ${plural(n)} this car is carrying real holding cost for the dealer, and that is the strongest timing lever you have. Say the number out loud: they know it.`
      : n >= 45
        ? `At ${n} ${plural(n)} it has been available long enough to have been passed over, which is worth naming without overplaying.`
        : `At ${n} ${plural(n)} this is fresh inventory. There is no holding-cost pressure yet, so do not expect the age of the listing to move the price — that lever belongs to cars that have sat.`;
    out.push({
      label: "Days on lot",
      value: `${n} ${plural(n)}`,
      tone: n >= 90 ? "pass" : "muted",   // long = the BUYER's advantage
      line: `Listed on ${d.onLot || d.added} according to ${d.source}. ${lever}`,
    });
  }

  // ---- 2. last touched ----------------------------------------------------
  if (d.daysSinceUpdate != null && d.daysOnLot != null) {
    const u = d.daysSinceUpdate;
    const managed = u <= 2
      ? "The listing was updated within the last day or two, so the asking price is current and actively managed."
      : u >= 30
        ? `The listing has not been touched in ${u} days, so the asking price is ${u} days stale — it may not reflect what they would take today. Ask when the price was last reviewed.`
        : `The listing was last updated ${u} ${plural(u)} ago.`;
    out.push({
      label: "Listing last updated",
      value: u === 0 ? "TODAY" : `${u} ${plural(u)} ago`,
      tone: "muted",
      line: `${managed} Days-on-lot alone cannot tell an actively managed price from one posted and forgotten; this can.`,
    });
  }

  // ---- 3. the sale flag ---------------------------------------------------
  // Deliberately worded as a question about a data field, not a claim about
  // conduct. A listing lagging a sale, or a deal falling through, is the far
  // likelier explanation and the line says so.
  if (d.sold) {
    out.push({
      label: "Sale flag on this listing",
      value: "SALE DATE RECORDED",
      tone: "flag",
      line: `${d.source} records a sale date of ${d.sold} on this listing, while the listing is still being advertised. `
        + `That usually means the record simply has not caught up, or a deal fell through and the car came back — neither is unusual and neither is anyone's fault. `
        + `But it is worth one question before you drive across town: ask whether this exact vehicle is still available, and ask for the answer in writing before you put down a deposit.`,
    });
  }

  // ---- 4. the two arrival dates disagree ----------------------------------
  if (d.arrivalDisagrees) {
    out.push({
      label: "Arrival date",
      value: "TWO DATES RECORDED",
      tone: "muted",
      line: `This listing records two different arrival dates — on the lot ${d.onLot}, record created ${d.added}. `
        + `We have used ${d.onLot} for days on lot because it is the more specific of the two, and we are telling you both rather than picking one silently.`,
    });
  }

  return out;
}
