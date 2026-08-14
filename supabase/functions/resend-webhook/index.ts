// supabase/functions/resend-webhook/index.ts
//
// Receives Resend delivery events (delivered / bounced / complained / opened)
// and appends them to the delivery ledger. This is the half of the proof we
// cannot generate ourselves: our own row says we handed the message to Resend;
// only Resend can say the receiving server accepted it.
//
// EVIDENCE WEIGHT — this matters more than the plumbing:
//   delivered   STRONG. The receiving mail server accepted the message. It does
//               NOT prove inbox vs junk, and it does not prove a human read it.
//   bounced     STRONG. Hard evidence of non-delivery, with the reason.
//   complained  STRONG, and proves receipt — you cannot mark as spam a message
//               you never got.
//   opened      WEAK, AND NOT EVIDENCE IN EITHER DIRECTION. Image blocking
//               suppresses opens; Apple Mail Privacy Protection manufactures
//               them. It is recorded for curiosity and rendered greyed out in
//               the admin panel. Never argue a dispute from an open, and never
//               argue from the ABSENCE of one.
//
// SECURITY. Resend signs with Svix. An unsigned or badly-signed event is
// recorded with sig_verified=false rather than dropped, so an attempt to forge
// delivery proof shows up in the panel's quarantined count instead of
// vanishing. Set RESEND_WEBHOOK_SECRET (the `whsec_...` value from the Resend
// dashboard) on this function.
//
// Deploy:  supabase functions deploy resend-webhook --no-verify-jwt
// (--no-verify-jwt is required: Resend cannot present a Supabase JWT. The Svix
// signature is the auth, which is why the secret must be set before enabling
// the endpoint in Resend.)

const WEBHOOK_SECRET = Deno.env.get("RESEND_WEBHOOK_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Resend event names -> our ledger kinds. Anything not listed is ignored.
const KIND_MAP: Record<string, string> = {
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.opened": "opened",
};

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Svix signature scheme: HMAC-SHA256 over `${id}.${timestamp}.${body}`, keyed
// by the secret's base64 payload, compared against any of the space-separated
// `v1,<sig>` entries in svix-signature.
async function verifySvix(raw: string, headers: Headers): Promise<boolean> {
  if (!WEBHOOK_SECRET) return false;
  const id = headers.get("svix-id");
  const ts = headers.get("svix-timestamp");
  const sigHeader = headers.get("svix-signature");
  if (!id || !ts || !sigHeader) return false;

  // Replay window. Svix's own tolerance is 5 minutes; matching it means a
  // captured-and-replayed event can't be injected an hour later.
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) return false;

  const keyBytes = b64ToBytes(WEBHOOK_SECRET.replace(/^whsec_/, ""));
  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${raw}`)),
  );

  for (const part of sigHeader.split(" ")) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    try {
      if (timingSafeEqual(mac, b64ToBytes(sig))) return true;
    } catch { /* malformed signature entry — try the next */ }
  }
  return false;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const raw = await req.text();
  const verified = await verifySvix(raw, req.headers);

  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const kind = KIND_MAP[event?.type];
  const msgId = event?.data?.email_id ?? event?.data?.id ?? null;
  // An event we can't map or can't correlate is dropped rather than stored
  // uncorrelated — a delivered event with no message id proves nothing about
  // any particular send, and would only inflate the counts.
  if (!kind || typeof msgId !== "string" || !msgId) {
    return new Response(JSON.stringify({ ok: true, ignored: true }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }

  // Detail is deliberately narrow: the bounce reason, never the recipient.
  // Resend's payload contains the address; we do not copy it into the ledger.
  const detail = typeof event?.data?.reason === "string"
    ? event.data.reason.slice(0, 500)
    : (typeof event?.data?.bounce?.message === "string" ? event.data.bounce.message.slice(0, 500) : null);

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/fn_record_delivery_webhook`, {
      method: "POST",
      headers: {
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_provider_msg_id: msgId,
        p_kind: kind,
        p_sig_verified: verified,
        p_detail: detail,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      // 5xx so Svix retries — a dropped delivery event is a hole in the record.
      console.error("ledger webhook insert failed:", res.status, await res.text());
      return new Response("ledger write failed", { status: 500 });
    }
  } catch (e) {
    console.error("ledger webhook insert threw:", e);
    return new Response("ledger write failed", { status: 500 });
  }

  if (!verified) {
    console.warn(`UNVERIFIED webhook recorded (kind=${kind}, msg=${msgId}) — check RESEND_WEBHOOK_SECRET, or someone is forging delivery proof.`);
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
});
