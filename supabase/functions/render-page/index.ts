// Render a manufacturer page and return its HTML.
//
// WHY THIS EXISTS. The published-MSRP capture needs a JS-rendered page, and the
// Scrapfly key already lives here as a Supabase secret. Copying that key into
// GitHub Actions would mean two places to rotate and two places to leak, so the
// CI job calls this instead using the Supabase service-role key it already has.
//
// LOCKED DOWN, deliberately -- an open render endpoint is an open proxy and a
// way to burn our Scrapfly credits:
//   * service-role JWT required (role claim; signature verified by Supabase)
//   * host allowlist: manufacturer sites only, nothing else renders
//   * POST only, one URL per call

const SCRAPFLY_API_KEY = Deno.env.get("SCRAPFLY_API_KEY") || "";

// AUTH: check the JWT's ROLE CLAIM, not a copied key value.
//
// Comparing against a stored key kept failing because there were three
// different "service role keys" in play -- CI's copy (2026-07-01), the value
// pasted into this function's secrets, and the project's current key after
// rotation. Supabase's gateway already verifies the token's SIGNATURE before
// this code runs (verify_jwt is on by default), so decoding the payload and
// requiring role === "service_role" is both safe and immune to rotation: the
// anon key that ships in our frontend has role "anon" and is rejected.
function isServiceRole(token: string): boolean {
  try {
    const payload = token.split(".")[1];
    if (!payload) return false;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "="));
    const claims = JSON.parse(json);
    return claims?.role === "service_role";
  } catch { return false; }
}

// Manufacturer domains whose own published prices we read. Nothing else is
// renderable through this endpoint -- notably no dealer sites, so it can never
// become a general-purpose scraping proxy or a way to burn Scrapfly credits.
const ALLOWED_HOSTS = [
  "www.chevrolet.ca", "www.gmc.ca", "www.buick.ca", "www.cadillaccanada.ca",
  "www.ford.ca", "www.lincolncanada.com",
  "www.toyota.ca", "www.lexus.ca",
  "www.nissan.ca", "www.hyundaicanada.com", "www.kia.ca", "www.mazda.ca",
  "www.honda.ca", "www.subaru.ca", "www.volkswagen.ca", "www.bmw.ca",
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!isServiceRole(token)) {
    return new Response(JSON.stringify({ error: "forbidden: service-role token required" }), { status: 403, headers: { ...CORS, "Content-Type": "application/json" } });
  }
  if (!SCRAPFLY_API_KEY) {
    return new Response(JSON.stringify({ error: "SCRAPFLY_API_KEY not configured" }), { status: 503, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  let url = "";
  try { url = String((await req.json())?.url || ""); } catch { /* handled below */ }
  let host = "";
  try { host = new URL(url).host.toLowerCase(); } catch {
    return new Response(JSON.stringify({ error: "invalid url" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  }
  if (!ALLOWED_HOSTS.includes(host)) {
    return new Response(JSON.stringify({ error: `host not allowed: ${host}` }), { status: 403, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  try {
    const u = new URL("https://api.scrapfly.io/scrape");
    u.searchParams.set("key", SCRAPFLY_API_KEY);
    u.searchParams.set("url", url);
    u.searchParams.set("render_js", "true");
    u.searchParams.set("auto_scroll", "true");
    u.searchParams.set("rendering_wait", "4000");
    u.searchParams.set("country", "ca");
    const res = await fetch(u.toString(), { signal: AbortSignal.timeout(90_000) });
    if (!res.ok) {
      return new Response(JSON.stringify({ error: `scrapfly HTTP ${res.status}` }), { status: 502, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    const j = await res.json();
    const html = j?.result?.content || "";
    if (html.length < 2000) {
      return new Response(JSON.stringify({ error: "no usable content" }), { status: 502, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ html, url }), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error)?.message || "render failed" }), { status: 502, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
