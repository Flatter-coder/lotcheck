// ============================================================================
// Market-value PROVIDER ABSTRACTION.
//
// One entry point, swappable backends. Data is a commodity input; keeping the
// provider behind a switch means expansion/vendor-swap is a config change, not a
// rewrite (locale-abstraction-rule), and no single provider can gate the roadmap
// (no-single-point-of-failure).
//
//   MARKETVALUE_PROVIDER  ->  marketcheck | cbb | none   (default: none)
//
// A provider is allowed here ONLY if it cannot be turned off by the people we
// audit. A vendor that also sells to dealers is a kill switch held by the other
// side of the table: the better LotCheck works, the stronger their incentive to
// have us cut off, and by then we would be dependent. VinAudit was removed on
// 2026-08-11 for exactly that reason (plus service quality) and must not come
// back. See vendor-capture-risk / zero-to-one-buyer-side-moat.
//
// EVERY provider normalizes to the same MarketValue shape the report already
// consumes. On ANY error, thin coverage, or missing key -> returns null, and the
// report simply omits the module. We NEVER emit a fabricated number: if a
// provider can't back the value with enough comps, that's null, not a guess
// (price-verification-gate / make-it-dispute-proof).
// ============================================================================

export interface MarketValue {
  average: number | null;     // the median asking price — the headline number
  below: number | null;       // 25th percentile (band, lower)
  above: number | null;       // 75th percentile (band, upper)
  low: number | null;         // cheapest kept comp (true range floor)
  high: number | null;        // priciest kept comp (true range ceiling)
  mileage: number | null;
  source: string | null;      // provenance label shown on the report
  comps?: number | null;      // # of comps behind the number (coverage signal)
  asOf?: string | null;       // capture date of the freshest comp (dated proof)
  confidence?: "high" | "low" | null;
  cpoPremium?: CpoPremium | null;  // set only for a CERTIFIED subject with enough non-certified comps
}

// The CPO "fee" is a market PREMIUM, not a line item: what a certified car costs
// over a comparable NON-certified one. Attached to marketValue for a certified
// subject; null (omitted) otherwise.
export interface CpoPremium {
  premium: number;              // subject asking − non-certified median (> 0)
  nonCertifiedMedian: number;
  certifiedMedian: number | null;
  nNonCertified: number;
  nCertified: number;
  basis: string;                // the mileage/trim control used for the baseline
}

export interface MarketCtx {
  year?: number | string | null;
  make?: string | null;
  model?: string | null;
  trim?: string | null;
  condition?: string | null;     // 'used' | 'new' — the lotcheck provider needs it
  province?: string | null;      // crawl coverage is per-province; 'AB' today
  postalOrZip?: string | null;
  country?: "CA" | "US" | null;
  saleCondition?: string | null; // finer: 'certified' triggers the CPO premium
  asking?: number | null;        // the subject's asking price, for the premium delta
}

const env = (k: string): string | undefined => (globalThis as any).Deno?.env?.get(k);
// Defaults to "lotcheck" -> our OWN vehicle_listing crawl via fn_market_comps.
// This is the vendor-free source (Phase 1 of the used-value method): it can't be
// revoked by anyone we audit, and it is FAIL-SAFE — thin coverage returns null
// and the report simply omits the module, so defaulting it on can never fabricate
// a number. Set MARKETVALUE_PROVIDER=none to force it off, or =marketcheck/cbb to
// swap in a paid provider (both are vendors — see the warning above).
const PROVIDER = (): string => (env("MARKETVALUE_PROVIDER") || "lotcheck").toLowerCase();

// Minimum comps required to DISPLAY a value. Below this we return null rather
// than show a low-confidence number as authoritative. Tunable per provider.
const COMP_FLOOR = Number(env("MARKETVALUE_COMP_FLOOR") || "5");

// Provinces our crawl actually covers. The value band + CPO premium are built
// from these comps, so a car OUTSIDE them has no honest baseline — we return null
// rather than compare it against Alberta prices unlabeled (missing beats wrong).
// Env-configurable so expansion is a config change, not a code change.
const COMPS_PROVINCES = (): Set<string> =>
  new Set((env("MARKETVALUE_COMPS_PROVINCES") || "AB").toUpperCase().split(",").map((s) => s.trim()).filter(Boolean));

/** True only when we have crawl comps for this province (Alberta today). An
 *  unknown/empty province is NOT served — we don't guess a car's market. */
export function servesComps(province: string | null | undefined): boolean {
  return COMPS_PROVINCES().has(String(province || "").toUpperCase());
}

// ---------------------------------------------------------------------------
// MarketCheck adapter — CONFIRMED endpoints (docs.marketcheck.com, 2026-08-04).
// Base https://api.marketcheck.com/v2/ ; auth = api_key query param.
//
// The dedicated price-prediction engine is US-ONLY, so for CANADA (Alberta
// beachhead) we aggregate our OWN value band from live comps via
// /v2/search/car/active (covers 8,200+ CA dealer + private sites, $0.002/call).
// Same path works for US. Median = the number; 25th/75th percentile = the band.
//
// Gated on MARKETCHECK_API_KEY -> inert until a key is set (safe to ship dark).
// NOT yet live-tested against a real key (test-before-release): confirm the
// listing field names on the first real call and adjust the defensive parse.
// ---------------------------------------------------------------------------
const MC_BASE = "https://api.marketcheck.com/v2";

export function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); }
export function percentile(xs: number[], p: number): number { const s = [...xs].sort((a, b) => a - b); const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1)))); return s[i]; }

async function marketcheckValue(vin: string, mileage: number | null, ctx: MarketCtx): Promise<MarketValue | null> {
  const key = env("MARKETCHECK_API_KEY");
  if (!key || !vin) return null;
  if (!ctx.make || !ctx.model) return null; // need ymm to build comps
  try {
    const u = new URL(`${MC_BASE}/search/car/active`);
    u.searchParams.set("api_key", key);
    u.searchParams.set("car_type", "used");
    u.searchParams.set("make", String(ctx.make));
    u.searchParams.set("model", String(ctx.model));
    if (ctx.year) u.searchParams.set("year", String(ctx.year));
    if (ctx.postalOrZip) { u.searchParams.set("zip", String(ctx.postalOrZip)); u.searchParams.set("radius", "250"); }
    u.searchParams.set("rows", "50");
    const res = await fetch(u.toString(), { headers: { accept: "application/json" } });
    if (!res.ok) { console.warn("marketcheck: HTTP", res.status); return null; }
    const j: any = await res.json();

    // Defensive parse — confirm the exact listing shape on first live call.
    const listings: any[] = j?.listings || j?.records || [];
    const prices = listings.map((l) => num(l?.price)).filter((n): n is number => n != null && n > 0);
    const comps = num(j?.num_found) ?? prices.length;

    // Coverage gate: too few real comps -> return null, never a fabricated value.
    if (prices.length < COMP_FLOOR) {
      console.warn(`marketcheck: thin coverage (${prices.length} < ${COMP_FLOOR}) — suppressing value`);
      return null;
    }
    const avg = median(prices);
    return {
      average: avg,
      below: percentile(prices, 25),
      above: percentile(prices, 75),
      low: Math.min(...prices),
      high: Math.max(...prices),
      mileage: mileage ?? null,
      source: `MarketCheck live comps (${prices.length})`,
      comps,
      asOf: null,
      confidence: prices.length >= COMP_FLOOR ? "high" : "low",
    };
  } catch (e) {
    console.warn("marketcheck error (suppressing):", (e as Error)?.message);
    return null;
  }
}

function num(x: unknown): number | null { const v = Number(x); return Number.isFinite(v) ? v : null; }

// ---------------------------------------------------------------------------
// LotCheck adapter — our OWN vehicle_listing crawl, zero vendor dependency.
//
// The band math lives HERE, in tested TypeScript, not in SQL: fn_market_comps
// (20260823) just returns the raw candidate price pool for the model, and
// computeBand() does the mileage-band selection, the median-relative outlier
// trim (pctracker.ca's 0.4x-2.0x method), and the min-comps gate. One tested
// implementation, so a thin or noisy set can never quietly produce a number.
// ---------------------------------------------------------------------------
export interface CompRow { price: number; odometerKm?: number | null; trim?: string | null; year?: number | null; asOf?: string | null; certified?: boolean | null; }
export interface Band {
  n: number; median: number; p25: number; p75: number; low: number; high: number;
  kmBasis: boolean;       // true = band computed within a mileage window of the subject
  trimBasis: boolean;     // true = band narrowed to the subject's trim (like-for-like)
  trimMatches: number;    // how many of the kept comps share the subject's trim
  asOf: string | null;    // most recent last_seen_on across the kept comps
  insufficient?: boolean; // true = below the comp floor, DO NOT show a number
}

export interface BandOpts { odometerKm?: number | null; trim?: string | null; condition?: string | null; kmBandPct?: number; minComps?: number; lowerMult?: number; upperMult?: number; }

// Pure. Given the candidate rows for a model, decide the honest band or refuse.
export function computeBand(rows: CompRow[], opts: BandOpts = {}): Band {
  const minComps = opts.minComps ?? COMP_FLOOR;
  const kmBandPct = opts.kmBandPct ?? 0.30;   // used cars: comps within +/-30% mileage
  const lowerMult = opts.lowerMult ?? 0.4;    // drop listings below 0.4x the raw median
  const upperMult = opts.upperMult ?? 2.0;    // and above 2.0x — junk/bundle/typo guard
  const empty: Band = { n: 0, median: 0, p25: 0, p75: 0, low: 0, high: 0, kmBasis: false, trimBasis: false, trimMatches: 0, asOf: null, insufficient: true };

  const priced = (rows || []).filter((r) => r && Number.isFinite(Number(r.price)) && Number(r.price) > 0);
  if (!priced.length) return empty;

  // Narrow to the subject's TRIM first — the biggest driver of the confusing
  // all-trims spread (a base and a loaded one are different cars, so a $29k base
  // and a $96k loaded one bracketing "the same truck" reads as broken). First-word
  // normalized so "XLT" and "XLT SuperCrew" group; generic tokens ("Other/Don't
  // Know") never match. Only when >= the floor of same-trim comps — otherwise fall
  // back to all trims rather than show a thin same-trim band.
  const normTrim = (t: unknown): string => String(t || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").trim().split(/\s+/)[0] || "";
  const GENERIC = new Set(["other", "unknown", "na", "don", "n", "base", ""]);
  let selected = priced;
  let trimBasis = false;
  const st = normTrim(opts.trim);
  if (st && !GENERIC.has(st)) {
    const tset = priced.filter((r) => normTrim(r.trim) === st);
    if (tset.length >= minComps) { selected = tset; trimBasis = true; }
  }

  // Then a mileage-matched window WITHIN that set, if dense enough — never a
  // 2-comp mileage band as if it were the market.
  let kmBasis = false;
  if (opts.condition === "used" && opts.odometerKm != null && Number.isFinite(Number(opts.odometerKm))) {
    const km = Number(opts.odometerKm);
    const lo = km * (1 - kmBandPct), hi = km * (1 + kmBandPct);
    const band = selected.filter((r) => r.odometerKm != null && Number(r.odometerKm) >= lo && Number(r.odometerKm) <= hi);
    if (band.length >= minComps) { selected = band; kmBasis = true; }
  }

  const asOf = selected.reduce<string | null>((mx, r) => (r.asOf && (!mx || r.asOf > mx) ? r.asOf : mx), null);
  const trimMatches = st ? selected.filter((r) => normTrim(r.trim) === st).length : 0;

  const prices0 = selected.map((r) => Number(r.price));
  if (prices0.length < minComps) return { ...empty, n: prices0.length, kmBasis, trimBasis, trimMatches, asOf };

  // Median-relative outlier trim, then recompute the band on what survives.
  const m0 = median(prices0);
  const kept = prices0.filter((p) => p >= m0 * lowerMult && p <= m0 * upperMult);
  if (kept.length < minComps) return { ...empty, n: kept.length, kmBasis, trimBasis, trimMatches, asOf };

  return {
    n: kept.length,
    median: median(kept),
    p25: percentile(kept, 25),
    p75: percentile(kept, 75),
    low: Math.min(...kept),
    high: Math.max(...kept),
    kmBasis, trimBasis, trimMatches, asOf,
    insufficient: false,
  };
}

// The CPO premium: what a CERTIFIED subject costs over a comparable NON-certified
// one. Baseline = the non-certified used comps, mileage/trim-controlled through
// computeBand (like-for-like), min-comps gated (thin -> null, never a guessed
// premium). Only a POSITIVE premium is returned — if the certified car is not
// priced above the non-certified median there is nothing to surface. The
// certified-set median is added as context when enough certified comps exist.
export function computeCpoPremium(rows: CompRow[], subjectAsking: number, opts: BandOpts = {}): CpoPremium | null {
  const ask = Number(subjectAsking);
  if (!(ask > 0) || !Array.isArray(rows)) return null;
  const nonCertified = rows.filter((r) => r && r.certified !== true);
  const certified = rows.filter((r) => r && r.certified === true);
  const minComps = opts.minComps ?? 5;
  const base = computeBand(nonCertified, opts);
  if (base.insufficient || base.n < minComps || !(base.median > 0)) return null;
  const premium = Math.round(ask - base.median);
  if (!(premium > 0)) return null;
  // Certified-set median as context — a plain median (not a min-comps-gated band):
  // the certified pool is small by nature, so 3+ is enough to sketch it.
  const certPrices = certified.map((r) => Number(r.price)).filter((p) => p > 0);
  const certifiedMedian = certPrices.length >= 3 ? median(certPrices) : null;
  const basis = base.trimBasis && base.kmBasis ? "same trim, similar mileage"
    : base.trimBasis ? "same trim" : base.kmBasis ? "similar mileage" : "all trims";
  return {
    premium,
    nonCertifiedMedian: base.median,
    certifiedMedian,
    nNonCertified: base.n,
    nCertified: certified.length,
    basis,
  };
}

// Market CPO premium for the VALUE report: certified median − non-certified
// median, both from our comps. Unlike computeCpoPremium (which measures a
// SUBJECT asking price against the baseline), this measures what the MARKET
// prices certification at — so it works when we're VALUING a car, not auditing a
// listing (no subject asking exists). Positive-only, gated on enough comps on
// both sides (>=minComps non-certified, >=3 certified) — else null. Never fabricates.
export function computeMarketCpoPremium(rows: CompRow[], opts: BandOpts = {}): CpoPremium | null {
  if (!Array.isArray(rows)) return null;
  const nonCertified = rows.filter((r) => r && r.certified !== true);
  const certified = rows.filter((r) => r && r.certified === true);
  const minComps = opts.minComps ?? 5;
  const base = computeBand(nonCertified, opts);
  if (base.insufficient || base.n < minComps || !(base.median > 0)) return null;
  const certPrices = certified.map((r) => Number(r.price)).filter((p) => p > 0);
  if (certPrices.length < 3) return null;
  const certifiedMedian = median(certPrices);
  const premium = Math.round(certifiedMedian - base.median);
  if (!(premium > 0)) return null;
  const basis = base.trimBasis && base.kmBasis ? "same trim, similar mileage"
    : base.trimBasis ? "same trim" : base.kmBasis ? "similar mileage" : "all trims";
  return { premium, nonCertifiedMedian: base.median, certifiedMedian, nNonCertified: base.n, nCertified: certified.length, basis };
}

async function lotcheckValue(vin: string, mileage: number | null, ctx: MarketCtx): Promise<MarketValue | null> {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_ANON_KEY");
  if (!url || !key) return null;
  if (!ctx.year || !ctx.make || !ctx.model || !ctx.condition) return null; // need ymm + condition to build comps
  // The LISTING's province must be one we actually crawl. A non-Alberta car (or
  // one whose province we couldn't establish) gets no value band and no CPO
  // premium — we won't show it Alberta comps unlabeled. See servesComps above.
  const prov = String(ctx.province || "").toUpperCase();
  if (!servesComps(prov)) return null;
  try {
    const res = await fetch(`${url}/rest/v1/rpc/fn_market_comps`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: key, authorization: `Bearer ${key}` },
      body: JSON.stringify({
        p_year: Number(ctx.year), p_make: String(ctx.make), p_model: String(ctx.model),
        p_condition: String(ctx.condition), p_exclude_vin: vin || null,
        p_province: prov,
        // +/-2 model years, not +/-1. A 2020-2024 window for a 2022 car is still
        // honest comparables (usually the same generation), and it roughly
        // doubles how many used cars clear the comp floor -- measured live against
        // the crawl: CX-5 4->7, Corolla 2->5, Rogue 8->31. The mileage band,
        // outlier trim and median still guard quality within the wider pool.
        p_year_span: 2,
      }),
    });
    if (!res.ok) { console.warn("lotcheck market_comps: HTTP", res.status); return null; }
    const rows = await res.json();
    const band = computeBand(Array.isArray(rows) ? (rows as CompRow[]) : [], {
      odometerKm: mileage, trim: ctx.trim ?? null, condition: String(ctx.condition),
    });
    // Coverage gate: too few real comps -> null, never a fabricated value.
    if (band.insufficient || band.n < COMP_FLOOR) {
      console.warn(`lotcheck: thin coverage (${band.n} < ${COMP_FLOOR}) — suppressing value`);
      return null;
    }
    const mv: MarketValue = {
      average: band.median,
      below: band.p25,
      above: band.p75,
      low: band.low,
      high: band.high,
      mileage: mileage ?? null,
      source: `LotCheck market · ${band.trimBasis && band.kmBasis ? "same trim, similar mileage" : band.trimBasis ? "same trim" : band.kmBasis ? "similar mileage" : "all trims"} · ${band.n} comparable listing${band.n === 1 ? "" : "s"}`,
      comps: band.n,
      asOf: band.asOf,
      confidence: band.n >= COMP_FLOOR ? "high" : "low",
    };
    // CPO premium: only for a certified subject, against the NON-certified comps
    // in the same pool. computeCpoPremium is min-comps gated and returns a
    // positive premium only, so this stays null unless it's genuinely backed.
    if (String(ctx.saleCondition) === "certified" && Number(ctx.asking) > 0) {
      const prem = computeCpoPremium(Array.isArray(rows) ? (rows as CompRow[]) : [], Number(ctx.asking), { odometerKm: mileage, trim: ctx.trim ?? null, minComps: COMP_FLOOR });
      if (prem) mv.cpoPremium = prem;
    }
    return mv;
  } catch (e) {
    console.warn("lotcheck market value error (suppressing):", (e as Error)?.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public entry point — dispatch by provider, always fail-safe to null.
// ---------------------------------------------------------------------------
// VALUE-report band: the same vendor-free comps as lotcheckValue, but keyed on
// year/make/model with the VIN OPTIONAL (used only to exclude the subject's own
// listing if it happens to be on the market). This is the value-report entry
// point — the user is VALUING a car and may have no VIN, so we must not gate on
// one the way fetchMarketValue does. It attaches the MARKET CPO premium
// (computeMarketCpoPremium: certified vs non-certified medians), not a
// subject-asking premium. Same coverage gates: non-served province or thin
// comps -> null, so it can never fabricate a value.
export async function lotcheckValueBand(
  ctx: MarketCtx,
  mileage?: number | null,
  vin?: string | null,
): Promise<MarketValue | null> {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_ANON_KEY");
  if (!url || !key) return null;
  if (!ctx.year || !ctx.make || !ctx.model || !ctx.condition) return null; // need ymm + condition
  const prov = String(ctx.province || "").toUpperCase();
  if (!servesComps(prov)) return null; // Alberta-only crawl coverage today
  try {
    const res = await fetch(`${url}/rest/v1/rpc/fn_market_comps`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: key, authorization: `Bearer ${key}` },
      body: JSON.stringify({
        p_year: Number(ctx.year), p_make: String(ctx.make), p_model: String(ctx.model),
        p_condition: String(ctx.condition), p_exclude_vin: vin || null,
        p_province: prov, p_year_span: 2,
      }),
    });
    if (!res.ok) { console.warn("lotcheckValueBand market_comps: HTTP", res.status); return null; }
    const rows = await res.json();
    const band = computeBand(Array.isArray(rows) ? (rows as CompRow[]) : [], {
      odometerKm: mileage ?? null, trim: ctx.trim ?? null, condition: String(ctx.condition),
    });
    if (band.insufficient || band.n < COMP_FLOOR) {
      console.warn(`lotcheckValueBand: thin coverage (${band.n} < ${COMP_FLOOR}) — suppressing value`);
      return null; // thin coverage -> null, never a fabricated value
    }
    const mv: MarketValue = {
      average: band.median, below: band.p25, above: band.p75, low: band.low, high: band.high,
      mileage: mileage ?? null,
      source: `LotCheck market · ${band.trimBasis && band.kmBasis ? "same trim, similar mileage" : band.trimBasis ? "same trim" : band.kmBasis ? "similar mileage" : "all trims"} · ${band.n} comparable listing${band.n === 1 ? "" : "s"}`,
      comps: band.n, asOf: band.asOf, confidence: band.n >= COMP_FLOOR ? "high" : "low",
    };
    const cpo = computeMarketCpoPremium(Array.isArray(rows) ? (rows as CompRow[]) : [], {
      odometerKm: mileage ?? null, trim: ctx.trim ?? null, minComps: COMP_FLOOR,
    });
    if (cpo) mv.cpoPremium = cpo;
    return mv;
  } catch (e) {
    console.warn("lotcheckValueBand error (suppressing):", (e as Error)?.message);
    return null;
  }
}

export async function fetchMarketValue(
  vin: string | null | undefined,
  mileage?: number | null,
  ctx: MarketCtx = {},
): Promise<MarketValue | null> {
  if (!vin) return null;
  try {
    switch (PROVIDER()) {
      case "lotcheck":
        return await lotcheckValue(vin, mileage ?? null, ctx);
      case "marketcheck":
        return await marketcheckValue(vin, mileage ?? null, ctx);
      case "cbb":
        // TODO: Canadian Black Book adapter (CA value anchor) — add when/if we
        // sign the CBB feed. Inert for now.
        return null;
      case "none":
      default:
        return null;
    }
  } catch (e) {
    console.warn("fetchMarketValue dispatch error (suppressing):", (e as Error)?.message);
    return null;
  }
}
