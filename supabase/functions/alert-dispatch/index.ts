// MSRP Alerts — Phase B: dispatch alerts for a dealer-pushed candidate.
//
// Admin-triggered (from the admin panel). The caller's admin session JWT is
// forwarded to the admin-gated RPCs, so authorization is enforced in the DB
// (fn_is_admin) — this fn holds no elevated key. Flow: prepare the matched,
// CONFIRMED, not-yet-alerted buyers for a candidate -> email each -> mark sent.
// Idempotent: re-running only emails buyers not already in alert_dispatch.
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_ADDRESS = "LotCheck Alerts <alerts@lotcheck.ca>";
const SITE = "https://lotcheck.ca";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const money = (n: unknown) => (Number.isFinite(Number(n)) ? "$" + Math.round(Number(n)).toLocaleString("en-CA") : "");

function alertEmail(c: any, r: any): string {
  const vehicle = [r.year || c.year, c.make, c.model || r.model].filter(Boolean).join(" ");
  const price = c.price ? ` for <b style="color:#fff">${money(c.price)}</b>` : "";
  const badge = c.below_msrp ? "below MSRP" : "at MSRP";
  const unsub = `${SITE}/alert-confirm?unsub=${encodeURIComponent(r.unsub_token || "")}`;
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto">
    <div style="background:#0b0b1e;border-radius:16px;padding:26px 24px;color:#eaf0ff">
      <div style="font:800 12px ui-monospace,monospace;letter-spacing:.2em;color:#3ae0ff;text-transform:uppercase">LotCheck · MSRP Alert</div>
      <h1 style="font-size:22px;margin:12px 0 8px;color:#fff">A ${esc(vehicle)} is ${badge} in ${esc(c.city)}</h1>
      <p style="font-size:15px;line-height:1.6;color:#c7cee6;margin:0 0 8px">${esc(c.dealer || "A dealer")} is offering it${price}. This is the car you asked us to watch.</p>
      <p style="font-size:14px;line-height:1.6;color:#c7cee6;margin:0 0 18px">Before you go in, run the quote through LotCheck so the out-the-door price stays honest — no add-ons dressed up as fees.</p>
      <a href="${SITE}/quote-check" style="display:inline-block;background:#3ae0ff;color:#04121a;font-weight:800;font-size:15px;text-decoration:none;padding:13px 26px;border-radius:11px">Check the deal →</a>
      <p style="font-size:11px;color:#8a92b4;margin:20px 0 0;line-height:1.5">You confirmed MSRP alerts for this vehicle on lotcheck.ca. <a href="${esc(unsub)}" style="color:#9aa2c4">Unsubscribe</a>.</p>
    </div>
  </div>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return json({ ok: false, error: "admin auth required" }, 401);
  try {
    const { candidate_id } = await req.json();
    if (!candidate_id) return json({ ok: false, error: "candidate_id required" }, 400);
    const rpc = (fn: string, args: unknown) => fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST", headers: { apikey: ANON, Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify(args),
    });

    const prep = await rpc("fn_admin_dispatch_prepare", { p_candidate: candidate_id });
    const data = await prep.json().catch(() => null);
    if (!prep.ok) return json({ ok: false, error: data?.message || "not authorized" }, prep.status === 200 ? 400 : prep.status);
    const c = data.candidate, recipients: any[] = data.recipients || [];
    if (!RESEND_API_KEY) return json({ ok: false, error: "email is not configured (RESEND_API_KEY)", matched: recipients.length }, 400);

    let sent = 0, failed = 0;
    for (const r of recipients) {
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST", headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: FROM_ADDRESS, to: [r.email], subject: `${[c.year, c.make, c.model].filter(Boolean).join(" ")} — ${c.below_msrp ? "below" : "at"} MSRP in ${c.city}`, html: alertEmail(c, r) }),
        });
        if (res.ok) { await rpc("fn_admin_dispatch_mark", { p_sub: r.id, p_candidate: candidate_id }); sent++; }
        else failed++;
      } catch { failed++; }
    }
    return json({ ok: true, matched: recipients.length, sent, failed });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 400);
  }
});
