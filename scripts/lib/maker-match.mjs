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
// ONE AUTHOR FOR THE MATCH. build-city-price-index.mjs used to key the
// catalogue on the dealer's exact model string and hand pickTrimMsrp the trim
// alone. classifyNewCar() is now the only place a live new car meets the
// catalogue -- the city index, the province read and the daily report's tally
// all read its answer.
//
// Pure: no I/O. test-maker-match.mjs pins it.
import { pickTrimMsrp, fuelKind } from "../../supabase/functions/_shared/trim-match.js";
import { powertrainMarkers, stripPowertrain } from "../../supabase/functions/_shared/model-identity.js";

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
  catalogue_missing_model: "our catalogue holds no prices under that model name",
  catalogue_missing_year: "our catalogue holds the model, but not that model year",
  model_year_superseded: "an older model year the maker no longer shows; our catalogue did not keep it",
  catalogue_base_price_only: "our catalogue holds only the model's starting price, not its trims",
  catalogue_missing_trim: "the trim the dealer names is not in our catalogue",
  catalogue_config_unpinned: "our catalogue row does not state the drivetrain, cab or body the dealer names",
  catalogue_duplicate_trim: "our catalogue holds one trim name at two prices",
  catalogue_missing_powertrain: "our catalogue lacks that powertrain's price ladder",
  powertrain_unlabelled: "our catalogue row does not say which powertrain it prices",
  trim_ambiguous: "the dealer's trim name fits more than one catalogue trim",
  price_far_above_row: "the asking price is far above the nearest catalogue trim (a package row is likely missing)",
  maker_limit_unverified: "a recorded manufacturer limit is too old to rely on",
};

export const isSourceReason = (r) => Object.prototype.hasOwnProperty.call(SOURCE_REASONS, r);

export const makeKey = (s) => String(s == null ? "" : s).normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

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
// and identical across postal codes, and the live catalogue held 277 fresh
// Chevrolet/GMC/Buick rows on 2026-09-26. A GM car we cannot match is ours.
export const MAKER_LIMIT_MAX_AGE_DAYS = 30;
export const MAKER_SOURCE_LIMITS = [
  {
    makes: ["Land Rover", "Jaguar"],
    reason: "maker_asks_not_to_be_read",
    checkedOn: "2026-09-11",
    evidence: "rules.config.landrover.com/robots.txt reads 'User-agent: *' / 'Disallow: /' (scripts/COVERAGE.md, re-tested 2026-09-11)",
  },
];

export function makerLimit(make, { now = Date.now(), limits = MAKER_SOURCE_LIMITS } = {}) {
  const k = makeKey(make);
  const hit = limits.find((e) => e.makes.some((m) => makeKey(m) === k));
  if (!hit) return null;
  const age = (now - Date.parse(hit.checkedOn)) / 86_400_000;
  if (!(age >= 0) || age > MAKER_LIMIT_MAX_AGE_DAYS) return { reason: "maker_limit_unverified", evidence: hit.evidence, checkedOn: hit.checkedOn };
  return { reason: hit.reason, evidence: hit.evidence, checkedOn: hit.checkedOn };
}

// ---- when a missing model YEAR is the maker's gap ---------------------------
//
// A fresh refresh that holds no row for year Y is evidence the maker has not
// published Y ONLY IF that refresh asked the maker which years exist (or asked
// for Y). Read from each scraper, 2026-09-26:
//   enumerated  the scraper lists the years the maker's own site/API offers
//   window      the scraper asks for a fixed span of years; evidence only inside it
// NOT HERE: Volvo (scrape-volvo.mjs stamps the CALENDAR year on whatever the
// build page shows, so a missing "2027" says nothing about Volvo) and every
// make whose year handling nobody has read yet. Their missing years are ours.
export const YEAR_EVIDENCE = [
  { makes: ["Chevrolet", "GMC", "Buick", "Cadillac"], how: "enumerated", source: "scripts/lib/gm-stack.mjs reads model/year tuples off the maker's build-and-price page" },
  { makes: ["Jeep", "Ram", "Dodge", "Chrysler", "Fiat", "Alfa Romeo"], how: "enumerated", source: "scripts/lib/fca-stack.mjs enumerates modelYears from the maker's build-and-price API" },
  { makes: ["Nissan", "Infiniti"], how: "enumerated", source: "scripts/lib/nissan-stack.mjs reads the years from the maker's own price JSON keys" },
  { makes: ["Honda", "Acura"], how: "enumerated", source: "scripts/lib/honda-stack.mjs reads each model's years off the maker's build-and-price page" },
  { makes: ["Ford", "Lincoln"], how: "window", years: [2025, 2027], source: "scripts/lib/ford-stack.mjs asks the maker for 2025, 2026 and 2027" },
  { makes: ["Toyota", "Lexus"], how: "window", relative: [-1, 1], source: "scripts/lib/tci-stack.mjs asks for the calendar year -1 to +1" },
  { makes: ["Volkswagen"], how: "window", relative: [0, 1], source: "scripts/scrape-vw.mjs asks for the calendar year and the next" },
];

export function yearEvidence(make, year, { now = Date.now(), table = YEAR_EVIDENCE } = {}) {
  const k = makeKey(make);
  const e = table.find((x) => x.makes.some((m) => makeKey(m) === k));
  if (!e) return null;
  const y = Number(year);
  if (e.how === "enumerated") return e;
  const cy = new Date(now).getUTCFullYear();
  const [lo, hi] = e.years || [cy + e.relative[0], cy + e.relative[1]];
  return y >= lo && y <= hi ? e : null;
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

// ---- the dealer's trim string, cleaned --------------------------------------
//
// What dealers actually write in the trim field (live, 2026-09-26):
//   "Rebel | Smartphone as a Key Capable |"            options after a pipe
//   "Comfortline R-Line Black Edition 4MOTION/Original List $50295"
//   "Other/Don't Know"                                  a form default, not a trim
// The first segment is the trim; the options after the pipe carry words like
// "Sport PKG" and "Premium Audio" that would otherwise read as grade names.
export function cleanTrim(t) {
  let s = String(t == null ? "" : t);
  s = s.split("|")[0];
  s = s.replace(/\/?\s*original\s+list\s*\$?\s*[\d,]+(\.\d+)?/gi, " ");
  s = s.replace(/\bother\s*\/\s*don'?t\s+know\b|\bdon'?t\s+know\b|\bunknown\b|\bn\/a\b/gi, " ");
  s = s.replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/&#0?39;/g, "'");
  s = s.replace(/\s+/g, " ").trim();
  return s || null;
}

// ---- model names ------------------------------------------------------------

// Words of a model name with powertrain MODIFIERS removed (stripPowertrain), for
// finding the base name only. The powertrain itself is decided separately, on
// the original strings, by powertrainMarkers -- the two jobs are never merged.
// [[dealer-model-name-variants]]
const words = (s) => stripPowertrain(String(s || "")).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const squash = (ws) => ws.join("");

// Words a dealer adds after the model name that describe the CONFIGURATION
// (cab, box, body, drive), never a different vehicle: "F-150 SuperCrew",
// "Sprinter Cargo Van", "Sierra 3500 HD SRW". "L" ("Grand Cherokee L"),
// "Hybrid" and "F-350" are NOT here -- those are different vehicles.
const CONFIG_SUFFIX = new Set([
  "supercrew", "supercab", "crewmax", "crew", "cab", "regular", "double", "quad", "access", "king",
  "extended", "srw", "drw", "cargo", "passenger", "chassis", "cutaway", "van", "sedan", "hatchback",
  "hatch", "coupe", "convertible", "wagon", "suv", "pickup", "truck", "4dr", "2dr", "5dr", "4x4",
  "4x2", "awd", "4wd", "fwd", "rwd", "2wd",
]);

const markerKind = (m) => (m === "phev" ? "phev" : m === "hybrid" ? "hybrid" : m === "bev" ? "bev" : null);
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const FUEL_LABEL = { hybrid: "Hybrid", phev: "PHEV", bev: "BEV" };

// The catalogue model(s) a listing's model resolves to, powertrain-safe, with
// the rows each may contribute. Tiers, best first; the first non-empty wins:
//   1 same base name, same powertrain markers          (RAV4 Hybrid -> RAV4 Hybrid)
//   2 same base name, the listing names a powertrain the catalogue NAME omits,
//     and the catalogue's own rows state that powertrain in fuel_type
//                                                       (Tucson Hybrid -> TUCSON's Hybrid rows)
//   3 the listing adds configuration words (cab/body) after a catalogue name
//                                                       (F-150 SuperCrew -> F-150)
// A catalogue name carrying a marker the listing lacks is never used: a plain
// gasoline listing must not pick up a hybrid or plug-in ladder. Rows whose own
// fuel_type contradicts the listing's powertrain are dropped at every tier.
export function resolveModel(listing, makeModels) {
  const trim = cleanTrim(listing?.trim);
  const lm = powertrainMarkers(`${listing?.model || ""} ${trim || ""}`);
  const lWords = words(listing?.model);
  if (!lWords.length || !makeModels) return { tier: 0, models: [], listingMarkers: lm };
  const tiers = [[], [], []];
  for (const entry of makeModels.values()) {
    const cWords = words(entry.name);
    if (!cWords.length) continue;
    const cm = powertrainMarkers(entry.name);
    if ([...cm].some((m) => !lm.has(m))) continue;              // catalogue claims a powertrain the listing does not
    let suffix = null;
    if (squash(cWords) === squash(lWords)) suffix = [];
    else {
      for (let k = lWords.length - 1; k >= 1; k--) {
        if (squash(lWords.slice(0, k)) !== squash(cWords)) continue;
        const tail = lWords.slice(k);
        if (tail.every((w) => CONFIG_SUFFIX.has(w))) suffix = tail;
        break;
      }
    }
    if (!suffix) continue;
    const exactMarkers = sameSet(lm, cm);
    const tier = suffix.length ? 2 : exactMarkers ? 0 : 1;
    tiers[tier].push({ entry, suffix, catalogMarkers: cm, exactMarkers });
  }
  const t = tiers.findIndex((x) => x.length);
  return { tier: t + 1, models: t >= 0 ? tiers[t] : [], listingMarkers: lm, trim };
}

// The rows a resolved model may contribute for one year, powertrain-filtered.
// A catalogue NAME that states a powertrain labels its unlabelled rows with it
// ("UX Hybrid" rows with a blank fuel_type are hybrid rows -- the catalogue said
// so in the name); a name that states none labels nothing.
export function rowsFor(resolved, index, listing) {
  const lm = resolved.listingMarkers;
  const want = lm.size === 1 ? markerKind([...lm][0]) : null;
  const out = [];
  for (const m of resolved.models) {
    const rows = index.byYMM.get(`${listing.year}|${makeKey(listing.make)}|${String(m.entry.name).toLowerCase()}`) || [];
    const nameKind = m.catalogMarkers.size === 1 ? markerKind([...m.catalogMarkers][0]) : null;
    for (const r of rows) {
      const fuel = r.fuel_type != null && String(r.fuel_type).trim() !== "" ? r.fuel_type : (nameKind ? FUEL_LABEL[nameKind] : null);
      // The listing names its powertrain: a row must state the SAME one, in its
      // own column or its own model name. Unknown is not a match. (A listing
      // that names none only ever reaches a catalogue name that names none --
      // resolveModel's wall -- and keeps that model's whole ladder, as before.)
      if (want && (!fuel || fuelKind(fuel) !== want)) continue;
      out.push({ ...r, fuel_type: fuel, _suffix: m.suffix });
    }
  }
  return out;
}

// What the matcher is told about the car. Same signals the report's own lookup
// passes (analyze-listing-url lookupCatalogMsrp): the trim, the trim again as a
// drivetrain source, the powertrain the listing names, the asking price.
export function matchSignals(listing, price, listingMarkers = null) {
  const trim = cleanTrim(listing?.trim);
  const lm = listingMarkers || powertrainMarkers(`${listing?.model || ""} ${trim || ""}`);
  const kind = lm.size === 1 ? markerKind([...lm][0]) : null;
  return { trim, drivetrain: trim, fuelType: kind ? FUEL_LABEL[kind] : null, quotedPrice: price };
}

// ---- the catalogue, indexed -----------------------------------------------

// rows: msrp_catalog rows { year, make, model, trim, msrp, fuel_type,
// drivetrain, attrs, price_basis, all_in_price, fetched_at? }
export function buildCatalogIndex(rows) {
  const byYMM = new Map();           // "year|makeKey|model lowercased" -> rows
  const models = new Map();          // makeKey -> Map(model lowercased -> { name, years:Set })
  const freshest = new Map();        // makeKey -> newest fetched_at (ms)
  for (const r of rows || []) {
    if (!(Number(r?.msrp) > 0)) continue;
    const mk = makeKey(r.make);
    const ml = String(r.model || "").toLowerCase();
    const k = `${r.year}|${mk}|${ml}`;
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

// ---- one car -> matched, or the reason it was not ---------------------------

// Words that describe drivetrain, body, cab/box or gearbox -- never a grade.
// Engine words (V6, Turbo) are NOT here: some makers sell those as the trim.
const DRIVE_OR_BODY = /\b(fwd|awd|rwd|2wd|4wd|4x4|4x2|4matic|4motion|xdrive|quattro|sedan|hatchback|hatch|coupe|convertible|wagon|suv|van|minivan|truck|pickup|crew|cab|crewcab|supercrew|supercab|double|quad|regular|extended|box|bed|short|long|[2-5]dr|[2-5]\s*door|doors?|cvt|auto|automatic)\b/g;
// An engine designation ("350", "350h", "450h+"). It names a grade only where
// the catalogue's own trim names use it (BMW "30 xDrive"); on a Lexus ladder
// of Premium / Luxury / F SPORT it names the engine, not the package.
const ENGINE_DESIGNATION = /^[a-z]{0,2}\d{2,3}[a-z]{0,2}\+?$/;

// Does the listing's trim string name a grade at all, once drivetrain, body,
// the model's own name and engine designations the ladder does not use are set
// aside? "AWD", "4dr Sedan", "Crew Cab 4WD" and a Lexus "NX 350" name none.
export function namesAGrade(listing, rows = []) {
  const trim = cleanTrim(listing?.trim);
  if (!trim) return false;
  const ladder = new Set(rows.flatMap((r) => String(r.trim || "").toLowerCase().split(/[^a-z0-9+]+/).filter(Boolean)));
  let t = trim.toLowerCase();
  for (const w of String(listing?.model || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    t = t.replace(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), " ");
  }
  t = t.replace(DRIVE_OR_BODY, " ");
  const left = t.split(/[^a-z0-9+]+/).filter(Boolean).filter((w) => !(ENGINE_DESIGNATION.test(w) && !ladder.has(w)));
  return left.length > 0;
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

const rank = (r) => (Number(r.all_in_price) > 0 ? 0 : r.price_basis === "incl_freight" ? 1 : 2);
const stripPrivate = ({ _suffix, ...r }) => r;

// listing: a fn_listing_once row (year, make, model, trim, list_price,
// sale_price, ...). Returns
//   { matched: true, row, price, msrp, catalogModel }   -- a confident match
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

  const resolved = resolveModel(listing, makeModels);
  if (!resolved.models.length) {
    if (lim) return { matched: false, reason: lim.reason, evidence: lim.evidence };
    return { matched: false, reason: "catalogue_missing_model" };
  }
  const catalogModel = resolved.models.map((m) => m.entry.name).join(" / ");
  const rows = rowsFor(resolved, index, listing);
  if (!rows.length) {
    if (lim) return { matched: false, reason: lim.reason, evidence: lim.evidence, catalogModel };
    const y = Number(listing.year);
    const years = resolved.models.flatMap((m) => [...m.entry.years]);
    const heldThisYear = resolved.models.some((m) => m.entry.years.has(y));
    // The model has rows this year, but none of the listing's powertrain.
    if (heldThisYear) return { matched: false, reason: "catalogue_missing_powertrain", catalogModel };
    if (years.length && y > Math.max(...years)) {
      // Newer than any year we hold. The MAKER's gap only if a fresh refresh of
      // this make asked the maker which years exist (YEAR_EVIDENCE) -- a stale
      // catalogue, or a scraper that never asks, is evidence of nothing.
      const t = index.freshest.get(mk);
      const fresh = Number.isFinite(t) && now - t <= freshDays * 86_400_000;
      const ev = fresh ? yearEvidence(listing.make, y, { now }) : null;
      return ev
        ? { matched: false, reason: "model_year_not_published", evidence: ev.source, catalogModel }
        : { matched: false, reason: "catalogue_missing_year", catalogModel };
    }
    if (years.length && y < Math.min(...years)) return { matched: false, reason: "model_year_superseded", catalogModel };
    return { matched: false, reason: "catalogue_missing_year", catalogModel };
  }

  const pick = pickTrimMsrp(rows, matchSignals(listing, price, resolved.listingMarkers));
  if (pick && pick.basis === "exact" && pick.msrp > 0) {
    const twins = rows
      .filter((r) => Number(r?.msrp) === pick.msrp && (r?.trim || null) === (pick.trim || null))
      .sort((a, b) => rank(a) - rank(b));
    if (twins.length) {
      const row = twins[0];
      // Reached through configuration words the catalogue NAME does not carry
      // ("F-150 SuperCrew" -> F-150): exact only if the row's own trim states
      // them. Otherwise it is the Mach-E case -- the right trim, not the right car.
      const suffix = row._suffix || [];
      const rowWords = new Set(String(row.trim || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
      if (suffix.some((w) => !rowWords.has(w))) return { matched: false, reason: "catalogue_config_unpinned", why: "model_suffix_unpinned", catalogModel };
      return { matched: true, row: stripPrivate(row), price, msrp: pick.msrp, catalogModel };
    }
  }
  // The dealer never named a grade, and the model has more than one: nothing
  // we hold can say which car this is. That is the listing's gap.
  const namedTrims = new Set(rows.map((r) => String(r.trim || "").trim().toLowerCase()).filter(Boolean));
  if (namedTrims.size > 1 && !namesAGrade(listing, rows)) return { matched: false, reason: "listing_names_no_trim", catalogModel };
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
const listReasons = (reasons, keys) => keys
  .filter((k) => reasons[k])
  .sort((a, b) => reasons[b] - reasons[a])
  .map((k) => `${fmt(reasons[k])} ${k.replace(/_/g, " ")}`)
  .join(", ");

// The daily report's check mark. GREEN only when every unmatched car sits in a
// SOURCE reason; any car in one of ours keeps it amber; nothing matched is red.
// covered counts cars ACCOUNTED FOR (matched + the source's gaps), and the note
// states the split, so a green can never be read as "every car was measured".
export function makerVsDealerStatus(t) {
  const n = t.n;
  const state = t.matched === 0 ? "red" : t.ours === 0 ? "green" : "amber";
  const src = listReasons(t.reasons, Object.keys(SOURCE_REASONS));
  const our = listReasons(t.reasons, Object.keys(OUR_REASONS));
  const note = t.matched === 0
    ? `No live new car at an Alberta dealer could be matched to a confident manufacturer MSRP (${fmt(n)} read).`
    : `${fmt(t.matched)} of ${fmt(n)} live new cars at Alberta dealers matched to a confident manufacturer MSRP. ` +
      (t.source ? `${fmt(t.source)} held back for the source's reason (${src}). ` : "") +
      (t.ours ? `${fmt(t.ours)} are our gap (${our}).` : "Every other car is held back for the source's reason; none is our gap.");
  return { state, covered: t.matched + t.source, of_total: n, unit: "live new cars accounted for", note: note.trim() };
}
