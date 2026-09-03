// ── Archived Canadian MSRP: what a car cost NEW, for a model year the ────────
//    manufacturer no longer publishes.
//
// WHY THIS EXISTS. msrp_catalog is a NEW-car catalogue being asked used-car
// questions. Measured 2026-09-03: 1,439 rows, of which exactly three are older
// than model year 2025 — because a manufacturer stops publishing a model year's
// pricing the moment it is superseded. Sampled against our own Alberta crawl,
// 73% of used listings are MY2024 or older, so on nearly three reports in four
// the price-versus-MSRP line has nothing to stand on. The biggest single gap
// year is 2024: the gap is largest exactly where a buyer most wants to know
// what the car cost new.
//
// THE ONE RULE THAT DECIDES WHETHER A ROW MAY BE PUBLISHED IS THE BASIS, NOT
// THE NUMBER. A manufacturer's "starting from $34,590" that quietly includes
// freight and PDI is a different figure from the sticker. Storing it as MSRP
// would make every price-versus-MSRP line wrong by roughly $2,000 IN THE
// DEALER'S FAVOUR — an accusation, at scale, that we could not defend. So a
// source whose basis the page does not state is refused here, however good the
// numbers look. [[msrp-100-percent-accuracy]] [[no-accusation-language]]
//
// A row published by this module therefore carries four things, or it is not
// published at all:
//   1. the price, read from the page — never derived, never converted;
//   2. price_basis, taken from words on that same page;
//   3. source_url, re-fetchable by anyone, including the buyer;
//   4. captured_on, the date we read it.
//
// Vendor policy: every source here is the manufacturer's own Canadian
// publication or a public archive of it. No dealer-funded data vendor is used
// or may be added — this is the one dataset where being cut off later would be
// fatal, because the whole report is denominated in it. [[vendor-capture-risk]]

import { UA, sleep } from "./catalog-io.mjs";

/** Bases we are willing to store. Anything else means we could not name it. */
export const BASIS = {
  EXCL_FREIGHT: "excl_freight",   // the sticker: before freight/PDI/A-C/levies
  ALL_IN: "all_in",               // freight, PDI, levies and fees included
};

/**
 * A price is only a price if it looks like a Canadian vehicle price.
 * Rejects the two things that actually turn up in this data: a freight or
 * accessory figure that happens to sit near the trim name, and a US number.
 */
export function plausibleVehiclePrice(n) {
  return Number.isFinite(n) && n >= 12000 && n <= 500000;
}

/** "$28,090" / "$28090" / "28,090" -> 28090, else null. Never rounds. */
export function readPrice(text) {
  if (typeof text !== "string") return null;
  const m = text.replace(/ /g, " ").match(/\$?\s*(\d{2,3}(?:[,\s]\d{3})+|\d{5,6})(?!\d)/);
  if (!m) return null;
  const n = Number(m[1].replace(/[,\s]/g, ""));
  return plausibleVehiclePrice(n) ? n : null;
}

/**
 * The MODEL YEAR is the year in the vehicle's name, never the year the release
 * was published. media.toyota.ca files the MY2020 RAV4 launch under /2019/,
 * because the car goes on sale the autumn before. Getting this wrong would
 * file every archived price one year out — which is not a small error on a
 * catalogue whose entire job is to be pinned to a model year.
 */
export function readModelYear(title, { min = 2005, max = 2030 } = {}) {
  if (typeof title !== "string") return null;
  const m = title.match(/\b(20\d{2})\b/);
  if (!m) return null;
  const y = Number(m[1]);
  return y >= min && y <= max ? y : null;
}

/** Strip tags to readable text, keeping cell and row boundaries meaningful. */
export function toText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(td|th)>/gi, "\t")
    .replace(/<\/(tr|p|div|li|h\d)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t]+/g, (s) => (s.includes("\t") ? "\t" : " "))
    .replace(/\n{2,}/g, "\n");
}

export async function getHtml(url, { tries = 3, timeoutMs = 25000 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      const r = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,*/*" }, signal: ctl.signal });
      clearTimeout(t);
      if (r.status === 404 || r.status === 410) return null;      // gone is an answer
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      if (i === tries - 1) { console.warn(`  fetch failed ${url}: ${e.message}`); return null; }
      await sleep(600 * (i + 1));
    }
  }
  return null;
}

/**
 * Shape a row, refusing anything we could not fully establish. Returns null
 * rather than a partial row: a catalogue row with a guessed field is worse
 * than no row, because nothing downstream can tell the two apart.
 * [[missing-beats-wrong]]
 */
export function archivedRow({ year, make, model, trim, msrp, basis, sourceUrl, capturedOn, fuel = null }) {
  if (!year || !make || !model || !trim) return null;
  if (!plausibleVehiclePrice(msrp)) return null;
  if (basis !== BASIS.EXCL_FREIGHT && basis !== BASIS.ALL_IN) return null;
  if (!sourceUrl || !/^https?:\/\//.test(sourceUrl)) return null;
  if (!capturedOn) return null;
  return {
    year, make,
    model: String(model).trim().slice(0, 60),
    trim: String(trim).trim().slice(0, 60),
    msrp,
    price_basis: basis,
    fuel_type: fuel,
    source_url: sourceUrl,
    fetched_at: new Date(capturedOn).toISOString(),
  };
}

/**
 * The catalogue already holds the CURRENT model years, refreshed daily. An
 * archived backfill must merge beside them and never replace them, so callers
 * use replaceRows(..., { upsert: true }), which is keyed on
 * (year, make, model, trim). This helper only guards the caller against the
 * mistake that would hurt: handing the writer a set that spans a current year.
 */
export function refuseCurrentYears(rows, currentYearFloor) {
  const kept = rows.filter((r) => r.year < currentYearFloor);
  const dropped = rows.length - kept.length;
  if (dropped) console.log(`  ${dropped} row(s) at or after MY${currentYearFloor} dropped — the daily scrapers own those.`);
  return kept;
}
