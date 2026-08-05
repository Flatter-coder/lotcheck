// MSRP Alerts — Phase B: subscribe + send the CASL double-opt-in confirmation.
//
// The public /msrp-alerts page POSTs here. We call the existing (anon) RPC
// fn_alert_subscribe to record the waitlist row + get its confirm_token, then
// email a one-click confirmation link. Only after the buyer confirms
// (fn_alert_confirm) does status become 'confirmed' — and only 'confirmed' rows
// are ever sent an actual alert. Requires RESEND_API_KEY (same secret + verified
// lotcheck.ca domain already used by email-quote-report). Nothing is stored here.
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
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function confirmEmail(vehicle: string, city: string, link: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#1a1a2e">
    <div style="background:#0b0b1e;border-radius:16px;padding:26px 24px;color:#eaf0ff">
      <div style="font:800 12px ui-monospace,monospace;letter-spacing:.2em;color:#3ae0ff;text-transform:uppercase">LotCheck · MSRP Alerts</div>
      <h1 style="font-size:22px;margin:12px 0 8px;color:#fff">Confirm your MSRP alert</h1>
      <p style="font-size:15px;line-height:1.6;color:#c7cee6;margin:0 0 18px">One click and you're set. We'll email you when a <b style="color:#fff">${esc(vehicle)}</b> is offered at or below MSRP in <b style="color:#fff">${esc(city)}</b>.</p>
      <a href="${esc(link)}" style="display:inline-block;background:#3ae0ff;color:#04121a;font-weight:800;font-size:15px;text-decoration:none;padding:13px 26px;border-radius:11px">Confirm my alert</a>
      <p style="font-size:12px;color:#8a92b4;margin:20px 0 0;line-height:1.5">You're getting this because you asked for MSRP alerts on lotcheck.ca. If it wasn't you, ignore this email — nothing happens until you confirm. Live tracking is rolling out city by city in Alberta.</p>
    </div>
    <p style="font-size:11px;color:#9aa2c4;text-align:center;margin:14px 0 0">LotCheck · Alberta, Canada</p>
  </div>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  try {
    const b = await req.json();
    // 1) Record the subscription (anon RPC does all validation + CASL gate).
    const rpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/fn_alert_subscribe`, {
      method: "POST",
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        p_email: b.email, p_make: b.make, p_model: b.model, p_year: b.year ?? null,
        p_province: b.province ?? null, p_city: b.city ?? null,
        p_threshold: b.threshold || "at_msrp", p_pct: b.pct ?? null, p_consent: b.consent === true,
      }),
    });
    const data = await rpc.json().catch(() => null);
    if (!rpc.ok) return json({ ok: false, error: (data?.message) || "Couldn't save that." }, 400);

    // 2) Send the confirmation email (best-effort; the row is already saved).
    const token = data?.confirm_token;
    let emailed = false;
    if (RESEND_API_KEY && token && b.email) {
      const link = `${SITE}/alert-confirm?token=${encodeURIComponent(token)}`;
      const vehicle = [b.year, b.make, b.model].filter(Boolean).join(" ") || `${b.make || ""} ${b.model || ""}`.trim();
      try {
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: FROM_ADDRESS, to: [b.email], subject: "Confirm your MSRP alert", html: confirmEmail(vehicle, b.city || "your city", link) }),
        });
        emailed = r.ok;
      } catch { /* email is best-effort; the waitlist row is saved regardless */ }
    }
    return json({ ok: true, emailed });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 400);
  }
});
