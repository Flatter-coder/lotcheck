#!/usr/bin/env node
// ── Hyundai Canada ARCHIVED MSRP: what a used Hyundai cost when it was new ───
//
// msrp_catalog holds 1,509 rows for model years 2025-2027 and THREE for every
// older year. That is why roughly three quarters of Alberta's used listings
// cannot be priced: without what a 2016 car cost new, nothing downstream — the
// distance-from-new line, the per-year depreciation, the model-year ladder —
// has a denominator.
//
// Hyundai deletes old model years. The Internet Archive does not:
//   https://www.hyundaicanada.com/en/showroom/2016/veloster
// is gone from Hyundai and held by the archive, with $18,599 still on it.
//
// THE MODEL YEAR IS IN THE URL HERE, AND WE STILL DO NOT TRUST IT. Hyundai's
// showroom path happens to carry /2016/, but scrape-archived-toyota.mjs was
// bitten by exactly this: a MY2020 launch filed under /releases/2019/ put every
// price one year out. So the year is read from the PAGE, beside the model name,
// and the URL year is used only to cross-check. When they disagree the row is
// dropped, because a price on the wrong model year is worse than no price.
//
// BASIS IS READ PER PAGE, FROM THE PAGE. An adversarial check on 2026-09-22
// found the 2016 Veloster snapshot states it outright: "Price excludes Delivery
// and Destination charges of $1,705... includes freight, P.D.E. and a full tank
// of gas." So that row is ex-freight on Hyundai's own words.
//
// It is never assumed for the make or carried across years. GMC's archived
// pages state an ALL-IN price, so a make-wide default would have been wrong for
// a sibling brand; and today's Hyundai API is evidence about today, not about a
// page from a decade ago. A page that says nothing leaves the basis null, which
// suppresses the subtraction downstream — the correct outcome.
//
// Run:
//   node scripts/scrape-archived-hyundai.mjs                 # report only
//   node scripts/scrape-archived-hyundai.mjs --max-years 4   # smaller sweep

import { cdxSearch, fetchSnapshotText, capturedOn, modelYearFromText } from "./lib/wayback.mjs";
import { writeCatalogs, parseArgs, inferFuelFromName, sleep } from "./lib/catalog-io.mjs";

const MAKE = "Hyundai";
const HOST = "hyundaicanada.com";
// The showroom path Hyundai used for per-model pages. `*` lets the archive
// answer with everything it holds beneath it.
const PATTERN = `${HOST}/en/showroom/*`;

// A used car the catalogue needs a new-price for. Older than this and there is
// no Alberta listing to price; newer and the live scrapers already cover it.
const OLDEST_YEAR = 2010;
const NEWEST_ARCHIVED_YEAR = 2024;

// A Canadian new-car price. Below this it is a fee, an accessory or a monthly
// payment; above it, not a Hyundai.
const MIN_PRICE = 9000;
const MAX_PRICE = 120000;

/** /en/showroom/2016/veloster -> { urlYear: 2016, model: "veloster" } */
function partsFromShowroomUrl(original) {
  const m = String(original).match(/\/en\/showroom\/(\d{4})\/([a-z0-9-]+)/i);
  if (!m) return null;
  const urlYear = Number(m[1]);
  const model = m[2].replace(/-/g, " ").trim();
  if (!urlYear || !model) return null;
  return { urlYear, model };
}

/**
 * The starting price on an archived showroom page.
 *
 * Requires the figure to sit beside price vocabulary. A bare "$18,599" anywhere
 * on a page is not a price claim — it could be a payment, a rebate or another
 * model in a comparison rail, and this catalogue is the denominator under
 * every price claim the product makes.
 */
/**
 * What the archived page itself says the price includes.
 *
 * THE BASIS IS ON THE PAGE, and an adversarial check on 2026-09-22 found it:
 * the 2016 Veloster snapshot carries, verbatim --
 *
 *   "Price of $18,599 available on all new 2016 Veloster Base Manual models.
 *    Price excludes Delivery and Destination charges of $1,705, fees, levies
 *    and all applicable charges (excluding HST, GST/PST)... Delivery and
 *    Destination charge includes freight, P.D.E. and a full tank of gas."
 *
 * So this is an ex-freight figure and Hyundai says so. Recording it as
 * unknown would suppress the comparison downstream on evidence we hold.
 *
 * It is read PER PAGE, never assumed for the make: GMC's archived pages state
 * an all-in price, and a basis inherited across makes or across years is the
 * guess this catalogue exists to refuse.
 */
export function basisFromText(text, price) {
  const t = String(text || "");

  // SCOPED TO THE LEGAL BLOCK THAT NAMES THIS PRICE. A whole archived page
  // carries several legal blocks — other models, offers, lease disclaimers —
  // and a page-wide read found "excludes" in one and "includes" in another and
  // returned nothing at all. The block that matters is the one quoting the
  // figure we extracted, so that is the only one read.
  // THE PRICE APPEARS MORE THAN ONCE. It is in the hero ("Starting from*
  // $18,599") and again in the legal block ("*Price of $18,599 available on all
  // new 2016 Veloster Base Manual models. Price excludes..."). Anchoring on the
  // first occurrence, or on the word "Legal" — which is also a nav item near
  // the top — lands on the hero, whose next 700 characters are fuel economy
  // figures and a gallery. So every occurrence is considered and the one
  // FOLLOWED BY the disclosure is the one read.
  let scope = t;
  if (price) {
    const needle = `$${Number(price).toLocaleString("en-CA")}`;
    for (let at = t.indexOf(needle); at > -1; at = t.indexOf(needle, at + 1)) {
      // The window opens BEFORE the figure. "Price of $37,535 includes freight"
      // puts the subject ahead of the number, and a window starting at the
      // dollar sign cut the word "Price" off — so an all-in page read as
      // stating nothing, which is the direction that loses a real disclosure.
      const window = t.slice(Math.max(0, at - 120), at + 700);
      if (/\b(?:excludes|includes)\b/i.test(window)) { scope = window; break; }
    }
  }

  const excl = /price[^.]{0,40}excludes[^.]{0,200}(?:delivery and destination|freight)/i.test(scope);
  const incl = /price[^.]{0,40}includes[^.]{0,200}(?:delivery and destination|freight)/i.test(scope);

  if (excl && !incl) {
    const m = scope.match(/((?:price|msrp)[^.]{0,240}excludes[^.]{0,240}\.)/i);
    return { basis: "excl_freight", evidence: m ? m[1].trim().slice(0, 300) : null };
  }
  if (incl && !excl) {
    const m = scope.match(/((?:price|msrp)[^.]{0,240}includes[^.]{0,240}\.)/i);
    return { basis: "incl_freight", evidence: m ? m[1].trim().slice(0, 300) : null };
  }
  // Both, or neither: the page is not telling us plainly enough to publish.
  return { basis: null, evidence: null };
}

export function priceFromText(text) {
  const t = String(text || "");
  // A FOOTNOTE MARKER SITS BETWEEN THE LABEL AND THE FIGURE. The real wording
  // is "Starting from* $18,599" — a pattern demanding the label run straight
  // into the dollar sign matched nothing on the very page this was built from.
  // Regex literals, not template strings: `\d` inside a template literal is
  // not the escape it looks like, and the first version of this silently
  // compiled to a pattern that could never match.
  const patterns = [
    /(?:starting\s+(?:at|from)|starting\s+msrp|msrp\s+from|price\s+from)[*†‡\d\s:,.-]{0,6}\$\s?([1-9]\d{0,2}(?:,\d{3}))/i,
    /\$\s?([1-9]\d{0,2}(?:,\d{3}))[*†‡\d\s:,.-]{0,6}(?:starting|msrp)/i,
    /msrp[^$]{0,40}\$\s?([1-9]\d{0,2}(?:,\d{3}))/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    const n = Number(String(m[1]).replace(/,/g, ""));
    if (Number.isFinite(n) && n >= MIN_PRICE && n <= MAX_PRICE) {
      return { price: n, label: m[0].trim().slice(0, 60) };
    }
  }
  return null;
}

async function main() {
  const args = parseArgs();
  const maxYears = Number(args["max-years"]) || 0;

  console.log(`[${MAKE}] asking the archive what it holds under ${PATTERN}`);
  let rows;
  try { rows = await cdxSearch(PATTERN, { limit: 4000 }); }
  catch (e) { console.error(`CDX unavailable: ${e.message}`); process.exit(1); }
  console.log(`[${MAKE}] ${rows.length} archived URL(s)`);

  // One snapshot per (year, model): the archive holds dozens of captures of the
  // same page and they say the same thing.
  const best = new Map();
  for (const row of rows) {
    const parts = partsFromShowroomUrl(row.original);
    if (!parts) continue;
    if (parts.urlYear < OLDEST_YEAR || parts.urlYear > NEWEST_ARCHIVED_YEAR) continue;
    const key = `${parts.urlYear}|${parts.model}`;
    // The EARLIEST capture of a model-year page is the one nearest its launch,
    // when the page still carried that year's own price rather than a later
    // year's takeover of the same URL.
    const prev = best.get(key);
    if (!prev || row.timestamp < prev.timestamp) best.set(key, { ...row, ...parts });
  }

  let targets = [...best.values()].sort((a, b) => b.urlYear - a.urlYear);
  if (maxYears) {
    const years = [...new Set(targets.map((t) => t.urlYear))].slice(0, maxYears);
    targets = targets.filter((t) => years.includes(t.urlYear));
  }
  console.log(`[${MAKE}] ${targets.length} (model year, model) page(s) to read\n`);

  const msrpRows = [];
  const skipped = { unreadable: 0, noPrice: 0, yearMismatch: 0, noYearOnPage: 0 };

  for (const t of targets) {
    const text = await fetchSnapshotText(t.timestamp, t.original);
    if (!text) { skipped.unreadable++; await sleep(250); continue; }

    // THE PAGE DECIDES THE MODEL YEAR, NOT THE URL.
    const pageYear = modelYearFromText(text, t.model);
    if (pageYear == null) { skipped.noYearOnPage++; await sleep(250); continue; }
    if (pageYear !== t.urlYear) {
      // A capture of /2016/veloster that the page itself calls a 2017 is the
      // URL being reused after a model-year rollover. Dropped, not guessed.
      console.log(`    skip  ${t.urlYear} ${t.model}: page says ${pageYear}`);
      skipped.yearMismatch++; await sleep(250); continue;
    }

    const found = priceFromText(text);
    if (!found) { skipped.noPrice++; await sleep(250); continue; }

    const basis = basisFromText(text, found.price);
    const captured = capturedOn(t.timestamp);
    console.log(`    ok    ${pageYear} ${t.model.padEnd(18)} $${found.price.toLocaleString()}   (captured ${captured})`);
    msrpRows.push({
      year: pageYear,
      make: MAKE,
      model: t.model.replace(/\b\w/g, (c) => c.toUpperCase()),
      trim: null,
      msrp: found.price,
      fuel_type: inferFuelFromName(t.model),
      // The snapshot IS the citation: anyone can open it and see the figure.
      source_url: `http://web.archive.org/web/${t.timestamp}/${t.original}`,
      price_basis: basis.basis || undefined,
      attrs: {
        archived_capture_date: captured,
        price_label_verbatim: found.label,
        archived_source: "internet_archive",
        ...(basis.evidence ? { price_basis_evidence: basis.evidence } : {}),
      },
      fetched_at: new Date().toISOString(),
    });
    await sleep(250);
  }

  console.log(`\n[${MAKE}] ${msrpRows.length} archived MSRP row(s).`);
  console.log(`         skipped — unreadable ${skipped.unreadable} · no price ${skipped.noPrice} · `
    + `no model year on page ${skipped.noYearOnPage} · year mismatch ${skipped.yearMismatch}`);

  if (!msrpRows.length) { console.log("Nothing to write."); return; }

  const withBasis = msrpRows.filter((r) => r.price_basis).length;
  console.log(`         ${withBasis} of ${msrpRows.length} carry a basis the page itself stated.`);

  // PER-ROW BASIS, FROM EACH PAGE'S OWN WORDING. Not a make-wide default:
  // today's Hyundai API proves msrp and delivery are separate fields NOW, which
  // is not evidence about a page from a decade ago. Rows whose page said
  // nothing keep a null basis, which suppresses the subtraction downstream --
  // the correct outcome, and the reason this is not filled in with a guess.
  await writeCatalogs(MAKE, { msrpRows, financeRows: [], leaseRows: [] }, {
    priceBasisUnknown: "archived snapshots carry their basis per row, read from each page's own legal wording; rows where the page stated nothing are left unknown",
  });
}

// Only run when invoked directly; the gate imports the two readers above.
if (process.argv[1] && process.argv[1].endsWith("scrape-archived-hyundai.mjs")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
