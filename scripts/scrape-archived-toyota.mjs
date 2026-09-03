#!/usr/bin/env node
// ── Toyota Canada ARCHIVED MSRP: what a used Toyota cost when it was new ─────
//
// Toyota's Canadian newsroom keeps every model-year launch release up
// permanently, and each one prints the full grade ladder with a Canadian price.
// That makes it the one source for a model year Toyota itself no longer sells.
//
//   sitemap : https://media.toyota.ca/en/sitemap.xml
//   release : https://media.toyota.ca/en/releases/<PUBLICATION_YEAR>/<slug>.html
//
// THREE THINGS THAT WILL BITE ANYONE EDITING THIS.
//
// 1. PUBLICATION YEAR IS NOT MODEL YEAR. The MY2020 RAV4 launch is filed under
//    /releases/2019/, because the car goes on sale the autumn before. The model
//    year comes from the vehicle's NAME in the headline and nowhere else. Take
//    the folder and every archived price lands a year out, on a catalogue whose
//    entire job is to be pinned to a model year.
//
// 2. "STARTING MSRP" IS THE STICKER, AND THAT IS PROVABLE, NOT ASSUMED. The
//    newer two-column releases footnote the SECOND column: "Vehicle Price
//    includes MSRP/Freight PDI/AC charge/maximum Dealer fees..." — so column
//    one, "Starting MSRP", is MSRP alone. Cross-checked independently: the
//    2020-09-18 capture of toyota.ca carries shownPrice and freight as separate
//    fields (Camry LE $26,620 + freight $1,770), and the MY2020 Camry release
//    prints exactly $26,620. Press-release "Starting MSRP" == toyota.ca
//    shownPrice == ex-freight. We store price_basis excl_freight and never fold
//    freight in. [[msrp-100-percent-accuracy]]
//
// 3. media.toyota.ca REPUBLISHES US RELEASES, which carry no Canadian price at
//    all. A price-less release is a MISS, never a zero: we skip it and say so.
//
// Usage:
//   node scripts/scrape-archived-toyota.mjs                 # all years, dry-run without a key
//   node scripts/scrape-archived-toyota.mjs --from=2018 --to=2024
//   node scripts/scrape-archived-toyota.mjs --url=<release> # one release, for checking the parser

import { writeCatalogs, parseArgs } from "./lib/catalog-io.mjs";
import { getHtml, toText, readPrice, readModelYear, archivedRow, refuseCurrentYears, BASIS, plausibleVehiclePrice } from "./lib/archived-msrp.mjs";

const MAKE = "Toyota";
const SITEMAP = "https://media.toyota.ca/en/sitemap.xml";
const CURRENT_YEAR_FLOOR = 2025;   // the daily scrapers own 2025+

/** Grade words that are a trim, versus prose that merely sits near a price. */
const TRIM_OK = /^[A-Z0-9][A-Za-z0-9''.\-+/ ]{0,38}$/;
const NOT_A_TRIM = /\b(price|msrp|freight|pdi|dealer|starting|includes?|available|models?|grades?|lineup|toyota|canada|vehicle)\b/i;

/** "2020 Toyota RAV4 Hybrid" -> "RAV4 Hybrid". Never guesses. */
export function modelFromTitle(title) {
  if (typeof title !== "string") return null;
  const m = title.match(/\b20\d{2}\s+Toyota\s+([A-Za-z0-9][A-Za-z0-9\- ]{1,28})/);
  if (!m) return null;
  return m[1]
    .replace(/\b(is|are|the|all|new|now|arrives?|gets?|adds?|brings?|revs?|and|with|for|in|on|to|a|an)\b.*$/i, "")
    .replace(/\s+/g, " ").trim() || null;
}

/**
 * The two shapes Toyota actually publishes.
 *
 * TABLE (MY2024+): a row per grade, cells separated by tabs after toText().
 *   "LE AWD \t $33,555 \t $37,125"  -> the FIRST price is Starting MSRP.
 * PROSE (older): "RAV4 LE is offered in a choice of FWD (starting MSRP:
 *   $28,090), and AWD (starting MSRP: $30,190)".
 *
 * Anything that does not fit one of these is left alone. A parser that guesses
 * on a page it does not understand is how a catalogue fills with plausible
 * wrong numbers, and a wrong MSRP is the denominator of every comparison we
 * make. [[missing-beats-wrong]]
 */
export function parseGrades(text, model) {
  const out = new Map();          // trim -> msrp (first wins; releases repeat)
  const add = (trim, msrp) => {
    if (!trim || !plausibleVehiclePrice(msrp)) return;
    let t = String(trim).replace(/\s+/g, " ").trim().replace(/^[-–—:•]+\s*/, "").replace(/[.,;:]+$/, "");
    // Releases label rows with the model in front ("RAV4 LE"); the model is
    // already its own column, so carrying it into the trim would give us
    // "RAV4 RAV4 LE" and break every trim match downstream.
    if (model) t = t.replace(new RegExp("^" + model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s+", "i"), "").trim();
    if (!t || !TRIM_OK.test(t) || NOT_A_TRIM.test(t)) return;
    if (!out.has(t)) out.set(t, msrp);
  };

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    // TABLE: grade in the first cell, Starting MSRP in the first priced cell.
    if (line.includes("\t")) {
      const cells = line.split("\t").map((c) => c.trim()).filter(Boolean);
      if (cells.length >= 2) {
        const price = readPrice(cells.slice(1).find((c) => readPrice(c) != null) || "");
        if (price != null && readPrice(cells[0]) == null) add(cells[0], price);
      }
      continue;
    }

    // PROSE. Anchored on the vehicle's own name, which is how Toyota writes
    // every one of these sentences:
    //
    //   "The 2020 Toyota RAV4 Limited (starting MSRP: $41,250) is an AWD model"
    //   "The 2020 Toyota RAV4 LE is offered in a choice of FWD (starting MSRP:
    //    $28,090), and AWD (starting MSRP: $30,190) drivetrain configurations."
    //
    // Anchoring on "<year> Toyota <model>" is what makes the trim reliable: a
    // regex that hunts backwards from the price picks up whatever words happen
    // to precede it, which is how the first version of this returned "AWD"
    // where the grade was "LE AWD". The drivetrain split has to be read as one
    // sentence about one grade, not two grades.
    const esc = String(model).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const anchor = new RegExp(`20\\d{2}\\s+Toyota\\s+${esc}\\s+([A-Za-z0-9][A-Za-z0-9''.\\-+/ ]{0,44}?)\\s*(?=\\(|\\bis (?:offered|available)\\b|,\\s*\\()`, "gi");
    let a;
    while ((a = anchor.exec(line)) !== null) {
      const label = a[1].trim();
      const rest = line.slice(a.index + a[0].length, a.index + a[0].length + 300);

      // Drivetrain split: one grade, two prices, one row each. Toyota writes
      // this two ways across the years -- "is offered in a choice of FWD ...
      // and AWD ..." (MY2020) and "is available in both front-wheel-drive ...
      // and all-wheel-drive ..." (MY2018) -- and the second spells the
      // drivetrain out. Matching only the first silently lost the base grade of
      // every older release, which is the cheapest row in the ladder and the
      // one a buyer most often wants.
      if (/^\s*is (?:offered|available) in (?:a choice of|both)/i.test(rest)) {
        const dt = /\b(FWD|AWD|4WD|2WD|front-wheel[- ]drive|all-wheel[- ]drive|four-wheel[- ]drive)\b[^$(]{0,24}\(?\s*starting\s+MSRP[:\s]*\$?\s*([\d,]{5,9})/gi;
        const norm = (s) => /front/i.test(s) ? "FWD" : /all-wheel/i.test(s) ? "AWD" : /four/i.test(s) ? "4WD" : s.toUpperCase();
        let d, found = 0;
        while ((d = dt.exec(rest)) !== null) {
          const px = readPrice("$" + d[2]);
          if (px != null) { add(`${label} ${norm(d[1])}`, px); found++; }
        }
        if (found) continue;
      }

      // The ordinary shape: the price is the first one after the grade.
      const p = rest.match(/^\s*\(?\s*starting\s+MSRP[:\s]*\$?\s*([\d,]{5,9})/i);
      if (p) { const px = readPrice("$" + p[1]); if (px != null) add(label, px); }
    }
  }
  return [...out.entries()].map(([trim, msrp]) => ({ trim, msrp }));
}

async function releaseUrls({ from, to }) {
  const xml = await getHtml(SITEMAP);
  if (!xml) throw new Error("sitemap unreachable");
  const urls = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
  // A release for model year Y is published in Y-1 or Y, so widen by one.
  return urls.filter((u) => {
    const m = u.match(/\/en\/releases\/(20\d{2})\//);
    if (!m) return false;
    const py = Number(m[1]);
    return py >= from - 1 && py <= to;
  });
}

async function scrapeRelease(url) {
  const html = await getHtml(url);
  if (!html) return { url, rows: [], why: "unreachable" };
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const h1M = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = toText(h1M?.[1] || titleM?.[1] || "").trim();
  const year = readModelYear(title);
  const model = modelFromTitle(title);
  if (!year || !model) return { url, rows: [], why: "no model year or model in the headline" };

  const text = toText(html);
  // A Canadian release says so, in dollars, with a Canadian dateline or the
  // word MSRP beside a price. A republished US release has neither.
  if (!/MSRP/i.test(text)) return { url, rows: [], why: "no MSRP on the page (likely a republished US release)" };

  const grades = parseGrades(text, model);
  const capturedOn = new Date().toISOString().slice(0, 10);
  const rows = grades
    .map((g) => archivedRow({
      year, make: MAKE, model, trim: g.trim, msrp: g.msrp,
      basis: BASIS.EXCL_FREIGHT, sourceUrl: url, capturedOn,
      fuel: /hybrid|prime|hev|phev/i.test(model + " " + g.trim) ? "Hybrid" : null,
    }))
    .filter(Boolean);
  return { url, year, model, rows, why: rows.length ? null : "no grade ladder recognised" };
}

async function main() {
  const args = parseArgs();
  const from = Number(args.from) || 2016;
  const to = Number(args.to) || CURRENT_YEAR_FLOOR - 1;

  if (args.url) {
    const r = await scrapeRelease(String(args.url));
    console.log(`\n${r.url}\n  ${r.model ?? "?"} MY${r.year ?? "?"} — ${r.rows.length} row(s)${r.why ? "  (" + r.why + ")" : ""}`);
    for (const row of r.rows) console.log(`    ${String(row.trim).padEnd(30)} $${row.msrp.toLocaleString()}`);
    return;
  }

  const urls = await releaseUrls({ from, to });
  console.log(`[${MAKE}] ${urls.length} release(s) published ${from - 1}-${to}`);

  let all = [], hits = 0, misses = 0;
  for (const u of urls) {
    const r = await scrapeRelease(u);
    if (r.rows.length) { hits++; all = all.concat(r.rows); }
    else misses++;
  }
  // A model year the daily scraper owns must never be overwritten from an
  // archive: today's price is a better fact than a launch-day one.
  all = refuseCurrentYears(all, CURRENT_YEAR_FLOOR);
  // One row per (year, model, trim). Releases are re-issued and refreshed, and
  // the launch price is the one that was true when the car was new.
  const seen = new Map();
  for (const r of all) { const k = `${r.year}|${r.model}|${r.trim}`; if (!seen.has(k)) seen.set(k, r); }
  const rows = [...seen.values()].filter((r) => r.year >= from && r.year <= to);

  const years = [...new Set(rows.map((r) => r.year))].sort();
  console.log(`[${MAKE}] ${hits} release(s) yielded prices, ${misses} did not. ${rows.length} archived MSRP row(s) across MY${years[0] ?? "-"}-${years[years.length - 1] ?? "-"}.`);
  for (const y of years) console.log(`   MY${y}: ${rows.filter((r) => r.year === y).length} rows`);

  // upsert: archived years merge BESIDE the current catalogue, never replacing
  // it. replaceRows is keyed (year, make, model, trim).
  await writeCatalogs(MAKE, { msrpRows: rows }, { upsert: true, label: "archived MSRP" });
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1].endsWith("scrape-archived-toyota.mjs")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
