// supabase/functions/founder-statement/index.ts
//
// On the 1st of the month, emails each active founder what they owe: the total
// operating bill split by their share, with the two known due dates (the 8th,
// Claude subscription; the 10th, Scrapfly) so there is a week of notice before
// the first debit.
//
// TWO MODES, and the separation IS the safety property.
//
//   ?mode=stage  (what the cron calls) — computes the statement, writes it as
//                a pending_approval run, and MAILS NOBODY.
//   ?mode=send   — sends only a run Vic has explicitly approved in the admin
//                panel, claimed atomically so a double trigger cannot bill the
//                founders twice.
//
// Vic, 2026-08-14: "before you send, you need permission from me — because if
// our cost jumps we need to adjust invoices." The statement tells two other
// people what they owe; if a vendor bill moves between the 1st and the send, an
// automated statement bills JC and Josh the wrong amount, and a number sent to
// a co-founder has been acted on by the time anyone notices. There is no code
// path here that mails a founder without an approved run.
//
// Also refuses when the split does not add up: if active founder shares do not
// total 10000 bps, someone owes an unassigned remainder and the statement is
// arithmetically true but practically a lie. 409, sends nothing.
//
// Deploy: supabase functions deploy founder-statement
// Trigger: .github/workflows/founder-statement.yml (cron, 1st — STAGE only)
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
  // Outstanding balance, if the ledger stamped one at approval. This is the
  // number that actually gets invoiced: an unpaid earlier month carries
  // forward, so JC's September note is August + September, not September alone.
  const bal = (s.balances ?? []).find((b: any) => b.email === me.email);
  const owed = bal ? Number(bal.balance_cad) : Number(me.owes_cad);
  const carried = bal ? owed - Number(me.owes_cad) : 0;

  const ledgerRows = (bal?.lines ?? [])
    .filter((l: any) => Number(l.amount_cad) !== 0)
    .map((l: any) => {
      const paid = l.kind === "payment";
      const month = new Date(l.month + "T00:00:00").toLocaleDateString("en-CA", { month: "long", year: "numeric" });
      return `<tr>
        <td style="padding:5px 0;color:#5B5885;">${month}${paid ? " — payment" : ""}</td>
        <td style="padding:5px 0;text-align:right;color:${paid ? "#17756B" : "#33305A"};font-weight:600;">${money(Number(l.amount_cad))}</td>
      </tr>`;
    }).join("");

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
  const mode = url.searchParams.get("mode") ?? "stage";  // stage is the safe default
  const dryRun = url.searchParams.get("dry_run") === "true";

  const rpc = async (fn: string, body = "{}") => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body,
    });
    if (!r.ok) throw new Error(`${fn}: ${r.status} ${await r.text()}`);
    return await r.json();
  };

  // ---- STAGE: compute, record, mail nobody --------------------------------
  if (mode === "stage") {
    try {
      await rpc("fn_expire_stale_statements");
      const staged = await rpc("fn_stage_statement");
      console.log(`statement staged: ${JSON.stringify(staged)}`);
      return new Response(JSON.stringify({
        ok: true, mode: "stage", sent: 0,
        note: "Staged for approval. Nothing has been emailed — approve it in the admin panel to send.",
        ...staged,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    } catch (e) {
      console.error("stage failed:", e);
      return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500 });
    }
  }

  if (mode !== "send") return new Response("unknown mode", { status: 400 });

  // ---- SEND: only a run Vic approved --------------------------------------
  let claimed: any;
  try {
    claimed = await rpc("fn_claim_statement_for_send");
  } catch (e) {
    console.error("claim failed:", e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500 });
  }
  if (!claimed) {
    // The default state, and not an error: nothing is approved, so nothing sends.
    return new Response(JSON.stringify({
      ok: true, sent: 0,
      reason: "no approved statement waiting — approve one in the admin panel first",
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  const s = claimed.snapshot;

  if (!s?.shares_balanced) {
    const msg = `shares total ${s?.shares_total_bps ?? 0} bps across ${s?.active_founders ?? 0} active founder(s), not 10000 — refusing to send a split that does not account for the whole bill.`;
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
