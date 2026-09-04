// ── Manual review request: the third door when a listing will not read ───────
//
// A buyer whose scan failed can hand the listing to a human. This endpoint does
// exactly three things, in this order, and the ORDER is the point:
//
//   1. write the request to the ledger (fn_request_manual_review),
//   2. tell the buyer it is in,
//   3. try to notify support by email.
//
// The ledger write comes first because it is the only step that must not fail
// silently. If Resend is down, the row still exists, the queue still shows it,
// and the promise on the card -- a report within 24 hours -- is still keepable.
// An endpoint that emailed first and stored nothing would look identical to one
// that worked, right up until somebody asked how many requests we had missed.
//
// Rate limiting lives in SQL, not here, so it cannot be skipped by calling the
// function another way. [[email-relay-abuse-guard]]
//
// It is NOT an open relay: the only address it can ever send to is our own
// support inbox, hard-coded below. The buyer's address is stored so we can
// write back, and is never used as a destination by this function.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_ADDRESS = "LotCheck <reports@lotcheck.ca>";
// Hard-coded, and deliberately not configurable from the request body. The one
// destination this function is allowed to reach.
const SUPPORT_INBOX = "support@lotcheck.ca";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const esc = (s: string) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "not configured" }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid body" }, 400); }

  const listingUrl = String(body?.url ?? "").trim();
  const email = String(body?.email ?? "").trim();
  const errorMessage = String(body?.error ?? "").slice(0, 500);
  // Coarse and non-identifying: enough to spot a flood, not enough to track one
  // person. The real limit is per email address, enforced in SQL.
  const hint = (req.headers.get("user-agent") ?? "").slice(0, 200);

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  // 1. THE LEDGER FIRST. Nothing below this line may cost us the request.
  const { data, error } = await supabase.rpc("fn_request_manual_review", {
    p_url: listingUrl, p_email: email, p_error: errorMessage, p_client_hint: hint,
  });
  if (error) {
    console.error("manual review insert failed:", error.message);
    return json({ ok: false, reason: "we could not record that just now — please try again in a minute" }, 500);
  }
  if (!data?.ok) return json({ ok: false, reason: data?.reason ?? "that request was not accepted" }, 400);

  // 2. Tell the buyer. Said before the email is attempted, because the promise
  //    rests on the row, not on Resend.
  const responseBody = {
    ok: true,
    duplicate: data.duplicate === true,
    message: data.duplicate
      ? "That one is already in the queue — we are on it."
      : "In the queue. We will read this listing ourselves and email you the report within 24 hours.",
  };

  // 3. Notify support. Best effort, and its failure is logged, never surfaced
  //    as a failure to the buyer, because the request is already safe.
  if (RESEND_API_KEY) {
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: FROM_ADDRESS,
          to: [SUPPORT_INBOX],
          reply_to: email,
          subject: `Manual check request — ${listingUrl.slice(0, 80)}`,
          html:
            `<p><b>A buyer asked for a manual read.</b> The automatic scan did not work on this listing.</p>` +
            `<p><b>Listing:</b> <a href="${esc(listingUrl)}">${esc(listingUrl)}</a></p>` +
            `<p><b>Write back to:</b> ${esc(email)}</p>` +
            (errorMessage ? `<p><b>What the scan said:</b> ${esc(errorMessage)}</p>` : "") +
            `<p>${data.ahead ? `${data.ahead} request(s) ahead of this one.` : "Nothing ahead of it."} ` +
            `We told them: a report within 24 hours.</p>`,
        }),
      });
      if (!r.ok) console.warn("support notification failed:", r.status, (await r.text()).slice(0, 200));
    } catch (e) {
      console.warn("support notification threw:", (e as Error)?.message);
    }
  } else {
    console.warn("RESEND_API_KEY absent — request is in the ledger but support was not emailed.");
  }

  return json(responseBody);
});
