// Capture a manufacturer's OWN LAUNCH-PRICING press release — a different
// channel from the Build & Price scrapers (tci-stack.mjs, gm-stack.mjs,
// fca-stack.mjs), for the makes that have no such scraper at all.
//
// WHERE THIS CAME FROM. A 2026-09-23 survey of all 35 makes' official Canadian
// newsrooms (see the memory manufacturer-canada-pressroom-survey.md) found that
// sales-VOLUME releases are universally useless for a per-vehicle report — a
// brand-wide unit count backs no single car's price. But several of the SAME
// newsrooms also publish real per-trim MSRP announcements when a model
// launches. GM and Stellantis brands already have a systematic scraper for
// this (their Build & Price APIs), so a press-release reader there would be a
// second, weaker author of the same fact — the two-authors-per-fact shape this
// repo spent 2026-09-22/23 closing. Subaru and BMW/MINI do not have one.
//
// BMW WAS CHECKED AND CUT. Its "/canada/rss" path serves BMW Group's GLOBAL
// corporate feed (production-line and concept-car news, zero Canada pricing
// content in the sampled window) despite the URL's /canada/ segment — reachable
// is not the same as useful, and shipping a parser against the wrong feed
// would be worse than not shipping one. Re-verify before adding a second make.
//
// SUBARU'S OWN PRICE TABLE ALREADY STATES BOTH BASES. Confirmed across three
// real releases (Trailseeker, Solterra, Uncharted — scripts/fixtures/): a
// <table class="pricing-table"> with columns Trim / MSRP / EVP. "Estimated
// Vehicle Price (EVP) includes MSRP/Freight PDI/AC charge/maximum Dealer
// fees/maximum other fees and charges, and excludes taxes, license, insurance
// and registration" is Subaru's own definition, printed on every such release
// — an ALL-IN figure, in the same table as the ex-freight MSRP, with no
// inference needed. [[amvic-all-in-pricing]] [[manufacturer-publishes-all-in-price]]
//
// MISSING BEATS WRONG. This module refuses far more than it extracts:
//   * a title that doesn't name a known Subaru model is skipped, never guessed
//   * a matched-title article with no pricing-table is skipped, never
//     regex-scraped from prose (that risk belongs to published-price.mjs's
//     "starting at" scanner, built for pages with no structured table; Subaru
//     HAS one, so falling back to fuzzy prose extraction here would be a
//     downgrade, not a fallback)
//   * a table cell that isn't a clean whole-dollar figure is skipped per-row,
//     not defaulted to null and not allowed to abort the whole release

const EVP_DEFINITION =
  "Subaru Canada's own Estimated Vehicle Price (EVP): MSRP + Freight/PDI + " +
  "A/C charge + maximum dealer fees + maximum other fees and charges; " +
  "excludes taxes, licence, insurance and registration.";

// The current Canadian Subaru lineup, longest name first so "Crosstrek" does
// not swallow a hypothetical "Crosstrek Sport" title before the real match
// runs — none of the observed titles need that yet, but the ordering is the
// cheap, permanent guard against a future one silently mismatching.
const SUBARU_MODELS = [
  "Trailseeker", "Uncharted", "Crosstrek", "Forester", "Outback",
  "Impreza", "Legacy", "Ascent", "Solterra", "WRX", "BRZ",
].sort((a, b) => b.length - a.length);

function stripTags(s) {
  return String(s == null ? "" : s)
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
}

// RSS <pubDate> here is "M/D/YYYY 12:00:00 AM" (verified against the live
// feed), not RFC-822 — new Date() parsing of that shape is engine-dependent,
// so it is parsed explicitly rather than trusted.
function parsePubDate(raw) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(raw || "").trim());
  if (!m) return null;
  const [, mo, d, y] = m.map(Number);
  const iso = new Date(Date.UTC(y, mo - 1, d)).toISOString();
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/** Parse the RSS feed into { title, link, pubDate, description } items. */
export function parseFeedItems(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(String(xml || ""))) !== null) {
    const block = m[1];
    const field = (tag) => {
      const mm = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(block);
      return mm ? stripTags(mm[1].replace(/^<!\[CDATA\[|\]\]>$/g, "")) : "";
    };
    items.push({
      title: field("title"),
      link: field("link"),
      pubDate: field("pubDate"),
      description: field("description"),
    });
  }
  return items;
}

/**
 * Does this title announce launch pricing, and if so, for which model/year?
 * Returns null (never a guess) when either signal is missing or ambiguous.
 */
export function identifyPricingRelease(title) {
  const t = String(title || "");
  if (!/pric(e|ing)/i.test(t)) return null; // not a pricing release at all
  const yearM = /\b(20\d{2})\b/.exec(t);
  if (!yearM) return null; // a pricing release naming no model year is not usable
  const model = SUBARU_MODELS.find((name) => new RegExp(`\\b${name}\\b`, "i").test(t));
  if (!model) return null; // an unrecognised model name — do not guess which one
  const allElectric = /all-?electric/i.test(t);
  return { year: Number(yearM[1]), model, allElectric };
}

// A whole-dollar figure only. Subaru's table never carries cents; anything
// else means the cell was not a price at all (a stray currency symbol, a
// footnote marker) and the row is not usable.
function parseDollar(cell) {
  const m = /^\$\s?([0-9]{2,3}(?:,[0-9]{3}))$/.exec(stripTags(cell).trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isInteger(n) && n >= 10_000 && n <= 250_000 ? n : null;
}

/**
 * Extract {trim, msrp, allInPrice} rows from the <table class="pricing-table">
 * in a rendered article page. Returns [] — never throws, never guesses — when
 * no such table exists, matching "an article that matched the title filter but
 * carries no table is a refusal, not a prose-scraping fallback" above.
 */
export function extractPricingTable(html) {
  const tableM = /<table class="pricing-table">([\s\S]*?)<\/table>/.exec(String(html || ""));
  if (!tableM) return [];
  const rows = [];
  const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
  let rm;
  while ((rm = rowRe.exec(tableM[1])) !== null) {
    const row = rm[1];
    const trimM = /data-label="Trim">([^<]*)</.exec(row);
    const msrpM = /data-label="MSRP">([^<]*)</.exec(row);
    const evpM = /data-label="EVP">([^<]*)</.exec(row);
    if (!trimM || !msrpM) continue; // header row, or a row this table shape doesn't carry
    const trim = stripTags(trimM[1]).trim();
    const msrp = parseDollar(msrpM[1]);
    // A trim NAME with no readable price is exactly the shape that must not
    // become a null-priced row: a null-trim/null-price is invisible in review,
    // a NAMED trim with no price looks like it was captured. Drop the row.
    if (!trim || msrp == null) continue;
    const allInPrice = evpM ? parseDollar(evpM[1]) : null;
    rows.push({ trim, msrp, allInPrice });
  }
  return rows;
}

/**
 * Full pipeline: one RSS item + its already-fetched article HTML -> catalog
 * rows, or [] with nothing written. `fetchedAt` should be the item's own
 * pubDate (parsed) so a re-run does not claim today's date for a months-old
 * announcement; falls back to now() only when the feed's date is unparsable.
 */
export function toCatalogRows(item, html) {
  const id = identifyPricingRelease(item.title);
  if (!id) return [];
  const table = extractPricingTable(html);
  if (!table.length) return [];
  const fetchedAt = parsePubDate(item.pubDate) || new Date().toISOString();
  const fuelType = id.allElectric ? "BEV" : null; // read from the title's own
  // words, never inferred from the model name — Uncharted's 2026 launch title
  // said "ALL-ELECTRIC" explicitly; a later release for the same nameplate
  // might not repeat it, and guessing from the name alone is what this file
  // exists to avoid doing anywhere else in the pipeline.
  return table.map((r) => ({
    year: id.year,
    make: "Subaru",
    model: id.model,
    trim: r.trim,
    msrp: r.msrp,
    fuel_type: fuelType,
    price_basis: "excl_freight",
    ...(r.allInPrice != null ? {
      all_in_price: r.allInPrice,
      attrs: { all_in_basis: EVP_DEFINITION, seeded: "press-release" },
    } : { attrs: { seeded: "press-release" } }),
    source_url: item.link,
    fetched_at: fetchedAt,
  }));
}
