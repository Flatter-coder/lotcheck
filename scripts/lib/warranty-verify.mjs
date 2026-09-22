// Does the manufacturer's own page still say what our catalogue says?
//
// THE PROBLEM THIS SOLVES. manufacturer_warranties holds 35 makes and is written
// by hand, in migrations, by a person reading each manufacturer's official
// Canadian warranty page. There is no refresh job of any kind. Every figure in
// it is a claim we publish about a named car -- "this vehicle has 1 yr / 22,000
// km of factory cover remaining, and it transfers to you" -- and until now
// nothing checked whether the page it came from still says that.
//
// The cost of being wrong is not theoretical. The hand-written Tesla row read
// "8-year/160,000 km (battery & drive unit, varies by model)". 160,000 km is the
// Extended Service Agreement ceiling, not the battery term. On a 2020 Model X at
// 198,909 km we told a buyer the cover was used up; it had 41,091 km left.
// [[warranty-catalog-all-migrations]] [[warranty-catalog-all-makes]]
//
// WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT DO.
//
// It VERIFIES. It fetches the source_url already stored beside every row and
// asks one question per coverage field: are the numbers we published still
// findable on the page we published them from?
//
// It NEVER REWRITES A FIGURE. A regex that is confident enough to overwrite a
// warranty term is confident enough to invent one, and an invented warranty term
// is a false statement about a specific vehicle in a document a buyer hands to a
// dealer. Drift is reported and a human fixes it. That asymmetry is the whole
// design. [[no-llm-generated-valuation-numbers]] [[claims-must-stay-backed]]
//
// WHY TWICE A DAY FOR DATA THAT CHANGES ANNUALLY. The cadence is not about
// catching changes -- warranty terms move once a model year. It is about the age
// of the last CONFIRMATION. A row nobody has re-read against the manufacturer in
// six months is a claim with no current backing, and the report cannot tell the
// difference between that and a row checked this morning. Twice a day means the
// answer to "when did a human-sourced figure last agree with its source?" is
// never worse than twelve hours. [[every-point-has-a-catalogue]]
//
// Pure and offline: no network here, no clock, no database. The runner does I/O;
// this module decides. That split is what makes the matching testable against
// real page text without hitting 35 manufacturer sites.

// Manufacturers write the YEARS out in words and the DISTANCE in digits, in the
// same sentence: Acura's own page says "Five years or 100,000 Km, whichever
// occurs first" and "Eight years or 160,000km". A matcher that requires digits
// on both sides reads that as "our stored 5-year/100,000 km is no longer on the
// page" -- drift reported against a manufacturer for spelling a number.
const WORD_NUM = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
};

/** Numbers only. "80,000" and "80000" and "80 000" are the same distance. */
import { NO_DISTANCE_LIMIT_PATTERN } from "../../supabase/functions/_shared/distance-vocab.js";

export function normalizePage(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/[   ]/g, " ")          // non-breaking spaces
    // (?!\d) and not : Acura writes "160,000km" with no space, and there is
    // NO word boundary between "0" and "k" -- both are word characters. So the
    // separator survived, "160000 km" never matched it, and a correct row was
    // reported as drift. Found by running this against the real page.
    // {1,2}: Acura's page renders "80 ,000" -- a space AND a comma.
    .replace(/(\d)[, \s]{1,2}(\d{3})(?!\d)/g, "$1$2")   // 80,000 -> 80000
    .replace(/[‐-―]/g, "-")               // en/em dashes -> hyphen
    .replace(/\s+/g, " ")
    // "Five years" -> "5 years", but ONLY before a time word, so a "four-door
    // sedan" or "eight airbags" elsewhere on the page never becomes a term.
    .replace(
      new RegExp(`\\b(${Object.keys(WORD_NUM).join("|")})\\b(?=[ -](?:year|yr|month))`, "g"),
      (w) => String(WORD_NUM[w]),
    );
}

/**
 * Read a stored coverage string into the numbers it asserts.
 *
 * Real values from the live table, all of which must parse:
 *   "4-year/80,000 km"
 *   "6-year/unlimited km"
 *   "10-year/160,000 km"
 *   "8-year/160,000 km (components), 10-year/240,000 km (battery)"
 *   "8-year/160,000 km (battery & drive unit, varies by model)"
 *
 * A term may assert SEVERAL pairs; all of them are checked, because the second
 * pair is usually the expensive one (the battery) and is exactly the figure the
 * Tesla defect got wrong.
 */
export function parseTerm(term) {
  const t = normalizePage(term);
  if (!t) return { pairs: [], unparsed: true };
  const pairs = [];
  // "<n>-year" / "<n> year" / "<n> yr", then a distance before the next pair.
  const re = new RegExp(`(\\d{1,2})\\s*-?\\s*(?:year|yr)s?\\s*[\\/,: ]\\s*(${NO_DISTANCE_LIMIT_PATTERN}|\\d{2,7})\\s*(?:km|kilometre|kilometer|mile)?`, "g");
  let m;
  while ((m = re.exec(t))) {
    // OUR OWN STORED VALUE GETS THE SAME VOCABULARY AS THEIR PAGE. Honda holds
    // "5-year/no distance limit" and Subaru "5-year/no km limit"; both read as
    // "could not read our own stored value as a term" while pairOnPage had
    // understood those exact words all along.
    const n = Number(m[2]);
    pairs.push({ years: Number(m[1]), km: Number.isFinite(n) ? n : "unlimited" });
  }

  // A TERM MAY STATE YEARS AND NO DISTANCE AT ALL. MINI publishes "12-year Rust
  // Perforation Warranty" and Polestar "12 years after delivery" -- neither
  // gives a kilometre figure and neither says there is no limit. Treating that
  // as unreadable would report our own correct value as a defect; treating it
  // as unlimited would assert a limit nobody published. It is its own case.
  if (!pairs.length) {
    const yOnly = t.match(new RegExp(`(\\d{1,2})\\s*-?\\s*(?:year|yr)s?`));
    if (yOnly) pairs.push({ years: Number(yOnly[1]), km: "not_stated" });
  }
  return { pairs, unparsed: pairs.length === 0 };
}

/**
 * Is this pair still on the page?
 *
 * Manufacturers phrase the same cover a dozen ways -- "4 years or 80,000 km",
 * "48 months/80,000 km", "80,000 km / 4 years" -- so matching the STORED STRING
 * against the page would report drift on almost every make and the report would
 * be noise. What cannot vary is the two numbers. Both must appear, close
 * together, with the distance actually labelled as a distance: finding "4" and
 * "80000" anywhere on a long page proves nothing.
 *
 * Months are accepted for the year figure (48 months IS 4 years) because several
 * makes publish it that way.
 */
export function pairOnPage(pair, page) {
  const p = normalizePage(page);
  if (!p) return false;
  // "UNLIMITED" IS THE WORD WE CHOSE; IT IS NOT THE WORD THEY USE.
  // Lexus states its corrosion cover as "72 months, regardless of distance
  // travelled" -- the word "unlimited" appears NOWHERE on that page. Matching
  // only our own vocabulary reported a correct row as drifted, which is an
  // accusation against the manufacturer produced by our own word choice.
  // A term with no distance is confirmed by its YEARS sitting beside warranty
  // vocabulary. Requiring a distance that was never published would report
  // drift on a figure the manufacturer still states.
  if (pair.km === "not_stated") {
    const y = `(?:${pair.years}\\s*-?\\s*(?:year|yr)s?|${pair.years * 12}\\s*months?)`;
    return new RegExp(`${y}[^;]{0,60}?(?:warrant|coverage|perforation|corrosion|rust)`).test(p)
        || new RegExp(`(?:warrant|coverage|perforation|corrosion|rust)[^;]{0,60}?${y}`).test(p);
  }
  const dist = pair.km === "unlimited"
    ? NO_DISTANCE_LIMIT_PATTERN
    : `${pair.km}\\s*(?:km|kilometre|kilometer)`;
  const yrs = `(?:${pair.years}\\s*-?\\s*(?:year|yr)s?|${pair.years * 12}\\s*months?)`;
  // PERIODS ARE ALLOWED INSIDE THE WINDOW. Acura writes its rust-perforation
  // cover as TWO SENTENCES -- "Five years. No distance limit." -- and a window
  // that refused to cross a full stop reported our CORRECT stored value as
  // drift. The window stays 40 characters, which is the real guard; excluding
  // the punctuation was never what kept an unrelated sentence out.
  // The trade is stated plainly: a slightly looser window can CONFIRM something
  // it should have flagged. That direction is the safer one here, because this
  // job never writes a figure -- a false confirm delays a finding, while a
  // false drift accuses a manufacturer of changing something they did not.
  // Either order, within a short window -- the two numbers must be presented
  // together, which is how a coverage term is always written.
  const a = new RegExp(`${yrs}[^;]{0,40}?${dist}`);
  const b = new RegExp(`${dist}[^;]{0,40}?${yrs}`);
  return a.test(p) || b.test(p);
}

/**
 * Does this page state ANY warranty-shaped term at all?
 *
 * THE CALIBRATION THAT STOPPED THIS SHIPPING BROKEN. A first probe of six real
 * manufacturer pages reported three as "drifted" -- and "unlimited km" failed on
 * Lexus AND Acura in the same run, which is not two brands changing terms in the
 * same week. It is a page we only half-read: a client-rendered warranty table
 * leaves a shell of navigation copy that is long enough to look like a page and
 * contains none of the numbers.
 *
 * A "drifted" report is an accusation that the manufacturer no longer states
 * something we publish, and it goes red. Crying wolf on half the catalogue twice
 * a day would make the whole job unreadable within a week.
 *
 * So drift now requires EVIDENCE THAT THE PAGE IS TALKING ABOUT WARRANTIES: at
 * least one year/distance pair somewhere on it. No pairs at all means we did not
 * really read it, and that is UNREACHABLE -- our failure, named as ours. Same
 * rule as everything else here. [[supervised-correctness-is-not-correctness]]
 */
export function pageStatesAnyTerm(page) {
  const p = normalizePage(page);
  if (!p) return false;
  return /(?:\d{1,2}\s*-?\s*(?:year|yr)s?|\d{2,3}\s*months?)[^;]{0,40}?(?:unlimited|\d{4,7}\s*(?:km|kilometre|kilometer))/.test(p)
    || /(?:unlimited|\d{4,7}\s*(?:km|kilometre|kilometer))[^;]{0,40}?(?:\d{1,2}\s*-?\s*(?:year|yr)s?|\d{2,3}\s*months?)/.test(p);
}

/**
 * Does this page DISCUSS this kind of cover, in a coverage context?
 *
 * Not merely 'does the word appear'. Every manufacturer's navigation and footer
 * mention roadside assistance, warranties and accessories on every page; Acura’s
 * nav reads "Warranty & Protection Roadside Assistance Resources" 578 characters
 * in. A bare word test therefore said "this page covers roadside", found no term,
 * and reported DRIFT against the manufacturer for a link in their own menu.
 *
 * So the subject has to appear NEAR a year/distance pair. Chrome has no numbers
 * beside it; a coverage table always does.
 */
export function fieldCoveredOnPage(field, page) {
  const subject = FIELD_SUBJECT[field];
  if (!subject) return true;
  const p = normalizePage(page);
  const re = new RegExp(subject.source, "gi");
  let m;
  while ((m = re.exec(p))) {
    const around = p.slice(Math.max(0, m.index - 160), m.index + 240);
    if (pageStatesAnyTerm(around)) return true;
  }
  return false;
}
/** "confirmed" | "drifted" | "not_covered" | "unparsed" — never "corrected". */
export function verifyField(term, page, field) {
  if (term == null || String(term).trim() === "") return { state: "absent", pairs: [] };
  const { pairs, unparsed } = parseTerm(term);
  if (unparsed) return { state: "unparsed", pairs: [] };
  // Does this page even discuss this kind of cover? If not, the figure is not
  // contradicted -- it is uncited.
  if (!fieldCoveredOnPage(field, page)) return { state: "not_covered", pairs: [] };
  const checked = pairs.map((pr) => ({ ...pr, found: pairOnPage(pr, page) }));
  // EVERY pair must still be findable. Confirming a term because its FIRST pair
  // matched is how "8-year/160,000 km (components), 10-year/240,000 km (battery)"
  // passes while the battery figure -- the expensive half, and the one the Tesla
  // report got wrong -- has silently changed.
  return { state: checked.every((c) => c.found) ? "confirmed" : "drifted", pairs: checked };
}

const FIELDS = ["basic_coverage", "powertrain_coverage", "corrosion_coverage",
  "roadside_assistance", "hybrid_ev_coverage"];

// WHAT EACH FIELD IS ABOUT, so "this page never mentions roadside" can be told
// apart from "this page no longer states the roadside term we hold".
//
// Lexus's warranty page covers comprehensive, powertrain, corrosion, emissions
// and hybrid -- and says nothing about roadside assistance at all. Reporting
// that as DRIFT blames the manufacturer for a page we chose. It is a CITATION
// gap: our source_url does not support every field we cite it for, and the fix
// is a better URL, not a corrected figure. [[make-it-dispute-proof]]
const FIELD_SUBJECT = {
  basic_coverage: /\b(basic|comprehensive|bumper[- ]to[- ]bumper|new vehicle limited|whole vehicle|major component)/i,
  // EV-only makes have no ICE powertrain, so migration 20260802 deliberately
  // stores the BATTERY AND DRIVE UNIT term in powertrain_coverage -- the Tesla
  // row is exactly that. Narrow phrasings only: a bare "battery" matches the
  // 12V accessory battery on half the pages on the internet, and a false "this
  // page covers powertrain" turns straight back into false drift.
  powertrain_coverage: /\b(powertrain|power train|engine and transmission|drivetrain|major component|drive unit|traction battery|high[- ]voltage battery|battery and drive)/i,
  corrosion_coverage: /\b(corrosion|perforation|rust|anti[- ]?perforation)/i,
  roadside_assistance: /\broadside\b/i,
  hybrid_ev_coverage: /\b(hybrid|electric|high[- ]voltage|traction battery|drive unit|ev\b)/i,
};

/**
 * One row against one page.
 *
 * `page` is null when the fetch failed. That is NOT drift -- we did not look,
 * and saying "the manufacturer no longer states this" because our own request
 * timed out is the same defect class as the whole 2026-09-13 report audit.
 */
/* A URL, or the reason it is not one.
 *
 * Three rows store a CITATION where a URL belongs:
 *   "https://www.ford.ca (Ford of Canada New Vehicle Limited Warranty Guide)"
 * Ford, Nissan and Subaru cite printed booklets. There is no page to fetch, and
 * `new URL()` throws on the whole string, which the job reported as
 * "unreachable" -- a word that says the MANUFACTURER'S site failed. It did not.
 * We stored something that was never fetchable. Different fact, different word,
 * and only one of the two is ours to fix. [[present-without-creating-questions]]
 */
export function sourceUrlOf(raw) {
  const s = String(raw || "").trim();
  if (!s) return { url: null, why: "no_source" };
  let u;
  try { u = new URL(s); } catch { u = null; }
  if (u && /^https?:$/.test(u.protocol)) return { url: u.href, why: null };
  // A bare origin followed by a document title is a citation of something
  // printed. Do NOT silently fetch the homepage: a homepage states no warranty
  // term, so it would read as "we looked and found nothing".
  if (/^https?:\/\/\S+\s+\(.+\)\s*$/.test(s)) return { url: null, why: "cites_document" };
  return { url: null, why: "bad_url" };
}

export const SOURCE_NOTE = {
  no_source: "no source_url on this row -- the figure cites nothing",
  cites_document: "this figure cites a printed booklet, not a web page, so there is nothing to re-read. " +
    "It is unverified by this job -- which is a gap in how we stored it, not a failure of the manufacturer's site.",
  bad_url: "the stored source is not a usable URL, so nothing was fetched. Ours to fix, not theirs.",
};

export function verifyRow(row, page, http = null) {
  const src = sourceUrlOf(row?.source_url);
  if (!src.url) return { status: src.why, fields: {}, note: SOURCE_NOTE[src.why] || SOURCE_NOTE.bad_url };
  if (page == null) {
    /* THEIR REFUSAL IS NOT OUR OUTAGE. 13 of 20 "unreachable" makes answer HTTP
     * 403 to an honest User-Agent -- GM and Stellantis each behind one WAF.
     * That is a live site declining an identified client, which is their
     * decision to make and a different thing from a link that is dead or a
     * network that failed. It is recorded as `blocked` so it can be counted,
     * escalated or routed through the render path on its own merits.
     *
     * We do NOT answer a 403 by pretending to be Chrome. A browser User-Agent
     * returns 200 from gmccanada.ca -- and sending one would be evasion, which
     * is not the posture this repo takes toward permission.
     * [[dealer-tos-daily-checks]]
     */
    const code = Number(http) || 0;
    if (code === 403 || code === 401 || code === 429) {
      return { status: "blocked", fields: {},
        note: `the manufacturer's site answered HTTP ${code} to an identified request. The stored figures are unchanged and unverified. This is their refusal, not a broken link.` };
    }
    if (code === 404 || code === 410) {
      return { status: "dead_link", fields: {},
        note: `the stored source URL returns HTTP ${code}. The page has moved or gone; the URL needs replacing. Ours to fix.` };
    }
    return { status: "unreachable", fields: {}, note: "we could not reach the manufacturer's page; the stored figures are unchanged and unverified" };
  }

  // Before judging any field: did we actually read a warranty page? A shell with
  // no year/distance pair anywhere is not evidence that the manufacturer dropped
  // a term -- it is evidence that we did not read the term.
  if (!pageStatesAnyTerm(page)) {
    return {
      status: "unreachable", fields: {},
      note: "the page we fetched states no warranty term at all, so we did not really read it (client-rendered table, consent wall, or a redirect). The stored figures are unchanged and unverified.",
    };
  }

  const fields = {};
  for (const f of FIELDS) fields[f] = verifyField(row[f], page, f);
  const live = FIELDS.filter((f) => fields[f].state !== "absent");
  if (!live.length) return { status: "empty_row", fields, note: "this make has no coverage figures stored" };

  const drifted = live.filter((f) => fields[f].state === "drifted");
  const unparsed = live.filter((f) => fields[f].state === "unparsed");
  const uncited = live.filter((f) => fields[f].state === "not_covered");
  if (drifted.length) {
    return {
      status: "drifted", fields,
      note: `no longer found on the manufacturer's page: ${drifted.map((f) => `${f}="${row[f]}"`).join("; ")}. NOT auto-corrected -- a human must re-read the source and update the row.`,
    };
  }
  if (unparsed.length) {
    return { status: "unparsed", fields, note: `could not read our own stored value as a term: ${unparsed.join(", ")}` };
  }
  if (uncited.length) {
    return {
      status: "uncited", fields,
      note: `this page does not cover ${uncited.join(", ")} at all, so our source_url does not support ${uncited.length === 1 ? "that figure" : "those figures"}. Not a finding about the manufacturer -- find a URL that states ${uncited.length === 1 ? "it" : "them"}.`,
    };
  }
  return { status: "confirmed", fields, note: `all ${live.length} stored figure(s) still stated on the manufacturer's page` };
}

export const VERIFY_FIELDS = FIELDS;
