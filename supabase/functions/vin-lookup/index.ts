// ============================================================================
// vin-lookup — client-triggered, OPT-IN vehicle history (VinAudit pullreport,
// $3 in live mode). Kept off the analyze path so history never runs — or bills
// — automatically. Market VALUE is auto and lives in the analyze functions;
// this endpoint is history-only.
//
// POST { vin } -> { history } | { error }. No-op ({history:null}) until
// VINAUDIT_MODE is test/live and credentials are set. VIN = personal info;
// nothing is stored here (caching by VIN is a separate, legally-gated step).
// ============================================================================
import { fetchHistory, historyDebug } from "../_shared/vinaudit.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function isVin(v: unknown): v is string {
  return typeof v === "string" && /^[A-HJ-NPR-Z0-9]{11,17}$/i.test(v.trim());
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const vin = (body?.vin || "").toString().trim().toUpperCase();
    if (!isVin(vin)) {
      return new Response(JSON.stringify({ error: "A valid VIN is required." }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    if (body?.debug === true) {
      return new Response(JSON.stringify({ debug: await historyDebug(vin) }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    const history = await fetchHistory(vin);
    if (!history) {
      // Off/misconfigured, or the provider returned nothing usable.
      return new Response(JSON.stringify({ history: null, error: "history_unavailable" }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ history }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: "Something went wrong looking up that VIN." }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
