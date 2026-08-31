// IS EVERY VENDOR KEY STILL ALIVE? Asked from inside production, where they live.
//
// WHY THIS EXISTS. Vic, 2026-08-31, after learning the Scrapfly key had been
// returning 401 for an unknown period: "i need daily checks 6am everty making
// sure all API Keys still running it will great to know when they expire so i
// can reset then all".
//
// The vendor keys a BUYER depends on are Supabase function secrets. Nothing
// outside this runtime can read them, so nothing outside could ever answer
// "does it still work" -- and the code that thought it was answering was really
// checking whether the variable was non-empty:
//
//     export function scrapflyEnabled() { return !!SCRAPFLY_API_KEY }
//
// A rejected key is "enabled" by that test. It stayed green while the anti-bot
// render -- the fallback for the ~28% of Alberta dealer hosts that refuse our
// datacenter IP -- returned null on every one of them, which a buyer sees as
// "we could not read this page" and cannot tell from a page that was empty.
// A green signal with no check behind it. [[no-single-point-of-failure]]
//
// WHAT IT DOES. One cheap authenticated call per vendor, reporting the status
// the vendor gave back. Presence is reported separately from health, because
// "not configured" and "configured but rejected" need different fixes.
//
// WHAT IT NEVER DOES. Return, log or echo a key value, or any prefix of one.
// The response carries verdicts and vendor-supplied detail only. A health
// endpoint that leaks the thing it is checking is worse than no endpoint.
//
// LOCKED DOWN the same way render-page is: service-role JWT required. The
// signature is verified by Supabase's gateway before this code runs, so
// checking the role claim is both safe and immune to key rotation.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function isServiceRole(token: string): boolean {
  try {
    const payload = token.split(".")[1];
    if (!payload) return false;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "="));
    return JSON.parse(json)?.role === "service_role";
  } catch { return false; }
}

type State = "working" | "rejected" | "absent" | "unclear";
interface Verdict {
  key: string;
  vendor: string;
  state: State;
  detail: string;
  /** ISO date when the credential stops working, when the vendor publishes one. */
  expiresAt?: string | null;
  /** Whether an expiry is knowable at all -- so "unknown" is never read as "never". */
  expiryKnown: boolean;
  /** True when a buyer's report degrades if this key is dead. */
  buyerFacing: boolean;
}

const TIMEOUT = 20_000;

/** Map an HTTP status onto a verdict. 401/403 mean the key; anything else does not. */
function fromStatus(status: number, okDetail: string): { state: State; detail: string } {
  if (status >= 200 && status < 300) return { state: "working", detail: okDetail };
  if (status === 401 || status === 403) return { state: "rejected", detail: `vendor answered HTTP ${status}` };
  if (status === 402) return { state: "rejected", detail: "HTTP 402 - payment required / quota exhausted" };
  // A 429 or a 5xx says the vendor is busy or broken. It is NOT evidence about
  // the key, and reporting it as a dead key would send Vic to rotate a
  // credential that was fine. [[absence-read-as-knowledge]]
  return { state: "unclear", detail: `HTTP ${status} - not a verdict on the key` };
}

async function check(
  name: string, vendor: string, buyerFacing: boolean,
  run: () => Promise<{ state: State; detail: string; expiresAt?: string | null; expiryKnown?: boolean }>,
): Promise<Verdict> {
  const raw = (Deno.env.get(name) || "").trim();
  if (!raw) {
    return { key: name, vendor, state: "absent", detail: "not configured in this project", expiryKnown: false, buyerFacing };
  }
  try {
    const r = await run();
    return { key: name, vendor, state: r.state, detail: r.detail, expiresAt: r.expiresAt ?? null, expiryKnown: r.expiryKnown ?? false, buyerFacing };
  } catch (e) {
    const m = String((e as Error)?.name || (e as Error)?.message || "").slice(0, 60);
    return { key: name, vendor, state: "unclear", detail: `could not reach vendor: ${m}`, expiryKnown: false, buyerFacing };
  }
}

const env = (n: string) => (Deno.env.get(n) || "").trim();

/**
 * Supabase keys are JWTs and carry a real `exp`. These are the ONLY credentials
 * here with a published expiry, which is worth saying out loud: for the rest,
 * "no expiry published" is the honest answer and an invented date would be
 * worse than none. [[present-without-creating-questions]]
 */
function jwtExpiry(token: string): string | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "="));
    const exp = JSON.parse(json)?.exp;
    return typeof exp === "number" ? new Date(exp * 1000).toISOString() : null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!isServiceRole(token)) {
    return new Response(JSON.stringify({ error: "forbidden: service-role token required" }),
      { status: 403, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  const checks = await Promise.all([
    // Scrapfly -- the account endpoint costs no scrape credit, unlike /scrape.
    check("SCRAPFLY_API_KEY", "Scrapfly", true, async () => {
      const u = new URL("https://api.scrapfly.io/account");
      u.searchParams.set("key", env("SCRAPFLY_API_KEY"));
      const r = await fetch(u, { signal: AbortSignal.timeout(TIMEOUT) });
      if (!r.ok) return fromStatus(r.status, "");
      const j = await r.json().catch(() => null);
      const used = j?.subscription?.usage?.scrape?.current;
      const limit = j?.subscription?.usage?.scrape?.limit;
      const suspended = j?.account?.suspended === true;
      // A suspended account accepts the key and serves nothing. Reporting that
      // as "working" is the same false all-clear this whole endpoint exists to
      // remove.
      if (suspended) return { state: "rejected" as State, detail: "account SUSPENDED - key is valid but nothing will render" };
      return {
        state: "working" as State,
        detail: used != null && limit != null ? `${used}/${limit} credits used this period` : "accepted",
        // Scrapfly publishes a billing PERIOD end, not a key expiry. Naming it
        // exactly is the difference between useful and misleading.
        expiresAt: null, expiryKnown: false,
      };
    }),

    // Anthropic -- a 1-token call is the cheapest way to make it authenticate.
    check("ANTHROPIC_API_KEY", "Anthropic", true, async () => {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env("ANTHROPIC_API_KEY"),
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: env("ANTHROPIC_MODEL") || "claude-haiku-4-5-20251001",
          max_tokens: 1,
          messages: [{ role: "user", content: "." }],
        }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      // A 400 here means the request shape was wrong, not the key -- the key was
      // accepted to get that far.
      if (r.status === 400) return { state: "working" as State, detail: "authenticated (400 on the probe body, not the key)" };
      return fromStatus(r.status, "authenticated");
    }),

    check("RESEND_API_KEY", "Resend", true, async () => {
      const r = await fetch("https://api.resend.com/domains", {
        headers: { authorization: `Bearer ${env("RESEND_API_KEY")}` },
        signal: AbortSignal.timeout(TIMEOUT),
      });
      return fromStatus(r.status, "authenticated");
    }),

    check("NIMBLE_API_KEY", "Nimble", true, async () => {
      const r = await fetch("https://api.webit.live/api/v1/realtime/web", {
        method: "POST",
        headers: { authorization: `Basic ${env("NIMBLE_API_KEY")}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com", render: false }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      return fromStatus(r.status, "authenticated");
    }),

    check("GOOGLE_PLACES_API_KEY", "Google Places", true, async () => {
      const u = new URL("https://maps.googleapis.com/maps/api/place/findplacefromtext/json");
      u.searchParams.set("input", "Calgary");
      u.searchParams.set("inputtype", "textquery");
      u.searchParams.set("fields", "place_id");
      u.searchParams.set("key", env("GOOGLE_PLACES_API_KEY"));
      const r = await fetch(u, { signal: AbortSignal.timeout(TIMEOUT) });
      if (!r.ok) return fromStatus(r.status, "");
      const j = await r.json().catch(() => null);
      // Google answers 200 with a status field. REQUEST_DENIED is the key.
      const st = String(j?.status || "");
      if (st === "REQUEST_DENIED") return { state: "rejected" as State, detail: String(j?.error_message || "REQUEST_DENIED").slice(0, 120) };
      if (st === "OVER_QUERY_LIMIT") return { state: "rejected" as State, detail: "OVER_QUERY_LIMIT - billing or quota" };
      if (st === "OK" || st === "ZERO_RESULTS") return { state: "working" as State, detail: `accepted (${st})` };
      return { state: "unclear" as State, detail: `Places status ${st || "(none)"}` };
    }),

    // The Supabase keys are JWTs: these are the only ones with a real expiry,
    // and the only ones Vic can actually plan a rotation around.
    check("SUPABASE_SERVICE_ROLE_KEY", "Supabase", true, async () => {
      const exp = jwtExpiry(env("SUPABASE_SERVICE_ROLE_KEY"));
      const r = await fetch(`${env("SUPABASE_URL")}/rest/v1/`, {
        headers: { apikey: env("SUPABASE_SERVICE_ROLE_KEY"), authorization: `Bearer ${env("SUPABASE_SERVICE_ROLE_KEY")}` },
        signal: AbortSignal.timeout(TIMEOUT),
      });
      const base = fromStatus(r.status, "accepted by PostgREST");
      return { ...base, expiresAt: exp, expiryKnown: exp !== null };
    }),

    check("SUPABASE_ANON_KEY", "Supabase", true, async () => {
      const exp = jwtExpiry(env("SUPABASE_ANON_KEY"));
      const r = await fetch(`${env("SUPABASE_URL")}/rest/v1/`, {
        headers: { apikey: env("SUPABASE_ANON_KEY") },
        signal: AbortSignal.timeout(TIMEOUT),
      });
      const base = fromStatus(r.status, "accepted by PostgREST");
      return { ...base, expiresAt: exp, expiryKnown: exp !== null };
    }),
  ]);

  // Shared secrets we sign or verify with. There is no vendor to ask, so the
  // only honest verdict is present / absent -- reported as its own state so it
  // is never mistaken for a checked one.
  const shared = ["STATEMENT_SECRET", "REGION_TOKEN_SECRET", "INVOICE_INGEST_SECRET", "RESEND_WEBHOOK_SECRET"]
    .map((name) => ({
      key: name,
      vendor: "internal",
      state: (env(name) ? "present-unverifiable" : "absent") as State | "present-unverifiable",
      detail: env(name) ? "set; no vendor can confirm it - correctness shows up only in use" : "not configured",
      expiryKnown: false,
      buyerFacing: false,
    }));

  const unhealthy = checks.filter((c) => c.state === "rejected" || (c.buyerFacing && c.state === "absent"));
  return new Response(JSON.stringify({
    checkedAt: new Date().toISOString(),
    healthy: unhealthy.length === 0,
    unhealthy: unhealthy.map((c) => c.key),
    vendors: checks,
    shared,
  }, null, 2), { headers: { ...CORS, "Content-Type": "application/json" } });
});
