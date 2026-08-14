// supabase/functions/founder-statement/index.ts
//
// On the 1st of the month, emails each active founder what they owe: the total
// operating bill split by their share, with the two known due dates (the 8th,
// Claude subscription; the 10th, Scrapfly) so there is a week of notice before
// the first debit.
//
// REFUSES TO SEND when the split does not add up. While JC's and Josh's real
// addresses are missing they sit inactive in the founder table, so the active
// shares total 3334 bps instead of 10000. Sending then would tell Vic he owes
// CA$138 of a CA$414 bill with nobody assigned the rest — a statement that is
// arithmetically true and practically a lie. It returns 409 and sends nothing
// until all three are active.
//
// Deploy: supabase functions deploy founder-statement
// Trigger: .github/workflows/founder-statement.yml (cron, 1st of the month)
// Auth:    STATEMENT_SECRET header — this sends mail, so it is not open.

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const STATEMENT_SECRET = Deno.env.get("STATEMENT_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const FROM_ADDRESS = "LotCheck <reports@lotcheck.ca>";

function constantTimeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let d = 0;
  for (let i = 0; i < ea.length; i++) d |= ea[i] ^ eb[i];
  return d === 0;
}

const money = (n: number) =>
  `CA$${Number(n).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function buildHtml(s: any, me: any): string {
  const due = (s.due_dates ?? [])
    .map((d: any) => `<tr>
      <td style="padding:6px 0;color:#5B5885;">${d.day}${d.day === 1 ? "st" : d.day === 2 ? "nd" : d.day === 3 ? "rd" : "th"} — ${d.label}</td>
      <td style="padding:6px 0;text-align:right;color:#33305A;font-weight:600;">${money(d.cad)}</td>
    </tr>`).join("");

  const others = (s.founders ?? [])
    .filter((f: any) => f.email !== me.email)
    .map((f: any) => `${f.name} ${money(f.owes_cad)}`).join(" · ");

  return `<!doctype html><html><body style="margin:0;background:#FBF5EC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:28px 20px;">
    <div style="font-size:19px;font-weight:800;color:#33305A;">LotCheck — ${s.month}</div>
    <div style="font-size:13px;color:#5B5885;margin-top:4px;">Operating costs, split ${s.active_founders} ways</div>

    <div style="background:#fff;border:1px solid rgba(51,48,90,.12);border-radius:14px;padding:18px 20px;margin:18px 0;">
      <div style="font-size:11px;font-weight:800;letter-spacing:1px;color:#706D96;">YOUR SHARE</div>
      <div style="font-size:34px;font-weight:800;color:#17756B;letter-spacing:-1px;margin:6px 0 2px;">${money(me.owes_cad)}</div>
      <div style="font-size:12px;color:#706D96;">of ${money(s.monthly_total_cad)} total${others ? ` · ${others}` : ""}</div>
    </div>

    <div style="font-size:11px;font-weight:800;letter-spacing:1px;color:#706D96;margin-bottom:6px;">WHEN IT LEAVES THE ACCOUNT</div>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">${due}</table>

    <div style="font-size:12px;color:#706D96;line-height:1.7;margin-top:18px;border-top:1px solid rgba(51,48,90,.12);padding-top:14px;">
      USD vendor lines are converted at the rate the card actually bills, not mid-market, so this is
      what really leaves the account. Figures come from the admin panel's operational cost table —
      if a plan changes, update it there and next month's statement follows automatically.
    </div>
  </div></body></html>`;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const supplied = req.headers.get("x-statement-secret") ?? "";
  if (!STATEMENT_SECRET || !constantTimeEqual(supplied, STATEMENT_SECRET)) {
    return new Response("forbidden", { status: 403 });
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "true";

  // Statement
  const sres = await fetch(`${SUPABASE_URL}/rest/v1/rpc/fn_founder_statement`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!sres.ok) {
    console.error("statement rpc failed:", sres.status, await sres.text());
    return new Response("statement failed", { status: 500 });
  }
  const s = await sres.json();

  // The refusal that matters. See the header.
  if (!s?.shares_balanced) {
    const msg = `shares total ${s?.shares_total_bps ?? 0} bps across ${s?.active_founders ?? 0} active founder(s), not 10000 — refusing to send a split that does not account for the whole bill. Add the missing founders' real addresses and set active = true.`;
    console.error(msg);
    return new Response(JSON.stringify({ ok: false, sent: 0, reason: msg, statement: s }), {
      status: 409, headers: { "Content-Type": "application/json" },
    });
  }

  if (dryRun) {
    return new Response(JSON.stringify({ ok: true, dry_run: true, sent: 0, statement: s }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  if (!RESEND_API_KEY) return new Response("RESEND_API_KEY not set", { status: 500 });

  let sent = 0;
  const failures: string[] = [];
  for (const f of s.founders ?? []) {
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: FROM_ADDRESS,
          to: [f.email],
          subject: `LotCheck ${s.month} — your share is ${money(f.owes_cad)}`,
          html: buildHtml(s, f),
        }),
      });
      if (r.ok) sent++;
      else failures.push(`${f.name}: ${r.status} ${await r.text()}`);
    } catch (e) {
      failures.push(`${f.name}: ${e}`);
    }
  }

  if (failures.length) console.error("statement send failures:", failures.join(" | "));
  return new Response(JSON.stringify({ ok: failures.length === 0, sent, failures }), {
    status: failures.length ? 207 : 200, headers: { "Content-Type": "application/json" },
  });
});
