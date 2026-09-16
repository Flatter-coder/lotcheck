// ── Toyota Canada Inc. build-&-price platform scraper (Toyota + Lexus) ──────
//
// Toyota.ca and Lexus.ca run the SAME Adobe AEM stack ("tcidigital"), so one
// module scrapes both -- only the host, brand code, and vehicle-fragment
// folder differ. Everything comes from the brands' own public build-&-price
// JSON: verified values only, each tagged with the trim it came from and the
// date fetched, matching the analyze-quote edge function's "no guessing" rule.
//
// Endpoints (all public GETs):
//   buildnprice.categories.json            -> full series lineup + fuel tag
//   price_calculation/from_prices.<BRAND>.<PROV>.json -> PUBLISHED national MSRP
//   price_calculation/<brand>/prices.json  -> per-trim deltas (province-calculated)
//   price_calculation/interest_rates.json  -> finance AND lease APR by term
//   graphql BnP-get-models                 -> model code -> trim name ("XSE")

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dedupeBy, writeCatalogs } from "./catalog-io.mjs";
import { CROSS_CHECK_PROVINCES, deriveSeriesMsrp, baseModelCode } from "./tci-msrp.mjs";
import { parseFeeStack, feeStackTotal, allInBreakdown } from "./tci-fees.mjs";
import { applyTciOverrides, flagAllOnePowertrain } from "./tci-overrides.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const PROVINCE = "ON"; // MSRP is national; ON is canonical for rate lookups
// The fee stack is PROVINCE-scoped, so one has to be chosen to store. Alberta,
// because that is the market these reports serve; every row stamps it in
// attrs.province so a consumer can never read it as a national figure.
const ALL_IN_PROVINCE = "AB";

const FUEL_MAP = {
  "Gas": "Gas", "Hybrid": "Hybrid", "Hybrid Available": "Hybrid",
  "Plug-in Hybrid": "PHEV", "Battery Electric": "BEV", "Fuel Cell Electric": "FCEV",
};

// The series `tag` is set at the line level, so a multi-powertrain line like
// Lexus ES (gas + hybrid + electric variants) tags every entry "Hybrid
// Available" even for the "ES All-Electric" series. When the series NAME is
// explicit about the powertrain, trust it over the line-level tag.
function inferFuel(name, tag) {
  const n = (name || "").toLowerCase();
  if (/plug-?in/.test(n)) return "PHEV";
  if (/all-electric|battery electric|\bev\b/.test(n)) return "BEV";
  if (/fuel cell/.test(n)) return "FCEV";
  return FUEL_MAP[tag] || null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchSeriesList(host, seriesPageSlug) {
  const paths = [
    `/jcr:content/root/container/buildnprice.categories.json`,
  ];
  for (const base of [`/build-price`, `/en/build-price`]) {
    for (const p of paths) {
      try {
        const data = await getJson(`${host}/content${base.replace("/build-price", "")}/build-price${p}`);
        const all = (data.categories || []).find(c => c.id === "categories:all") || data.categories?.[0];
        if (all?.seriesItems?.length) {
          const seen = new Set();
          return all.seriesItems.filter(s => !s.comingSoon && s.seriesCode && !seen.has(s.seriesCode) && seen.add(s.seriesCode));
        }
      } catch { /* try next */ }
    }
  }
  // Fallback: a known series page always returns the full list.
  const data = await getJson(`${host}/content/${host.includes("lexus") ? "lexus" : "toyota"}/en/build-price/${seriesPageSlug}/jcr:content/root/container/buildnprice.categories.json`);
  const all = (data.categories || []).find(c => c.id === "categories:all") || data.categories?.[0];
  const seen = new Set();
  return (all?.seriesItems || []).filter(s => !s.comingSoon && s.seriesCode && !seen.has(s.seriesCode) && seen.add(s.seriesCode));
}

async function fetchPrices(host, brand, seriesCode, year, province = PROVINCE) {
  const brandPath = brand === "LEX" ? "lexus" : "toyota";
  const url = `${host}/bin/api/price_calculation/${brandPath}/prices.json?brand=${brand}&series=${seriesCode}&year=${year}&province=${province}`;
  try {
    const data = await getJson(url);
    return data?.[province]?.[year]?.[seriesCode] || null;
  } catch { return null; }
}

// The published, NATIONAL MSRP table. Assembled at runtime by the Build & Price
// client, which is why it appears nowhere in the served HTML -- see tci-msrp.mjs
// for the field path and the evidence that it is national and ex-freight.
async function fetchFromPrices(host, brand, province) {
  const url = `${host}/bin/api/price_calculation/from_prices.${brand}.${province}.json`;
  try { return await getJson(url); } catch { return null; }
}

// interest_rates.json -> { finance: {term: apr}, lease: {term: {apr, km}} }.
// Rates are advertised at the series level, so the first model/package wins.
async function fetchRates(host, brand, seriesCode, year) {
  const url = `${host}/bin/api/price_calculation/interest_rates.json?brand=${brand}&series=${seriesCode}&year=${year}&province=${PROVINCE}`;
  let data;
  try { data = await getJson(url); } catch { return null; }
  const byModel = data?.[seriesCode]?.[year];
  if (!byModel) return null;
  for (const modelCode of Object.keys(byModel)) {
    const byPkg = byModel[modelCode];
    for (const pkg of Object.keys(byPkg)) {
      const prov = byPkg[pkg]?.[PROVINCE];
      if (!prov) continue;
      const out = { finance: {}, lease: {} };
      for (const [term, r] of Object.entries(prov.finance || {})) {
        if (r?.annualPercentageRate != null) out.finance[term] = { apr: r.annualPercentageRate, through: r.effectiveThroughDate || null };
      }
      for (const [term, r] of Object.entries(prov.lease || {})) {
        if (r?.annualPercentageRate != null) out.lease[term] = { apr: r.annualPercentageRate, km: r.annualAllowDistanceMeasureValue || null, through: r.effectiveThroughDate || null };
      }
      if (Object.keys(out.finance).length || Object.keys(out.lease).length) return out;
    }
  }
  return null;
}

const modelCache = new Map();
// Returns { grade, packages: Map<packageCode, {name, isBase}> }.
//
// A package suffix is a real Canadian trim name, not a variant code: XERAPC
// package B is literally "XSE Technology Package", which is exactly how the
// hand-seeded Build & Price rows name it. Emitting only the base package
// silently drops those trims, so package names are read from the same fragment
// the grade already comes from.
async function fetchModel(host, brandFolder, seriesCode, year, modelCode) {
  const key = `${host}-${seriesCode}-${year}-${modelCode}`;
  if (modelCache.has(key)) return modelCache.get(key);
  const modelPath = `/content/dam/tcidigital/vehicle-fragments/${brandFolder}/${seriesCode}/${year}-${modelCode.toLowerCase()}-models`;
  const url = `${host}/graphql/execute.json/tcidigital/BnP-get-models%3BmodelPath%3D${encodeURIComponent(modelPath)}%3b.json`;
  const out = { grade: null, packages: new Map() };
  try {
    const item = (await getJson(url))?.data?.modelV2ByPath?.item;
    out.grade = item?.grade || null;
    for (const p of item?.packagesFragmentPath || []) {
      if (p?.packageSuffixCode) {
        out.packages.set(p.packageSuffixCode, { name: p?.packageSuffixDescriptionEn?.plaintext || null, isBase: !!p.isBasePackage });
      }
    }
  } catch { /* leave nulls */ }
  modelCache.set(key, out);
  return out;
}

// A BASE PACKAGE'S PUBLISHED NAME IS SOMETIMES A STUB, NOT A TRIM NAME.
//
// "Standard Package" is Adobe AEM's DEFAULT LABEL for a base package that
// carries no distinct name of its own. It is not a Canadian showroom trim and
// no dealer or buyer ever writes it. Measured live 2026-09-16: 27 catalog rows
// across Toyota and Lexus were stored under that label.
//
// WHAT IT COST. The trim string is part of the identity key that carry-forward
// and supersede both run on (catKey in catalog-io.mjs is year|model|trim), so a
// base trim stored under a stub name does not match the row it should have
// replaced. Three things follow from that one rename, and all three were live:
//   1. supersede never fires, so the correctly-named row survives every refresh
//      and freezes at its original capture date -- the 2026 Crown Signia sat at
//      its 2026-08-16 read while a second row for the same car was rewritten
//      daily beside it;
//   2. carry-forward finds no predecessor, so drivetrain and source_url come
//      back NULL -- on 2026-09-16 the three 4Runner trims whose names did NOT
//      change kept their source_url through the same run that blanked the one
//      that did;
//   3. both rows persist, so which MSRP a listing resolves against is decided
//      by whichever row the matcher reaches first.
//
// The real trim is the fragment's own `grade`. Measured across all 27 models,
// grade is a usable Canadian trim name for 16 of them (RAV4 LE, Camry SE,
// 4Runner SR5, Sienna LE, Tundra SR5, Highlander XLE ...) and an internal code
// or a stub for 11 (Crown Signia HI, Land Cruiser BX, LC NONE, ES STD).
// Where grade cannot name the car, the stub is KEPT rather than replaced with a
// guess -- and for Crown and GR86 the stub row is the only row that model has,
// so refusing it would remove the model from the catalogue entirely.
export const GENERIC_PACKAGE_LABELS = new Set([
  "standard package", "standard", "base package", "base", "base model", "standard model",
]);
export const isGenericPackageLabel = (name) =>
  GENERIC_PACKAGE_LABELS.has(String(name || "").trim().toLowerCase());

// Grades that are NOT trim names, measured off the live fragments 2026-09-16.
// These are separate from looksLikeInternalCode because that predicate has
// other callers whose behaviour must not shift: it lets "LTD" and "BASE"
// through via REAL_SHORT_TRIMS (they are genuine trims elsewhere) and its regex
// cannot see a single character, so "N" passes. All three are internal grades
// here -- Crown's grade is LTD, GR86's is BASE, Corolla Hatchback's is N -- and
// publishing any of them would put a code on a window sticker.
const GRADE_STUBS = new Set(["none", "std", "base", "ltd", "n", "tbd", "na", "n/a", ""]);

// A trailing drivetrain token belongs in the drivetrain column, not in the trim.
// Toyota publishes the 2027 bZ's grade as "XLE FWD"; stored whole it is a trim
// no listing says, and it hides a fact the report has a field for.
const DRIVETRAIN_TOKEN = /\s+(AWD|FWD|RWD|4WD|4X4|2WD)$/i;

export function usableGradeName(grade) {
  const g = String(grade || "").trim();
  if (!g) return false;
  if (GRADE_STUBS.has(g.toLowerCase())) return false;
  // Strip a drivetrain suffix before judging: "XLE FWD" is usable, and what
  // makes it usable is the "XLE".
  const core = g.replace(DRIVETRAIN_TOKEN, "").trim();
  if (!core || GRADE_STUBS.has(core.toLowerCase())) return false;
  return !looksLikeInternalCode(core);
}

// A TRIM MUST NOT REPEAT THE MODEL IT SITS UNDER. "Sienna / Sienna XLE Mobility
// Package" renders as "Sienna Sienna XLE Mobility Package" wherever the two are
// concatenated, and an exact-trim match against a listing's "XLE" can never
// fire. Only a leading model name followed by more words is stripped: a trim
// that IS exactly its model name ("4Runner / 4Runner") is left alone, because
// stripping it would leave an empty trim, which satisfies no match at all and
// collides with every other trim-less row for that model.
export function stripModelPrefix(trim, model) {
  const t = String(trim || "").trim();
  const m = String(model || "").trim();
  if (!t || !m) return t;
  if (t.toLowerCase() === m.toLowerCase()) return t;
  if (!t.toLowerCase().startsWith(m.toLowerCase() + " ")) return t;
  const rest = t.slice(m.length).trim();
  return rest || t;
}

// The single place a row's trim is decided. Pure and exported so the rules can
// be tested without a network or a database (scripts/test-trim-identity.mjs).
//
// Returns { trim, drivetrain, refused, reason }. `refused` true means the
// package must not be published at all -- the caller counts it and moves on.
export function resolveTrim({ publishedName, grade, model, isBase }) {
  const published = publishedName ? String(publishedName).trim() : "";
  const generic = isGenericPackageLabel(published);
  let trim = "";
  let reason = "";

  if (published && !generic && !looksLikeInternalCode(published)) {
    // THE 2026-08-27 LEXUS NX FIX, PRESERVED. A base package with a real
    // published name keeps it: NX 350h package P is `isBase: true, name:
    // "Premium"` while grade reads "LUXURY", and storing it as LUXURY put a
    // $70,878 ladder against a car asking $62,005. A published name always
    // wins; the rule below fires only on a STUB.
    trim = published;
    reason = "published";
  } else if (generic || !published) {
    if (usableGradeName(grade)) {
      trim = String(grade).trim();
      reason = generic ? "grade (published name was a stub)" : "grade (no published name)";
    } else if (generic) {
      // Nothing can name this car. KEEP the stub rather than drop the row --
      // for Crown and GR86 it is the only row that model has -- and never
      // invent a name. The caller logs it so the gap stays visible.
      trim = published;
      reason = "unnamed base trim: published name is a stub and grade is not a trim name";
    } else if (!isBase) {
      return { trim: "", drivetrain: null, refused: true, reason: "non-base package has no usable published name" };
    } else {
      return { trim: "", drivetrain: null, refused: true, reason: "base package has neither a published name nor a usable grade" };
    }
  } else if (!isBase) {
    return { trim: "", drivetrain: null, refused: true, reason: "non-base package has no usable published name" };
  } else if (usableGradeName(grade)) {
    trim = String(grade).trim();
    reason = "grade (published name was an internal code)";
  } else {
    return { trim: "", drivetrain: null, refused: true, reason: `grade "${grade}" is an internal code, not a Canadian trim name` };
  }

  let drivetrain = null;
  const dt = trim.match(DRIVETRAIN_TOKEN);
  if (dt) {
    const core = trim.replace(DRIVETRAIN_TOKEN, "").trim();
    // Only split when something is left to be the trim. "AWD" alone is a trim
    // on some lineups and must not become an empty name.
    if (core) { drivetrain = dt[1].toUpperCase(); trim = core; }
  }

  trim = stripModelPrefix(trim, model);
  return { trim, drivetrain, refused: false, reason };
}

// A STUB-NAMED ROW MUST NOT SIT BESIDE THE SAME CAR UNDER ITS REAL NAME.
//
// Where the fragment's grade could not name a base trim, the row keeps its stub
// ("Standard Package"). That is the honest answer when nothing can name the car
// -- but it is the WRONG answer when the very same car is already in the batch
// under a real trim name at the identical MSRP. Measured 2026-09-16: the 2026
// GR Corolla was in the catalogue twice at $50,295, once as "Core" and once as
// "Standard Package", because two model codes resolve to one car and only one
// of them publishes a package name.
//
// The price match is what makes this safe. A stub is never a real trim, so a
// named row at the same year/model/price is the same vehicle better described.
// Two DIFFERENT trims colliding on price is common and legitimate -- Jeep
// Gladiator Rubicon and Mojave are both $65,495 -- but neither of those is a
// stub, so this rule cannot reach them.
export function dropStubDuplicates(rows) {
  const named = new Set();
  for (const r of rows || []) {
    if (!isGenericPackageLabel(r.trim)) named.add(`${r.year}|${r.model}|${r.msrp}`);
  }
  const dropped = [];
  const kept = (rows || []).filter((r) => {
    if (!isGenericPackageLabel(r.trim)) return true;
    if (!named.has(`${r.year}|${r.model}|${r.msrp}`)) return true;   // the only row for this car
    dropped.push(`${r.year} ${r.model} "${r.trim}" $${r.msrp}`);
    return false;
  });
  return { rows: kept, dropped };
}

// Toyota's own `grade` field is sometimes an INTERNAL code rather than the
// Canadian marketing trim: the Land Cruiser's grades are "BX" and "WX" where
// the showroom names are "1958" and "Cruiser", and GR86, C-HR, bZ Woodland,
// Crown Signia and Tundra do the same with "HI", "MID" and "PLT".
//
// A catalog row named "BX" cannot match a listing -- no dealer and no buyer
// ever writes that -- so at best it is dead weight and at worst it attaches an
// MSRP to the wrong trim. Shipping those names is the 2026-08-11 Land Cruiser
// regression in a new disguise, so they are refused instead. Every model still
// keeps at least its base trim; only the code-named variants drop out.
//
// The allowlist is real Canadian trim vocabulary that merely LOOKS code-like.
const REAL_SHORT_TRIMS = new Set(["SE", "XSE", "XLE", "LE", "SR", "SR5", "TRD", "GR", "BASE", "LTD", "GRMN", "XE", "XL"]);
function looksLikeInternalCode(trim) {
  const t = String(trim || "").trim();
  if (!t) return true;
  if (REAL_SHORT_TRIMS.has(t.toUpperCase())) return false;
  return /^[A-Z]{2,4}(-[A-Z]{2,3})?$/.test(t);
}

function candidateYears(pinYear) {
  if (pinYear) return [Number(pinYear)];
  const y = new Date().getUTCFullYear();
  return [y + 1, y, y - 1];
}

export async function scrapeBrand({ host, brand, brandFolder, makeName, seriesPageSlug, filterSeries, pinYear }) {
  const today = new Date().toISOString().slice(0, 10);
  let series = await fetchSeriesList(host, seriesPageSlug);
  if (filterSeries) series = series.filter(s => s.seriesCode === filterSeries);
  console.log(`[${makeName}] series to scrape: ${series.length}${filterSeries ? ` (filtered to ${filterSeries})` : ""}`);

  let msrpRows = []; const financeRows = [], leaseRows = [];
  const skipped = { noGrade: 0, refused: 0 };
  const refusals = [];
  const unnamedBase = [];

  // The published national MSRP table, pulled once per cross-check province.
  // Fetched up front because every series reads from the same payload.
  const fromPricesByProv = {};
  for (const p of CROSS_CHECK_PROVINCES) {
    const fp = await fetchFromPrices(host, brand, p);
    if (fp) fromPricesByProv[p] = fp;
  }
  if (Object.keys(fromPricesByProv).length < 2) {
    // Refusing here is the point: one province cannot prove the fee stack
    // cancelled, and an MSRP we cannot prove is one must not be published.
    throw new Error(
      `from_prices returned usable data for ${Object.keys(fromPricesByProv).length} of ${CROSS_CHECK_PROVINCES.length} provinces. ` +
      `At least two are required -- cross-province agreement is the evidence that a derived trim price is a real MSRP.`);
  }
  console.log(`[${makeName}] national MSRP table read for ${Object.keys(fromPricesByProv).join(", ")}`);

  for (const s of series) {
    const fuel = inferFuel(s.name, s.tag);
    let hitYear = null;
    for (const year of candidateYears(pinYear)) {
      const pricesByProv = {};
      for (const p of Object.keys(fromPricesByProv)) {
        const byModel = await fetchPrices(host, brand, s.seriesCode, year, p);
        if (byModel && Object.keys(byModel).length) pricesByProv[p] = byModel;
      }
      if (!Object.keys(pricesByProv).length) continue;
      hitYear = year;

      // ── THE MANUFACTURER'S OWN FEE STACK ────────────────────────────────
      //
      // from_prices itemises what sits on top of MSRP -- freight, the A/C
      // excise, the regulator fee, the tire levy, factory accessories, and the
      // brand's own published dealer fee. We have been fetching this payload
      // three times per brand for the MSRP derivation and throwing every one of
      // those lines away.
      //
      // Without them a dealer's bundled "Fees & Accessories $3,330" row is
      // unattributable, and LotCheck was attributing it to the DEALER -- see
      // _shared/fee-caption.ts. With them it decomposes to the cent: on the
      // 2026 Lexus NX 350h, $2,335 of that row is freight and government
      // charges and $995 is Lexus's own published fee, at Lexus's own ceiling.
      //
      // Captured per PROVINCE because DRF and the regulator lines differ by
      // province (Lexus AB 995 / ON 999 / QC 795), and the base model code
      // itself differs by province on at least two Toyota series -- so it is
      // resolved per province rather than from provinces[0].
      const feeByProv = {};
      for (const p of Object.keys(fromPricesByProv)) {
        const baseCode = baseModelCode(fromPricesByProv[p], s.seriesCode, year);
        if (!baseCode) continue;
        const st = parseFeeStack(fromPricesByProv[p], s.seriesCode, year, baseCode);
        if (st.ok) feeByProv[p] = st;
        else if (st.refusal) {
          // A stack that does not reconcile against the manufacturer's own
          // SUBTOTAL is not stored. An unproven decomposition is exactly the
          // input that becomes a false accusation.
          skipped.refused++;
          refusals.push(`${s.name} ${p} fee stack: ${st.refusal}`);
        }
      }

      // MSRP comes from the published from_prices line for the base trim, and
      // from a self-verifying difference for every other trim. See tci-msrp.mjs.
      const { msrp: derived, refused } = deriveSeriesMsrp({
        fromPricesByProv, pricesByProv, series: s.seriesCode, year,
      });
      for (const r of refused) { skipped.refused++; refusals.push(`${s.name} ${r.key}: ${r.reason}`); }

      // One row per (model, package): a non-base package suffix IS the trim name
      // in Canada ("XSE Technology Package"), and emitting only the base package
      // silently drops those rows from the catalog.
      const anyProv = pricesByProv[Object.keys(pricesByProv)[0]];
      for (const [modelCode, pkgs] of Object.entries(anyProv)) {
        const model = await fetchModel(host, brandFolder, s.seriesCode, year, modelCode);
        await sleep(100);
        // NEVER fall back to modelCode: internal codes ("BX", "WX", "HI") are not
        // Canadian marketing trims, can't be matched to a listing, and shipped
        // as real trim names once (2026-08-11 Land Cruiser regression).
        if (!model.grade) { skipped.noGrade += (pkgs || []).length; continue; }
        for (const pk of pkgs || []) {
          const msrp = derived.get(`${modelCode}/${pk.packageCode}`);
          if (!Number.isFinite(msrp)) continue;   // already counted in refusals
          const info = model.packages.get(pk.packageCode);
          // EVERY package is named by its PUBLISHED name. The base package used
          // to be named by `model.grade` instead -- the manufacturer's internal
          // series grade, which is not what the car is called on the lot.
          //
          // Caught live 2026-08-27 on the 2026 Lexus NX 350h (NXH/2026-bkcezc):
          // grade = "LUXURY", while the BASE package P is `isBase: true, name:
          // "Premium"`. So the NX 350h **Premium** (55,870 + 2,155 = $58,025)
          // was stored under the trim name "LUXURY", and the genuinely
          // different Luxury package L (+6,295, $62,165) sat beside it. A
          // listing that says "Premium" could therefore never match its own
          // row -- and worse, "premium" is a KEY_TOKEN, so every correctly
          // named row took the -5 grade-conflict penalty and the one row with
          // no recognised grade word won by default. Measured: the real
          // listing resolved to trim "Executive" at $70,878 against a car
          // asking $62,005 -- $12,853 above its true $58,025 MSRP.
          //
          // `grade` remains the fallback for a package with no published name,
          // which is the only case it was ever right for. A non-base package
          // with no name is still refused rather than invented.
          const named = resolveTrim({
            publishedName: info && info.name ? info.name : null,
            grade: model.grade,
            model: s.name,
            isBase: !!(info && info.isBase),
          });
          if (named.refused) {
            skipped.refused++;
            refusals.push(`${s.name} ${modelCode}/${pk.packageCode}: ${named.reason}`);
            continue;
          }
          const trim = named.trim;
          if (named.reason.startsWith("unnamed base trim")) {
            // NOT a refusal: the row still carries a real, cross-province-proven
            // MSRP and dropping it would remove the model's only price. It is
            // logged because a row nobody can match is a gap, not a success.
            unnamedBase.push(`${s.name} ${year} (grade "${model.grade}")`);
          }
          // The all-in figure a dealer's advertised price is actually
          // comparable to. AMVIC (and ON/BC/QC) require the advertised price to
          // be all-in, so an ex-freight MSRP is the wrong thing to compare a
          // sticker against -- that mismatch is what produced the $11,173
          // phantom markup. [[amvic-all-in-pricing]]
          //
          // Alberta is the stack we store, because that is the market these
          // reports serve; the province is stamped in attrs so a consumer can
          // never mistake it for a national figure.
          //
          // HONEST ABOUT THE BASIS: from_prices publishes ONE model code per
          // series -- the base configuration -- so the stack is per NAMEPLATE.
          // Freight and the regulator lines do not vary by trim, but the tire
          // levy can, so `all_in_basis` records that this is the series' base
          // stack applied to this trim's MSRP rather than a per-trim figure.
          const feeStack = feeByProv[ALL_IN_PROVINCE] || null;
          const feeTotal = feeStack ? feeStackTotal(feeStack) : null;
          const breakdown = feeStack ? allInBreakdown(feeStack) : null;
          msrpRows.push({
            year, make: makeName, model: s.name, trim, msrp, fuel_type: fuel,
            // A drivetrain the manufacturer stated in the grade ("XLE FWD"), not
            // one inferred from a name. Left null when the grade did not say, so
            // carry-forward can still supply the hand-verified value.
            ...(named.drivetrain ? { drivetrain: named.drivetrain } : {}),
            fetched_at: new Date().toISOString(),
            ...(feeTotal != null ? { all_in_price: Math.round((msrp + feeTotal) * 100) / 100 } : {}),
            ...(breakdown ? { attrs: {
              province: ALL_IN_PROVINCE,
              all_in_breakdown: breakdown,
              all_in_basis: "series base configuration; freight and levies do not vary by trim",
              captured_from: `${host}/bin/api/price_calculation/from_prices.${brand}.${ALL_IN_PROVINCE}.json (${s.seriesCode}/${year}/${feeStack.modelCode})`,
              captured_on: today,
              // The page a buyer can open to check this figure. It goes in attrs,
              // NOT in the source_url COLUMN: replaceRows' DELETE carries
              // "&source_url=is.null", so that column means "hand-verified, spare
              // me" to the refresh. Writing it on every scraped row would make the
              // DELETE spare the whole make and leave the UNIQUE(year,make,model,
              // trim) collision to be avoided by the supersede probe, which is
              // wrapped in a catch and explicitly best-effort.
              source_page: `${host}/en/build-price/${s.seriesCode.toLowerCase()}/`,
            } } : {}),
          });
        }
      }

      const rates = await fetchRates(host, brand, s.seriesCode, year);
      if (rates) {
        for (const [term, r] of Object.entries(rates.finance)) {
          financeRows.push({ make: makeName, model: s.name, apr: r.apr, term_months: Number(term), promo: false, effective_date: today });
        }
        for (const [term, r] of Object.entries(rates.lease)) {
          leaseRows.push({ make: makeName, model: s.name, apr: r.apr, term_months: Number(term), annual_km: r.km, effective_date: today });
        }
      }
      break;
    }
    console.log(`  ${s.seriesCode.padEnd(4)} ${s.name}${hitYear ? ` @${hitYear}` : "  (no price data)"}`);
  }

  console.log(`[${makeName}] ${msrpRows.length} MSRP, ${financeRows.length} finance, ${leaseRows.length} lease rows.`);
  if (unnamedBase.length) {
    console.log(`  ${unnamedBase.length} base trim(s) published under a stub name -- the fragment's grade is an internal code, so nothing can name them:`);
    for (const u of unnamedBase.slice(0, 8)) console.log(`    - ${u}`);
    if (unnamedBase.length > 8) console.log(`    - … +${unnamedBase.length - 8} more`);
  }
  if (skipped.noGrade || skipped.refused) {
    console.log(`  refused: ${skipped.noGrade} missing-grade, ${skipped.refused} unprovable MSRP`);
    for (const r of refusals.slice(0, 8)) console.log(`    - ${r}`);
    if (refusals.length > 8) console.log(`    - … +${refusals.length - 8} more`);
  }
  // Rule: a stub-named row is dropped when the same car is present under a real
  // trim name at the same price. Runs BEFORE dedupeBy, because dedupeBy keys on
  // the trim string and so cannot see that two different strings name one car.
  const stub = dropStubDuplicates(msrpRows);
  if (stub.dropped.length) {
    console.log(`  dropped ${stub.dropped.length} stub-named row(s) already present under a real trim name: ${stub.dropped.slice(0, 3).join("; ")}`);
  }
  msrpRows = stub.rows;

  // A grade can appear under two modelCodes (same year/model/trim) — collapse to
  // the lowest MSRP so we don't violate msrp_catalog's UNIQUE(year,make,model,trim).
  return {
    // lower(trim): the key was CASE-SENSITIVE, so Lexus's AEM fragment
    // returning "LUXURY" for one package and "Luxury" for another created TWO
    // catalog rows for one trim at two different prices. Confirmed live
    // 2026-08-27: a 2026 Lexus NX card printed six rows of "Luxury" at six
    // prices. The database UNIQUE constraint is case-sensitive too, so it
    // could not stop it either -- this is the write-side half of the fix.
    msrpRows: dedupeBy(msrpRows, r => `${r.year}|${r.make}|${r.model}|${String(r.trim ?? "").trim().toLowerCase()}`, "msrp"),
    financeRows: dedupeBy(financeRows, r => `${r.make}|${r.model}|${r.term_months}`, "apr"),
    leaseRows,
  };
}

// ── Supabase write (delete-then-insert per make) ───────────────────────────
// replaceRows now comes from catalog-io.mjs. The local copy that used to live
// here had no empty-scrape guard, no carry-forward and no collapse check, so a
// partial Toyota scrape deleted the lineup and re-inserted 7 rows while
// printing "replaced with 7 rows" as if it had succeeded (2026-08-14).

// Shared runner used by scrape-toyota / scrape-lexus wrappers.
export async function run(config) {
  const args = Object.fromEntries(process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  }));
  const { msrpRows: rawMsrp, financeRows, leaseRows } = await scrapeBrand({ ...config, filterSeries: args.series, pinYear: args.year });

  // Hand-seed corrections for models the SERIES-level fuel tag mis-derives — the
  // Lexus TX had its gas TX 350 trims stored as Hybrid and its base named by the
  // internal grade "Premium" instead of the "Luxury" trim. Runs on every refresh,
  // so replaceRows() can't wipe it. See tci-overrides.mjs (proper inferFuel fix
  // is tracked separately). The guard warns if any OTHER multi-powertrain line
  // comes back all one non-gas fuel, so the next mis-tag is loud, not silent.
  const { rows: msrpRows, replaced } = applyTciOverrides(rawMsrp, config.makeName);
  for (const r of replaced) console.log(`  override: ${r.key} — dropped ${r.dropped} scraped row(s), inserted ${r.inserted} verified`);
  // A PROVEN MIS-TAG IS NOW REFUSED, NOT JUST LOGGED. This was a console.warn,
  // so a whole gasoline line tagged "Hybrid" shipped to msrp_catalog anyway --
  // and every downstream consumer then offered a hybrid buyer the GAS ladder
  // (or vice versa), which is the exact false anchor [[powertrain-identity-rule]]
  // forbids. Confirmed live 2026-08-27: all six gasoline Lexus 'NX' rows carried
  // fuel_type 'Hybrid'.
  //
  // "Proven" is deliberately strict: the same make/year must ALSO list a sibling
  // nameplate extending this one with a powertrain marker ("NX" alongside "NX
  // Hybrid"), which makes the bare nameplate the gas line by construction. A
  // genuinely single-powertrain line (Sienna is hybrid-only) is never refused --
  // it still warns, so a real new mis-tag stays loud. Missing beats wrong: a
  // dropped model shows as "no catalog figure", which every surface already
  // handles honestly; a mis-tagged one produces a confident wrong number.
  const powertrainFlags = flagAllOnePowertrain(msrpRows);
  const refusedKeys = new Set(powertrainFlags.filter((s) => s.proven).map((s) => s.key));
  for (const s of powertrainFlags) {
    if (s.proven) console.error(`  REFUSED: ${s.key} — ${s.trims} trims ALL tagged ${s.fuel} while a powertrain-marked sibling nameplate exists; this is a series-level fuel mis-tag. Rows dropped. Add a tci-override or fix inferFuel.`);
    else console.warn(`  WARN: ${s.key} — ${s.trims} trims ALL tagged ${s.fuel}; likely a series-level fuel mis-tag. Add a tci-override or fix inferFuel.`);
  }
  const keptMsrpRows = refusedKeys.size
    ? msrpRows.filter((r) => !refusedKeys.has(`${r.make}|${r.model}|${r.year}`))
    : msrpRows;
  if (refusedKeys.size) console.error(`  ${msrpRows.length - keptMsrpRows.length} MSRP row(s) withheld across ${refusedKeys.size} mis-tagged model(s).`);

  // WRITE THROUGH writeCatalogs, NOT THREE BARE AWAITS.
  // 5f4259d fixed exactly this defect -- an MSRP write that throws must not take
  // the finance and lease writes down with it -- and converted twenty scrapers
  // to the shared helper. This file and fca-stack.mjs kept their own hand-rolled
  // copy of the sequence and so kept the bug, which is why the Toyota run that
  // motivated 5f4259d is STILL losing its rates: the collapse guard correctly
  // refuses the MSRP rows, the refusal throws, and 123 finance + 120 lease rows
  // that were already in hand never get written.
  //
  // writeCatalogs also brings the dry-run path, the dedupe, the quality gate and
  // the ratesOnly option, all of which this file was duplicating or missing.
  // MSRP here is the PUBLISHED national figure, not a calculated one.
  //
  // This platform used to store pkg.vehicleStartPrice as MSRP. That is a
  // province-calculated price -- twelve distinct values across thirteen
  // provinces for one Land Cruiser -- and the whole-dollar filter that was
  // supposed to catch it instead ADMITTED 7 calculated rows, because five
  // provinces happen to return whole dollars that disagree with each other.
  //
  // The real source is from_prices.<BRAND>.<PROVINCE>.json, whose MSRP line is
  // identical in every province and whose fee stack reconciles to the printed
  // subtotal. Base trims take it directly; other trims are reached by a
  // difference that must produce the SAME whole-dollar figure in every
  // cross-check province before it is allowed out. See tci-msrp.mjs.
  //
  // price_basis is stamped excl_freight because the payload proves it:
  // SUBTOTAL = MSRP + PACKAGE + DRF + FPD + AC + levies, so the MSRP line sits
  // below freight. That matches the hand-seeded Build & Price rows, which this
  // derivation reproduces exactly for all four 2026 RAV4 PHEV trims.
  await writeCatalogs(config.makeName, { msrpRows: keptMsrpRows, financeRows, leaseRows }, {
    priceBasis: "excl_freight",
  });
}
