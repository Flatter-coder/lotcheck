// ============================================================================
// VinAudit client — used-car MARKET VALUE (auto) + VEHICLE HISTORY (opt-in).
//
// Master spend switch: VINAUDIT_MODE secret.
//   unset / "off"  -> no calls at all (safe default; reports behave as today)
//   "test"         -> history via VinAudit mode=test (their approved test VINs
//                     only, no billing); market value has no test mode -> skipped
//   "live"         -> real calls. Market value = cheap, auto. History = $5,
//                     opt-in only (never called from the analyze path).
//
// Credentials (Supabase secrets): VINAUDIT_KEY, VINAUDIT_USER, VINAUDIT_PASS.
// Everything is best-effort and defensive: any error / missing field returns
// null so a report never breaks. VIN is personal information — display must be
// sourced + dated + suppress-on-notice (see defamation-proof-and-compliant).
// ============================================================================

// Two INDEPENDENT spend switches so cheap auto value and the paid $5 history
// go live separately:
//   VINAUDIT_MODE          -> market value (auto).   off | live
//   VINAUDIT_HISTORY_MODE  -> vehicle history (paid). off | test | prod
// Keep HISTORY at test until the paid add-on charge is wired, or every click
// costs $5 with no revenue. VinAudit's own mode param is "test" | "prod".
const VALUE_MODE = (): string => ((globalThis as any).Deno?.env?.get("VINAUDIT_MODE") || "off").toLowerCase();
const HIST_MODE = (): string => ((globalThis as any).Deno?.env?.get("VINAUDIT_HISTORY_MODE") || "off").toLowerCase();
async function vaPost(url: string, params: Record<string, string>): Promise<any> {
  const body = new URLSearchParams({ ...params, format: "json" });
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  return await res.json().catch(() => null);
}
const KEY = (): string => (globalThis as any).Deno?.env?.get("VINAUDIT_KEY") || "";
const USER = (): string => (globalThis as any).Deno?.env?.get("VINAUDIT_USER") || "";
const PASS = (): string => (globalThis as any).Deno?.env?.get("VINAUDIT_PASS") || "";

const num = (x: unknown): number | null => { const v = Number(x); return Number.isFinite(v) ? v : null; };
const arr = (x: unknown): any[] => Array.isArray(x) ? x : [];

export interface MarketValue {
  average: number | null; below: number | null; above: number | null;
  mean: number | null; certainty: number | null; count: number | null;
  mileage: number | null; vehicle: string | null; period: string[] | null;
  source: "vinaudit"; asOf: string;
}

// Auto (cheap). Live mode only — the market-value endpoint has no free test mode.
export async function fetchMarketValue(vin: string | null | undefined, mileage?: number | null): Promise<MarketValue | null> {
  if (VALUE_MODE() !== "live" || !KEY() || !vin) return null;
  try {
    const u = new URL("https://marketvalue.vinaudit.com/getmarketvalue.php");
    u.searchParams.set("vin", vin);
    u.searchParams.set("key", KEY());
    u.searchParams.set("format", "json");
    if (mileage != null && Number.isFinite(mileage)) u.searchParams.set("mileage", String(mileage));
    const res = await fetch(u.toString());
    const j: any = await res.json().catch(() => null);
    if (!j || j.success === false) return null;
    return {
      average: num(j.prices?.average ?? j.mean),
      below: num(j.prices?.below),
      above: num(j.prices?.above),
      mean: num(j.mean),
      certainty: num(j.certainty),
      count: num(j.count),
      mileage: num(j.mileage ?? mileage),
      vehicle: j.vehicle || null,
      period: Array.isArray(j.period) ? j.period : null,
      source: "vinaudit",
      asOf: new Date().toISOString(),
    };
  } catch (e) { console.warn("VinAudit market value failed:", (e as Error)?.message); return null; }
}

export interface VehicleHistory {
  clean: boolean | null;
  titleBrands: any[];          // Status Checks: normal/irreparable/salvage/rebuilt/stolen/inspection
  accidents: { date: string | null; severity: string | null }[];
  odometer: { date: string | null; reading: number | null; region: string | null }[];
  liens: any[]; salvage: any[]; thefts: any[]; jsi: any[];
  buybacks: any[];             // CAMVAP manufacturer buybacks (Canada lemon signal)
  hasUsHistory: boolean;       // matching US records (cross-border import risk)
  canadaRegistrations: any[]; canadaRecalls: any[]; canadaThefts: any[];
  counts: Record<string, number>;
  source: "vinaudit"; asOf: string; reportId: string | null;
  // NOTE: JSON field names below are best-effort from VinAudit's docs + the
  // report-sections page — VALIDATE against a real payload once API creds land.
}

// Opt-in + PAID ($5 in live mode). Query -> id -> pullreport. Never called from
// the analyze path; only via the vin-lookup edge function on a user action.
export async function fetchHistory(vin: string | null | undefined): Promise<VehicleHistory | null> {
  const mode = HIST_MODE();
  if ((mode !== "test" && mode !== "prod") || !KEY() || !vin) return null;
  try {
    // 1) Query for the record id (query.php takes vin, mode, key).
    const q: any = await vaPost("https://api.vinaudit.com/query.php", { vin, mode, key: KEY(), user: USER(), pass: PASS() });
    if (!q || q.success === false || !q.id) { console.warn("VinAudit query failed:", q?.error || q?.error_message || "no id"); return null; }
    // 2) Pull the full report — the billed call in prod (pullreport.php takes
    //    id, vin, user, pass, mode, key).
    const r: any = await vaPost("https://api.vinaudit.com/pullreport.php", { id: String(q.id), vin, user: USER(), pass: PASS(), mode, key: KEY() });
    if (!r || r.success === false) { console.warn("VinAudit pullreport failed:", r?.error_message || r?.error); return null; }
    const titles = arr(r.titles);
    const caRegs = arr(r.canada_registrations);
    const buybacks = arr(r.buybacks ?? r.camvap ?? r.canada_buybacks);
    // Odometer trail: Canadian readings live in the REGISTRATION records
    // (Registration Date / Jurisdiction / Odometer), NOT the US-style `titles`
    // array — build from both so Canadian cars actually show a mileage history.
    const odoSrc = [...caRegs, ...titles];
    // "US Vehicle History" section: matching US records (title/jsi/theft/sale)
    // — a cross-border import can hide US salvage. Flag if any US record exists.
    const usBlock = r.us || r.us_history || r.usa || null;
    const hasUsHistory = !!(usBlock && typeof usBlock === "object" &&
      ["titles", "jsi", "thefts", "sale", "checks"].some((k) => arr(usBlock[k]).length > 0));
    return {
      clean: typeof r.clean === "boolean" ? r.clean : null,
      titleBrands: arr(r.checks),
      accidents: arr(r.accidents).map((a: any) => ({ date: a.date || a.reportdate || null, severity: a.severity || a.damage || a.type || null })),
      odometer: odoSrc.map((t: any) => ({ date: t.date || t.regdate || null, reading: num(t.meter ?? t.odometer ?? t.mileage), region: t.jurisdiction || t.state || t.province || t.region || null })).filter((o) => o.reading != null),
      liens: arr(r.lie),
      salvage: arr(r.salvage),
      thefts: arr(r.thefts),
      jsi: arr(r.jsi),
      buybacks,
      hasUsHistory,
      canadaRegistrations: caRegs,
      canadaRecalls: arr(r.canada_recalls),
      canadaThefts: arr(r.canada_thefts),
      counts: {
        titles: titles.length, accidents: arr(r.accidents).length, liens: arr(r.lie).length,
        salvage: arr(r.salvage).length, thefts: arr(r.thefts).length, brands: arr(r.checks).length,
        buybacks: buybacks.length,
        caRegistrations: caRegs.length, caRecalls: arr(r.canada_recalls).length,
      },
      source: "vinaudit",
      asOf: new Date().toISOString(),
      reportId: r.id || q.id || null,
    };
  } catch (e) { console.warn("VinAudit history failed:", (e as Error)?.message); return null; }
}

// TEMP diagnostic: reports config state (booleans only — no secret values) and
// the RAW VinAudit responses so we can validate field mappings against a real
// payload. Uses test mode if HISTORY_MODE isn't set (safe with approved test
// VINs). Remove after validation.
export async function historyDebug(vin: string): Promise<any> {
  const mode = (HIST_MODE() === "prod") ? "prod" : "test";
  const out: any = { histMode: HIST_MODE(), valueMode: VALUE_MODE(), hasKey: !!KEY(), hasUser: !!USER(), hasPass: !!PASS(), usedMode: mode };
  if (!KEY()) { out.note = "VINAUDIT_KEY not set"; return out; }
  try {
    const q: any = await vaPost("https://api.vinaudit.com/query.php", { vin, mode, key: KEY(), user: USER(), pass: PASS() });
    out.query = q;
    if (q && q.id) {
      const r: any = await vaPost("https://api.vinaudit.com/pullreport.php", { id: String(q.id), vin, user: USER(), pass: PASS(), mode, key: KEY() });
      out.reportKeys = r ? Object.keys(r) : null;
      out.report = r;
    }
  } catch (e) { out.error = (e as Error)?.message; }
  return out;
}
