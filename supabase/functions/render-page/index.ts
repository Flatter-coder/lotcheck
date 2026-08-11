// Render a manufacturer page and return its HTML.
//
// WHY THIS EXISTS. The published-MSRP capture needs a JS-rendered page, and the
// Scrapfly key already lives here as a Supabase secret. Copying that key into
// GitHub Actions would mean two places to rotate and two places to leak, so the
// CI job calls this instead using the Supabase service-role key it already has.
//
// LOCKED DOWN, deliberately -- an open render endpoint is an open proxy and a
// way to burn our Scrapfly credits:
//   * service-role bearer token required (constant-time compared)
//   * host allowlist: manufacturer sites only, nothing else renders
//   * POST only, one URL per call

const SCRAPFLY_API_KEY = Deno.env.get("SCRAPFLY_API_KEY") || "";

// Supabase deprecated SUPABASE_SERVICE_ROLE_KEY in favour of secret keys, so
// the value CI sends and the value this function reads can legitimately differ.
// Accept the token if it matches ANY configured privileged key; a comma/JSON
// list (SUPABASE_SECRET_KEYS) is split so each entry is checked.
const KEY_VARS = ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS", "SUPABASE_SECRET_KEY", "SB_SECRET_KEY"];
function privilegedKeys(): string[] {
  const out: string[] = [];
  for (const name of KEY_VARS) {
    const raw = (Deno.env.get(name) || "").trim();
    if (!raw) continue;
    if (raw.startsWith("[") || raw.startsWith("{")) {
      try {
        const parsed = JSON.parse(raw);
        for (const v of (Array.isArray(parsed) ? parsed : Object.values(parsed))) {
          const k = typeof v === "string" ? v : (v as any)?.api_key || (v as any)?.key;
          if (typeof k === "string" && k.length > 20) out.push(k.trim());
        }
        continue;
      } catch { /* fall through to plain split */ }
    }
    for (const k of raw.split(/[,\s]+/)) if (k.length > 20) out.push(k.trim());
  }
  return out;
}
function configuredNames(): string[] {
  return KEY_VARS.filter((n) => (Deno.env.get(n) || "").trim().length > 0);
}

// Manufacturer domains whose own published prices we read. Nothing else is
// renderable through this endpoint -- notably no dealer sites, so it can never
// become a general-purpose scraping proxy.
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

// Constant-time-ish comparison so a token can't be probed byte by byte.
function sameSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const keys = privilegedKeys();
  if (!keys.length || !keys.some((k) => sameSecret(token, k))) {
    // Names only, never values -- enough to diagnose a key-rotation mismatch
    // without turning an auth failure into a credential leak.
    return new Response(JSON.stringify({ error: "forbidden", configured: configuredNames() }), { status: 403, headers: { ...CORS, "Content-Type": "application/json" } });
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
