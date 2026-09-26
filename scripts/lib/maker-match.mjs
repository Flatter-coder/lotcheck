// MAKER VS DEALER, ACCOUNTED FOR.
//
// The daily report's "Manufacturer vs Alberta dealer prices" row said "989 of
// 5,883 live new cars matched to a confident manufacturer MSRP; 4,710 could
// not be matched to an exact trim yet" -- and nothing said WHY 4,710 failed,
// so nobody could tell a dealer who never named the trim from a catalogue we
// never finished. (5,883 - 989 - 4,710 = 184 cars were in neither number: a
// car with no single city left the tally entirely.)
//
// The owner's accounting principle (2026-09-25, inventory; applied here the
// same way): the row is GREEN when every car is ACCOUNTED FOR -- matched, or
// held back for a named reason that is the SOURCE's. A gap that is OURS keeps
// it amber. Never hide a gap by redefinition: every reason below names whose
// gap it is, and a reason that cannot be shown to be the source's is ours.
//
// Pure: no I/O. build-city-price-index.mjs feeds it; test-maker-match.mjs pins it.
import { pickTrimMsrp } from "../../supabase/functions/_shared/trim-match.js";

// ---- the reasons, and whose they are ---------------------------------------

// THE SOURCE'S. Each is something the dealer's listing or the manufacturer did
// (or did not) publish -- a fact about THEIR page, not about our reading of it.
export const SOURCE_REASONS = {
  listing_states_no_price: "the dealer's listing states no price to compare",
  listing_names_no_trim: "the dealer's listing names no trim, and the maker sells more than one",
  maker_publishes_no_msrp: "the manufacturer publishes no national MSRP for it",
  maker_asks_not_to_be_read: "the manufacturer's price service asks crawlers not to read it",
  model_year_not_published: "the manufacturer has not published that model year's prices",
};

// OURS. Our catalogue or our matcher could not place the car.
export const OUR_REASONS = {
  catalogue_missing_make: "our catalogue holds no prices for the make",
  catalogue_missing_model: "our catalogue holds no prices for the model",
  catalogue_missing_year: "our catalogue holds the model, but not that model year",
  model_year_superseded: "an older model year the maker no longer shows; our catalogue did not keep it",
  catalogue_base_price_only: "our catalogue holds only the model's starting price, not its trims",
  catalogue_missing_trim: "the trim the dealer names is not in our catalogue",
  catalogue_config_unpinned: "our catalogue row does not state the drivetrain the dealer names",
  catalogue_duplicate_trim: "our catalogue holds one trim name at two prices",
  catalogue_missing_powertrain: "our catalogue lacks that powertrain's price ladder",
  powertrain_unlabelled: "our catalogue row does not say which powertrain it prices",
  powertrain_ambiguous: "the trim exists in more than one powertrain and the listing does not say which",
  trim_ambiguous: "the dealer's trim name fits more than one catalogue trim",
  price_far_above_row: "the asking price is far above the nearest catalogue trim (a package row is likely missing)",
  maker_limit_unverified: "a recorded manufacturer limit is too old to rely on",
};

export const isSourceReason = (r) => Object.prototype.hasOwnProperty.call(SOURCE_REASONS, r);

// ---- manufacturer-side limits, with their evidence and its date -------------
//
// A RECORDED BLOCKER IS AN ASSERTION WITH A DATE ON IT (scripts/COVERAGE.md,
// 2026-09-11: Mitsubishi sat for a year as a "dead end" that was a wrong path
// argument). So an entry here only accounts for a car while its evidence is
// younger than MAKER_LIMIT_MAX_AGE_DAYS; after that the same cars read
// `maker_limit_unverified` -- OURS -- until someone re-checks and re-dates it.
//
// NOT HERE, ON PURPOSE: GM. The 2026-08-12 note "GM publishes no national
// MSRP" was about the trim-matrix endpoint; scripts/lib/gm-stack.mjs
// (investigated 2026-09-02) found GM's fully-configured `baseMsrp`, national
// and identical across postal codes. A GM car we cannot match is our gap.
export const MAKER_LIMIT_MAX_AGE_DAYS = 30;
export const MAKER_SOURCE_LIMITS = [
  {
    makes: ["Land Rover", "Jaguar"],
    reason: "maker_asks_not_to_be_read",
    checkedOn: "2026-09-11",
    evidence: "rules.config.landrover.com/robots.txt reads 'User-agent: *' / 'Disallow: /' (scripts/COVERAGE.md, re-tested 2026-09-11)",
  },
];

export const makeKey = (s) => String(s == null ? "" : s).normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function makerLimit(make, { now = Date.now(), limits = MAKER_SOURCE_LIMITS } = {}) {
  const k = makeKey(make);
  const hit = limits.find((e) => e.makes.some((m) => makeKey(m) === k));
  if (!hit) return null;
  const age = (now - Date.parse(hit.checkedOn)) / 86_400_000;
  if (!(age >= 0) || age > MAKER_LIMIT_MAX_AGE_DAYS) return { reason: "maker_limit_unverified", evidence: hit.evidence, checkedOn: hit.checkedOn };
  return { reason: hit.reason, evidence: hit.evidence, checkedOn: hit.checkedOn };
}

// ---- prices ----------------------------------------------------------------

// The price the dealer is actually asking. The crawler writes sale_price as
// final ?? asking, so sale_price is the effective advertised price whenever
// any price exists.
export function effectivePrice(l) {
  if (Number(l?.sale_price) > 0) return Number(l.sale_price);
  if (Number(l?.list_price) > 0) return Number(l.list_price);
  return null;
}

// ---- the catalogue, indexed -----------------------------------------------

// rows: msrp_catalog rows { year, make, model, trim, msrp, fuel_type,
// drivetrain, attrs, price_basis, all_in_price, fetched_at? }
export function buildCatalogIndex(rows) {
  const byYMM = new Map();           // "year|make|model" (lowercased) -> rows
  const models = new Map();          // makeKey -> Map(model lowercased -> { name, years:Set })
  const freshest = new Map();        // makeKey -> newest fetched_at (ms)
  for (const r of rows || []) {
    if (!(Number(r?.msrp) > 0)) continue;
    const mk = makeKey(r.make);
    const ml = String(r.model || "").toLowerCase();
    const k = `${r.year}|${String(r.make || "").toLowerCase()}|${ml}`;
    if (!byYMM.has(k)) byYMM.set(k, []);
    byYMM.get(k).push(r);
    if (!models.has(mk)) models.set(mk, new Map());
    const mm = models.get(mk);
    if (!mm.has(ml)) mm.set(ml, { name: r.model, years: new Set() });
    mm.get(ml).years.add(Number(r.year));
    const t = r.fetched_at ? Date.parse(r.fetched_at) : NaN;
    if (Number.isFinite(t) && !(freshest.get(mk) >= t)) freshest.set(mk, t);
  }
  return { byYMM, models, freshest };
}

// The candidate rows for one listing: exactly its year + make + model, the
// same key the index has always used.
export function candidateRows(listing, index) {
  const k = `${listing.year}|${String(listing.make || "").toLowerCase()}|${String(listing.model || "").toLowerCase()}`;
  const rows = index.byYMM.get(k) || [];
  return { rows, catalogModel: rows.length ? rows[0].model : null };
}

// What the matcher is told about the car.
export function matchSignals(listing, price) {
  return { trim: listing?.trim, quotedPrice: price };
}

// ---- one car -> matched, or the reason it was not ---------------------------

// Words that describe drivetrain, body, cab/box or gearbox -- never a grade.
// Engine words (V6, Turbo) are NOT here: some makers sell those as the trim.
const DRIVE_OR_BODY = /\b(fwd|awd|rwd|2wd|4wd|4x4|4x2|4matic|4motion|xdrive|quattro|sedan|hatchback|hatch|coupe|convertible|wagon|suv|van|minivan|truck|pickup|crew|cab|crewcab|supercrew|supercab|double|quad|regular|extended|box|bed|short|long|[2-5]dr|[2-5]\s*door|doors?|cvt|auto|automatic)\b/g;

// Does the listing's trim string name a grade at all, once drivetrain, body,
// transmission and the model's own name are set aside? "AWD", "4dr Sedan" and
// "Crew Cab 4WD" name none.
export function namesAGrade(listing) {
  let t = String(listing?.trim || "").toLowerCase();
  for (const w of String(listing?.model || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    t = t.replace(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), " ");
  }
  t = t.replace(DRIVE_OR_BODY, " ").replace(/[^a-z0-9]+/g, " ").trim();
  return t.length > 0;
}

const WHY_TO_REASON = {
  row_names_other_trim: "catalogue_missing_trim",
  row_names_no_trim: "catalogue_base_price_only",
  drive_unpinned: "catalogue_config_unpinned",
  drive_differs: "catalogue_missing_trim",
  fuel_unlabelled: "powertrain_unlabelled",
  fuel_differs: "catalogue_missing_powertrain",
  price_implausible: "price_far_above_row",
  trim_name_duplicated: "catalogue_duplicate_trim",
  more_specific_sibling: "trim_ambiguous",
  tie: "trim_ambiguous",
  no_trim_signal: "trim_ambiguous",
};

// listing: a fn_listing_once row (year, make, model, trim, list_price,
// sale_price, ...). Returns
//   { matched: true, row, price, msrp }                 -- a confident match
//   { matched: false, reason, why?, catalogModel? }     -- and whose gap it is
export function classifyNewCar(listing, index, { now = Date.now(), freshDays = 8 } = {}) {
  const price = effectivePrice(listing);
  if (!price) return { matched: false, reason: "listing_states_no_price" };

  const lim = makerLimit(listing.make, { now });
  const mk = makeKey(listing.make);
  const makeModels = index.models.get(mk);
  if (!makeModels || !makeModels.size) {
    if (lim) return { matched: false, reason: lim.reason, evidence: lim.evidence };
    return { matched: false, reason: "catalogue_missing_make" };
  }

  const { rows, catalogModel } = candidateRows(listing, index);
  if (!rows.length) {
    if (lim) return { matched: false, reason: lim.reason, evidence: lim.evidence };
    const entry = makeModels.get(String(listing.model || "").toLowerCase());
    if (!entry) return { matched: false, reason: "catalogue_missing_model" };
    const years = [...entry.years];
    const y = Number(listing.year);
    if (years.length && y > Math.max(...years)) {
      // Newer than any year we hold. That is the MAKER's gap only if our read of
      // this make is fresh -- a refresh that ran this week and found no such
      // year is evidence the maker has not published it; a stale catalogue is
      // evidence of nothing.
      const t = index.freshest.get(mk);
      const fresh = Number.isFinite(t) && now - t <= freshDays * 86_400_000;
      return { matched: false, reason: fresh ? "model_year_not_published" : "catalogue_missing_year", catalogModel: entry.name };
    }
    if (years.length && y < Math.min(...years)) return { matched: false, reason: "model_year_superseded", catalogModel: entry.name };
    return { matched: false, reason: "catalogue_missing_year", catalogModel: entry.name };
  }

  const pick = pickTrimMsrp(rows, matchSignals(listing, price));
  if (pick && pick.basis === "exact" && pick.msrp > 0) {
    const rank = (r) => (Number(r.all_in_price) > 0 ? 0 : r.price_basis === "incl_freight" ? 1 : 2);
    const twins = rows
      .filter((r) => Number(r?.msrp) === pick.msrp && (r?.trim || null) === (pick.trim || null))
      .sort((a, b) => rank(a) - rank(b));
    if (twins.length) return { matched: true, row: twins[0], price, msrp: pick.msrp, catalogModel };
  }
  // The dealer never named a grade, and the model has more than one: nothing
  // we hold can say which car this is. That is the listing's gap.
  const namedTrims = new Set(rows.map((r) => String(r.trim || "").trim().toLowerCase()).filter(Boolean));
  if (!namesAGrade(listing) && namedTrims.size > 1) return { matched: false, reason: "listing_names_no_trim", catalogModel };
  const why = pick?.why || "no_trim_signal";
  return { matched: false, reason: WHY_TO_REASON[why] || "trim_ambiguous", why, catalogModel };
}

// ---- the tally, and the row it becomes -------------------------------------

export function tallyNewCars(results) {
  const reasons = {};
  let matched = 0, source = 0, ours = 0;
  for (const r of results) {
    if (r.matched) { matched++; continue; }
    reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    if (isSourceReason(r.reason)) source++; else ours++;
  }
  return { n: results.length, matched, source, ours, reasons };
}

const fmt = (n) => Number(n).toLocaleString("en-CA");
const list = (reasons, keys) => keys
  .filter((k) => reasons[k])
  .sort((a, b) => reasons[b] - reasons[a])
  .map((k) => `${fmt(reasons[k])} ${k.replace(/_/g, " ")}`)
  .join(", ");

// The daily report's check mark. GREEN only when every unmatched car sits in a
// SOURCE reason; any car in one of ours keeps it amber; nothing matched is red.
export function makerVsDealerStatus(t) {
  const n = t.n;
  const accounted = t.matched + t.source;
  const state = t.matched === 0 ? "red" : t.ours === 0 ? "green" : "amber";
  const src = list(t.reasons, Object.keys(SOURCE_REASONS));
  const our = list(t.reasons, Object.keys(OUR_REASONS));
  const note = t.matched === 0
    ? `No live new car at an Alberta dealer could be matched to a confident manufacturer MSRP (${fmt(n)} read).`
    : `${fmt(t.matched)} of ${fmt(n)} live new cars at Alberta dealers matched to a confident manufacturer MSRP. ` +
      (t.source ? `${fmt(t.source)} held back for the source's reason (${src}). ` : "") +
      (t.ours ? `${fmt(t.ours)} are our gap (${our}).` : "Every other car is held back for the source's reason; none is our gap.");
  return { state, covered: accounted, of_total: n, unit: "live new cars accounted for", note: note.trim() };
}
