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
  average: number | null;
  below: number | null;
  above: number | null;
  mileage: number | null;
  source: string | null;      // provenance label shown on the report
  comps?: number | null;      // # of comps behind the number (coverage signal)
  confidence?: "high" | "low" | null;
}

export interface MarketCtx {
  year?: number | string | null;
  make?: string | null;
  model?: string | null;
  trim?: string | null;
  postalOrZip?: string | null;
  country?: "CA" | "US" | null;
}

const env = (k: string): string | undefined => (globalThis as any).Deno?.env?.get(k);
// Defaults to "none" -> fetchMarketValue returns null and the report omits the
// module. Behaviour-identical to the old "vinaudit" default, which was itself a
// no-op unless a second switch was flipped.
const PROVIDER = (): string => (env("MARKETVALUE_PROVIDER") || "none").toLowerCase();

// Minimum comps required to DISPLAY a value. Below this we return null rather
// than show a low-confidence number as authoritative. Tunable per provider.
const COMP_FLOOR = Number(env("MARKETVALUE_COMP_FLOOR") || "5");

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

function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); }
function percentile(xs: number[], p: number): number { const s = [...xs].sort((a, b) => a - b); const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1)))); return s[i]; }

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
      mileage: mileage ?? null,
      source: `MarketCheck live comps (${prices.length})`,
      comps,
      confidence: prices.length >= COMP_FLOOR ? "high" : "low",
    };
  } catch (e) {
    console.warn("marketcheck error (suppressing):", (e as Error)?.message);
    return null;
  }
}

function num(x: unknown): number | null { const v = Number(x); return Number.isFinite(v) ? v : null; }

// ---------------------------------------------------------------------------
// Public entry point — dispatch by provider, always fail-safe to null.
// ---------------------------------------------------------------------------
export async function fetchMarketValue(
  vin: string | null | undefined,
  mileage?: number | null,
  ctx: MarketCtx = {},
): Promise<MarketValue | null> {
  if (!vin) return null;
  try {
    switch (PROVIDER()) {
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
