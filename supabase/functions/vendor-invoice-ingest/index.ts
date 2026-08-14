// supabase/functions/vendor-invoice-ingest/index.ts
//
// Receives a forwarded vendor invoice email, parses the money out of it, and
// STAGES it against the matching operational_cost line. Applying is a separate,
// deliberate admin click — see the migration header for why.
//
// AUTH. A shared secret in the X-Invoice-Secret header (INVOICE_INGEST_SECRET),
// compared in constant time. This endpoint changes what LotCheck believes it
// spends, so it is not open. The secret is the gate, not the sender address:
// a FORWARDED email carries the forwarder's envelope, so the From header proves
// nothing and is recorded as a hint, never as authorisation.
//
// WIRING (one of):
//   a) Cloudflare Email Routing — free, route invoices@lotcheck.ca to a Worker
//      that POSTs {from, subject, text} here with the secret header.
//   b) Any inbound-email provider that can POST a webhook (Postmark, SendGrid
//      inbound parse, Resend inbound where available).
// The endpoint is deliberately provider-agnostic: it takes normalised JSON, so
// swapping the mail plumbing never touches this function.
//
// Deploy: supabase functions deploy vendor-invoice-ingest --no-verify-jwt
// Secret: supabase secrets set INVOICE_INGEST_SECRET=<random>

const INGEST_SECRET = Deno.env.get("INVOICE_INGEST_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

function constantTimeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

type Parsed = {
  vendor: string;
  invoiceNo: string | null;
  amount: number | null;
  currency: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  paidAt: string | null;
  note: string;
};

// Deliberately conservative. A parser that guesses produces a confident wrong
// number, and a confident wrong number in a cost panel is the failure mode this
// whole design is built to avoid. Anything it cannot read stays null and the
// admin sees "could not parse" beside the raw subject.
function parseInvoice(from: string, subject: string, body: string): Parsed {
  const hay = `${subject}\n${body}`;
  const lower = `${from} ${hay}`.toLowerCase();

  const vendor = lower.includes("anthropic") ? "anthropic"
               : lower.includes("scrapfly") ? "scrapfly"
               : lower.includes("nimble") ? "nimble"
               : "other";

  // Money. Handles "CA$294.00", "$30.00 USD", "US$50.00". Currency is only
  // asserted when the text actually says so — an unlabelled "$" is ambiguous
  // between CAD and USD and is left null rather than assumed.
  let amount: number | null = null;
  let currency: string | null = null;
  const m =
    hay.match(/\bCA\$\s*([\d,]+\.\d{2})/i) ??
    hay.match(/\bUS\$\s*([\d,]+\.\d{2})/i) ??
    hay.match(/\$\s*([\d,]+\.\d{2})\s*(USD|CAD)\b/i) ??
    hay.match(/\b(?:total|amount due|amount paid)\b[^\d]{0,20}\$?\s*([\d,]+\.\d{2})/i);
  if (m) {
    amount = Number(m[1].replace(/,/g, ""));
    if (/CA\$/i.test(m[0])) currency = "CAD";
    else if (/US\$/i.test(m[0])) currency = "USD";
    else if (m[2]) currency = m[2].toUpperCase();
  }

  // Invoice number: Anthropic NA6DBMZO-0004, Scrapfly X3J1RQES-0001.
  const inv = hay.match(/#?\b([A-Z0-9]{6,10}-\d{3,5})\b/);

  // Period: "Period: 2026-08-10 - 2026-09-10"
  const per = hay.match(/(\d{4}-\d{2}-\d{2})\s*(?:-|–|to)\s*(\d{4}-\d{2}-\d{2})/);

  // Paid date: "Payment date  August 8, 2026" or an ISO date.
  let paidAt: string | null = null;
  const iso = hay.match(/\b(?:payment date|paid on|paid)\b[^\d]{0,20}(\d{4}-\d{2}-\d{2})/i);
  const longD = hay.match(/\b(?:payment date|paid on|paid)\b[^A-Za-z]{0,20}([A-Z][a-z]+ \d{1,2},? \d{4})/);
  if (iso) paidAt = iso[1];
  else if (longD) {
    const d = new Date(longD[1]);
    if (!isNaN(d.getTime())) paidAt = d.toISOString().slice(0, 10);
  }

  const missing: string[] = [];
  if (vendor === "other") missing.push("vendor");
  if (amount == null) missing.push("amount");
  if (currency == null) missing.push("currency");

  return {
    vendor,
    invoiceNo: inv ? inv[1] : null,
    amount,
    currency,
    periodStart: per ? per[1] : null,
    periodEnd: per ? per[2] : null,
    paidAt,
    note: missing.length ? `could not parse: ${missing.join(", ")}` : "parsed cleanly",
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const supplied = req.headers.get("x-invoice-secret") ?? "";
  if (!INGEST_SECRET || !constantTimeEqual(supplied, INGEST_SECRET)) {
    // Same response either way — an attacker learns nothing about whether the
    // secret is merely wrong or not configured at all.
    console.warn("vendor-invoice-ingest: rejected (bad or missing secret)");
    return new Response("forbidden", { status: 403 });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const from = String(payload?.from ?? "").slice(0, 200);
  const subject = String(payload?.subject ?? "").slice(0, 300);
  const body = String(payload?.text ?? payload?.body ?? "").slice(0, 20000);
  if (!subject && !body) return new Response("empty message", { status: 400 });

  const p = parseInvoice(from, subject, body);

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/fn_ingest_vendor_invoice`, {
      method: "POST",
      headers: {
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_vendor: p.vendor,
        p_invoice_no: p.invoiceNo,
        p_amount: p.amount,
        p_currency: p.currency,
        p_period_start: p.periodStart,
        p_period_end: p.periodEnd,
        p_paid_at: p.paidAt,
        p_from: from,
        p_subject: subject,
        p_parse_note: p.note,
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      console.error("invoice ingest insert failed:", res.status, await res.text());
      return new Response("ingest failed", { status: 500 });
    }
    const id = await res.json();
    // A null id means the unique index caught a re-forward of the same invoice.
    console.log(`invoice staged: vendor=${p.vendor} no=${p.invoiceNo} amount=${p.amount} ${p.currency} (${p.note})${id ? "" : " [duplicate, ignored]"}`);
    return new Response(JSON.stringify({ ok: true, staged: !!id, duplicate: !id, parsed: p }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("invoice ingest threw:", e);
    return new Response("ingest failed", { status: 500 });
  }
});
