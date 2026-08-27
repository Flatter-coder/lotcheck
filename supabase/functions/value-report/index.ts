// ============================================================================
// value-report — the LotCheck Live Market Value edge function (Phase 1 MVP).
//
// Structured JSON in (year/make/model/trim/km/condition/province, optional VIN),
// a SIGNED value-report PDF out. Clones the analyze-quote shell (CORS + region
// gate) but is far simpler: no image, no Anthropic — just our own comps.
//
// Signs ONLY what our comps back: the retail-ASKING band + the market CPO
// premium (per the spread decision). Thin coverage / out-of-region -> honest
// error, NEVER a fabricated number.
//
// Billing is Phase 3: this MVP does NOT charge (free/comp'd). Because nothing is
// charged, there is no hold to wrongly-capture — the full credit lifecycle (with
// a release on every non-delivery branch, per never-charge-to-ask-a-question)
// lands with Stripe in Phase 3.
// ============================================================================

import { finalizeServerSide, canonicalValueReport } from "../_shared/report-sign.ts";
import { lotcheckValueBand, servesComps, type MarketCtx } from "../_shared/marketvalue.ts";
import { buildValuePdf, u8ToB64 } from "../_shared/value-pdf.ts";
import { gateRequest } from "../_shared/region-gate.js";
import { lookupRecalls } from "../_shared/recalls.ts";
import { computeRemainingWarranty } from "../_shared/warranty.ts";
import { canonicalMake } from "../_shared/makes.ts";
import { canonicalModel } from "../_shared/models.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const APP_ORIGIN = Deno.env.get("APP_ORIGIN") ?? "https://lotcheck.ca";

// Remaining factory warranty from the manufacturer_warranties table (make ilike),
// same source + math the buyer report uses. REST fetch (no supabase client here),
// service key from env. Returns null on any miss — never throws, never guesses.
async function fetchRemainingWarranty(make: string, year: number, km: number | null): Promise<any> {
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY");
    if (!url || !key || !make || !year) return null;
    const m = canonicalMake(make);
    const q = `${url}/rest/v1/manufacturer_warranties?make=ilike.${encodeURIComponent(m)}&select=basic_coverage,powertrain_coverage,source_url&limit=1`;
    const res = await fetch(q, { headers: { apikey: key, authorization: `Bearer ${key}` } });
    if (!res.ok) return null;
    const rows = await res.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return null;
    const rw = computeRemainingWarranty(row, Number(year), km, new Date().getUTCFullYear());
    if (rw) (rw as any).make = m;
    return rw;
  } catch (e) {
    console.warn("fetchRemainingWarranty failed:", (e as Error)?.message);
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  const J = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });

  try {
    const body = await req.json().catch(() => ({}));

    // Alberta-only. Runs FIRST, before any work, so an out-of-region request
    // costs nothing. Region is proven by an HMAC token minted server-side, never
    // claimed by the browser. Fails OPEN when location can't be established.
    const gate = await gateRequest({
      token: body?.regionToken,
      secret: Deno.env.get("REGION_TOKEN_SECRET") ?? "",
      selfDeclared: body?.regionSelfDeclared === true,
    });
    if (!gate.allow) {
      return J({ error: "outside_service_area", region: gate.region ?? null, regionLabel: gate.regionLabel ?? null }, 403);
    }

    // ---- parse + validate the subject vehicle ----
    const year = Number(body?.year);
    const make = String(body?.make ?? "").trim();
    const model = String(body?.model ?? "").trim();
    const trim = body?.trim ? String(body.trim).trim() : null;
    const kmRaw = body?.km ?? body?.odometerKm ?? body?.mileage;
    const km = kmRaw != null && kmRaw !== "" && Number.isFinite(Number(kmRaw)) ? Number(kmRaw) : null;
    const province = String(body?.province ?? "").trim().toUpperCase();
    const vin = body?.vin ? String(body.vin).trim().toUpperCase() : null;
    const saleCondition = body?.condition ? String(body.condition).trim() : "used";

    if (!year || !make || !model) {
      return J({ error: "missing_vehicle", message: "Year, make and model are required." }, 400);
    }
    if (!province) {
      return J({ error: "missing_province", message: "A province is required." }, 400);
    }
    // Coverage: the province must be one our crawl actually covers (Alberta
    // today). Distinct from thin comps so the front end can show the right
    // teaser. We never show a non-Alberta car Alberta comps unlabeled.
    if (!servesComps(province)) {
      return J({ error: "outside_service_area", region: province, message: "LotCheck's live market coverage is Alberta today." }, 403);
    }

    // ---- the band, from our OWN comps (asking + market CPO premium). VIN optional. ----
    const ctx: MarketCtx = { year, make, model, trim, condition: "used", province, saleCondition };
    const mv = await lotcheckValueBand(ctx, km, vin);
    if (!mv || mv.average == null) {
      // Thin coverage -> honest 422, never fabricate. (Nothing charged in Phase 1.)
      return J({
        error: "insufficient_coverage",
        message: "There aren't enough comparable Alberta listings yet to value this one honestly.",
      }, 422);
    }

    // ---- assemble, SIGN (canonicalValueReport), and build the PDF ----
    const analysis: any = {
      reportType: "value",
      vehicle: [year, make, model].filter(Boolean).join(" "),
      year, make, model, trim,
      odometerKm: km, saleCondition, condition: "used", province, vin,
      marketValue: mv,
    };

    // Phase 2: recalls + remaining warranty. Independent of the band, both
    // fail-safe — a lookup miss stays a miss (never a clean bill), warranty null
    // is simply omitted. Attached BEFORE signing so they ride in the canonical.
    try {
      const baseModel = canonicalModel(make, model);
      analysis.recalls = await lookupRecalls(year, make, model, baseModel);
    } catch (e) { console.warn("recalls lookup failed:", (e as Error)?.message); }
    try {
      const rw = await fetchRemainingWarranty(make, year, km);
      if (rw) analysis.remainingWarranty = rw;
    } catch (e) { console.warn("warranty failed:", (e as Error)?.message); }

    await finalizeServerSide(analysis, canonicalValueReport);

    let verifyUrl: string | undefined;
    if (analysis.verifyPayload) {
      verifyUrl = `${APP_ORIGIN}/verify?d=${analysis.verifyPayload}`
        + (analysis.reportId ? `&id=${analysis.reportId}` : "")
        + (analysis.sig ? `&s=${analysis.sig}` : "")
        + (analysis.keyId ? `&k=${analysis.keyId}` : "");
    }

    const pdfBytes = await buildValuePdf(analysis, verifyUrl);
    const pdfBase64 = u8ToB64(pdfBytes);

    return J({ analysis, pdfBase64, verifyUrl: verifyUrl ?? null });
  } catch (e) {
    console.error("value-report error:", (e as Error)?.message);
    return J({ error: "server_error", message: "Something went wrong building the value report." }, 500);
  }
});
