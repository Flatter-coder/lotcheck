// supabase/functions/email-quote-report/index.ts
//
// Sends a Quote Check analysis to the address the buyer entered on the
// results screen. Takes the already-computed `analysis` object from the
// client (the same one already rendered on screen) rather than re-running
// the quote through Claude a second time -- cheaper, faster, and there's
// no reason to redo work that's already done.
//
// The report itself is never persisted: the analysis, the PDF bytes, the
// capture, and the recipient's address all live only in this request's memory
// -- which is what keeps Quote Check's "analyzed once, never stored" and
// "not saved on our end" lines literally true.
//
// What IS persisted, since 2026-08-14, is a delivery LEDGER: one row per send
// attempt recording the SHA-256 of the PDF we handed to Resend, its byte
// length, the recipient's DOMAIN (never the address, and never a hash of it),
// and Resend's message id. That is enough to answer the only two disputes that
// happen -- "you never sent it" and "you sent the wrong file" -- and it holds
// nothing about the person or the vehicle. See
// supabase/migrations/20260814_report_delivery.sql for what is deliberately
// absent and why. Ledger writes are FAIL-OPEN: a database problem must never
// stop a buyer receiving their report.
//
// Requires a RESEND_API_KEY secret set on this function (see deployment
// notes below). Uses Resend (resend.com) -- a transactional email API,
// not a marketing/newsletter tool, which is the right category for a
// one-off "here's your report" send like this.

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
// Must be an address on a domain you've verified in Resend (Resend
// dashboard -> Domains -> Add Domain -> add the DNS records they give you
// at your domain registrar). Until that's done, sends will fail -- Resend
// won't let you send "from" a domain it hasn't confirmed you control.
const FROM_ADDRESS = "LotCheck <reports@lotcheck.ca>";

// ── Delivery ledger ─────────────────────────────────────────────────────────
// Bump when anything changes that could alter the PDF bytes for the same
// analysis (pdf-lib version, font subset, layout). A customer holding an older
// copy will then hash differently, and the row explains why instead of the
// mismatch reading as tampering.
const PDF_BUILDER_VER = "2026-09-25b";  // 25b: the 4-page report replaces the old detail pages -- 1 cards, 2 compare (sealed listings, market line), 3 shortlist (sealed pool, by city), 4 summary + thank-you + disclosures, 5 details (fee breakdown, recalls, extras, insurance, AMVIC, payment default); a finance-tied price leads page 1. 24a: the Hub & Spoke redesign -- page 1 is thirteen cards around the car, page 2 the summary and thank-you; the full detail follows unchanged.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Every ledger call goes through here. It NEVER throws and never returns a
// rejected promise: the ledger is evidence, not a gate, and a buyer must get
// their report even when Postgres is having a bad day. A gap this creates is
// visible in the admin panel's attempts-vs-rows reconciliation.
async function ledgerRpc(fn: string, args: Record<string, unknown>): Promise<any> {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      console.warn(`ledger ${fn} failed:`, res.status, await res.text());
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn(`ledger ${fn} threw (send continues regardless):`, e);
    return null;
  }
}

// Per-request CORS. This used to be a module-level constant with
// "Access-Control-Allow-Origin: *", which told every browser on the internet
// that any page was welcome to script this endpoint. It now echoes only an
// allowlisted origin (corsOrigin falls back to lotcheck.ca), so another site
// cannot drive a visitor's browser into minting LotCheck mail.
//
// Worth being clear about what this is and is not: CORS is enforced by
// BROWSERS, and Origin is a header any non-browser client sets freely. This
// closes the drive-by/embedded-page vector and nothing more. The control that
// actually holds against a deliberate attacker is the signature gate below.
function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": corsOrigin(origin),
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function isValidEmail(v: string): boolean {
  // Same simple pattern as the client-side check -- catches obvious typos
  // without the false-negative risk of a stricter regex. The client already
  // validates this, but a request can always come from somewhere other
  // than the real page, so it's checked again here.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

// Parked-time care asks for the Days-on-Lot surfaces (email HTML deck + PDF).
// Server-side mirror of src/App.jsx dolCareAsk — identical wording on every
// surface, locked by the report-parity gate. Backed: GM dealer-inventory
// bulletin 09-00-89-002K (battery test + move every 30 days in stock; oil
// advisory past 7 months; flat spots can become permanent past 90 days) and
// OEM oil schedules' months clauses. Ask-framed: questions, never assertions.
function dolCareAskTxt(d: number): string {
  if (d >= 90) return " Parked this long, the car sits mechanically too — ask when the oil was last changed (manufacturers cap oil life by time, not just km), whether the 12-volt battery was tested and the car moved every 30 days (GM's own dealer-inventory guidance calls for both), and ask to see the completed pre-delivery inspection sheet.";
  if (d >= 31) return " Worth asking too: whether the 12-volt battery has been tested and the car moved during storage — manufacturer lot-care guidance calls for both every 30 days.";
  return "";
}

// ── MSRP per trim (standing requirement 2026-08-19) ─────────────────────────
// The client attaches analysis.trimRange (catalog-derived, evapRebate
// pattern). Shape-validated here, and the source link is built from THIS
// server-owned map — a client-supplied URL never rides into a DKIM-signed
// email (same rule as reportUrl/verifyUrl).
const EMAIL_MAKE_SITE: Record<string, string> = {
  Toyota: "https://www.toyota.ca", Lexus: "https://www.lexus.ca", Honda: "https://www.honda.ca",
  Acura: "https://www.acura.ca", Mazda: "https://www.mazda.ca", Hyundai: "https://www.hyundaicanada.com",
  Kia: "https://www.kia.ca", Genesis: "https://www.genesis.ca", Subaru: "https://www.subaru.ca",
  Nissan: "https://www.nissan.ca", Infiniti: "https://www.infiniti.ca", Volkswagen: "https://www.vw.ca",
  Ford: "https://www.ford.ca", Lincoln: "https://www.lincolncanada.com", Chevrolet: "https://www.chevrolet.ca",
  GMC: "https://www.gmc.ca", Buick: "https://www.buick.ca", Cadillac: "https://www.cadillac.ca",
  Jeep: "https://www.jeep.ca", Ram: "https://www.ramtruck.ca", Dodge: "https://www.dodge.ca",
  Chrysler: "https://www.chrysler.ca", Fiat: "https://www.fiatcanada.com", "Alfa Romeo": "https://www.alfaromeo.ca",
  "Mercedes-Benz": "https://www.mercedes-benz.ca", BMW: "https://www.bmw.ca", Mini: "https://www.mini.ca",
  Porsche: "https://www.porsche.com", Volvo: "https://www.volvocars.com", "Land Rover": "https://www.landrover.ca",
  Jaguar: "https://www.jaguar.ca", Mitsubishi: "https://www.mitsubishi-motors.ca",
};
function trimRangeOk(tr: any): boolean {
  return !!tr && typeof tr === "object" && Number(tr.y) > 0 &&
    typeof tr.mk === "string" && typeof tr.md === "string" &&
    Array.isArray(tr.t) && tr.t.length > 0 && tr.t.length <= 40 &&   // the FULL ladder rides here; the PDF renders a capped view of it
    tr.t.every((x: any) => x && typeof x.n === "string" && Number(x.m) > 0);
}

function escapeHtml(s: unknown): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(n: unknown): string {
  const num = Number(n);
  if (!n || Number.isNaN(num)) return "—";
  return `$${num.toLocaleString()}`;
}

// Builds the email body to match the FULL on-screen Quote Check report --
// every card the browser shows (price vs MSRP, leverage, recalls, odometer,
// VIN, EVAP rebate, financing math, financing examples, dealer reviews,
// warranty, add-ons, summary). The client sends the same enriched `analysis`
// object it rendered, plus a precomputed `evapRebate` (the on-site EVAP card
// is computed client-side, so it's attached to the payload for the email).
// Email-safe throughout: table layout, inline styles, no flexbox/JS.
const CARD = 'background:#fff;border:1px solid #eee;border-radius:14px;padding:18px;margin-bottom:14px;';
const LBL = 'font-size:11px;color:#706D96;margin-bottom:3px;';
const NOTE = 'font-size:12px;color:#5B5885;line-height:1.55;margin-top:4px;';

function aprTierEmail(apr: number) {
  if (apr <= 4.99) return { ink: "#17756B", bg: "#E3F4F1", border: "#2FA79A", lab: "low rate" };
  if (apr <= 7.99) return { ink: "#9A6B00", bg: "#FCF3E0", border: "#E0A800", lab: "average rate" };
  return { ink: "#A63C25", bg: "#FDEAE5", border: "#F2836B", lab: "high rate" };
}

function financeGridEmail(price: number, apr: number): string {
  const terms = [36, 48, 60, 72, 84, 96];
  const downs = [0, 5000, 10000, 15000];
  const r = apr / 1200;
  const head = `<tr><th style="text-align:left;font-size:11px;color:#706D96;padding:3px 6px;">Term</th>${downs
    .map((d) => `<th style="text-align:right;font-size:11px;color:#706D96;padding:3px 6px;white-space:nowrap;">${d === 0 ? "$0" : "$" + d / 1000 + "k"} down</th>`)
    .join("")}</tr>`;
  const rows = terms
    .map((n) => `<tr><td style="font-size:12px;font-weight:800;color:#33305A;padding:5px 6px;border-top:1px solid #eee;white-space:nowrap;">${n} mo</td>${downs
      .map((d) => {
        const P = price - d;
        const v = P > 0 ? "$" + Math.round((P * r) / (1 - Math.pow(1 + r, -n))).toLocaleString() : "—";
        return `<td style="text-align:right;font-size:12px;color:${P > 0 ? "#33305A" : "#aaa"};padding:5px 6px;border-top:1px solid #eee;white-space:nowrap;">${v}</td>`;
      })
      .join("")}</tr>`)
    .join("");
  return `<table style="width:100%;border-collapse:collapse;">${head}${rows}</table>`;
}

function financeBlockEmail(title: string, sub: string, apr: number, price: number, ref: boolean): string {
  const t = aprTierEmail(apr);
  const border = ref ? "1px dashed #ccc" : `2px solid ${t.border}`;
  const bg = ref ? "#fff" : t.bg;
  const titleColor = ref ? "#5B5885" : t.ink;
  return `<div style="border:${border};background:${bg};border-radius:12px;padding:12px 14px;margin-top:10px;">
    <table style="width:100%;"><tr>
      <td style="font-size:13px;font-weight:900;color:${titleColor};">${escapeHtml(title)}</td>
      <td style="text-align:right;font-size:15px;font-weight:900;color:${t.ink};white-space:nowrap;">${apr}% APR &middot; ${t.lab}</td>
    </tr></table>
    <div style="font-size:11px;color:#706D96;margin:2px 0 8px;line-height:1.4;">${escapeHtml(sub)}</div>
    ${financeGridEmail(price, apr)}
  </div>`;
}

// ── #24 swipe-deck email ────────────────────────────────────────────────────
// The email body is a compact "card deck": a dark cosmic VERDICT cover card
// that answers the whole deal at a glance (leverage score + price delta +
// watch-out count + one-line bottom line), then the audit as a short run of
// NUMBERED cards ("03 / 08") instead of ten tall stacked ones. The items that
// cost the buyer money -- flagged add-ons, a high APR, open recalls -- and the
// "say this" capstone carry an email-safe cosmic glow (cyan border + halo; the
// halo drops in Outlook, the border stays). Everything except the cover stays
// editorial cream so it still prints/forwards clean. Email-safe throughout:
// table layout, inline styles, solid fills (no gradient -> Outlook renders it),
// no flexbox/JS.

// A chip on the dark verdict header -- white text on a translucent fill.
function coverChip(txt: string, tone: string): string {
  const map: Record<string, [string, string]> = { flag: ["rgba(244,63,94,.28)", "rgba(244,63,94,.5)"], ok: ["rgba(58,224,255,.16)", "rgba(58,224,255,.4)"] };
  const [bg, bd] = map[tone] || map.ok;
  return `<span style="display:inline-block;font-size:11px;font-weight:800;color:#fff;background:${bg};border:1px solid ${bd};border-radius:7px;padding:3px 9px;margin:0 5px 6px 0;">${txt}</span>`;
}

// The dark cosmic "verdict" cover -- the FIRST card, so the reader never has to
// scroll to know the answer. Solid dark bg + solid bar fill (no gradient) for
// Outlook. barColor: green >=7, amber >=4, rose below.
function coverCard(a: any): string {
  // The over/under claim is decided by _shared/msrp-claim.ts, never here. This
  // used to be `a.quotedPrice > a.msrp` with a special case for "starting_at"
  // only -- so a USED vehicle carrying `original_when_new` rendered
  // "▼ $28,400 under MSRP" on this cover while the PDF inside the same email
  // refused that exact claim. One signed report, two answers.
  const claim = qualifyMsrpClaim(a);
  const hasCmp = claim.comparable;
  const over = claim.over;
  const diff = claim.delta !== null ? Math.abs(claim.delta) : 0;
  const pv = resolvePriceVerified(a).sourceVerified;
  const score = a.leverageScore?.computed ? Number(a.leverageScore.score) : null;
  const pct = score != null ? Math.max(4, Math.min(100, Math.round(score * 10))) : 0;
  const barColor = score == null ? "#3ae0ff" : score >= 7 ? "#5eead4" : score >= 4 ? "#facc15" : "#fb7185";
  const flaggedN = (a.addOns || []).filter((x: any) => x.verdict === "flagged").length;
  const rc = a.recalls;
  const chips: string[] = [];
  if (flaggedN) chips.push(coverChip(`✗ ${flaggedN} watch-out${flaggedN > 1 ? "s" : ""}`, "flag"));
  if (rc?.checked && rc.count > 0) chips.push(coverChip(`✗ ${rc.count} recall${rc.count > 1 ? "s" : ""}`, "flag"));
  else if (rc?.checked && rc.count === 0 && rc.confirmed !== false) chips.push(coverChip("✓ No recalls", "ok"));
  if (a.vinCheck?.present && a.vinCheck.valid) chips.push(coverChip("✓ VIN valid", "ok"));
  if (a.financingCheck?.checked && a.financingCheck.consistent) chips.push(coverChip("✓ Math checks", "ok"));
  // When the claim is refused the MSRP is still SHOWN -- refusing the
  // comparison is not the same as hiding the number, and staying silent would
  // itself read as "no gap", which is a claim of its own.
  const right = hasCmp
    ? `<div style="font-size:15px;font-weight:900;color:${over ? "#fca5a5" : "#5eead4"};">${diff === 0 ? "= at MSRP" : over ? "▲ " + money(diff) + " over" : "▼ " + money(diff) + " under"} MSRP</div>`
    : claim.msrp
      ? `<div style="font-size:13px;font-weight:800;color:#c9c6e8;">${escapeHtml(claim.label)} ${money(claim.msrp)}</div>${claim.refusal ? `<div style="font-size:11px;color:#a7a3d0;line-height:1.45;margin-top:3px;">no over/under-MSRP claim is made</div>` : ""}`
      // "price unverified" in red, under a price we had just printed in full,
      // answered nothing and asked one: unverified against WHAT? And red beside
      // a dealer's number reads as a verdict on the dealer, which we never make.
      // Worded once in report-lines.js (priceCheckState) and rendered NEUTRAL.
      // [[present-without-creating-questions]] [[no-accusation-language]]
      : (pv ? "" : `<div style="font-size:11px;line-height:1.45;color:#c9c6e8;">${escapeHtml(priceCheckState(a).short)}</div>`);
  return `<div style="background:#211f3d;border-radius:18px;padding:20px;margin-bottom:14px;color:#fff;">
    <div style="font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#a7a3d0;font-weight:800;">The verdict${a.reportId ? " · " + escapeHtml(a.reportId) : ""}</div>
    <table style="width:100%;margin-top:10px;"><tr>
      <td style="vertical-align:bottom;">
        ${score != null
          ? `<div style="font-size:12px;color:#c9c6e8;">Negotiation leverage</div>
             <div style="font-size:38px;font-weight:900;line-height:1;color:#fff;">${score.toFixed(1)}<span style="font-size:15px;color:#9c98c8;">/10</span></div>
             <div style="height:6px;width:150px;border-radius:4px;background:rgba(255,255,255,.15);margin-top:8px;font-size:0;line-height:0;"><div style="height:6px;width:${pct}%;border-radius:4px;background:${barColor};font-size:0;line-height:0;">&nbsp;</div></div>`
          : `<div style="font-size:16px;font-weight:800;color:#fff;">Quote reviewed</div>`}
      </td>
      <td style="vertical-align:bottom;text-align:right;">
        ${a.quotedPrice ? `<div style="font-size:12px;color:#c9c6e8;">${money(a.quotedPrice)} asking</div>` : ""}
        ${right}
      </td>
    </tr></table>
    ${chips.length ? `<div style="margin-top:14px;">${chips.join("")}</div>` : ""}
    ${a.summary ? `<div style="margin-top:12px;font-size:13px;line-height:1.55;color:#e8e6f6;border-top:1px solid rgba(255,255,255,.12);padding-top:12px;">${escapeHtml(a.summary)}</div>` : ""}
  </div>`;
}

// One numbered deck card ("03 / 08"). tone tints the card; glow wraps the money
// items in the cosmic ring.
function deckCard(idx: number, total: number, label: string, tone: string, bodyHtml: string, glow: boolean): string {
  const bd = tone === "flag" ? "#F2836B55" : tone === "pass" ? "#2FA79A55" : "#eee";
  const bg = tone === "flag" ? "#FDEAE5" : tone === "pass" ? "#F3FAF8" : "#fff";
  const glowCss = glow ? "border-color:#3ae0ff;box-shadow:0 0 0 1px #3ae0ff,0 0 14px 2px rgba(58,224,255,.42);" : "";
  const n = (v: number) => String(v).padStart(2, "0");
  return `<div style="background:${bg};border:1px solid ${bd};border-radius:14px;padding:14px 16px;margin-bottom:11px;${glowCss}">
    <table style="width:100%;margin-bottom:6px;"><tr>
      <td style="font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#706D96;">${escapeHtml(label)}</td>
      <td style="text-align:right;font-size:10px;font-family:ui-monospace,Consolas,monospace;color:#b9b3a4;font-weight:700;white-space:nowrap;">CARD ${n(idx)} OF ${n(total)}</td>
    </tr></table>
    ${bodyHtml}</div>`;
}

// Builds the numbered audit deck + the "say this" capstone from the analysis.
// Returns the card count and pre-rendered HTML so buildEmailHtml stays a shell.
function buildDeckBody(analysis: any): { total: number; deckHtml: string; sayHtml: string } {
  const a = analysis;
  const price = a.quotedPrice || a.msrp || 0;
  // Same gate as the cover. This card previously checked NOTHING -- not even
  // the "starting_at" case the cover handled -- so every non-exact basis
  // produced an over/under figure here.
  const claim = qualifyMsrpClaim(a);
  const hasCmp = claim.comparable;
  const over = claim.over;
  const diff = claim.delta !== null ? Math.abs(claim.delta) : 0;
  const pv = resolvePriceVerified(a).sourceVerified;
  const flaggedN = (a.addOns || []).filter((x: any) => x.verdict === "flagged").length;
  // The emailed HTML body is its own render surface. e80122c put the
  // gated-price disclosure in the attached PDF but not here, so the email a
  // buyer actually opens showed the recovered price with no indication the
  // dealer's page refuses to display it -- while the PDF stapled to that same
  // email said so plainly. One signed report, two stories.
  const gatedPriceNoteHtml = (an: any): string => {
    if (!an || !(Number(an.quotedPrice) > 0) || !an.priceGatedButRecovered) return "";
    const msg = String(an.priceGateMessage || "Call for pricing");
    const txt = an.priceGateGoogleAdsBacked
      ? `This dealer's page displays "${msg}" instead of a number — but the page's own data carries the real asking price, and it's independently published to Google's vehicle ads too, so it's public either way.`
      : `This dealer's page displays "${msg}" instead of a number — but the page's own data carries the real asking price shown here.`;
    return `<div style="font-size:11.5px;color:#706D96;margin-top:6px;line-height:1.5;">${escapeHtml(txt)}</div>`;
  };
  const deck: Array<{ label: string; tone: string; glow: boolean; body: string }> = [];

  // 1 -- Price vs MSRP (compact; the cover headlines the delta, this is the detail)
  deck.push({
    label: "Price vs MSRP",
    tone: !pv ? "flag" : (!hasCmp ? "muted" : over ? "flag" : "pass"),
    glow: false,
    body: `<div style="font-size:18px;font-weight:900;color:${!pv || over ? "#A63C25" : "#17756B"};">${hasCmp ? (diff === 0 ? "At MSRP" : over ? money(diff) + " over" : money(diff) + " under") : (a.quotedPrice ? money(a.quotedPrice) : "Price not shown")}</div>
      <div style="font-size:12px;color:#706D96;margin-top:2px;">${a.quotedPrice ? money(a.quotedPrice) : "—"}${hasCmp ? " vs " + money(a.msrp) + " MSRP" : (claim.msrp ? ` · ${escapeHtml(claim.label)} ${money(claim.msrp)}` : "")} · ${pv ? "price verified" : "price not verified"}</div>
      ${gatedPriceNoteHtml(a)}
      ${!hasCmp && claim.refusal ? `<div style="font-size:11.5px;color:#706D96;margin-top:6px;line-height:1.5;">${escapeHtml(claim.refusal)}</div>` : ""}
      ${a.msrpSourceUrl ? `<div style="font-size:11.5px;margin-top:7px;"><a href="${escapeHtml(a.msrpSourceUrl)}" style="color:#17756B;">See ${escapeHtml(a.make || "the manufacturer")}'s own page for this MSRP →</a></div>` : ""}`,
  });

  // 2 -- Add-ons & fees (glow if anything flagged)
  if ((a.addOns || []).length) {
    const rows = a.addOns.map((x: any) => `<tr>
      <td style="padding:7px 0;border-top:1px solid #eee;font-size:13px;color:#33305A;">${x.verdict === "flagged" ? "✗ " : ""}${escapeHtml(x.name)}${x.reason ? `<div style="font-size:11.5px;color:#706D96;line-height:1.4;">${escapeHtml(x.reason)}</div>` : ""}</td>
      <td style="padding:7px 0;border-top:1px solid #eee;text-align:right;font-weight:700;color:${x.verdict === "flagged" ? "#A63C25" : "#33305A"};white-space:nowrap;">${money(x.price)}</td></tr>`).join("");
    deck.push({
      label: flaggedN ? "Flagged add-ons" : "Add-ons & fees",
      tone: flaggedN ? "flag" : "muted",
      glow: !!flaggedN,
      body: `${flaggedN ? `<div style="font-size:18px;font-weight:900;color:#A63C25;margin-bottom:4px;">${money(a.totalFlaggedCost || 0)} · ${flaggedN} item${flaggedN > 1 ? "s" : ""} to question</div>` : ""}<table style="width:100%;border-collapse:collapse;">${rows}</table>`,
    });
  }

  // 3 -- AMVIC (point 4): the regulator's own status, verbatim. Retitled from
  // "Financing APR" 2026-09-09, then wired to this real data 2026-09-10 (Vic:
  // "make it real AMVIC data") after a live PDF showed this card titled AMVIC
  // with a 4.9% financing rate as its body -- the 09-09 pass renamed the
  // label only, per that day's explicit "just replace the words ... the rest
  // do not touch". Worded once in report-lines.js so this card can never
  // read differently than the point card or the compact "10-point
  // verification" row below.
  if (a.dealerLicence && a.dealerLicence.status) {
    const L = a.dealerLicence, dl = dealerLicenceLine(a);
    deck.push({ label: "AMVIC", tone: dl.tone, glow: dl.tone === "flag", body:
      `<div style="font-size:18px;font-weight:900;color:${dl.tone === "pass" ? "#17756B" : "#A63C25"};">${escapeHtml(L.status)}</div>` +
      `<div style="font-size:12px;color:#706D96;margin-top:2px;">${L.legalName ? escapeHtml(L.legalName) + " &middot; " : ""}${L.licenceNumber ? "Licence " + escapeHtml(L.licenceNumber) + " &middot; " : ""}AMVIC public registry</div>` +
      `<div style="font-size:12.5px;color:#33305A;margin-top:6px;line-height:1.5;">${escapeHtml(dl.line)}</div>` });
  }

  // 3a -- Payment default: the page's own pre-selected payment scenario
  // (pageDefault), read by code, sealed in the canonical (dflt), worded by the
  // shared builder. ALWAYS RENDERS -- "not published" and "not read" are
  // answers the buyer can act on; a missing card is not. Same rule as
  // days-on-lot below. [[report-never-empty]]
  {
    const line = pageDefaultLine(a);
    const confirmed = line.state === "confirmed";
    const meta = line.meta || (PD_STATE_WORD[line.state] || PD_STATE_WORD.unchecked);
    deck.push({ label: "Payment starting point", tone: "muted", glow: false, body:
      `<div style="font-size:18px;font-weight:900;color:${confirmed ? "#33305A" : "#706D96"};">${escapeHtml(line.headline)}</div>` +
      `<div style="font-size:12px;color:#706D96;margin-top:2px;">${escapeHtml(meta)}</div>` +
      `<div style="font-size:12.5px;color:#33305A;margin-top:6px;line-height:1.5;">${escapeHtml(line.body)}</div>` });
  }

  // 4 -- Recalls (every branch; glow only when there are open recalls)
  const rc = a.recalls;
  if (rc) {
    if (!rc.checked) deck.push({ label: "Recalls · Transport Canada", tone: "muted", glow: false, body: `<div style="font-size:13px;color:#5B5885;line-height:1.5;">Couldn't reach the registry — check directly at Transport Canada before you sign.</div>` });
    else if (rc.count === 0 && rc.confirmed === false) deck.push({ label: "Recalls · Transport Canada", tone: "muted", glow: false, body: `<div style="font-size:14px;font-weight:800;color:#9A6B00;">Couldn't confirm for this exact model</div><div style="font-size:12px;color:#5B5885;margin-top:3px;line-height:1.5;">Not an all-clear — check open recalls by VIN at Transport Canada.</div>` });
    else if (rc.count === 0) deck.push({ label: "Recalls · Transport Canada", tone: "pass", glow: false, body: `<div style="font-size:15px;font-weight:800;color:#17756B;">✓ None open</div>` });
    else {
      // The PDF in this same email prints EVERY recall. This deck printed the

      // first three under a headline count that could say seven -- the two

      // halves of one email disagreeing about how many safety recalls a car

      // has. A cap is defensible; a silent one is not, so the note below says

      // it. [[recalls-detail-list-must-match-count]]

      const DECK_RECALL_CAP = 3;

      const shownDeck = Math.min((rc.items || []).length, DECK_RECALL_CAP);

      const items = (rc.items || []).slice(0, DECK_RECALL_CAP).map((it: any) => {
        const yr = it.date && !Number.isNaN(new Date(it.date).getFullYear()) ? " · " + new Date(it.date).getFullYear() : "";
        return `<div style="font-size:12px;color:#33305A;margin-top:6px;padding-top:6px;border-top:1px solid #F2836B33;"><b>${escapeHtml(it.system || "Recall")}${yr}</b>${it.summary ? `<div style="color:#5B5885;margin-top:2px;line-height:1.45;">${escapeHtml(it.summary)}</div>` : ""}</div>`;
      }).join("");
      deck.push({ label: "Recalls · Transport Canada", tone: "flag", glow: true, body: `<div style="font-size:18px;font-weight:900;color:#A63C25;">${rc.count} open recall${rc.count > 1 ? "s" : ""}</div>${items}${recallsShownNote(rc.count, shownDeck) ? `<div style="font-size:11px;color:#706D96;margin-top:8px;">${escapeHtml(recallsShownNote(rc.count, shownDeck))}</div>` : ""}<div style="font-size:11px;color:#706D96;margin-top:8px;">Repaired free of charge — confirm the fix status before you sign.</div>` });
    }
  }

  // 5 -- THE TEN, ALWAYS TEN.
  //
  // This was a "Quick checks" roll-up whose EVERY row was conditional --
  // `if (a.vinCheck?.present) checks.push(...)` with no else -- so an
  // unresolved point emitted nothing at all. The PDF stapled to this very
  // email is documented to "ALWAYS return exactly 10 rows ... a point with no
  // data reads NOT ON QUOTE, never omitted", and it does. So one signed report
  // showed a different number of checks depending on which half of the same
  // email you opened. If a check did not resolve, the buyer paid for it and was
  // never told it had been asked.
  //
  // Built from tenPoints() -- the same builder the PDF uses -- so the two
  // cannot diverge again. The cards above still give price, recalls, fees and
  // reputation their own richer treatment; this is the checklist, and it is
  // complete by construction. [[report-never-empty]] [[claims-must-stay-backed]]
  {
    const pts = tenPoints(a);
    const core = pts.slice(0, POINT_TITLES.length);
    const extras = pts.slice(POINT_TITLES.length);
    const anyFlag = core.some((p) => p.tone === "flag");
    const row = (p: { t: string; v: string; tone: string }) => {
      const c = p.tone === "flag" ? "#A63C25" : p.tone === "pass" ? "#17756B" : "#706D96";
      // ✗ / ✓ / · only: U+26A0 renders as an emoji in most mail clients, and
      // display:flex is dropped by Gmail and Outlook, which ran the label and the
      // value together ("Price vs MSRPPRICE UNVERIFIED", LC-0F75-A93, 2026-09-02).
      // A two-cell table is what every client lays out.
      const mark = p.tone === "flag" ? "\u2717" : p.tone === "pass" ? "\u2713" : "\u00b7";
      return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;"><tr>`
        + `<td style="padding:5px 8px 5px 0;font-size:13px;color:#33305A;line-height:1.5;border-bottom:1px solid rgba(51,48,90,.07);">${mark} ${escapeHtml(p.t)}</td>`
        + `<td style="padding:5px 0;font-size:13px;color:${c};font-weight:700;white-space:nowrap;text-align:right;line-height:1.5;border-bottom:1px solid rgba(51,48,90,.07);">${escapeHtml(p.v)}</td>`
        + `</tr></table>`;
    };
    deck.push({
      label: `The ${core.length}-point verification`,
      tone: anyFlag ? "flag" : "pass",
      glow: !!anyFlag,
      body: core.map(row).join(""),
    });
    if (extras.length) {
      deck.push({
        label: `Also checked on this listing (${extras.length})`,
        tone: extras.some((p) => p.tone === "flag") ? "flag" : "muted",
        glow: false,
        body: extras.map(row).join(""),
      });
    }
    // Not a verification point -- it is something the DEALER offered -- so it
    // is stated separately rather than counted.
    if (a.warranty?.offered) {
      deck.push({
        label: "Protection plan offered",
        tone: "muted",
        glow: false,
        body: `<div style="font-size:13px;color:#33305A;line-height:1.5;">${escapeHtml(a.warranty.offered)}`
          + `${a.warranty.price ? " (" + money(a.warranty.price) + ")" : ""}</div>`,
      });
    }
  }

  // 5a2 -- MSRP per trim: the factory range (client-derived from the verified
  // catalog, evapRebate pattern; source link is server-built, never client's).
  if (trimRangeOk(a.trimRange)) {
    const tr = a.trimRange;
    const qpT = Number(a.quotedPrice) || 0;
    const aboveN = qpT > 0 ? tr.t.filter((x: any) => qpT > Number(x.m)).length : 0;
    const allExcl = tr.t.every((x: any) => Number(x.b) === 1);
    const site = EMAIL_MAKE_SITE[tr.mk] || null;
    // Same capped view as the PDF and the on-screen card -- one number, so a
    // buyer comparing the email against the app is not reading two counts.
    const HTML_ROWS_SHOWN = 12;
    const rows = tr.t.slice(0, HTML_ROWS_SHOWN).map((x: any) =>
      `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;"><tr><td style="padding:3px 8px 3px 0;font-size:12px;color:#33305A;border-bottom:1px solid rgba(51,48,90,.08);">${x.p ? escapeHtml(String(x.p)) + " · " : ""}${escapeHtml(x.n)}</td><td style="padding:3px 0;font-size:12px;color:#33305A;font-weight:700;white-space:nowrap;text-align:right;border-bottom:1px solid rgba(51,48,90,.08);">$${Number(x.m).toLocaleString("en-CA")}${Number(x.b) === 1 ? " <span style='color:#706D96;font-weight:600'>+ freight</span>" : ""}</td></tr></table>`).join("");
    deck.push({ label: "MSRP per trim", tone: "muted", body:
      `<div style="font-size:13px;font-weight:900;color:#33305A;">${tr.y} ${escapeHtml(tr.mk)} ${escapeHtml(tr.md)} — the manufacturer's price per trim${allExcl ? " (before freight & fees)" : ""}</div>` +
      `<div style="margin-top:6px;">${rows}</div>` +
      (tr.t.length > HTML_ROWS_SHOWN ? `<div style="font-size:11px;color:#706D96;margin-top:4px;">Showing ${HTML_ROWS_SHOWN} of ${tr.t.length} published trims.</div>` : "") +
      (qpT > 0 ? `<div style="font-size:12px;color:#5B5885;margin-top:6px;">The asking price $${qpT.toLocaleString("en-CA")} sits above ${aboveN} of ${tr.t.length} published trim prices.${allExcl ? " Catalog prices exclude freight & fees — compare like-for-like." : ""}</div>` : "") +
      (site ? `<div style="font-size:12px;margin-top:6px;"><a href="${site}" style="color:#17756B;font-weight:700;">Confirm the range on ${escapeHtml(tr.mk)}'s own site</a></div>` : "") });
  }

  // 5b -- Days on lot (motivated-seller clock)
  //
  // ALWAYS RENDERS. It used to be inside `if (daysOnLot)`, so on any dealer
  // platform we could not read — a VW store, 2026-08-16 — the card vanished and
  // the buyer had no idea the question had even been asked. A missing answer is
  // information: "ask the dealer" is a usable instruction, an absent card is
  // not. Same rule as VIN (vin-every-scan).
  // ONE SIGHTING IS A DATE, NOT A DURATION. Worded once in report-lines.js so
  // the deck, the PDF and the screen say the same thing about the same fact.
  // [[days-on-lot-needs-real-observations]] [[report-features-all-views]]
  {
    const dl = daysOnLotLine(a);
    if (a.daysOnLot && dl && !(Number(a.daysOnLot.days) > 0)) {
      deck.push({ label: "Days on lot", tone: "muted", glow: false,
        body:
        `<div style="font-size:18px;font-weight:900;color:#33305A;">${escapeHtml(dl.value)}</div>` +
        `<div style="font-size:12.5px;color:#33305A;margin-top:6px;line-height:1.5;">${escapeHtml(dl.line)}</div>` });
    }
    const sv = sameVinElsewhereLine(a);
    if (sv) deck.push({ label: "Also advertised elsewhere", tone: "muted", glow: false,
      body:
        `<div style="font-size:18px;font-weight:900;color:#33305A;">${escapeHtml(sv.value)}</div>` +
        `<div style="font-size:12.5px;color:#33305A;margin-top:6px;line-height:1.5;">${escapeHtml(sv.line)}</div>` });
    const pm = priceMovesLine(a);
    if (pm) deck.push({ label: "Advertised price moves", tone: pm.tone, glow: false,
      body:
        `<div style="font-size:18px;font-weight:900;color:#33305A;">${escapeHtml(pm.value)}</div>` +
        `<div style="font-size:12.5px;color:#33305A;margin-top:6px;line-height:1.5;">${escapeHtml(pm.line)}</div>` });
  }
  if (a.daysOnLot && Number(a.daysOnLot.days) > 0) {
    const d = Math.round(Number(a.daysOnLot.days));
    // FOUR tiers, matching the on-screen card. Email clients strip CSS
    // animation, so the 120+ tier cannot lean on the blink the app uses --
    // it carries the meaning in COLOUR and WORDS instead, which is what the
    // reduced-motion path does on screen too. A tier that only exists as
    // motion does not exist in a PDF.
    const critical = d >= 120, hot = d >= 90, warm = d >= 31 && d < 90;
    const dolC = critical ? "#8B1A1A" : hot ? "#A63C25" : warm ? "#8a6a12" : "#17756B";
    // `atLeast` marks our own first-seen tracker, which is a LOWER BOUND — the
    // car may have sat there before our crawl noticed it. Stating it as exact
    // is the kind of number a dealer would take apart, correctly.
    const atLeast = a.daysOnLot.atLeast === true;
    deck.push({ label: "Days on lot", tone: hot ? "flag" : warm ? "muted" : "pass", glow: hot, body:
      `<div style="font-size:18px;font-weight:900;color:${dolC};">${atLeast ? "At least " : ""}${d.toLocaleString()} days on the lot${critical ? " — over four months" : ""}</div>` +
      `<div style="font-size:12px;color:#706D96;margin-top:2px;">${a.daysOnLot.since ? "First seen " + escapeHtml(a.daysOnLot.since) + " · " : ""}${escapeHtml(a.daysOnLot.sourceLabel || "dealer inventory data")}</div>` +
      `<div style="font-size:12.5px;color:#33305A;margin-top:6px;line-height:1.5;">${atLeast
        ? "This is how long we have seen this exact car listed — it may have been sitting longer before we first saw it, so treat it as a floor, not a total. "
        : "This is how long this exact car has sat unsold — counted by the dealer's own inventory system. "}${hot ? "At this age you're doing them a favour by buying it — negotiate like it." : warm ? "A month-plus of sitting is real carrying cost — reasonable grounds to ask for a better price." : "This one is fresh, so sitting-time won't move the price much yet."}${escapeHtml(dolCareAskTxt(d))}</div>` });
  } else {
    deck.push({ label: "Days on lot", tone: "muted", body:
      `<div style="font-size:18px;font-weight:900;color:#706D96;">Not published — ask the dealer</div>` +
      `<div style="font-size:12px;color:#706D96;margin-top:2px;">This dealer's platform doesn't expose an inventory date, and we haven't seen this VIN in our own daily tracking yet</div>` +
      `<div style="font-size:12.5px;color:#33305A;margin-top:6px;line-height:1.5;">Worth asking outright: <b>&ldquo;How long has this exact car been on your lot?&rdquo;</b> A car that has sat 90+ days is carrying real cost for them, and the answer is easy for them to give and awkward to dodge. We could not read it here, so we are not guessing at it.</div>` });
  }

  // 5b1 -- How this vehicle compares with the Alberta market: three plain
  // lines (this vehicle / similar listings in Alberta / difference) worded by
  // ONE shared builder (report-lines.js marketCompareLine) and carrying a
  // traffic light -- green at or below the middle, amber above the middle but
  // inside the range, red above every similar listing read. Vic, 2026-09-02,
  // after LC-0F75-A93 printed "$9,908 above the local middle value" against
  // 2024 hybrids: "not easy to understand". Renders whenever a comparison set
  // exists, INCLUDING the not-enough state -- an unmade comparison still gets
  // its card and its reason. [[report-never-empty]]
  if (a.marketValue) {
    const line = marketCompareLine(a);
    const lines: Array<{ k: string; v: string }> = Array.isArray(line.lines) ? line.lines : [];
    const LIGHT: Record<string, { dot: string; bg: string; fg: string }> = {
      green: { dot: "#17756B", bg: "#E3F4F1", fg: "#17756B" },
      amber: { dot: "#8A6414", bg: "#FDF4DF", fg: "#8A6414" },
      red:   { dot: "#A63C25", bg: "#FDEAE5", fg: "#A63C25" },
    };
    const lt = line.light && LIGHT[line.light] ? LIGHT[line.light] : null;
    // Tables throughout: Gmail and Outlook drop display:flex, so the dot and
    // its label are two cells, and each of the three lines is a two-cell row.
    const lightRow = lt && line.lightLabel
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 10px;"><tr>` +
          `<td style="padding:6px 12px 6px 10px;background:${lt.bg};border-radius:999px;">` +
            `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>` +
              `<td style="width:12px;height:12px;border-radius:50%;background:${lt.dot};font-size:0;line-height:0;">&nbsp;</td>` +
              `<td style="padding-left:8px;font-size:12px;font-weight:800;color:${lt.fg};line-height:1.2;">${escapeHtml(line.lightLabel)}</td>` +
            `</tr></table>` +
          `</td>` +
        `</tr></table>`
      : "";
    const rows = lines.map((l) =>
      `<tr>` +
        `<td style="padding:5px 12px 5px 0;vertical-align:top;white-space:nowrap;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#706D96;">${escapeHtml(l.k)}</td>` +
        `<td style="padding:5px 0;vertical-align:top;font-size:13px;color:#33305A;line-height:1.5;">${escapeHtml(l.v)}</td>` +
      `</tr>`).join("");
    const linesTable = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">${rows}</table>`;
    // The linear low -> middle -> high band with a "you are here" marker stays
    // under the three lines, and only once a comparison was actually made.
    let band = "";
    if (line.state === "confirmed") {
      const mv = a.marketValue;
      const median = Number(mv.average) || 0;
      const low = Number(mv.low != null ? mv.low : mv.below) || 0;
      const high = Number(mv.high != null ? mv.high : mv.above) || 0;
      // The marker sits only where the builder measured the asking price: an
      // unverified or finance-contingent price is in the lines, not on the band.
      const ask = Number(line.askUsed) || 0;
      if (median && low && high) {
        const lo0 = Math.min(low, ask > 0 ? ask : low), hi0 = Math.max(high, ask > 0 ? ask : high);
        const pad = Math.max(1, (hi0 - lo0) * 0.10), d0 = lo0 - pad, d1 = hi0 + pad;
        const pct = (v: number) => Math.max(0, Math.min(100, ((v - d0) / ((d1 - d0) || 1)) * 100));
        const bandL = pct(low), bandR = pct(high), medPct = pct(median), askPct = pct(ask || median);
        band =
          `<div style="position:relative;height:12px;border-radius:999px;background:#EDEAF3;margin:14px 0 6px;">` +
            `<div style="position:absolute;top:0;bottom:0;left:${bandL.toFixed(1)}%;width:${(bandR - bandL).toFixed(1)}%;background:#CDE8E5;border-radius:999px;"></div>` +
            `<div style="position:absolute;top:-4px;bottom:-4px;left:${medPct.toFixed(1)}%;width:2px;background:#17756B;"></div>` +
            (ask >= 1 ? `<div style="position:absolute;top:50%;left:${askPct.toFixed(1)}%;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:#C6820E;border:2px solid #FFFDF7;"></div>` : "") +
          `</div>` +
          `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;font-size:11px;color:#706D96;font-weight:700;"><tr>` +
            `<td style="text-align:left;">Low ${money(low)}</td><td style="text-align:center;">Middle ${money(median)}</td><td style="text-align:right;">High ${money(high)}</td>` +
          `</tr></table>`;
      }
    }
    deck.push({ label: line.title, tone: line.tone, glow: line.light === "red", body:
      lightRow + linesTable + band +
      (line.note ? `<div style="font-size:12px;color:#706D96;margin-top:8px;line-height:1.5;">${escapeHtml(line.note)}</div>` : "") });
  }

  // 5b1a -- What older model years ask today: the market page's model-year
  // ladder as ONE report line (this vehicle / one, two, three years older),
  // worded by the shared builder (report-lines.js olderYearsLine) from the
  // sealed ladder (canonical v8 `oy`), with the comparison card's own
  // like-for-like rules. Renders whenever the ladder exists, INCLUDING the
  // not-read and not-enough states -- an unmade read still gets its card and
  // its reason. Only the builder's strings reach the page. [[report-never-empty]]
  // Tables only (Gmail and Outlook drop display:flex): each line is a two-cell row.
  if (a.olderYears) {
    const oyLine = olderYearsLine(a);
    const oyConfirmed = oyLine.state === "confirmed";
    const oyLines: Array<{ k: string; v: string }> = Array.isArray(oyLine.lines) ? oyLine.lines : [];
    const oyRows = oyLines.map((l) =>
      `<tr>` +
        `<td style="padding:5px 12px 5px 0;vertical-align:top;white-space:nowrap;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#706D96;">${escapeHtml(l.k)}</td>` +
        `<td style="padding:5px 0;vertical-align:top;font-size:13px;color:#33305A;line-height:1.5;">${escapeHtml(l.v)}</td>` +
      `</tr>`).join("");
    // The not-read state carries its reason in the builder's body and no
    // lines, so the body is what prints when there is no table to print.
    const oyDetail = oyLines.length
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-top:6px;">${oyRows}</table>`
      : (oyLine.body ? `<div style="font-size:12.5px;color:#33305A;margin-top:6px;line-height:1.5;">${escapeHtml(oyLine.body)}</div>` : "");
    deck.push({ label: oyLine.title, tone: oyLine.tone, glow: false, body:
      `<div style="font-size:18px;font-weight:900;color:${oyConfirmed ? "#33305A" : "#706D96"};">${escapeHtml(oyLine.headline)}</div>` +
      oyDetail +
      (oyLine.meta ? `<div style="font-size:12px;color:#706D96;margin-top:6px;">${escapeHtml(oyLine.meta)}</div>` : "") +
      (oyLine.note ? `<div style="font-size:12px;color:#706D96;margin-top:8px;line-height:1.5;">${escapeHtml(oyLine.note)}</div>` : "") });
  }

  // 5b1a2 -- Insurance before you sign: a SEQUENCING warning, worded by the
  // shared builder (report-lines.js financeCoverageLine). Not a figure and not
  // a check -- a lender or lessor requires collision and comprehensive, and
  // Alberta's Take All Comers rule (Insurance Act s. 555) obliges insurers to
  // write only the MANDATORY coverages. The finance contract is signed at the
  // dealership; the insurance is arranged afterwards, so a buyer can commit to
  // a payment before knowing they can bind the cover the contract requires.
  //
  // Alberta only. It cites Alberta statute and an Alberta regulator, so this
  // card renders ONLY where financeCoverageApplies() is true -- same gate on
  // every surface, so no reader outside Alberta is told an Alberta rule.
  //
  // BOTH states render the same five lines: "confirmed" when the listing
  // itself shows financing and "general" when it does not. The warning holds
  // either way (a cash buyer has no lender, which is exactly the point), so
  // there is no greyed-out variant here -- the headline keeps the ink colour
  // in both states, and only the builder's meta says which one it is.
  // Only the builder's strings reach the page. [[report-never-empty]]
  // Tables only (Gmail and Outlook drop display:flex): each line is a two-cell row.
  if (financeCoverageApplies(a)) {
    const fcLine = financeCoverageLine(a);
    const fcLines: Array<{ k: string; v: string }> = Array.isArray(fcLine.lines) ? fcLine.lines : [];
    const fcRows = fcLines.map((l) =>
      `<tr>` +
        `<td style="padding:5px 12px 5px 0;vertical-align:top;white-space:nowrap;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#706D96;">${escapeHtml(l.k)}</td>` +
        `<td style="padding:5px 0;vertical-align:top;font-size:13px;color:#33305A;line-height:1.5;">${escapeHtml(l.v)}</td>` +
      `</tr>`).join("");
    // The builder always returns five lines, but if it ever returned none the
    // body sentence is what prints -- this card is never empty.
    const fcDetail = fcLines.length
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-top:6px;">${fcRows}</table>`
      : (fcLine.body ? `<div style="font-size:12.5px;color:#33305A;margin-top:6px;line-height:1.5;">${escapeHtml(fcLine.body)}</div>` : "");
    deck.push({ label: fcLine.title, tone: fcLine.tone, glow: false, body:
      `<div style="font-size:18px;font-weight:900;color:#33305A;">${escapeHtml(fcLine.headline)}</div>` +
      fcDetail +
      (fcLine.meta ? `<div style="font-size:12px;color:#706D96;margin-top:6px;">${escapeHtml(fcLine.meta)}</div>` : "") +
      (fcLine.note ? `<div style="font-size:12px;color:#706D96;margin-top:8px;line-height:1.5;">${escapeHtml(fcLine.note)}</div>` : "") });
  }

  // 5b1a3 -- Your premium after this purchase: the COST sibling of the card
  // above, worded by the shared builder (report-lines.js insurancePremiumLine).
  // The one above asks whether a buyer can GET the cover a lender requires;
  // this one is what it costs -- buying this vehicle is a change of vehicle on
  // the buyer's own policy, and the two-million-dollar liability limit is a
  // choice made at the same desk.
  //
  // Alberta only, on the SAME gate as its sibling: it cites Alberta statute and
  // an Alberta regulator, so financeCoverageApplies() decides it here exactly
  // as it does on every other surface, and no reader outside Alberta is told an
  // Alberta rule.
  //
  // The builder reads NOTHING from the listing -- it is regulator copy,
  // identical for every Alberta report -- so there is ONE state, no confirmed/
  // general split to grey out, and no conditional beyond the province gate.
  // No figure, no traffic light, no band: four labelled lines and a citation.
  // Only the builder's strings reach the page. [[report-never-empty]]
  // Tables only (Gmail and Outlook drop display:flex): each line is a two-cell row.
  if (financeCoverageApplies(a)) {
    const ipLine = insurancePremiumLine(a);
    const ipLines: Array<{ k: string; v: string }> = Array.isArray(ipLine.lines) ? ipLine.lines : [];
    const ipRows = ipLines.map((l) =>
      `<tr>` +
        `<td style="padding:5px 12px 5px 0;vertical-align:top;white-space:nowrap;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#706D96;">${escapeHtml(l.k)}</td>` +
        `<td style="padding:5px 0;vertical-align:top;font-size:13px;color:#33305A;line-height:1.5;">${escapeHtml(l.v)}</td>` +
      `</tr>`).join("");
    // The builder always returns four lines, but if it ever returned none the
    // body sentence is what prints -- this card is never empty.
    const ipDetail = ipLines.length
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-top:6px;">${ipRows}</table>`
      : (ipLine.body ? `<div style="font-size:12.5px;color:#33305A;margin-top:6px;line-height:1.5;">${escapeHtml(ipLine.body)}</div>` : "");
    deck.push({ label: ipLine.title, tone: ipLine.tone, glow: false, body:
      `<div style="font-size:18px;font-weight:900;color:#33305A;">${escapeHtml(ipLine.headline)}</div>` +
      ipDetail +
      (ipLine.meta ? `<div style="font-size:12px;color:#706D96;margin-top:6px;">${escapeHtml(ipLine.meta)}</div>` : "") +
      (ipLine.note ? `<div style="font-size:12px;color:#706D96;margin-top:8px;line-height:1.5;">${escapeHtml(ipLine.note)}</div>` : "") });
  }

  // 5b1b -- Other listings read: "Of N other listings read, M advertise below
  // this one." Computed once on the server (marketCount), sealed in the
  // canonical (mc), worded by the shared builder. Sits outside the market-value
  // conditional above so it ALWAYS RENDERS -- an unread or empty set still gets
  // its card, its headline and the reason, same rule as days-on-lot.
  // [[report-never-empty]]
  {
    const line = marketCountLine(a);
    const confirmed = line.state === "confirmed";
    // The builder's own meta line (vehicle · province · read <dates>), so the
    // date range here is the same one the sentence names.
    const meta = line.meta || (MC_STATE_WORD[line.state] || MC_STATE_WORD.unchecked);
    deck.push({ label: "Other listings read", tone: "muted", glow: false, body:
      `<div style="font-size:18px;font-weight:900;color:${confirmed ? "#33305A" : "#706D96"};">${escapeHtml(line.headline)}</div>` +
      `<div style="font-size:12px;color:#706D96;margin-top:2px;">${escapeHtml(meta)}</div>` +
      `<div style="font-size:12.5px;color:#33305A;margin-top:6px;line-height:1.5;">${escapeHtml(line.body)}</div>` });
  }

  // 5b0 -- basis note: all-in asking price vs freight-excluding MSRP
  if (a.msrpBasis === "exact" && a.allInPricing?.body && a.msrpPriceBasis !== "incl_freight" && Number(a.msrp) > 0 && Number(a.quotedPrice) > Number(a.msrp) + 100) {
    deck.push({ label: "Basis note - freight & PDI", tone: "muted", glow: false, body:
      `<div style="font-size:12.5px;color:#33305A;line-height:1.5;">The asking price is <b>all-in</b> (${escapeHtml(a.allInPricing.body)}), while a published MSRP normally <b>excludes freight &amp; PDI</b> (typically $2,000-$2,600). Part of the gap above is that freight - ask for freight and PDI as their own line.</div>` });
  }

  // 5b0b -- used vehicles: price when new, or an honest reason there is none
  if (a.msrpBasis === "original_when_new" && a.originalMsrp) {
    deck.push({ label: "MSRP when new", tone: "muted", glow: false, body:
      `<div style="font-size:18px;font-weight:900;color:#33305A;">${money(a.originalMsrp.msrp)}</div>` +
      `<div style="font-size:12.5px;color:#33305A;margin-top:6px;line-height:1.5;">What this ${escapeHtml(String(a.originalMsrp.year || a.year || ""))} ${escapeHtml(a.model || "vehicle")} cost new. Context only - it is not a sticker to measure a used asking price against, so no over/under-MSRP claim is made.</div>` });
  } else if (a.msrpUnavailable) {
    deck.push({ label: "MSRP when new", tone: "muted", glow: false, body:
      `<div style="font-size:12.5px;color:#33305A;line-height:1.5;">${escapeHtml(a.msrpUnavailable.note)}</div>` });
  }

  // 5b1 -- dealer-stated MSRP + the manufacturer's published anchor
  if (a.msrpBasis === "dealer_stated" && Number(a.msrp) > 0) {
    const ref = a.msrpReference;
    deck.push({ label: "MSRP - as stated by the dealer", tone: "muted", glow: false, body:
      `<div style="font-size:18px;font-weight:900;color:#33305A;">${money(a.msrp)}</div>` +
      `<div style="font-size:12.5px;color:#33305A;margin-top:6px;line-height:1.5;">This is the figure the dealer states on their own page. We could not verify it against ${escapeHtml(a.make || "the manufacturer")}'s published price, so no over/under-MSRP claim is made from it.` +
      (ref && ref.msrp > 0 ? ` For reference, ${escapeHtml(ref.make || "the manufacturer")} publishes this model${ref.trim ? " (" + escapeHtml(ref.trim) + ")" : ""} from <b>${money(ref.msrp)}</b> - ask which options account for the difference.` : "") +
      `</div>` });
  }

  // AMVIC dealer licence moved up to card 3, 2026-09-10 (it's point 4 now,
  // not an extra beyond the ten) -- no longer built twice.

  // 5b2 -- Finance-contingent price (S37). A flag, not a note: the cash buyer
  // and the buyer with their own bank approval are the ones it costs.
  if (a.financeContingent && a.financeContingent.contingent) {
    const reasons = escapeHtml((a.financeContingent.reasons || []).join(" · "));
    const ev = a.financeContingent.evidence ? escapeHtml(a.financeContingent.evidence) : "";
    deck.push({ label: "Price depends on financing with the dealer", tone: "flag", glow: true, body:
      `<div style="font-size:15px;font-weight:900;color:#A63C25;">This price is tied to taking the dealer's financing</div>` +
      `<div style="font-size:12.5px;color:#33305A;margin-top:6px;line-height:1.5;">The listing's own wording conditions the advertised price on financing through the dealer. Pay cash, or use your own bank, and the price can legitimately change — the discount is often funded by the dealer's commission on the loan, so it leaves with the loan.</div>` +
      (ev ? `<div style="font-size:12px;color:#5B5885;margin-top:8px;font-style:italic;line-height:1.45;">“…${ev}…”</div>` : "") +
      `<div style="font-size:12.5px;color:#33305A;margin-top:8px;line-height:1.5;"><b>Ask before you go in:</b> “What is the price if I pay cash or use my own bank — and if it changes, by exactly how much?” In writing.</div>` +
      (reasons ? `<div style="font-size:11px;color:#706D96;margin-top:6px;">Detected: ${reasons}</div>` : "") });
  }

  // 5c -- Trade-in instant-offer widget (S36): name the mechanism, coach the split
  if (a.tradeInWidget && a.tradeInWidget.detected) {
    const tv = a.tradeInWidget.vendor ? escapeHtml(a.tradeInWidget.vendor) : "";
    deck.push({ label: "Trade-in tool on this listing", tone: "muted", glow: false, body:
      `<div style="font-size:15px;font-weight:900;color:#33305A;">This dealer runs an instant trade-in appraisal widget${tv ? " (" + tv + ")" : ""}</div>` +
      `<div style="font-size:12.5px;color:#33305A;margin-top:6px;line-height:1.5;">Its number is anchored to the wholesale side of the market (what dealers pay each other), it's non-binding, and it appears in exchange for your contact and vehicle details. If you have a trade: settle this vehicle's price first; get the trade offer in writing on its own line — never one blended payment; and check retail listings for your own car before disclosing anything.</div>` });
  }

  // 6 -- Dealer reputation (compact)
  const ds = a.dealerSentiment;
  if (ds && (ds.rating || (ds.highlights || []).length)) {
    const hl = (ds.highlights || []).slice(0, 2).map((h: any) => `<div style="padding:5px 0;border-top:1px solid #eee;font-size:12.5px;color:#33305A;line-height:1.45;"><span style="color:#17756B;font-weight:800;">★${h.rating}</span> ${escapeHtml(h.text)}</div>`).join("");
    deck.push({ label: "Dealer reputation", tone: "muted", glow: false, body: `<div style="font-size:15px;font-weight:800;color:#33305A;">${ds.rating ? "★ " + Number(ds.rating).toFixed(1) : ""}<span style="font-size:12px;color:#706D96;font-weight:600;">${ds.reviewCount ? " · " + Number(ds.reviewCount).toLocaleString() + " Google reviews" : ""}</span></div>${hl}` });
  }

  const total = deck.length;
  const deckHtml = deck.map((c, i) => deckCard(i + 1, total, c.label, c.tone, c.body, c.glow)).join("");

  // capstone -- "say this at the table" always glows (it's the part people act on)
  const cs = a.counterScript;
  let sayHtml = "";
  if (cs && Array.isArray(cs.moves) && cs.moves.length) {
    const items = cs.moves.map((mv: any, i: number) => `<div style="font-size:13px;color:#33305A;padding:6px 0;${i > 0 ? "border-top:1px solid rgba(51,48,90,.1);" : ""}line-height:1.5;"><b style="color:#17756B;">${i + 1}.</b> ${escapeHtml(String(mv?.say || ""))}</div>`).join("");
    sayHtml = `<div style="background:#fff;border:1px solid #3ae0ff;border-radius:14px;padding:16px;margin-bottom:11px;box-shadow:0 0 0 1px #3ae0ff,0 0 14px 2px rgba(58,224,255,.42);">
      <div style="font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#17756B;margin-bottom:6px;">★ ${cs.clean ? "Say this to confirm" : "Say this at the table"}</div>${items}</div>`;
  }
  return { total, deckHtml, sayHtml };
}

function buildEmailHtml(analysis: any, reportUrl?: string, verifyUrl?: string, sealedShot?: SealedShot | null): string {
  const a = analysis;
  const { total, deckHtml, sayHtml } = buildDeckBody(a);
  // The capture box renders ONLY off the handler's verified SealedShot — the
  // same object that drives the actual attachment — so the email copy and the
  // attachment can never disagree (divergent-gate class, capture.test.ts).
  const hasShot = !!sealedShot;
  return `
  <div style="font-family:'Nunito',system-ui,-apple-system,sans-serif;background:#FBF5EC;padding:24px;">
    <div style="max-width:560px;margin:0 auto;">
      <div style="font-weight:800;font-size:18px;color:#33305A;margin-bottom:4px;">LotCheck Quote Check</div>
      <div style="font-size:13px;color:#706D96;margin-bottom:14px;">${escapeHtml(a.vehicle || "Your quote")}</div>
      ${coverCard(a)}
      ${reportUrl ? `<div style="margin-bottom:14px;"><a href="${escapeHtml(reportUrl)}" style="display:inline-block;background:#17756B;color:#fff;font-weight:800;font-size:14px;text-decoration:none;padding:12px 22px;border-radius:10px;">View your interactive report</a><div style="font-size:11px;color:#706D96;margin-top:6px;">Swipe through the deck in your browser, or open the attached PDF.</div></div>` : ""}
      ${verifyUrl ? `<div style="margin-bottom:14px;padding:12px 14px;background:#fff;border:1px solid #eee;border-radius:12px;"><div style="font-size:12px;color:#33305A;font-weight:800;">${a.reportId ? escapeHtml(a.reportId) : "Your report"} — tamper-evident</div><div style="font-size:12px;color:#5B5885;line-height:1.5;margin:4px 0 0;">If a dealer questions this report, <a href="${escapeHtml(verifyUrl)}" style="color:#17756B;font-weight:700;">verify it here</a> — the ID is a fingerprint of its contents, so any altered figure changes it. We store nothing.</div></div>` : ""}
      ${hasShot ? `<div style="margin-bottom:14px;padding:12px 14px;background:#fff;border:1px solid #eee;border-radius:12px;"><div style="font-size:12px;color:#33305A;font-weight:800;">Attached: the listing, as it looked at report time</div><div style="font-size:12px;color:#5B5885;line-height:1.5;margin:4px 0 0;">The capture rides along as its own photo file. Its fingerprint is sealed in the signed report — if the page ever changes, ${verifyUrl ? `drop the photo on <a href="${escapeHtml(verifyUrl)}" style="color:#17756B;font-weight:700;">the verify page</a>` : "drop the photo on lotcheck.ca/verify"} to prove yours is the untouched original. Keep this email — nothing is stored on our end.</div></div>` : ""}
      <div style="font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#706D96;margin:6px 2px 8px;">The audit · ${total} card${total > 1 ? "s" : ""} · flagged cards glow</div>
      ${deckHtml}
      ${sayHtml}
      <div style="text-align:center;margin-top:18px;font-size:11px;color:#706D96;line-height:1.5;">
        Read from the dealer's page by an automated system, including AI reading when it can't be parsed directly — verify the numbers against the original listing before you rely on them.
        <br/>Sent once to the address you entered — not saved on our end.
        <br/><a href="https://lotcheck.ca/quote-check" style="color:#17756B;font-weight:700;">Check another quote</a>
      </div>
    </div>
  </div>`;
}

// ── PDF attachment ──────────────────────────────────────────────────────────
// THE CAR'S OWN PHOTOGRAPH is a PARAMETER of buildReportPdf, not something it
// resolves. This endpoint is unauthenticated and gated only on the report
// signature, so the decision "may this picture be printed, and from where" is
// made once, in the handler, after verifyReportAuthenticity() has passed -- the
// same rule SealedShot already follows. The rules themselves live in
// _shared/vehicle-photo.ts so they can be imported by a test.

// Builds a clean, printable one-to-few-page PDF of the report with pdf-lib
// (server-side, nothing stored). Text is sanitized to WinAnsi (StandardFonts
// only encode that set) so an odd glyph can never crash the generator. Callers
// wrap this in try/catch — a PDF failure must never block the email itself.
function pdfSafe(s: unknown): string {
  return String(s ?? "")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-").replace(/•/g, "-").replace(/…/g, "...")
    .replace(/[★☆\u2B50]/g, "*").replace(/▲/g, "^").replace(/▼/g, "v")
    .replace(/[✓✔⚑⚐]/g, "").replace(/[^\x20-\x7E -ÿ]/g, "");
}
// Chunked base64 for the PDF bytes (Deno's btoa needs a binary string).
function u8ToB64(u8: Uint8Array): string {
  let s = ""; const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk) as unknown as number[]);
  return btoa(s);
}
// Sealed listing capture — shape/size/magic-byte validation lives in the pure,
// tested module (_shared/capture.ts, pinned by capture.test.ts).
import { parseListingShot, pngPixelCount, capturePageCount, bytesToHex, PNG_PIXEL_BUDGET, SHOT_PDF_EMBED_CAP, type ParsedShot } from "../_shared/capture.ts";
import { fetchVehiclePhoto, photoAnchorOk, type VehiclePhoto } from "../_shared/vehicle-photo.ts";
import { resolvePriceVerified } from "../_shared/price-verified.ts";
import { verifyReportAuthenticity, originAllowed, corsOrigin, REPORT_PUBLIC_KEYS, MAX_BODY_BYTES } from "../_shared/report-auth.ts";
import { qualifyMsrpClaim } from "../_shared/msrp-claim.ts";
import { dealerReputationPoint } from "../_shared/point-state.ts";
import { POINT_TITLES } from "../_shared/report-points.js";
import { reportBands } from "../_shared/report-bands.js";
import { reportCards, cardTally } from "../_shared/report-cards.js";
import { recallDigest, recallsShownNote, warrantyLine, dealerLicenceLine, priceMovesLine, daysOnLotLine, sameVinElsewhereLine, priceCheckState, financingMathNote, marketCountLine, pageDefaultLine, marketCompareLine, olderYearsLine, financeCoverageLine, financeCoverageApplies, insurancePremiumLine, fmtDateEn, fmtMoney } from "../_shared/report-lines.js";
import { brandedTitleLine } from "../_shared/branded-title.js";
import { lotDateLines } from "../_shared/lot-dates.js";

// The count, default, comparison and older-model-year lines (marketCount,
// pageDefault, marketValue, olderYears) come from ONE shared builder, so the
// sentence in this email is the sentence on screen. Nothing in this file
// writes a new sentence for them:
// value / headline / lines / body are used as returned on every surface below
// (HTML deck, audit rows, PDF narrative). The PDF fonts encode WinAnsi only,
// so the em dash becomes a hyphen there.
const noEmDash = (s: unknown): string => String(s ?? "").replace(/—/g, "-");
// Province code -> name, mirroring report-lines.js so the meta line under the
// headline and the body sentence never name the same place two ways.
const provinceNameEn = (code: unknown): string => (String(code || "").toUpperCase() === "AB" ? "Alberta" : String(code || "Alberta"));
// The meta line under each card's headline when there is no confirmed read to
// date: the state, in words. Keyed per line because "absent" means "no other
// listings" for the count and "nothing pre-selected" for the page default.
const MC_STATE_WORD: Record<string, string> = { confirmed: "Confirmed", not_counted: "Not counted", absent: "None read", unchecked: "Not read" };
const PD_STATE_WORD: Record<string, string> = { confirmed: "Read", absent: "None found", unchecked: "Not read" };

// A capture the server has PROVEN is the sealed original: its SHA-256 was
// recomputed here over the actual bytes AND that hash sits inside the report's
// ECDSA-signed canonical (signature checked against LotCheck's public key).
// Only a SealedShot may be attached, printed, or described as "sealed" — the
// endpoint is unauthenticated, so anything less lets an anonymous caller mint
// LotCheck-branded "evidence" for a doctored image (2026-08-12 review).
interface SealedShot extends ParsedShot {
  sha: string;          // computed server-side over shot.bytes
  issuedAt: string | null; // from the VERIFIED canonical, not raw client input
  rid: string;             // report id recomputed from the VERIFIED canonical
  sourceUrl: string | null; // listing URL from the VERIFIED canonical
}

// Public verification keys now live in _shared/report-auth.ts — ONE registry,
// used by both the send gate and the sealed-capture check. Two copies would
// drift on the next key rotation, and a stale copy here would mean captures
// silently stop being treated as sealed while sends kept working.
function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  const bin = atob(s); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i); return arr;
}
async function maybeGunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b && typeof DecompressionStream !== "undefined") {
    // Budgeted read: gzip inflates up to ~1000:1 and this runs BEFORE the
    // signature check on an unauthenticated endpoint, so an unbounded
    // arrayBuffer() hands any caller an OOM lever. Real canonicals are a few
    // KB; anything past the cap is hostile and throws (caller catches -> null).
    const CANON_MAX = 2_000_000;
    const ds = new DecompressionStream("gzip");
    const w = ds.writable.getWriter();
    // Fire-and-catch: a corrupt stream rejects these promises OUTSIDE the
    // caller's try/catch — unhandled, that kills the whole isolate mid-send.
    w.write(bytes as unknown as ArrayBufferView).catch(() => {});
    w.close().catch(() => {});
    const reader = ds.readable.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > CANON_MAX) {
        try { await reader.cancel(); } catch { /* already errored */ }
        throw new Error("canonical payload exceeds decompression budget");
      }
      chunks.push(value);
    }
    const out = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }
  return bytes;
}
// Prove the parsed capture is the one sealed in the SIGNED canonical:
// 1) recompute SHA-256 over the decoded bytes (never trust the client's claim),
// 2) verify the ECDSA P-256 signature over the canonical payload bytes
//    (signature is over the RAW canonical string — same as /verify),
// 3) require canonical.shot === computed hash.
// Returns null when any link in that chain fails — unsigned/legacy reports
// simply don't get the capture treatment, which is the honest outcome.
async function verifySealedShot(analysis: any, shot: ParsedShot): Promise<SealedShot | null> {
  try {
    const dig = await crypto.subtle.digest("SHA-256", shot.bytes as unknown as ArrayBuffer);
    const sha = bytesToHex(new Uint8Array(dig));
    const pubB64 = analysis?.keyId ? REPORT_PUBLIC_KEYS[analysis.keyId] : null;
    if (!pubB64 || !analysis?.sig || !analysis?.verifyPayload) return null;
    const canonBytes = await maybeGunzip(b64urlToBytes(String(analysis.verifyPayload)));
    const spki = Uint8Array.from(atob(pubB64), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64urlToBytes(String(analysis.sig)), canonBytes as unknown as ArrayBuffer);
    if (!ok) return null;
    const canonical = JSON.parse(new TextDecoder().decode(canonBytes));
    if (canonical?.shot !== sha) return null;
    // Bind the seal to THIS report. A valid signature only proves the image is
    // sealed in SOME LotCheck canonical — without this check an attacker can
    // keep a genuine (verifyPayload, sig, keyId, listingShot) quad and rewrite
    // every other analysis field, transplanting the seal's credibility onto
    // fabricated report content (cross-report splice). The report id is the
    // canonical's own fingerprint, so recompute it here and require the match.
    const fpDig = await crypto.subtle.digest("SHA-256", canonBytes as unknown as ArrayBuffer);
    const fp = bytesToHex(new Uint8Array(fpDig));
    const rid = "LC-" + fp.slice(0, 4).toUpperCase() + "-" + fp.slice(4, 7).toUpperCase(); // mirrors makeReportId (src/App.jsx)
    if (String(analysis?.reportId || "") !== rid) return null;
    const issuedAt = typeof canonical?.issuedAt === "string" && !Number.isNaN(Date.parse(canonical.issuedAt)) ? canonical.issuedAt : null;
    // Caption facts come from the VERIFIED canonical, never the client's
    // mutable analysis fields (forged-evidence class).
    const sourceUrl = typeof canonical?.source?.url === "string" ? canonical.source.url : null;
    return { ...shot, sha, issuedAt, rid, sourceUrl };
  } catch (e) {
    console.warn("Sealed-shot verification failed:", (e as Error)?.message);
    return null;
  }
}
// Stable, non-random report number from vehicle + dealer (same input -> same No.).
function reportNo(a: any): string {
  const s = (a.vehicle || "") + (a.dealerName || "");
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return "LC-" + (1000 + (h % 9000));
}

// The canonical 10 verification points. ALWAYS returns exactly 10 rows, each
// with its own result -- a point with no data reads "NOT ON QUOTE"/"N/A", never
// omitted, so the "10-POINT" label is always backed (claims must stay backed)
// and a dealer can see every point and its outcome (dispute-proof).
// Total of the fees the DEALER itemised on their own listing. These sit
// separately from addOns because, where the page's arithmetic proves it, they
// are already INSIDE the advertised price rather than added on top -- see
// _shared/d2c-vdp.js and the analyze-listing-url attach site.
function dealerFeeTotal(a: any): number {
  const fees = a?.dealerLineItems?.fees;
  if (!Array.isArray(fees)) return 0;
  return fees.reduce((t: number, f: any) => t + (Number(f?.amount) || 0), 0);
}

function tenPoints(a: any): Array<{ t: string; v: string; tone: "pass" | "flag" | "muted" }> {
  const money = (n: unknown) => { const v = Number(n); return (!n || Number.isNaN(v)) ? "-" : "$" + v.toLocaleString("en-CA"); };
  const qp = Number(a.quotedPrice) || 0, ms = Number(a.msrp) || 0;
  const pv = resolvePriceVerified(a).sourceVerified;
  const P: Array<{ t: string; v: string; tone: "pass" | "flag" | "muted" }> = [];
  // ── THE CANONICAL TEN, FROM THE SAME FILE THE SCREEN READS ────────────────
  //
  // Seventy lines of hand-written pushes used to live here, deciding the same
  // ten points the on-screen report decided separately from the same analysis
  // object. They disagreed in production: an unread drivetrain printed
  // "NOT DETERMINED" on screen and "N/A (GAS)" in this document -- a fabricated
  // fact about the car, in the artifact the buyer carries INTO the dealership.
  //
  // PR #455 moved the screen onto report-bands.js and left this file as the
  // second author. That was the whole remaining exposure: the PDF is the
  // surface that gets printed, forwarded and argued over, and it was the one
  // still deciding for itself. [[two-authors-per-fact]] [[report-features-all-views]]
  //
  // THE TITLES ARE UNCHANGED. report-bands.js was written from this file's own
  // canonical ten, so every heading a buyer already recognises is identical --
  // this swaps the author, not the wording. What it does change is that the
  // four states now agree across surfaces: a check that did not run renders as
  // "not checked" in both places instead of one of them inventing a value.
  //
  // Extras below are untouched: they already read shared builders, and the ten
  // is a FLOOR we advertise, never a cap. [[ten-point-claim-policy]]
  for (const b of reportBands(a)) {
    P.push({
      t: b.title,
      v: b.value,
      tone: b.state === "raise" ? "flag" : b.state === "clear" ? "pass" : "muted",
    });
  }
  // TITLE STATUS — salvage / rebuilt / reconstructed.
  //
  // Placed here, immediately AFTER the canonical ten, so it lands first among
  // the "also checked" extras. report-points.js is explicit that the advertised
  // ten is fixed and extras are never counted among them, and changing what is
  // advertised is not a code decision.
  //
  // It is nonetheless the most decision-relevant fact on some listings — the
  // brand is permanent in Alberta, every future seller must disclose it, and it
  // drives insurability, financing, resale and, on an EV, whether the maker
  // still supports the car. Until 2026-09-12 it was not read AT ALL: a listing
  // stating "carries a REBUILT TITLE due to previous rear-end damage" produced
  // a report that never mentioned it. First among the extras is where it can
  // ship today; whether it should displace one of the ten is Vic's call.
  // [[ten-point-claim-policy]]
  { const bt = brandedTitleLine(a.brandedTitle); P.push({ t: "Title status", v: bt.value, tone: bt.tone }); }
  // THE LISTING'S OWN DATES. Vic, 2026-09-12: "i want this added to report",
  // looking at a Go Kia page carrying date_on_lot, date_added, date_updated and
  // date_sold side by side. We were reading one of the four.
  //
  // "Listing last updated" is the one days-on-lot cannot replace: it separates
  // a keenly priced car being actively worked from one posted and forgotten,
  // whose asking price is however many days stale. "Sale flag" is the one that
  // protects the buyer — a sale date recorded on a still-live listing is worth
  // one question before driving across town, asked as a question about a data
  // field and never as an allegation.
  //
  // After the canonical ten, like Title status: these are extras by design.
  for (const L of lotDateLines(a.lotDates)) {
    if (L.label === "Days on lot") continue;   // already a point of its own
    P.push({ t: L.label, v: L.value, tone: L.tone });
  }

  // ---- BEYOND THE ADVERTISED FLOOR ----------------------------------------
  // Vic, 2026-08-27: "always good to over deliver ... minimum 10 points we
  // will keep increasing ... add them to pdf file all 14". Ten is a FLOOR we
  // advertise, not a cap we enforce. This used to `return P.slice(0, 10)`,
  // so the emailed PDF -- the artifact a buyer actually forwards to a dealer
  // -- was the THINNEST surface, printing 10 while the app rendered 14. That
  // inverts the priority: the forwarded document should carry everything.
  //
  // The first ten above ALWAYS render (including explicit "not published"
  // states), which is what makes the advertised floor safe. These additional
  // points are conditional on having something real to say -- a point with no
  // data is omitted rather than padded with a dead "-", so the count can rise
  // above ten but never fall below it.
  if (Number(a.msrpCeiling?.trimsConsidered) >= 2 && Number(a.msrpCeiling?.allIn) > 0) {
    P.push({ t: "MSRP per trim", v: `${a.msrpCeiling.trimsConsidered} TRIMS`, tone: "muted" });
  }
  // "Other listings read" ALWAYS prints: the shared builder returns a value for
  // every state, including unchecked, so the row is never blank. The
  // comparableListings branch that stood here read a field no code ever set,
  // so it never printed at all.
  P.push({ t: "Other listings read", v: marketCountLine(a).value, tone: "muted" });
  {
    const dl = daysOnLotLine(a);
    if (dl) P.push({ t: "Days on lot", v: dl.value, tone: Number(a.daysOnLot?.days) >= 90 ? "flag" : dl.tone });
    const sv = sameVinElsewhereLine(a);
    if (sv) P.push({ t: "Also advertised elsewhere", v: sv.value, tone: "muted" });
    const pm = priceMovesLine(a);
    if (pm) P.push({ t: "Advertised price moves", v: pm.value, tone: pm.tone });
  }
  // Dealer licence · AMVIC folded into point 4 above, 2026-09-10 -- no
  // longer pushed here (would duplicate the point's own data).
  if (a.tradeInWidget?.detected) {
    P.push({ t: "Trade-in tool on this listing", v: String(a.tradeInWidget.vendor || "DETECTED").toUpperCase(), tone: "muted" });
  }
  if (a.financeContingent?.contingent) {
    P.push({ t: "Price depends on financing", v: "FLAGGED", tone: "flag" });
  }
  // "Payment default" ALWAYS prints, same builder rule as the count above:
  // NOT PUBLISHED and NOT READ are results, not gaps.
  P.push({ t: "Payment starting point", v: pageDefaultLine(a).value, tone: "muted" });
  return P;
}

// "What this means" — the plain-language translation printed under each audit
// point, mirroring the on-screen explanation layer. DETERMINISTIC: built from
// the same verified fields the point shows (never free-styled), compressed for
// print. Returns null when a point needs no gloss.
function pointExplain(t: string, a: any): string | null {
  const money = (n: unknown) => { const v = Number(n); return (!n || Number.isNaN(v)) ? "-" : "$" + v.toLocaleString("en-CA"); };
  const qp = Number(a.quotedPrice) || 0, ms = Number(a.msrp) || 0;
  const exact = ms > 0 && a.msrpBasis === "exact";
  switch (t) {
    case "Price vs MSRP": {
      // The page itself gated the price ("Call for pricing" or similar) but
      // its own machine-readable data carried the real ask -- a verifiable
      // claim about what the page's own source contains, not an inference
      // about intent (gated-price-recovery memory, point 3). Prefixed onto
      // whichever branch below fires, so the "how" of the comparison stays
      // exactly as accurate as it already was; only the "where this number
      // came from" note is new. Confirmed live 2026-08-22, Okotoks Toyota
      // RAV4 PHEV GR Sport AWD (VIN JTM7ERAV1TD018440): the rendered page
      // shows "Call for pricing" while window.__vdpJSON's own price field
      // held $85,995 the whole time -- also published to Google Vehicle Ads,
      // so this is public information, not a private number LotCheck leaked.
      // The Google Vehicle Ads corroboration is only assertable on NEW units --
      // Google mandates a real (all-in, in Canada) price on those, which is
      // what makes "public either way" a backed statement. On used/CPO the
      // premise does not hold, so the sentence narrows to what we actually
      // verified: the page's own data. (claims-must-stay-backed)
      const gatedNote = (qp && a.priceGatedButRecovered)
        ? (a.priceGateGoogleAdsBacked
            ? `This dealer's page displays "${a.priceGateMessage || "Call for pricing"}" instead of a number -- but the page's own data carries the real asking price, and it's independently published to Google's vehicle ads too, so it's public either way. `
            : `This dealer's page displays "${a.priceGateMessage || "Call for pricing"}" instead of a number -- but the page's own data carries the real asking price shown here. `)
        : "";
      if (!qp && a.priceDisclosure === "contact_for_price") return `The dealer chose not to publish a price - the page says "contact us" instead. That's a lead-capture tactic.${ms ? ` Your anchor: the manufacturer's MSRP starts at ${money(ms)}.` : ""} Get their full all-in price in writing before you visit.`;
      if (!qp) return "No asking price could be read from this listing. Get the full price in writing before anything else.";
      // EXACT IS NOT ENOUGH TO SUBTRACT. An exact-trim match says we found the
      // right row; it says nothing about whether the two figures are measured
      // the same way. In AB/ON/BC/QC the advertised price is all-in by law, and
      // half the catalogue is ex-freight or records no basis, so `qp - ms` on
      // an exact match still counted roughly $3,000 of mandatory freight and
      // levies as the dealer's markup. That is the same subtraction 13o removed
      // from the hero band, the on-screen gap bar and counter-script move S14 --
      // this prose was its fourth author, and it reached the PDF a buyer hands
      // across the desk. qualifyMsrpClaim owns reference selection (all-in vs
      // ex-freight), the basis check and the delta. Never recompute it.
      const claim = qualifyMsrpClaim(a);
      if (qp && ms && exact && claim.comparable && claim.delta !== null) {
        const d = claim.delta;
        return gatedNote + (d > 0
          ? `MSRP is the manufacturer's own sticker for this exact version. The dealer is asking ${money(d)} more than sticker - anything over sticker is pure negotiation room.`
          : d === 0
            ? "MSRP is the manufacturer's own sticker for this exact version. This asks exactly sticker - not a markup, but not a deal either."
            : `MSRP is the manufacturer's own sticker for this exact version. This asks ${money(-d)} below sticker - a real discount; confirm nothing was added back in fees.`);
      }
      // Exact trim, but the two figures are not comparable. The gate's own
      // sentence says why -- an absence is NOTED, never rendered as agreement.
      if (qp && ms && exact && claim.refusal) return gatedNote + claim.refusal;
      // Was hardcoded to the "starting at" story, which is wrong prose for a used
      // car's original MSRP or a dealer-stated figure. The gate owns the reason.
      if (ms) return gatedNote + (qualifyMsrpClaim(a).refusal
        ?? `The manufacturer's price for this model starts at ${money(ms)} for the base version. This exact car carries extra options, so no over/under call is made - use the base figure as your reference and make the dealer justify everything above it.`);
      return gatedNote + "The manufacturer's sticker couldn't be verified for this exact car, so no comparison is made - never trust a savings claim you can't check.";
    }
    case "Listing last updated":
    case "Sale flag on this listing":
    case "Arrival date": {
      const L = lotDateLines(a.lotDates).find((x) => x.label === t);
      return L ? L.line : "";
    }
    case "Title status":
      return brandedTitleLine(a.brandedTitle).line;
    case "Transport Canada recalls":
      if (a.recalls?.checked && a.recalls.count > 0) return `A recall is a safety defect the manufacturer must fix free of charge. Have the dealer complete the repair${a.recalls.count > 1 ? "s" : ""} before delivery - it costs you nothing.`;
      if (a.recalls?.checked && a.recalls.confirmed !== false) return "A recall is a safety defect the manufacturer must fix for free. The government registry shows none outstanding for this model.";
      return "This exact model couldn't be confirmed in the registry - not an all-clear. Check by VIN at Transport Canada (free) before signing.";
    case "Add-ons & fee audit":
      if (!(a.addOns || []).length && dealerFeeTotal(a) <= 0 && a.feesRead !== true) {
        return "We could not read this page's pricing section, so we cannot say whether extras are itemized - this is a gap in our read, not a clean bill. Ask for the full out-the-door breakdown in writing.";
      }
      return (a.addOns || []).length
        ? "These are extras the dealer added on top of the car's price - where dealers make extra margin. You can say no to most of them; every line is one you're allowed to question."
        : "No dealer extras were itemized. That doesn't mean there are none - get the full out-the-door breakdown in writing.";
    case "AMVIC":
      // Worded once in report-lines.js so this sentence can never contradict
      // the deck card's own AMVIC paragraph in the same email.
      return dealerLicenceLine(a).line;
    case "Financing math":
      // Worded once in report-lines.js from the fields computeFinancingCheck
      // records. The old sentence here and on screen named the price and the
      // rate; the check reads neither. [[report-features-all-views]]
      return financingMathNote(a);
    case "Odometer":
      // Branches on the BAND the reading was actually put in, not on
      // vehicleCondition alone. The old string told every new car -- including
      // one reading 12 km -- that "thousands on the clock" meant demo use,
      // directly under our own note saying 12 km is delivery distance.
      if (a.odometerCheck?.checked) {
        const km = Number(a.odometerCheck.km);
        const kmTxt = Number.isFinite(km) ? km.toLocaleString() + " km" : "this reading";
        switch (a.odometerCheck.band) {
          case "new_delivery":
            return `New vehicles do not arrive on zero. Coming off the transport truck, moving around the lot and the pre-delivery inspection all put kilometres on the clock. ${kmTxt} is delivery distance, not use. Read the dash yourself when you see the car and confirm it still matches.`;
          case "new_beyond_delivery":
            return `A new vehicle normally shows only delivery distance. This one reads ${kmTxt}, which is further than a car gets being delivered - most often that means it was a demonstrator or a service loaner. That is a normal part of the business, not a fault. What matters to you is that the factory warranty clock starts when a vehicle goes into service, not when you buy it: ask for the in-service date in writing, and ask how the price reflects it.`;
          case "used_nearly_new":
            return `On a car this new, low kilometres usually mean a demonstrator, a loaner or a short lease return rather than anything unusual. Ask for the in-service date - the factory warranty started then, not on the day you buy.`;
          default:
            return "Compare the reading against the car's age - roughly 15,000-20,000 km per year is typical.";
        }
      }
      return "No odometer reading was shown. Read it off the dash yourself before signing - never off the paperwork alone.";
    case "VIN check":
      return a.vinCheck?.present
        ? "The VIN is the car's unique fingerprint. Before signing, match it against the plate at the base of the windshield so the paperwork is for THIS exact car."
        : "The VIN (the car's unique fingerprint) isn't shown. Ask for it - it unlocks recalls, history, and proof the paperwork matches the car.";
    case "EV / PHEV rebate":
      if (a.evapRebate?.eligible) return "Government money you may qualify for - the dealer doesn't control it. Make sure it's applied on top of your negotiated price, not instead of a discount.";
      if (a.fuelType === "BEV" || a.fuelType === "PHEV") return "This electric/plug-in doesn't qualify (price cap or model list). Don't let anyone imply a government discount that isn't there.";
      return "Rebates apply only to electric and plug-in vehicles - none is in play on a gas vehicle.";
    case "Included warranty":
      return warrantyLine(a).line;

    case "Dealer reputation":
      return dealerReputationPoint(a.dealerSentiment).explain;
    // Both lines gloss themselves: the builder's body IS the plain-language
    // explanation, and it is the same sentence the HTML deck and PDF narrative
    // print. Em dash -> hyphen for the WinAnsi fonts.
    // Both lines carry their full sentence in their own narrative section
    // (OTHER LISTINGS READ / PAYMENT DEFAULT), so the audit row prints the
    // value alone -- one place per sentence, same as Days on lot.
    case "Other listings read":
    case "Payment starting point":
      return null;
    default: return null;
  }
}

// Editorial report — ink-on-cream, typeset masthead (no logo), serif display
// headline, monospace figures, and a vector semicircle leverage gauge. Prints
// clean (no dark fill). The status line + MSRP label flip on whether the
// listing price was actually verified (price-verification gate).
// Unique visual signature ("LotCheck seal") — a guilloché rosette derived from
// the report's ECDSA signature (falls back to reportId). Byte-identical to the
// generator in App.jsx so the printed seal matches the on-screen / verify seal.
// Impossible to reproduce without the private key; changes if any figure changes.
function sealSeed(s: string): number { let h = 2166136261 >>> 0; const str = String(s || "lotcheck"); for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function sealRng(a: number): () => number { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function guillocheRings(seed: number, cx: number, cy: number, R: number, steps: number): string[] {
  const rnd = sealRng(seed);
  const petal = 4 + Math.floor(rnd() * 7), fine = 16 + Math.floor(rnd() * 26), ph = rnd() * 6.28318;
  const a1 = R * (0.10 + rnd() * 0.13), a2 = R * (0.04 + rnd() * 0.07);
  const ring = (scale: number, off: number) => { let d = ""; const n = steps; for (let i = 0; i <= n; i++) { const t = i / n * 6.28318; const rr = R * scale + a1 * Math.sin(petal * t + ph) + a2 * Math.sin(fine * t); const x = cx + (rr + off) * Math.cos(t), y = cy + (rr + off) * Math.sin(t); d += (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1) + " "; } return d; };
  return [ring(1, 0), ring(1, 2.4), ring(0.66, 0), ring(0.66, 1.9)];
}

async function buildReportPdf(a: any, verifyUrl?: string, sealedShot?: SealedShot | null, vehiclePhoto?: VehiclePhoto | null): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("https://esm.sh/pdf-lib@1.17.1");
  const doc = await PDFDocument.create();
  // Poppins throughout — the StandardFonts set (Times/Helvetica) rendered too
  // thin to read comfortably ("hard to see, not bold enough", 2026-08-12).
  // Weight map: body Regular, emphasis Medium, headers SemiBold/Bold, notes
  // MediumItalic. Falls back to StandardFonts if the embed ever fails — a font
  // problem must never cost the user their PDF (no-single-point-of-failure).
  let serif: any, serifB: any, serifI: any, sans: any, sansB: any;
  try {
    const fontkit = (await import("https://esm.sh/@pdf-lib/fontkit@1.1.1")).default;
    const P = await import("../_shared/poppins.ts");
    doc.registerFontkit(fontkit);
    serif  = await doc.embedFont(P.fontBytes(P.POPPINS_REGULAR), { subset: true });
    serifB = await doc.embedFont(P.fontBytes(P.POPPINS_BOLD), { subset: true });
    serifI = await doc.embedFont(P.fontBytes(P.POPPINS_MEDIUM_ITALIC), { subset: true });
    sans   = await doc.embedFont(P.fontBytes(P.POPPINS_MEDIUM), { subset: true });
    sansB  = await doc.embedFont(P.fontBytes(P.POPPINS_SEMIBOLD), { subset: true });
  } catch (e) {
    console.warn("Poppins embed failed, falling back to standard fonts:", (e as Error)?.message);
    serif  = await doc.embedFont(StandardFonts.TimesRoman);
    serifB = await doc.embedFont(StandardFonts.TimesRomanBold);
    serifI = await doc.embedFont(StandardFonts.TimesRomanItalic);
    sans   = await doc.embedFont(StandardFonts.Helvetica);
    sansB  = await doc.embedFont(StandardFonts.HelveticaBold);
  }
  const mono   = await doc.embedFont(StandardFonts.Courier);
  const monoB  = await doc.embedFont(StandardFonts.CourierBold);

  // Dark palette -- "the winner" from the 10-design gallery (Isometric
  // Dashboard Wall / diorama), Vic, 2026-09-10. Every section below draws
  // from these same tokens, so this one swap recolors the whole document.
  // Flat (no 3D tilt) -- diorama's own print CSS already drops the tilt for
  // the printed/PDF state, which is what this ports.
  // A PDF IS PRINTED. THE GROUND IS WHITE.
  // Vic, 2026-09-10, reviewing the dark build: "pages are to dark" ->
  // "for pdf files change them in white backgroud" -> "pdf must [look] the
  // same as price terrain pdf file". The dark HUD stays the approved treatment
  // for the ON-SCREEN report; the emailed PDF is read on paper and gets white.
  // The two surfaces now differ deliberately. [[pdf-must-match-price-terrain]]
  //
  // Accents are the LIGHT-SAFE versions, not the screen ones: #2dd4bf teal on
  // white is 1.9:1 and unreadable as text, so every accent here is darkened
  // until small text clears 4.5:1 on both white and the #F5F7FA panel fill.
  // Measured: TEAL 5.2:1, CORAL 5.8:1, AMBER 5.1:1, FAINT 5.2:1 on white and
  // 4.7:1 on a panel, SOFT 6.9:1, INK 17.8:1.
  const PAPER = rgb(1, 1, 1), INK = rgb(0.078, 0.098, 0.169),
        SOFT = rgb(0.290, 0.329, 0.408), FAINT = rgb(0.384, 0.424, 0.490),
        TEAL = rgb(0.043, 0.478, 0.437), CORAL = rgb(0.725, 0.220, 0.082),
        AMBER = rgb(0.631, 0.384, 0.027),
        HAIR = rgb(0.847, 0.875, 0.910), TRACK = rgb(0.961, 0.969, 0.980),
        // an unfilled gauge arc or range-bar track has to read as a track, so
        // it sits a step below a panel fill rather than sharing it
        RAIL = rgb(0.863, 0.890, 0.925),
        // the recessed surface behind a panel
        PANEL2 = rgb(0.929, 0.945, 0.965),
        PURPLE = rgb(0.427, 0.231, 0.839), PURPLE_LT = rgb(0.545, 0.361, 0.965);

  const PW = 595.28, PH = 841.89, M = 56, W = PW - M * 2;
  let page = doc.addPage([PW, PH]);
  const paper = () => page.drawRectangle({ x: 0, y: 0, width: PW, height: PH, color: PAPER });
  paper();
  let y = PH - M;

  const money = (n: unknown) => { const v = Number(n); return (!n || Number.isNaN(v)) ? "-" : "$" + v.toLocaleString("en-CA"); };
  const priceVerified = resolvePriceVerified(a).sourceVerified;
  const RID = a.reportId || reportNo(a);  // tamper-evident ID stamped client-side; fallback to legacy hash
  const issued = a.issuedAt ? new Date(a.issuedAt) : null;
  const reportDate = a.reportDate || (issued ? issued.toLocaleDateString("en-CA", { month: "long", year: "numeric" }) : new Date().toLocaleDateString("en-CA", { month: "long", year: "numeric" }));

  const need = (h: number) => { if (y - h < M + 30) { page = doc.addPage([PW, PH]); paper(); y = PH - M; } };
  const T = (str: string, o: any = {}) => page.drawText(pdfSafe(str), { x: o.x ?? M, y: y - (o.size ?? 10), size: o.size ?? 10, font: o.font ?? sans, color: o.color ?? INK });
  const Tat = (str: string, yy: number, o: any = {}) => page.drawText(pdfSafe(str), { x: o.x ?? M, y: yy, size: o.size ?? 10, font: o.font ?? sans, color: o.color ?? INK });
  const right = (str: string, o: any = {}) => { const s = pdfSafe(str), f = o.font ?? sans, sz = o.size ?? 10; page.drawText(s, { x: (o.rx ?? M + W) - f.widthOfTextAtSize(s, sz), y: y - sz, size: sz, font: f, color: o.color ?? INK }); };
  const center = (str: string, yy: number, o: any = {}) => { const s = pdfSafe(str), f = o.font ?? sans, sz = o.size ?? 10; page.drawText(s, { x: (o.cx ?? PW / 2) - f.widthOfTextAtSize(s, sz) / 2, y: yy, size: sz, font: f, color: o.color ?? INK }); };
  function wrap(str: string, f: any, size: number, maxW: number): string[] {
    const words = pdfSafe(str).split(/\s+/).filter(Boolean); const out: string[] = []; let cur = "";
    /* pdf-safe: `words` is already split out of pdfSafe(str) above */
    for (const w of words) { const t = cur ? cur + " " + w : w; if (f.widthOfTextAtSize(t, size) > maxW && cur) { out.push(cur); cur = w; } else cur = t; }
    if (cur) out.push(cur); return out;
  }
  const para = (str: string, o: any = {}) => { const f = o.font ?? serif, sz = o.size ?? 10, lead = o.lead ?? 5, mw = o.maxW ?? W, x = o.x ?? M; for (const ln of wrap(str, f, sz, mw)) { need(sz + lead); page.drawText(ln, { x, y: y - sz, size: sz, font: f, color: o.color ?? SOFT }); y -= sz + lead; } };
  // Vic, 2026-09-10: "too many gaps" -- tightened from pad=8/16 (this doc has
  // 15-20+ kicker/rule sections; a few points saved per call compounds across
  // a whole report into real pages). Still enough breathing room to read.
  const rule = (color = HAIR, th = 0.7, pad = 6) => { need(pad * 2); page.drawLine({ start: { x: M, y: y - pad }, end: { x: M + W, y: y - pad }, thickness: th, color }); y -= pad * 2 + 2; };
  const kicker = (str: string) => { need(18); T(str, { size: 8.5, font: sansB, color: TEAL }); y -= 13; };
  const advance = (h: number) => { y -= h; };

  // MEASURE WHAT YOU DRAW.
  // Every drawing helper here passes its string through pdfSafe(), which
  // rewrites characters the embedded fonts cannot set -- and some of those
  // rewrites CHANGE WIDTH: "..." becomes three dots, an em dash becomes a
  // hyphen, a check mark disappears. Measuring the raw string and drawing the
  // rewritten one therefore sizes a box for text that is not what lands in it.
  // Reviewed 2026-09-10: the "also checked" pills measured raw, so a value
  // containing an ellipsis would have been drawn wider than its own border, and
  // a tone chip sized for an em dash drew a hyphen. check:pdf-measure now
  // refuses any width measurement in this file that does not go through here.
  const wSafe = (f: any, str: string, size: number) => f.widthOfTextAtSize(pdfSafe(str), size);

  // ---- ROUNDED PANELS ----
  // Every surface in the approved diorama design is a rounded panel: the card
  // and hero tiles at 14px, the audit tiles at 12px, the chips as full pills.
  // The PDF drew all of them as hard 90-degree rectangles, which is most of
  // why the printed page read as loose text on black rather than as
  // instrumentation mounted on panels (Vic, 2026-09-10, holding the mockup
  // next to the real report).
  //
  // pdf-lib has no rounded-rect primitive, and drawSvgPath's arc sweep flag
  // inverts with its y-axis flip -- an arc that bulges the right way on screen
  // bulges inward on the page. So the shape is composed from three rectangles
  // and four corner circles, which cannot be got wrong, and a border is the
  // outer shape with the fill laid `borderWidth` inside it.
  const rrfill = (x: number, yTop: number, w: number, h: number, r: number, col: any) => {
    if (!(w > 0) || !(h > 0)) return;
    const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
    page.drawRectangle({ x: x + rr, y: yTop - h, width: Math.max(w - rr * 2, 0), height: h, color: col });
    page.drawRectangle({ x, y: yTop - h + rr, width: rr, height: Math.max(h - rr * 2, 0), color: col });
    page.drawRectangle({ x: x + w - rr, y: yTop - h + rr, width: rr, height: Math.max(h - rr * 2, 0), color: col });
    if (rr <= 0) return;
    for (const [ccx, ccy] of [[x + rr, yTop - rr], [x + w - rr, yTop - rr], [x + rr, yTop - h + rr], [x + w - rr, yTop - h + rr]]) {
      page.drawCircle({ x: ccx, y: ccy, size: rr, color: col });
    }
  };
  const rrect = (x: number, yTop: number, w: number, h: number, r: number, o: any = {}) => {
    const bw = o.borderColor ? (o.borderWidth ?? 0.7) : 0;
    if (bw > 0) {
      rrfill(x, yTop, w, h, r, o.borderColor);
      if (o.color) rrfill(x + bw, yTop - bw, w - bw * 2, h - bw * 2, Math.max(r - bw, 0), o.color);
    } else if (o.color) rrfill(x, yTop, w, h, r, o.color);
  };

  // ---- BRAND MARK ---- the 07b "Sticker + Scan" mark (2026-09-24): the window
  // sticker (the quote), the scan line across it, the stamp that says checked.
  // Same 64-unit geometry as the site's SVG and the app icons, flattened to
  // straight-edged polygons because drawSvgPath inverts arc sweep with its
  // y-flip. An entry with a third value is a stroke of that width; the rest are
  // fills, pre-composited over white paper.
  const LOGO_SHAPES: [string, [number, number, number], number?][] = [
    ["M45 4 L46.81 4.24 L48.5 4.94 L49.95 6.05 L51.06 7.5 L51.76 9.19 L52 11 L52 53 L51.76 54.81 L51.06 56.5 L49.95 57.95 L48.5 59.06 L46.81 59.76 L45 60 L15 60 L13.19 59.76 L11.5 59.06 L10.05 57.95 L8.94 56.5 L8.24 54.81 L8 53 L8 11 L8.24 9.19 L8.94 7.5 L10.05 6.05 L11.5 4.94 L13.19 4.24 L15 4Z",[0.0431,0.1059,0.2471]],
    ["M45 8 L45.78 8.1 L46.5 8.4 L47.12 8.88 L47.6 9.5 L47.9 10.22 L48 11 L48 53 L47.9 53.78 L47.6 54.5 L47.12 55.12 L46.5 55.6 L45.78 55.9 L45 56 L15 56 L14.22 55.9 L13.5 55.6 L12.88 55.12 L12.4 54.5 L12.1 53.78 L12 53 L12 11 L12.1 10.22 L12.4 9.5 L12.88 8.88 L13.5 8.4 L14.22 8.1 L15 8Z",[1,1,1]],
    ["M12 8 L48 8 L48 18 L12 18Z",[0.0431,0.1059,0.2471]],
    ["M36.1 24 L37.05 24.25 L37.75 24.95 L38 25.9 L38 25.9 L37.75 26.85 L37.05 27.55 L36.1 27.8 L17.9 27.8 L16.95 27.55 L16.25 26.85 L16 25.9 L16 25.9 L16.25 24.95 L16.95 24.25 L17.9 24Z",[0.3302,0.3741,0.473]],
    ["M58.5 31 L59.75 31.33 L60.67 32.25 L61 33.5 L61 33.5 L60.67 34.75 L59.75 35.67 L58.5 36 L5.5 36 L4.25 35.67 L3.33 34.75 L3 33.5 L3 33.5 L3.33 32.25 L4.25 31.33 L5.5 31Z",[0.1137,0.4196,1]],
    ["M57.5 47 L57.29 49.34 L56.69 51.62 L55.69 53.75 L54.34 55.68 L52.68 57.34 L50.75 58.69 L48.62 59.69 L46.34 60.29 L44 60.5 L41.66 60.29 L39.38 59.69 L37.25 58.69 L35.32 57.34 L33.66 55.68 L32.31 53.75 L31.31 51.62 L30.71 49.34 L30.5 47 L30.71 44.66 L31.31 42.38 L32.31 40.25 L33.66 38.32 L35.32 36.66 L37.25 35.31 L39.38 34.31 L41.66 33.71 L44 33.5 L46.34 33.71 L48.62 34.31 L50.75 35.31 L52.68 36.66 L54.34 38.32 L55.69 40.25 L56.69 42.38 L57.29 44.66Z",[1,1,1]],
    ["M54.5 47 L54.34 48.82 L53.87 50.59 L53.09 52.25 L52.04 53.75 L50.75 55.04 L49.25 56.09 L47.59 56.87 L45.82 57.34 L44 57.5 L42.18 57.34 L40.41 56.87 L38.75 56.09 L37.25 55.04 L35.96 53.75 L34.91 52.25 L34.13 50.59 L33.66 48.82 L33.5 47 L33.66 45.18 L34.13 43.41 L34.91 41.75 L35.96 40.25 L37.25 38.96 L38.75 37.91 L40.41 37.13 L42.18 36.66 L44 36.5 L45.82 36.66 L47.59 37.13 L49.25 37.91 L50.75 38.96 L52.04 40.25 L53.09 41.75 L53.87 43.41 L54.34 45.18Z",[0.1137,0.4196,1]],
    ["M38.48 47.48 L42.68 51.68 L50.12 44.24",[1,1,1],3.72],
  ];
  const drawLogo = (x0: number, yTop: number, w: number) => {
    // Callers size the box by width (the old mark was 320x182). The new mark is
    // square, so it fills that box's HEIGHT and sits centred in its width --
    // every existing call site keeps its footprint and alignment.
    const S = w * 182 / 320, s = S / 64, ax = x0 + (w - S) / 2;
    for (const [path, c, sw] of LOGO_SHAPES) {
      page.drawSvgPath(path, sw
        ? { x: ax, y: yTop, scale: s, borderColor: rgb(c[0], c[1], c[2]), borderWidth: sw, borderLineCap: 1 }
        : { x: ax, y: yTop, scale: s, color: rgb(c[0], c[1], c[2]) });
    }
  };
  // Unique seal — cxAbs = horizontal centre, cyCentre = vertical centre, S = radius-ish.
  // Stroke-only (borderColor, no fill) so it prints as fine guilloché lines.
  const SEALSEED = sealSeed(a.sig || RID);
  const drawSeal = (cxAbs: number, cyCentre: number, S: number) => {
    // Certificate frame — two concentric rings so the guilloché reads as a
    // proper wax/stamp seal rather than a loose spiky shape.
    page.drawEllipse({ x: cxAbs, y: cyCentre, xScale: S * 1.46, yScale: S * 1.46, borderColor: PURPLE, borderWidth: 1 });
    page.drawEllipse({ x: cxAbs, y: cyCentre, xScale: S * 1.34, yScale: S * 1.34, borderColor: TEAL, borderWidth: 0.5 });
    const rings = guillocheRings(SEALSEED, cxAbs, 0, S, 420);
    rings.forEach((d, i) => page.drawSvgPath(d, { x: 0, y: cyCentre, borderColor: i < 2 ? PURPLE : TEAL, borderWidth: i % 2 ? 0.35 : 0.6 }));
    page.drawText("LC", { x: cxAbs - wSafe(monoB, "LC", S * 0.22) / 2, y: cyCentre - S * 0.22 / 2, size: S * 0.22, font: monoB, color: INK });
  };
  // Plain verified badge -- a filled green circle with a white check mark,
  // no ornament. Replaces the guilloché seal in the masthead: Vic, 2026-09-10,
  // "i don't like qr code and check lc report on top right dosent look
  // professional" -- a checkmark reads as "verified" at a glance, a seal ring
  // does not. [[verification-needs-green-checkmark]]
  const drawCheckBadge = (cxAbs: number, cyCentre: number, S: number) => {
    page.drawCircle({ x: cxAbs, y: cyCentre, size: S, color: TEAL });
    page.drawSvgPath("M-4.6 0.3 L-1.4 3.6 L5 -4.2", {
      x: cxAbs, y: cyCentre, scale: S / 11,
      borderColor: PAPER, borderWidth: 2.6,
    });
  };

  const qp = Number(a.quotedPrice) || 0, ms = Number(a.msrp) || 0;
  // MSRP basis, NOT quotedPrice verification -- "VERIFIED" must mean exact-trim
  // match, never a base-trim "starting at" floor, or the header makes an
  // over/under claim the audit detail below it explicitly disclaims.
  const msrpExact = ms > 0 && a.msrpBasis === "exact";

  // ---- MASTHEAD ----
  // ════════════════════════════════════════════════════════════════════════
  // THE REDESIGN (2026-09-24, "Hub & Spoke"). Page 1 is thirteen cards around
  // the car; the summary and thank-you page follows it; then the full detail
  // below, every section it always had. Every state, value and word on these
  // pages comes from reportCards() -- this block only draws.
  // [[one-report-new-and-used]] [[traffic-column-report-direction]]
  // ════════════════════════════════════════════════════════════════════════
  let heroImg: any = null;
  if (vehiclePhoto) {
    try {
      heroImg = vehiclePhoto.kind === "png" ? await doc.embedPng(vehiclePhoto.bytes) : await doc.embedJpg(vehiclePhoto.bytes);
    } catch (e) {
      console.warn("Vehicle photo embed failed:", (e as Error)?.message);
      heroImg = null;
    }
  }
  // Pre-embed the sealed capture BEFORE the footer text so the footer can only
  // promise pages that will actually exist (embed failures, oversize captures,
  // and PNG pixel bombs all resolve to capImg = null here, never mid-promise).
  let capImg: any = null;
  if (sealedShot && sealedShot.b64.length <= SHOT_PDF_EMBED_CAP) {
    try {
      if (sealedShot.ext === "png") {
        const px = pngPixelCount(sealedShot.bytes);
        if (px !== null && px <= PNG_PIXEL_BUDGET) capImg = await doc.embedPng(sealedShot.bytes);
        else console.warn(`Capture PDF embed skipped: PNG pixel count ${px} over budget.`);
      } else {
        capImg = await doc.embedJpg(sealedShot.bytes);
      }
    } catch (e) { console.warn("Capture embed skipped:", (e as Error)?.message); capImg = null; }
  }
  // Page geometry hoisted ABOVE the footer text: a capture can embed fine yet
  // slice to zero pages (extreme wide-thin aspect), and the footer may only
  // promise pages that will actually render.
  // 13 PAGES, AND DERIVED AT THE NARROWEST CAPTURE, NOT THE WIDEST.
  //
  // Raising what we CAPTURE without raising what we PRINT is half a two-step:
  // the bigger captures would simply be truncated on paper instead. But the
  // page count cannot be derived at 1920, because capScaledH above scales by
  // the CAPTURE's own width -- so a NARROWER source image prints TALLER, and
  // the narrow ones are exactly what the refit ladder produces on the tall
  // pages that need the pages most. Deriving at 1920 would repeat, one
  // constant over, the mistake this whole change is about.
  //
  // So derive at CAPTURE_MIN_WIDTH = 1024, the narrowest the ladder can emit.
  // The tallest capture on record here is a 17,729 px capitalchev.ca page:
  // scaledH = 17,729 * (483.28 / 1024) = 8,367 pt, and 1 + ceil((8367 -
  // 629.89) / 695.89) = 13 pages. At 1920 the same page needs 7. Thirteen is
  // the ceiling, not the typical count -- an ordinary 5,900 px listing prints
  // in 4 -- and the image is embedded ONCE and drawn per page, so extra pages
  // cost drawing instructions, not megabytes. capture.test.ts hand-copies
  // these constants and test:capture-whole-page fails if the copy drifts.
  const CAP_HEAD_FIRST = 100, CAP_HEAD_REST = 34, CAP_MAXP = 13;
  const capScaledH = capImg ? capImg.height * (W / capImg.width) : 0;
  const capU0 = PH - M * 2 - CAP_HEAD_FIRST, capUR = PH - M * 2 - CAP_HEAD_REST;
  const capPages = capImg ? capturePageCount(capScaledH, capU0, capUR, CAP_MAXP) : 0;

  {
    const cards = reportCards(a);
    const tally = cardTally(cards);
    const HM = 30, CW = PW - HM * 2;
    const NAVY = rgb(0.043, 0.106, 0.247), BLUE = rgb(0.114, 0.420, 1), CARD = rgb(0.055, 0.114, 0.251);
    const WHITE = rgb(1, 1, 1), MUTE = rgb(0.765, 0.804, 0.878), CYAN = rgb(0.361, 0.784, 1), HATCH = rgb(0.165, 0.227, 0.357);
    const DK: any = { raise: rgb(1, 0.420, 0.341), clear: rgb(0.243, 0.878, 0.561), noted: rgb(0.706, 0.737, 0.796), unchecked: rgb(0.549, 0.584, 0.659) };
    const LT: any = { raise: rgb(0.678, 0.192, 0.098), clear: rgb(0.086, 0.420, 0.314), noted: rgb(0.435, 0.420, 0.388), unchecked: rgb(0.435, 0.420, 0.388) };
    const LTBG: any = { raise: rgb(0.984, 0.925, 0.910), clear: rgb(0.906, 0.953, 0.933), noted: rgb(0.945, 0.941, 0.933), unchecked: rgb(0.957, 0.957, 0.949) };
    const WORDS: any = { raise: "RAISE IT", clear: "VERIFIED", noted: "NOTED", unchecked: "NOT CHECKED" };
    const isNewCar = String(a.vehicleCondition || "").toLowerCase() === "new";
    const cond = isNewCar ? "new" : "used";
    const vehTitle = a.vehicle || [a.year, a.make, a.model, a.trim].filter(Boolean).join(" ") || "Your quote";

    // One path per rounded box. rrect() builds a box from abutting rectangles,
    // and on these dark cards the border shows through the seams as hairlines.
    // Corners are quadratic curves: drawSvgPath flips an arc's sweep.
    const rpath = (x: number, yTop: number, w: number, h: number, r: number, o: any = {}) => {
      if (!(w > 0) || !(h > 0)) return;
      const q = Math.max(0, Math.min(r, w / 2, h / 2));
      const d = `M${q} 0 L${w - q} 0 Q${w} 0 ${w} ${q} L${w} ${h - q} Q${w} ${h} ${w - q} ${h} L${q} ${h} Q0 ${h} 0 ${h - q} L0 ${q} Q0 0 ${q} 0 Z`;
      page.drawSvgPath(d, { x, y: yTop, ...(o.color ? { color: o.color } : {}), ...(o.borderColor ? { borderColor: o.borderColor, borderWidth: o.borderWidth ?? 0.7 } : {}) });
    };
    const TX = (s: string, x: number, yy: number, size: number, font: any, color: any, o: any = {}) =>
      page.drawText(pdfSafe(s), { x, y: yy, size, font, color, ...o });
    const TC = (s: string, cx: number, yy: number, size: number, font: any, color: any) => TX(s, cx - wSafe(font, s, size) / 2, yy, size, font, color);
    const TR = (s: string, rx: number, yy: number, size: number, font: any, color: any) => TX(s, rx - wSafe(font, s, size), yy, size, font, color);
    const fit = (s: string, font: any, size: number, maxW: number) => { let z = size; while (z > 5 && wSafe(font, s, z) > maxW) z -= 0.25; return z; };
    const clamp = (s: string, font: any, size: number, maxW: number, max: number) => {
      const ls = wrap(s, font, size, maxW);
      if (ls.length <= max) return ls;
      const out = ls.slice(0, Math.max(max, 1));
      let last = out[out.length - 1];
      while (last && wSafe(font, last + "...", size) > maxW) last = last.replace(/\s*\S+$/, "");
      out[out.length - 1] = last + "...";
      return out;
    };
    const splitTitle = (t: string): [string, string] => {
      const fixed: any = { "Add-ons & fee audit": ["Add-ons &", "fee audit"], "EV / PHEV rebate": ["EV / PHEV", "rebate"] };
      if (fixed[t]) return fixed[t];
      const w = String(t).split(" ");
      if (w.length < 2) return [t, ""];
      return [w.slice(0, -1).join(" "), w[w.length - 1]];
    };

    // The state glyph: shape AND word carry the state, so a photocopy still reads.
    const glyph = (st: string, cx: number, cy: number, r: number, col: any, ink: any) => {
      if (st === "raise") {
        page.drawSvgPath(`M0 ${-r} L${r} ${r * 0.85} L${-r} ${r * 0.85} Z`, { x: cx, y: cy, color: col });
        page.drawLine({ start: { x: cx, y: cy + r * 0.38 }, end: { x: cx, y: cy - r * 0.18 }, thickness: r * 0.26, color: ink });
        page.drawCircle({ x: cx, y: cy - r * 0.5, size: r * 0.14, color: ink });
      } else if (st === "clear") {
        page.drawCircle({ x: cx, y: cy, size: r, color: col });
        page.drawSvgPath(`M${-r * 0.45} 0 L${-r * 0.1} ${r * 0.35} L${r * 0.5} ${-r * 0.35}`, { x: cx, y: cy, borderColor: ink, borderWidth: r * 0.28, borderLineCap: 1 });
      } else if (st === "noted") {
        rpath(cx - r, cy + r, r * 2, r * 2, r * 0.35, { color: col });
        page.drawLine({ start: { x: cx - r * 0.5, y: cy }, end: { x: cx + r * 0.5, y: cy }, thickness: r * 0.28, color: ink });
      } else {
        page.drawCircle({ x: cx, y: cy, size: r, borderColor: col, borderWidth: r * 0.22 });
        for (const k of [-0.45, 0, 0.45]) page.drawLine({ start: { x: cx + (k - 0.35) * r, y: cy - 0.55 * r }, end: { x: cx + (k + 0.35) * r, y: cy + 0.55 * r }, thickness: r * 0.16, color: col });
      }
    };

    // ── ICONS, one per card, drawn in brand blue so they never compete with the state colour.
    const FACE = rgb(0.227, 0.557, 1), DEEP = rgb(0.043, 0.184, 0.471), PALE = rgb(0.867, 0.945, 1), INKD = rgb(0.039, 0.086, 0.2);
    const icon = (key: string, x: number, yTop: number, size: number, dim: boolean) => {
      const s = size / 34, op = dim ? 0.4 : 1;
      const P = (d: string, dx: number, dy: number, sc: number, color: any) => page.drawSvgPath(d, { x: x + dx * s, y: yTop - dy * s, scale: s * sc, color, opacity: op });
      const PS = (d: string, color: any, w: number) => page.drawSvgPath(d, { x, y: yTop, scale: s, borderColor: color, borderWidth: w * s, borderLineCap: 1, borderOpacity: op });
      const R = (rx: number, ry: number, w: number, h: number, color: any) => page.drawRectangle({ x: x + rx * s, y: yTop - (ry + h) * s, width: w * s, height: h * s, color, opacity: op });
      const Ci = (cx: number, cy: number, r: number, color: any, border?: [any, number]) => page.drawCircle({ x: x + cx * s, y: yTop - cy * s, size: r * s, ...(color ? { color, opacity: op } : {}), ...(border ? { borderColor: border[0], borderWidth: border[1] * s, borderOpacity: op } : {}) });
      const twice = (d: string, dx = 0, dy = 0, sc = 1) => { P(d, dx + 1.2, dy + 1.8, sc, DEEP); P(d, dx, dy, sc, FACE); };
      switch (key) {
        case "price_vs_msrp": case "used_vs_new_tag":
          twice("M4 6.5 Q4 4 6.5 4 L17 4 L30 17 Q31.5 18.5 30 20 L20 30 Q18.5 31.5 17 30 L4 17 Z");
          Ci(10, 10, 2.3, INKD);
          page.drawText("$", { x: x + 16 * s, y: yTop - 22 * s, size: 11 * s, font: serifB, color: WHITE, opacity: op });
          break;
        case "recalls":
          twice("M22.7 19 L13.6 9.9 C14.5 7.6 14 4.9 12.1 3 C10.1 1 7.1 0.6 4.7 1.7 L9 6 L6 9 L1.6 4.7 C0.4 7.1 0.9 10.1 2.9 12.1 C4.8 14 7.5 14.5 9.8 13.6 L18.9 22.7 C19.3 23.1 19.9 23.1 20.3 22.7 L22.6 20.4 C23.1 20 23.1 19.3 22.7 19 Z", 4, 4, 1.1);
          break;
        case "fees":
          R(6.2, 4.8, 19, 25, DEEP); R(5, 3, 19, 25, FACE);
          R(9, 8, 11, 1.8, PALE); R(9, 12, 11, 1.8, PALE); R(9, 16, 7, 1.8, PALE);
          Ci(23, 23, 5.6, INKD, [WHITE, 2.4]);
          PS("M27.2 27.2 L31 31", WHITE, 3);
          break;
        case "dealer_licence":
          R(4.2, 8.8, 28, 21, DEEP); R(3, 7, 28, 21, FACE);
          Ci(10.5, 14.5, 3, PALE); R(6.5, 19, 8, 4.5, PALE); R(17, 12.5, 10, 1.8, PALE); R(17, 16.5, 7, 1.8, PALE);
          Ci(27, 25, 4.6, WHITE);
          PS("M24.9 25.1 L26.4 26.6 L29.2 23.6", FACE, 1.6);
          break;
        case "finance_math":
          R(8.2, 4.8, 20, 28, DEEP); R(7, 3, 20, 28, FACE); R(10, 6, 14, 6, PALE);
          for (const bx of [10.5, 15.5, 20.5]) for (const by of [15, 20, 25]) R(bx, by, 3.4, 3.2, WHITE);
          break;
        case "odometer": {
          Ci(18.2, 19.8, 14, DEEP); Ci(17, 18, 14, FACE); Ci(17, 18, 10.8, INKD);
          const pts: string[] = [];
          for (let t = 150; t <= 390; t += 15) { const r = (t * Math.PI) / 180; pts.push(`${(17 + 8.5 * Math.cos(r)).toFixed(2)} ${(18 + 8.5 * Math.sin(r)).toFixed(2)}`); }
          PS("M" + pts.join(" L"), rgb(0.561, 0.816, 1), 1.8);
          PS("M17 18 L22.4 11.8", WHITE, 2);
          Ci(17, 18, 2, WHITE);
          break;
        }
        case "vin":
          R(3.2, 9.8, 30, 19, DEEP); R(2, 8, 30, 19, FACE); R(5, 11, 24, 13, rgb(0.918, 0.961, 1));
          for (const [bx, bw] of [[6.5, 1.2], [8.5, 2], [11.3, 1], [13, 2.4], [16.1, 1], [17.8, 1.6], [20.1, 2.2], [23.1, 1], [24.8, 2], [27.4, 0.9]]) R(bx, 12.5, bw, 10, DEEP);
          break;
        case "rebate":
          Ci(18.2, 18.8, 14, DEEP); Ci(17, 17, 14, FACE);
          P("M19 5 L10 19 L16 19 L13.5 29 L24 14 L17.5 14 Z", 0, 0, 1, WHITE);
          break;
        case "warranty":
          twice("M17 3 L29 7.5 L29 16 C29 23.5 23.8 28.5 17 31 C10.2 28.5 5 23.5 5 16 L5 7.5 Z");
          PS("M11.5 17 L15.5 21 L23 13", WHITE, 3);
          break;
        case "reputation": {
          const pts: string[] = [];
          for (let i = 0; i < 10; i++) { const ang = ((-90 + i * 36) * Math.PI) / 180, r = i % 2 ? 6.4 : 14.5; pts.push(`${(17 + r * Math.cos(ang)).toFixed(2)} ${(17.5 + r * Math.sin(ang)).toFixed(2)}`); }
          twice("M" + pts.join(" L") + " Z");
          break;
        }
        case "days_on_lot":
          R(5.2, 7.8, 25, 23, DEEP); R(4, 6, 25, 23, FACE); R(4, 6, 25, 6.5, DEEP);
          R(9, 3, 2.6, 6, WHITE); R(21.4, 3, 2.6, 6, WHITE);
          for (const gx of [8, 13, 18, 23]) for (const gy of [16, 20.5]) R(gx, gy, 2.8, 2.6, PALE);
          Ci(25, 25, 7, WHITE); Ci(25, 25, 5.4, null, [FACE, 1.4]);
          PS("M25 22 L25 25.2 L27.2 26.6", FACE, 1.5);
          break;
        case "apr_vs_maker":
          Ci(18.2, 18.8, 14, DEEP); Ci(17, 17, 14, FACE);
          Ci(12, 12.5, 3, null, [WHITE, 2.2]); Ci(22, 21.5, 3, null, [WHITE, 2.2]);
          PS("M23 10.5 L11 23.5", WHITE, 2.4);
          break;
        case "used_vs_new":
          twice("M2 22.5 C2 19.1 4 17.9 6.4 17.3 L10.6 12.4 C11.6 11.3 12.9 10.7 14.4 10.7 L20.8 10.7 C22.4 10.7 23.8 11.3 24.8 12.5 L28.5 17 C31.5 17.4 33 18.9 33 21.6 L33 23.9 C33 24.8 32.3 25.5 31.4 25.5 L3.6 25.5 C2.7 25.5 2 24.8 2 23.9 Z");
          P("M9.6 17.1 L12.6 13.6 C13.2 12.9 14 12.6 14.9 12.6 L17.5 12.6 L17.5 17.1 Z", 0, 0, 1, PALE);
          P("M19.4 12.6 L20.8 12.6 C21.7 12.6 22.6 13 23.2 13.7 L26 17.1 L19.4 17.1 Z", 0, 0, 1, PALE);
          Ci(9.5, 26, 3.6, INKD, [WHITE, 1.4]); Ci(26, 26, 3.6, INKD, [WHITE, 1.4]);
          break;
        case "freight_pdi":
          R(3.2, 9.8, 18, 15, DEEP); twice("M20 12 L26 12 L30 17 L30 23 L20 23 Z"); R(2, 8, 18, 15, FACE);
          P("M22 14 L25.3 14 L27.7 17 L22 17 Z", 0, 0, 1, PALE);
          R(5, 12, 12, 2, PALE); R(5, 16, 8, 2, PALE);
          Ci(8, 25, 3.3, INKD, [WHITE, 1.4]); Ci(25, 25, 3.3, INKD, [WHITE, 1.4]);
          break;
      }
    };

    // 45-degree hatch inside a box: NOT CHECKED never renders as a flat colour,
    // which would read as a quiet pass. [[supervised-correctness-is-not-correctness]]
    const hatch = (x: number, yTop: number, w: number, h: number, col: any, step = 6) => {
      const yb = yTop - h;
      for (let k = -h; k < w; k += step) {
        let x1 = x + k, y1 = yb, x2 = x + k + h, y2 = yTop;
        if (x1 < x) { y1 += x - x1; x1 = x; }
        if (x2 > x + w) { y2 -= x2 - (x + w); x2 = x + w; }
        if (y2 > y1) page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.6, color: col });
      }
    };

    const drawHeader = () => {
      const top = PH - 28;
      drawLogo(HM - 6, top + 2, 34);
      TX("Lot", HM + 26, top - 16, 15, serifB, NAVY);
      TX("Check", HM + 26 + wSafe(serifB, "Lot", 15), top - 16, 15, serifB, BLUE);
      TR("QUOTE CHECK REPORT", PW - HM, top - 7, 6.8, sansB, FAINT);
      TR("No. " + RID + (a.reportDate ? "  -  " + a.reportDate : ""), PW - HM, top - 17, 6.8, sans, FAINT);
      page.drawLine({ start: { x: HM, y: top - 25 }, end: { x: PW - HM, y: top - 25 }, thickness: 1.2, color: NAVY });
      return top - 25;
    };
    const drawFooter = () => {
      page.drawLine({ start: { x: HM, y: 36 }, end: { x: PW - HM, y: 36 }, thickness: 0.6, color: HAIR });
      drawLogo(HM - 4, 31, 16);
      TX("Lot", HM + 12, 22, 7.5, serifB, NAVY);
      TX("Check", HM + 12 + wSafe(serifB, "Lot", 7.5), 22, 7.5, serifB, BLUE);
      TR((verifyUrl ? "Tamper-evident report " : "Report ") + "No. " + RID + (verifyUrl ? "  -  verify at lotcheck.ca/verify" : ""), PW - HM, 23, 6.2, sans, FAINT);
    };

    // One card: dark glass, the state colour on its border, badge on the corner.
    const drawCard = (c: any, x: number, yTop: number, w: number, h: number) => {
      const col = DK[c.state], un = c.state === "unchecked", yb = yTop - h;
      rpath(x, yTop, w, h, 7, { color: CARD, borderColor: col, borderWidth: un ? 0.8 : 1.1 });
      if (un) hatch(x + 1.5, yTop - 1.5, w - 3, h - 3, HATCH);
      page.drawCircle({ x: x + 3, y: yTop - 3, size: 9.6, color: WHITE });
      page.drawCircle({ x: x + 3, y: yTop - 3, size: 8.2, color: WHITE, borderColor: col, borderWidth: 1.3 });
      TC(c.n, x + 3, yTop - 5.4, 6.8, sansB, NAVY);
      icon(c.key, x + 8, yTop - 11, 21, un);
      const tx = x + 34, tw = w - 40;
      let yy = yTop - 15;
      const [t1, t2] = splitTitle(c.title);
      TX(t1.toUpperCase(), tx, yy, fit(t1.toUpperCase(), serifB, 7.4, tw), serifB, col);
      if (t2) { yy -= 8.6; TX(t2.toUpperCase(), tx, yy, fit(t2.toUpperCase(), serifB, 7.4, tw), serifB, WHITE); }
      yy -= 10;
      glyph(c.state, tx + 3.2, yy + 2.4, 3.2, col, CARD);
      TX(WORDS[c.state], tx + 8.5, yy, 6.1, sansB, col);
      const wordW = wSafe(sansB, WORDS[c.state], 6.1);
      const val = String(c.value || "");
      if (val && val !== WORDS[c.state]) {
        if (wSafe(sansB, val, 5.8) <= tw - wordW - 14) TX(val, tx + 8.5 + wordW + 4, yy, 5.8, sansB, col);
        else { yy -= 7.6; TX(val, tx, yy, fit(val, sansB, 5.8, tw), sansB, col); }
      }
      // Suggestion block at the foot, measured first so the summary fills only the space left.
      const sugLab = "SUGGESTION: ";
      const sugLines = clamp(sugLab + (c.suggestion || ""), sans, 5.9, w - 14, 2);
      const sugTop = yb + 5 + sugLines.length * 7.2 + 3;
      page.drawLine({ start: { x: x + 7, y: sugTop }, end: { x: x + w - 7, y: sugTop }, thickness: 0.5, color: rgb(0.2, 0.27, 0.42) });
      sugLines.forEach((ln, i) => {
        const ly = sugTop - 8.4 - i * 7.2;
        if (i === 0 && ln.startsWith("SUGGESTION:")) {
          TX("SUGGESTION:", x + 7, ly, 5.9, sansB, CYAN);
          TX(ln.slice(sugLab.length), x + 7 + wSafe(sansB, "SUGGESTION: ", 5.9), ly, 5.9, sans, WHITE);
        } else TX(ln, x + 7, ly, 5.9, sans, WHITE);
      });
      const room = Math.floor((yy - 5 - sugTop) / 7.6);
      if (room > 0 && c.short) clamp(c.short, sans, 6.2, tw, room).forEach((ln, i) => TX(ln, tx, yy - 8.4 - i * 7.6, 6.2, sans, MUTE));
    };

    // ── PAGE 1 ─────────────────────────────────────────────────────────────
    const hdr = drawHeader();
    TX(vehTitle, HM, hdr - 22, fit(vehTitle, serifB, 15, CW * 0.55), serifB, NAVY);
    const idLine = [a.vinCheck?.vin ? "VIN " + a.vinCheck.vin : null, cond.toUpperCase(), a.odometerKm != null && Number.isFinite(Number(a.odometerKm)) ? Number(a.odometerKm).toLocaleString("en-CA") + " KM" : null, a.dealerCity || null].filter(Boolean).join("  -  ");
    TR(idLine, PW - HM, hdr - 19, fit(idLine, sans, 6.5, CW * 0.44), sans, FAINT);

    // A price tied to the dealer's financing is not the price: it leads page 1.
    const fcx = !!(a.financeContingent && a.financeContingent.contingent);
    if (fcx) {
      rpath(HM, hdr - 29, CW, 15, 3, { color: LTBG.raise, borderColor: LT.raise, borderWidth: 0.7 });
      glyph("raise", HM + 10, hdr - 36.5, 3.4, LT.raise, WHITE);
      const fcT = "PRICE DEPENDS ON FINANCING WITH THE DEALER  -  pay cash or use your own bank and the price can change. Details on page 5.";
      TX(fcT, HM + 19, hdr - 38.8, fit(fcT, sansB, 6.4, CW - 26), sansB, LT.raise);
    }
    const gTop = hdr - 38 - (fcx ? 19 : 0), colW = 150, gap = 10, sideW = (CW - colW - gap * 2) / 2;
    const bottomRowH = 84, stripH = 18, gBottom = 42 + stripH + 8 + bottomRowH + 8;
    const cardH = (gTop - gBottom - 4 * 7) / 5;
    const L = cards.slice(0, 5), Rr = cards.slice(5, 10);
    L.forEach((c: any, i: number) => drawCard(c, HM, gTop - i * (cardH + 7), sideW, cardH));
    Rr.forEach((c: any, i: number) => drawCard(c, HM + sideW + gap + colW + gap, gTop - i * (cardH + 7), sideW, cardH));

    // Centre column: the car, the headline figure, the listings as strands.
    const cx0 = HM + sideW + gap, cxm = cx0 + colW / 2;
    let cy = gTop;
    const PHW = colW, PHH = colW * 0.75;
    rpath(cx0, cy, PHW, PHH, 6, { color: PANEL2, borderColor: HAIR, borderWidth: 0.7 });
    if (heroImg) {
      const sc = Math.min((PHW - 2) / heroImg.width, (PHH - 2) / heroImg.height);
      const dw = heroImg.width * sc, dh = heroImg.height * sc;
      page.drawImage(heroImg, { x: cx0 + (PHW - dw) / 2, y: cy - PHH + (PHH - dh) / 2, width: dw, height: dh });
      TC("The dealer's own listing photo", cxm, cy - PHH - 9, 6, serifI, FAINT);
    } else {
      TC("NO PHOTO PUBLISHED", cxm, cy - PHH / 2 + 2, 6.5, sansB, FAINT);
      TC("in this listing's own page data", cxm, cy - PHH / 2 - 8, 6.5, sans, FAINT);
    }
    cy -= PHH + 16;

    const c01 = cards[0];
    const circR = 50, ccy = cy - circR - 2;
    page.drawCircle({ x: cxm, y: ccy, size: circR, color: WHITE, borderColor: rgb(0.953, 0.965, 0.984), borderWidth: 6 });
    page.drawCircle({ x: cxm, y: ccy, size: circR - 3.5, borderColor: HAIR, borderWidth: 0.8 });
    const kick = isNewCar ? "PRICE VS MSRP" : "PRICE VS MARKET";
    TC(kick, cxm, ccy + 19, 5.8, sansB, BLUE);
    const vm = String(c01.value || "").match(/^([+-]?\$[\d,.]+)\s+(.*)$/);
    const big = vm ? vm[1] : String(c01.value || "");
    TC(big, cxm, ccy + 1, fit(big, serifB, 16, circR * 1.7), serifB, LT[c01.state]);
    const mvc = a.marketValue || {};
    const vWords = vm ? vm[2].toLowerCase() : "";
    const sub = !vm ? "" : isNewCar ? `${vWords} MSRP${a.allInPricing ? ", all-in" : ""}` : (Number(mvc.comps) > 0 ? `${vWords} of ${mvc.comps} listings` : vWords);
    if (sub) TC(sub, cxm, ccy - 10, fit(sub, sans, 6.2, circR * 1.6), sans, SOFT);
    TC("see point 01", cxm, ccy - 19, 5.4, sans, FAINT);
    cy = ccy - circR - 10;

    // The fibre gauge. Every strand is ONE sealed listing, its height its price;
    // the green line is the reference the claim gate itself uses (MSRP on a new
    // car, the middle of the similar listings on a used one).
    const gH = cy - gBottom - 16, gW = colW, gx0 = cx0, gyT = cy;
    if (gH > 60) {
      const stops: [number, number[]][] = [[0, [0.020, 0.043, 0.110]], [0.42, [0.043, 0.106, 0.247]], [0.66, [0.227, 0.361, 0.596]], [0.82, [0.796, 0.855, 0.941]], [0.94, [1, 1, 1]], [1, [1, 1, 1]]];
      const at = (t: number) => { for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) { const [t0, c0] = stops[i - 1], [t1, c1] = stops[i]; const k = (t - t0) / (t1 - t0 || 1); return rgb(c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k); } return WHITE; };
      const N = 48;
      for (let i = 0; i < N; i++) page.drawRectangle({ x: gx0, y: gyT - (i + 1) * (gH / N), width: gW, height: gH / N + 0.4, color: at((i + 0.5) / N) });
      const base = gyT - gH + 30, top = gyT - 12, mid = gx0 + gW / 2;
      for (let k = 0; k < 41; k++) {
        const i = k - 20, sgn = Math.sign(i) || 1, x0 = mid + i * 1.1, x1 = mid + i * 3.6 + sgn * Math.abs(i) * 0.5;
        page.drawSvgPath(`M${x0} ${-(base + 10)} Q${mid + i * 1.5} ${-(gyT - gH + 10)} ${x1} ${-(gyT - gH + 1)}`, { x: 0, y: 0, borderColor: [FACE, rgb(0.310, 0.659, 1), rgb(0.624, 0.831, 1)][k % 3], borderWidth: 0.6, borderOpacity: 0.55 });
      }
      const mv = a.marketValue || {};
      const rows: any[] = Array.isArray(mv.sample) ? mv.sample.filter((r: any) => Number(r?.price) > 0) : [];
      const claim = qualifyMsrpClaim(a);
      const ref = isNewCar ? (claim.comparable && Number(claim.reference) > 0 ? Number(claim.reference) : null) : (Number(mv.average) > 0 ? Number(mv.average) : null);
      const ask = Number(a.quotedPrice) > 0 ? Number(a.quotedPrice) : null;
      const vals = [...rows.map((r: any) => Number(r.price)), ask, ref].filter((v: any) => Number(v) > 0) as number[];
      if (vals.length) {
        const lo = Math.min(...vals) * 0.985, hi = Math.max(...vals) * 1.01;
        const Y = (v: number) => base + ((v - lo) / (hi - lo || 1)) * (top - base);
        const strand = (sx: number, v: number, col: any, w: number, halo: number) => {
          page.drawLine({ start: { x: sx, y: base - 4 }, end: { x: sx, y: Y(v) }, thickness: w, color: rgb(0.745, 0.890, 1), opacity: 0.85 });
          page.drawCircle({ x: sx, y: Y(v), size: halo, color: col, opacity: 0.28 });
          page.drawCircle({ x: sx, y: Y(v), size: w + 0.9, color: rgb(0.949, 0.980, 1), borderColor: col, borderWidth: 0.9 });
        };
        const order = rows.map((r: any) => Number(r.price)).sort((p, q) => q - p);
        order.forEach((v, i) => strand(mid + (i % 2 ? -1 : 1) * 11 * (Math.floor(i / 2) + 1), v, rgb(0.424, 0.769, 1), 0.8, 3.8));
        if (ref) {
          page.drawRectangle({ x: gx0, y: Y(ref) - 2.5, width: gW, height: 5, color: DK.clear, opacity: 0.14 });
          page.drawLine({ start: { x: gx0, y: Y(ref) }, end: { x: gx0 + gW, y: Y(ref) }, thickness: 1, color: DK.clear });
          const lab = isNewCar ? "MSRP" + (claim.comparedAgainst === "all_in" || a.allInPricing ? " ALL-IN" : "") : "MIDDLE";
          rpath(gx0 + 3, Y(ref) + 13, 50, 18, 3, { color: rgb(0.039, 0.165, 0.133), borderColor: DK.clear, borderWidth: 0.6 });
          TC(lab, gx0 + 28, Y(ref) + 6.5, 4.6, sansB, DK.clear);
          TC(fmtMoney(ref), gx0 + 28, Y(ref) - 0.5, fit(fmtMoney(ref), sansB, 6.4, 46), sansB, WHITE);
        }
        if (ask) {
          const col = DK[c01.state];
          strand(mid, ask, col, 1.5, 5.5);
          const ty = Math.min(Y(ask) + 8, gyT - 4);
          rpath(gx0 + gW - 53, ty, 50, ref ? 25 : 18, 3, { color: c01.state === "raise" ? rgb(0.180, 0.059, 0.047) : rgb(0.039, 0.165, 0.133), borderColor: col, borderWidth: 0.6 });
          TC("ASKING", gx0 + gW - 28, ty - 6.5, 4.6, sansB, col);
          TC(fmtMoney(ask), gx0 + gW - 28, ty - 13.5, fit(fmtMoney(ask), sansB, 6.4, 46), sansB, WHITE);
          if (ref) { const d = ask - ref, dl = (d >= 0 ? "+" : "-") + fmtMoney(Math.abs(d)); TC(dl, gx0 + gW - 28, ty - 20.5, fit(dl, sansB, 5.4, 46), sansB, rgb(1, 0.706, 0.659)); }
        }
      }
      const cap = rows.length
        ? (isNewCar ? "Each strand is one other Alberta dealer's price for this car." : `Each strand is one of ${rows.length} similar Alberta listings.`)
        : "No similar listings were sealed with this report.";
      TC(cap, cxm, gyT - gH - 8, fit(cap, sans, 5.6, colW + 8), sans, FAINT);
    }

    // Bottom row: cards 11-13.
    const w3 = (CW - gap * 2) / 3, rowTop = 42 + stripH + 8 + bottomRowH;
    cards.slice(10, 13).forEach((c: any, i: number) => drawCard(c, HM + i * (w3 + gap), rowTop, w3, bottomRowH));

    // The tally strip: states, never a total. [[claims-must-stay-backed]]
    const sy = 42 + stripH;
    rpath(HM, sy, CW, stripH, 5, { color: WHITE, borderColor: HAIR, borderWidth: 0.8 });
    let tx0 = HM + 12;
    for (const st of ["raise", "clear", "noted", "unchecked"]) {
      glyph(st, tx0 + 3.5, sy - 9, 3.5, LT[st], WHITE);
      const lab = `${(tally as any)[st]} ${WORDS[st].toLowerCase()}`;
      TX(lab, tx0 + 10, sy - 11.5, 7.2, sansB, LT[st]);
      tx0 += 10 + wSafe(sansB, lab, 7.2) + 16;
    }
    TR("COMPARE P.2  -  SHORTLIST P.3  -  SUMMARY P.4  -  DETAILS P.5", PW - HM - 10, sy - 11.5, 6.2, sansB, BLUE);
    drawFooter();

    {
    // ── PAGES 2 + 3: COMPARE, THEN SHORTLIST ─────────────────────────────
    // Vic 09-24: "have dedicated page just to compare", then the elimination
    // page (same car -> price -> km or MSRP -> days on lot, by city). Every row
    // is a SEALED listing (canonical v15 rows, v16 pool) -- never a second read
    // at PDF time -- and the sentence box is marketCompareLine(), the author
    // card 01 already reads. [[two-authors-per-fact]] [[elimination-sum-up-page]]
    const mvP: any = a.marketValue || {};
    const mcP = marketCompareLine(a);
    const askP = Number(a.quotedPrice) > 0 ? Number(a.quotedPrice) : null;
    const kmP = !isNewCar && Number(a.odometerKm) > 0 ? Number(a.odometerKm) : null;
    const kmS = (v: any) => (Number(v) > 0 ? Math.round(Number(v)).toLocaleString("en-CA") + " km" : "km not stated");
    const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const dShort = (s: any) => { const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? MON[Number(m[2]) - 1] + " " + Number(m[3]) : "-"; };
    const ymm = [mvP.make || a.make, mvP.model || a.model].filter(Boolean).join(" ");
    const yrs = mvP.yearFrom && mvP.yearTo ? (mvP.yearFrom === mvP.yearTo ? String(mvP.yearFrom) : `${mvP.yearFrom}-${mvP.yearTo}`) : "";
    const kept: any[] = (Array.isArray(mvP.sample) ? mvP.sample : []).filter((r: any) => Number(r?.price) > 0).sort((p: any, q: any) => p.price - q.price);
    const dol = Number(a.daysOnLot?.days) > 0 ? Number(a.daysOnLot.days) : null;
    const nm = (r: any) => (r?.dealer ? String(r.dealer) : "Dealer not named");
    const nD = Number(mvP.dealers) > 0 ? Number(mvP.dealers) : null;
    const kickRow = (l: string, r: string, yy: number) => {
      TX(l, HM, yy, fit(l, sansB, 7, CW * 0.6), sansB, BLUE);
      if (r) TR(r, PW - HM, yy, fit(r, sansB, 6.4, CW * 0.38), sansB, FAINT);
    };
    // The page-2 verdict is the MARKET line's own light, on a new car too
    // (card 01 measures a new car against MSRP; this page against dealers).
    const stP = mcP.state !== "confirmed" ? "unchecked" : mcP.light === "red" ? "raise" : mcP.light === "green" ? "clear" : "noted";
    const midP = Number(mvP.average) > 0 ? Number(mvP.average) : null;

    page = doc.addPage([PW, PH]); paper();
    let py = drawHeader() - 14;
    kickRow(`COMPARE  -  ${vehTitle.toUpperCase()}`, kept.length ? `${kept.length} LISTING${kept.length === 1 ? "" : "S"}${nD ? `  -  ${nD} DEALER${nD === 1 ? "" : "S"}` : ""}  -  ALBERTA-WIDE` : "", py);
    py -= 19;
    TX(mcP.title, HM, py, fit(mcP.title, serifB, 15, CW), serifB, NAVY);
    py -= 14;

    // The sentence, in the market line's own words, and its verdict.
    const bw = CW - 158, vw = bw - 132;
    const linesP: any[] = (mcP.lines || []).length ? mcP.lines : [{ k: "Comparison", v: mcP.body || "No comparison set was read for this report." }];
    const rowsL = linesP.map((l: any) => ({ k: wrap(String(l.k || "").toUpperCase(), sansB, 6, 104), v: wrap(String(l.v || ""), sans, 7.4, vw) }));
    const bh = Math.max(78, 14 + rowsL.reduce((s: number, r: any) => s + Math.max(r.v.length * 9.6, r.k.length * 8) + 6, 0));
    rpath(HM, py, bw, bh, 6, { color: WHITE, borderColor: HAIR, borderWidth: 0.8 });
    page.drawRectangle({ x: HM, y: py - bh + 5, width: 3, height: bh - 10, color: LT[stP] });
    let ly = py - 16;
    for (const r of rowsL) {
      r.k.forEach((t: string, i: number) => TX(t, HM + 14, ly - i * 8, 6, sansB, SOFT));
      r.v.forEach((t: string, i: number) => TX(t, HM + 124, ly - i * 9.6, 7.4, sans, INK));
      ly -= Math.max(r.v.length * 9.6, r.k.length * 8) + 6;
    }
    const vx0 = HM + bw + 10, vbw = CW - bw - 10;
    rpath(vx0, py, vbw, bh, 6, { color: LTBG[stP], borderColor: LT[stP], borderWidth: 0.9 });
    glyph(stP, vx0 + 16, py - 16, 4, LT[stP], WHITE);
    TX(WORDS[stP], vx0 + 25, py - 18.5, 7, sansB, LT[stP]);
    const dP = askP && midP && mcP.state === "confirmed" ? askP - midP : null;
    const bigP = dP != null ? (dP > 0 ? "+" : dP < 0 ? "-" : "") + fmtMoney(Math.abs(dP)) : String(mcP.value || "NOT COMPARED");
    TX(bigP, vx0 + 12, py - 42, fit(bigP, serifB, 18, vbw - 24), serifB, LT[stP]);
    clamp(String(mcP.lightLabel || mcP.headline || ""), sans, 6.6, vbw - 24, 3).forEach((t: string, i: number) => TX(t, vx0 + 12, py - 55 - i * 8.4, 6.6, sans, INK));
    py -= bh + 10;

    if (kept.length) {
      // The chart: every strand one sealed listing, height its price, position
      // its odometer (a new car's are spread evenly -- all read near zero).
      const chH = 280, chT = py;
      rpath(HM, chT, CW, chH, 8, { color: NAVY });
      for (let i = 0; i < 24; i++) page.drawRectangle({ x: HM + 1, y: chT - chH + 1 + i * 2.2, width: CW - 2, height: 2.3, color: rgb(0.114, 0.243, 0.471), opacity: 0.5 * (1 - i / 24) });
      const pL = HM + 44, pR = PW - HM - 70, pT = chT - 30, pB = chT - chH + 30;
      const pv = [...kept.map((r: any) => Number(r.price)), askP, midP].filter((v: any) => Number(v) > 0) as number[];
      let lo = Math.min(...pv), hi = Math.max(...pv);
      const padv = (hi - lo) * 0.1 || hi * 0.05; lo -= padv; hi += padv;
      const Yp = (v: number) => pB + ((v - lo) / (hi - lo || 1)) * (pT - pB);
      const byKm = !isNewCar && kmP != null && kept.every((r: any) => Number(r.km) > 0);
      const kv = byKm ? [...kept.map((r: any) => Number(r.km)), kmP as number] : [];
      const kLo = byKm ? Math.min(...kv) * 0.92 : 0, kHi = byKm ? Math.max(...kv) * 1.05 : 1;
      const order = kept.map((r: any, i: number) => i);
      const Xk = (r: any, i: number) => byKm ? pL + ((Number(r.km) - kLo) / (kHi - kLo || 1)) * (pR - pL) : pL + ((i + 0.5) / (kept.length + 1)) * (pR - pL);
      const step = [500, 1000, 2000, 2500, 5000, 10000, 20000].find((s) => (hi - lo) / s <= 5) || 20000;
      for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
        page.drawLine({ start: { x: pL, y: Yp(v) }, end: { x: PW - HM - 12, y: Yp(v) }, thickness: 0.4, color: rgb(0.204, 0.290, 0.451) });
        TR("$" + (v >= 1000 ? (v / 1000).toLocaleString("en-CA", { maximumFractionDigits: 1 }) + "k" : String(v)), pL - 6, Yp(v) - 2, 5.8, mono, MUTE);
      }
      if (byKm) {
        const ks = [5000, 10000, 20000, 25000, 50000].find((s) => (kHi - kLo) / s <= 7) || 50000;
        for (let k = Math.ceil(kLo / ks) * ks; k <= kHi; k += ks) {
          const x = pL + ((k - kLo) / (kHi - kLo)) * (pR - pL);
          TC(`${Math.round(k / 1000)}k km`, x, chT - chH + 12, 5.6, mono, MUTE);
        }
      }
      const legend = `HEIGHT = ASKING PRICE${byKm ? "  -  POSITION = ODOMETER" : ""}${Number(mvP.low) > 0 && Number(mvP.high) > 0 ? `  -  SHADED = RANGE OF THE ${kept.length}` : ""}`;
      TR(legend, PW - HM - 12, chT - 14, 5.4, sansB, MUTE);
      if (Number(mvP.low) > 0 && Number(mvP.high) > Number(mvP.low)) {
        page.drawRectangle({ x: pL, y: Yp(Number(mvP.low)), width: PW - HM - 12 - pL, height: Yp(Number(mvP.high)) - Yp(Number(mvP.low)), color: BLUE, opacity: 0.12 });
      }
      if (midP) {
        page.drawLine({ start: { x: pL, y: Yp(midP) }, end: { x: PW - HM - 12, y: Yp(midP) }, thickness: 1, color: DK.clear });
        rpath(PW - HM - 66, Yp(midP) + 12, 56, 22, 3, { color: rgb(0.039, 0.165, 0.133), borderColor: DK.clear, borderWidth: 0.6 });
        TC(`MIDDLE OF THE ${kept.length}`, PW - HM - 38, Yp(midP) + 4, fit(`MIDDLE OF THE ${kept.length}`, sansB, 4.8, 52), sansB, DK.clear);
        TC(fmtMoney(midP), PW - HM - 38, Yp(midP) - 5, 6.6, monoB, WHITE);
      }
      const boxes: [number, number, number, number][] = [];
      const hit = (x: number, y0: number, w: number, h: number) => boxes.some(([bx, by, bw2, bh2]) => x < bx + bw2 && x + w > bx && y0 < by + bh2 && y0 + h > by);
      kept.forEach((r: any, i: number) => {
        const x = Xk(r, order[i]), yv = Yp(Number(r.price));
        page.drawLine({ start: { x, y: pB - 8 }, end: { x, y: yv }, thickness: 0.7, color: rgb(0.745, 0.890, 1), opacity: 0.8 });
        page.drawCircle({ x, y: yv, size: 4, color: CYAN, opacity: 0.25 });
        page.drawCircle({ x, y: yv, size: 2, color: WHITE, borderColor: CYAN, borderWidth: 0.8 });
        const l1 = fmtMoney(Number(r.price)), l2 = [r.year, r.city].filter(Boolean).join(" - ");
        const lw = Math.max(wSafe(monoB, l1, 6.6), wSafe(sans, l2, 5.2)) + 2;
        const cands: [number, number][] = [[x + 5, yv + 1], [x - 5 - lw, yv + 1], [x + 5, yv - 17], [x - 5 - lw, yv - 17], [x + 5, yv + 12]];
        const [lx, lyy] = cands.find(([cx, cy2]) => cx > pL && cx + lw < PW - HM - 12 && !hit(cx, cy2 - 7, lw, 15)) || cands[0];
        boxes.push([lx, lyy - 7, lw, 15]);
        TX(l1, lx, lyy + 1, 6.6, monoB, WHITE);
        TX(l2, lx, lyy - 6, 5.2, sans, MUTE);
      });
      if (askP) {
        const x = byKm ? pL + (((kmP as number) - kLo) / (kHi - kLo)) * (pR - pL) : pL + ((kept.length + 0.5) / (kept.length + 1)) * (pR - pL);
        const yv = Yp(askP), col = DK[stP === "unchecked" ? "noted" : stP];
        page.drawLine({ start: { x, y: pB - 8 }, end: { x, y: yv }, thickness: 1.6, color: col });
        page.drawCircle({ x, y: yv, size: 6, color: col, opacity: 0.3 });
        page.drawCircle({ x, y: yv, size: 2.8, color: WHITE, borderColor: col, borderWidth: 1 });
        const t1 = `THIS CAR${kmP ? "  -  " + kmS(kmP) : ""}`, t2 = fmtMoney(askP) + (dP != null ? `  ${dP >= 0 ? "+" : "-"}${fmtMoney(Math.abs(dP))}` : "");
        const tw = Math.max(wSafe(sansB, t1, 5), wSafe(monoB, t2, 7.2)) + 14;
        const tx = Math.min(Math.max(x - tw / 2, pL), PW - HM - 14 - tw), ty = Math.min(yv + 30, chT - 20);
        rpath(tx, ty, tw, 23, 3, { color: rgb(0.180, 0.059, 0.047), borderColor: col, borderWidth: 0.8 });
        TX(t1, tx + 7, ty - 8, 5, sansB, col);
        TX(t2, tx + 7, ty - 18, 7.2, monoB, WHITE);
      }
      py = chT - chH - 12;

      // The named table: the same sealed rows, cheapest first.
      const C = { yt: HM + 6, odo: HM + 158, ask: HM + 212, vs: HM + 286, days: HM + 326, dealer: HM + 358, city: HM + 462, read: PW - HM - 6 };
      const hdrY = py;
      const H = (s: string, x: number, al: "l" | "r" | "c") => (al === "l" ? TX : al === "r" ? TR : TC)(s, x, hdrY, 5.6, sansB, FAINT);
      H("YEAR - TRIM", C.yt, "l"); H("ODOMETER", C.odo, "r"); H("ASKING", C.ask, "r"); H("VS THIS CAR", C.vs, "r");
      H("DAYS ON LOT", C.days, "c"); H("DEALER", C.dealer, "l"); H("CITY", C.city, "l"); H("READ", C.read, "r");
      page.drawLine({ start: { x: HM, y: hdrY - 5 }, end: { x: PW - HM, y: hdrY - 5 }, thickness: 0.6, color: HAIR });
      const rh = 17;
      let ry = hdrY - 5;
      const midIdx = kept.length % 2 ? (kept.length - 1) / 2 : -1;
      const row = (cells: any, tint: any, bar: any) => {
        if (tint) page.drawRectangle({ x: HM, y: ry - rh, width: CW, height: rh, color: tint });
        if (bar) page.drawRectangle({ x: HM, y: ry - rh, width: 2.5, height: rh, color: bar });
        const by = ry - rh + 5;
        TX(cells.yt, C.yt, by, 7, sansB, INK);
        if (cells.tag) TX(cells.tag[0], C.yt + wSafe(sansB, cells.yt, 7) + 5, by + 0.5, 5, sansB, cells.tag[1]);
        TR(cells.odo, C.odo, by, 6.8, mono, INK); TR(cells.ask, C.ask, by, 6.8, monoB, INK);
        TR(cells.vs[0], C.vs, by, 6.8, monoB, cells.vs[1]);
        TC(cells.days[0], C.days, by, 5.8, sans, cells.days[1]);
        TX(cells.dealer, C.dealer, by, fit(cells.dealer, sansB, 6.8, C.city - C.dealer - 6), sansB, INK);
        TX(cells.city, C.city, by, fit(cells.city, sans, 6.8, C.read - C.city - 28), sans, SOFT);
        TR(cells.read, C.read, by, 6.8, mono, SOFT);
        ry -= rh;
        page.drawLine({ start: { x: HM, y: ry }, end: { x: PW - HM, y: ry }, thickness: 0.4, color: HAIR });
      };
      kept.forEach((r: any, i: number) => {
        const d = askP ? askP - Number(r.price) : null;
        row({
          yt: `${r.year || ""} ${r.trim || ""}`.trim() || "-", tag: i === midIdx ? ["MIDDLE", LT.clear] : null,
          odo: kmS(r.km), ask: fmtMoney(Number(r.price)),
          vs: d == null ? ["-", SOFT] : d > 0 ? [`${fmtMoney(d)} less`, LT.clear] : d < 0 ? [`${fmtMoney(-d)} more`, LT.raise] : ["same", SOFT],
          days: ["not stated", FAINT], dealer: nm(r), city: r.city || "-", read: dShort(r.asOf),
        }, i === midIdx ? LTBG.clear : null, i === midIdx ? LT.clear : null);
      });
      row({
        yt: `${a.year || ""} ${a.trim || ""}`.trim() || vehTitle, tag: ["THIS CAR", LT[stP === "unchecked" ? "noted" : stP]],
        odo: kmP ? kmS(kmP) : isNewCar ? "new" : "km not stated", ask: askP ? fmtMoney(askP) : "not shown",
        vs: ["THIS CAR", LT[stP === "unchecked" ? "noted" : stP]], days: [dol ? String(dol) : "not stated", dol ? INK : FAINT],
        dealer: a.dealerName || "This dealer", city: a.dealerCity || "-", read: dShort(a.issuedAt || new Date().toISOString()),
      }, LTBG[stP], LT[stP]);
      py = ry - 12;
    } else {
      // Nothing sealed to draw: say what the market line says, in its words.
      const nh = 96;
      rpath(HM, py, CW, nh, 8, { color: PANEL2, borderColor: HAIR, borderWidth: 0.7 });
      hatch(HM + 1, py - 1, CW - 2, nh - 2, HAIR, 9);
      TC(String(mcP.headline || "Not compared"), PW / 2, py - 36, 12, serifB, NAVY);
      clamp(String(mcP.body || ""), sans, 7.4, CW - 80, 3).forEach((t: string, i: number) => TC(t, PW / 2, py - 52 - i * 10, 7.4, sans, SOFT));
      py -= nh + 12;
    }

    // Two notes: what was left out, and why days on lot mostly says "not stated".
    const ot = Number(mvP.otherTrims) || 0, okm = Number(mvP.outKm) || 0;
    const outPr = Math.max(0, (Number(mvP.nRead) || 0) - (Number(mvP.comps) || 0));
    const poolArr: any[] = Array.isArray(mvP.pool) ? mvP.pool : [];
    const kmList = poolArr.filter((r: any) => r.out === "km").slice(0, 4).map((r: any) => kmS(r.km));
    const parts = [
      ot ? `${ot} ${ot === 1 ? "was another trim" : "were other trims"}` : "",
      okm ? `${okm} sat outside this car's mileage range${kmList.length ? ` (${kmList.join(", ")}${okm > kmList.length ? ", ..." : ""})` : ""}` : "",
      kept.length && outPr ? `${outPr} ${outPr === 1 ? "was a price outlier" : "were price outliers"}` : "",
    ].filter(Boolean);
    const leftTxt = !kept.length ? "No similar listings were compared, so nothing was left out."
      : mvP.pool == null ? `Only the ${kept.length} listings compared were sealed with this report.`
      : parts.length ? `Besides the ${kept.length} compared, other ${yrs} ${ymm} listings read in Alberta were left out: ${parts.join("; ")}. A car two dealers both list is counted once.`
      : `Every like-for-like ${ymm} listing read in Alberta is compared above. A car two dealers both list is counted once.`;
    const dayTxt = `Shown only where a dealer's own inventory feed states it. This car: ${dol ? `${dol} days${a.daysOnLot?.since ? `, listed since ${fmtDateEn(a.daysOnLot.since)}` : ""}` : "not stated"}.` +
      (kept.length ? ` We hold it for none of the ${kept.length} compared listings, so each is marked "not stated" rather than estimated.` : "");
    const nw = (CW - 10) / 2;
    const nlL = clamp(leftTxt, sans, 6.6, nw - 20, 5), nlR = clamp(dayTxt, sans, 6.6, nw - 20, 5);
    const nh2 = 24 + Math.max(nlL.length, nlR.length) * 8.6;
    ([[`LEFT OUT${kept.length ? ` OF THE ${kept.length + ot + okm + outPr}` : ""}`, nlL, HM], ["DAYS ON LOT", nlR, HM + nw + 10]] as [string, string[], number][]).forEach(([t, ls, x]) => {
      rpath(x, py, nw, nh2, 6, { color: WHITE, borderColor: HAIR, borderWidth: 0.8 });
      TX(t, x + 10, py - 13, 6, sansB, SOFT);
      ls.forEach((ln, i) => TX(ln, x + 10, py - 24 - i * 8.6, 6.6, sans, INK));
    });
    drawFooter();

    // ── PAGE 3: SHORTLIST ──────────────────────────────────────────────
    page = doc.addPage([PW, PH]); paper();
    let sy = drawHeader() - 14;
    const poolRows: any[] = (poolArr.length ? poolArr : kept.map((r: any) => ({ ...r, out: null }))).filter((r: any) => Number(r?.price) > 0);
    const claimP = qualifyMsrpClaim(a);
    const msrpRef = isNewCar && claimP.comparable && Number(claimP.reference) > 0 ? Number(claimP.reference) : null;
    const judged = poolRows.map((r: any) => {
      const s1 = r.out ? "fail" : "pass";
      const s2 = s1 !== "pass" ? "skip" : askP ? (Number(r.price) < askP ? "pass" : "fail") : "none";
      const s3 = s2 === "fail" || s2 === "skip" ? "skip" : isNewCar ? (msrpRef ? (Number(r.price) <= msrpRef ? "pass" : "fail") : "none") : (kmP && Number(r.km) > 0 ? (Number(r.km) < kmP ? "pass" : "fail") : "none");
      const s4 = s3 === "fail" || s3 === "skip" ? "skip" : "none";
      return { r, s: [s1, s2, s3, s4], alive: s1 === "pass" && s2 !== "fail" && s3 !== "fail" };
    });
    const alive = judged.filter((j: any) => j.alive).sort((p: any, q: any) => p.r.price - q.r.price);
    alive.forEach((j: any, i: number) => { j.rank = i + 1; });
    const n1 = judged.filter((j: any) => j.s[0] === "pass").length, n2 = judged.filter((j: any) => j.s[0] === "pass" && j.s[1] !== "fail").length;
    const cityOf = (c: any) => String(c || "City not stated");
    const cityN = new Map<string, number>();
    judged.forEach((j: any) => cityN.set(cityOf(j.r.city), (cityN.get(cityOf(j.r.city)) || 0) + 1));
    const home = cityOf(a.dealerCity);
    const cities = [...cityN.entries()].sort((p, q) => (q[0] === home ? 1 : 0) - (p[0] === home ? 1 : 0) || q[1] - p[1]).map(([c]) => c);
    if (!cities.includes(home)) cities.unshift(home);
    const cityLine = cities.filter((c) => cityN.get(c)).map((c) => `${c.toUpperCase()} ${cityN.get(c)}`).join("  -  ");
    kickRow(`SHORTLIST  -  ${vehTitle.toUpperCase()}  -  ${cond.toUpperCase()}`, poolRows.length ? `${poolRows.length} LISTINGS  -  ${cityLine}` : "", sy);
    sy -= 19;
    TX("Every similar one for sale in Alberta, narrowed down", HM, sy, fit("Every similar one for sale in Alberta, narrowed down", serifB, 15, CW), serifB, NAVY);
    sy -= 12;

    if (poolRows.length) {
      const X = { name: HM + 10, s: [HM + 130, HM + 226, HM + 330, HM + 424], rank: PW - HM - 14 };
      const stepT = ["1. SAME CAR", "2. PRICE VS YOURS", isNewCar ? "3. VS MSRP" : "3. ODOMETER", "4. DAYS ON LOT"];
      const stepS = [
        `${[yrs, mvP.trimLabel || "all trims"].filter(Boolean).join(" - ")}${mvP.kmLow != null && mvP.kmHigh != null ? ` - ${Math.round(Number(mvP.kmLow)).toLocaleString("en-CA")}-${kmS(mvP.kmHigh)}` : ""} - ${n1} left`,
        askP ? `under ${fmtMoney(askP)} - ${n2} left` : "no asking price shown",
        isNewCar ? (msrpRef ? `at or under ${fmtMoney(msrpRef)} - ${alive.length} left` : "no MSRP compared") : (kmP ? `fewer than ${kmS(kmP)} - ${alive.length} left` : "odometer not read"),
        "where the dealer states it",
      ];
      const nRowsT = judged.length + 1 + cities.length;
      const reserve = 262;  // sum-up, verdict, method note, footer
      const headH = 40;
      const rh = Math.max(11.5, Math.min(20, (sy - reserve - headH - 10) / nRowsT));
      const panH = headH + nRowsT * rh + 10;
      rpath(HM, sy, CW, panH, 8, { color: NAVY });
      TX(`${poolRows.length} ${mvP.trimLabel ? String(mvP.trimLabel).toUpperCase() + " " : ""}LISTINGS READ`, X.name, sy - 30, 5.6, sansB, MUTE);
      stepT.forEach((t, i) => {
        TX(t, X.s[i], sy - 13, 6.4, sansB, WHITE);
        clamp(stepS[i], mono, 5.2, (X.s[i + 1] || X.rank - 20) - X.s[i] - 8, 2).forEach((ln: string, k: number) => TX(ln, X.s[i], sy - 22 - k * 6.6, 5.2, mono, MUTE));
      });
      TR("RANK", X.rank + 4, sy - 30, 5.6, sansB, MUTE);
      let ry = sy - headH;
      const cellW = (i: number) => (X.s[i + 1] || X.rank - 16) - X.s[i] - 14;
      const mark = (st: string, x: number, yc: number) => {
        if (st === "pass") { page.drawCircle({ x, y: yc, size: 3.4, color: CYAN, opacity: 0.35 }); page.drawCircle({ x, y: yc, size: 2.2, color: WHITE }); }
        else if (st === "fail") { page.drawCircle({ x, y: yc, size: 3.2, borderColor: DK.raise, borderWidth: 0.9 }); page.drawLine({ start: { x: x - 2.2, y: yc + 2.2 }, end: { x: x + 2.2, y: yc - 2.2 }, thickness: 0.9, color: DK.raise }); }
        else if (st === "none") page.drawCircle({ x, y: yc, size: 2.2, color: rgb(0.353, 0.408, 0.518) });
      };
      const cellText = (j: any, i: number): [string, any] => {
        const r = j.r, st = j.s[i];
        if (st === "skip") return ["", MUTE];
        if (i === 0) return st === "pass" ? [`${r.year || ""} ${r.trim || ""}`.trim(), WHITE] : r.out === "km" ? [kmS(r.km), DK.raise] : [`${fmtMoney(Number(r.price))} price outlier`, DK.raise];
        if (i === 1) return askP ? [`${fmtMoney(Number(r.price))}  ${Number(r.price) < askP ? "-" : "+"}${fmtMoney(Math.abs(askP - Number(r.price)))}`, st === "fail" ? DK.raise : WHITE] : [fmtMoney(Number(r.price)), WHITE];
        if (i === 2) return isNewCar ? (msrpRef ? [`vs ${fmtMoney(msrpRef)}`, st === "fail" ? DK.raise : WHITE] : ["not compared", MUTE]) : [kmS(r.km), st === "fail" ? DK.raise : WHITE];
        return ["not stated", MUTE];
      };
      const subjRow = () => {
        page.drawRectangle({ x: HM + 1, y: ry - rh, width: CW - 2, height: rh, color: rgb(0.290, 0.078, 0.071) });
        const yc = ry - rh / 2;
        TX("This dealer", X.name, yc - 0.5, 6.6, sansB, WHITE);
        TX("YOUR QUOTE", X.name, yc - 7, 4.8, sansB, DK.raise);
        TX(`${a.year || ""} ${a.trim || ""}`.trim(), X.s[0], yc - 2.3, 6.2, monoB, WHITE);
        if (askP) TX(fmtMoney(askP), X.s[1], yc - 2.3, 6.2, monoB, WHITE);
        TX(isNewCar ? (msrpRef ? `MSRP ${fmtMoney(msrpRef)}` : "") : kmP ? kmS(kmP) : "", X.s[2], yc - 2.3, 6.2, monoB, WHITE);
        TX(dol ? `${dol} days` : "not stated", X.s[3], yc - 2.3, 6.2, monoB, dol ? WHITE : MUTE);
        ry -= rh;
      };
      for (const c of cities) {
        const js = judged.filter((j: any) => cityOf(j.r.city) === c);
        if (!js.length && c !== home) continue;
        TX(`${c.toUpperCase()}  -  ${js.length}`, X.name, ry - rh + 4.5, 5.8, sansB, CYAN);
        ry -= rh;
        js.sort((p: any, q: any) => (p.s[0] === "pass" ? 0 : 1) - (q.s[0] === "pass" ? 0 : 1) || p.r.price - q.r.price);
        for (const j of js) {
          const yc = ry - rh / 2;
          TX(nm(j.r), X.name, yc - 2.3, fit(nm(j.r), sansB, 6.6, X.s[0] - X.name - 8), sansB, j.alive ? WHITE : MUTE);
          j.s.forEach((st: string, i: number) => {
            if (st === "skip") { page.drawLine({ start: { x: X.s[i], y: yc }, end: { x: X.s[i] + cellW(i), y: yc }, thickness: 0.5, color: rgb(0.204, 0.290, 0.451), dashArray: [2, 2] }); return; }
            mark(st, X.s[i] + 3, yc);
            const [t, col] = cellText(j, i);
            if (t) TX(t, X.s[i] + 10, yc - 2.2, fit(t, mono, 6.2, cellW(i)), mono, col);
          });
          if (j.rank) {
            const top = j.rank === 1;
            page.drawCircle({ x: X.rank, y: yc, size: 5.4, color: top ? DK.clear : NAVY, borderColor: top ? DK.clear : WHITE, borderWidth: 0.8 });
            TC(String(j.rank), X.rank, yc - 2.2, 6.2, sansB, top ? NAVY : WHITE);
          } else TC("out", X.rank, yc - 2, 5.6, sans, rgb(0.451, 0.502, 0.600));
          ry -= rh;
          page.drawLine({ start: { x: HM + 8, y: ry }, end: { x: PW - HM - 8, y: ry }, thickness: 0.3, color: rgb(0.137, 0.212, 0.353) });
        }
        if (c === home) subjRow();
      }
      sy -= panH + 14;

      // The sum-up: the survivors, cheapest first.
      TX("THE SUM-UP", HM, sy, 7, sansB, BLUE);
      const fewer = isNewCar ? (msrpRef ? " at or under MSRP" : "") : kmP ? " with fewer km" : "";
      TR(`ranked by price  -  ${alive.length} of ${poolRows.length} ask less${fewer}`, PW - HM, sy, 6.4, sans, FAINT);
      sy -= 8;
      const oh = 76;
      if (alive.length) {
        const ow = (CW - 16) / 3;
        alive.slice(0, 3).forEach((j: any, i: number) => {
          const r = j.r, x = HM + i * (ow + 8);
          rpath(x, sy, ow, oh, 6, i === 0 ? { color: LTBG.clear, borderColor: LT.clear, borderWidth: 1 } : { color: WHITE, borderColor: HAIR, borderWidth: 0.8 });
          TX(`OPTION ${i + 1}${i === 0 ? "  -  LOWEST PRICE" : ""}`, x + 9, sy - 12, 5.6, sansB, i === 0 ? LT.clear : SOFT);
          if (r.city) TR(String(r.city), x + ow - 9, sy - 12, 5.8, sans, SOFT);
          TX(nm(r), x + 9, sy - 25, fit(nm(r), serifB, 9.5, ow - 18), serifB, NAVY);
          TX(fmtMoney(Number(r.price)), x + 9, sy - 42, 14, serifB, NAVY);
          TX(`${r.year || ""} ${r.trim || ""}${r.km ? "  -  " + kmS(r.km) : ""}`.trim(), x + 9, sy - 52, fit(`${r.year || ""} ${r.trim || ""}  -  ${kmS(r.km)}`, sans, 6.4, ow - 18), sans, SOFT);
          if (askP) {
            const l1 = `${fmtMoney(askP - Number(r.price))} less than your quote`;
            const l2 = kmP && Number(r.km) > 0 ? `  -  ${Math.round(kmP - Number(r.km)).toLocaleString("en-CA")} km fewer` : "";
            TX(l1, x + 9, sy - 61, fit(l1 + l2, sansB, 6.2, ow - 18), sansB, LT.clear);
            if (l2) TX(l2, x + 9 + wSafe(sansB, l1, fit(l1 + l2, sansB, 6.2, ow - 18)), sy - 61, fit(l1 + l2, sansB, 6.2, ow - 18), sans, SOFT);
          }
          TX(`read from the dealer's page ${dShort(r.asOf)}`, x + 9, sy - 70, 5.8, sans, FAINT);
        });
      } else {
        rpath(HM, sy, CW, 40, 6, { color: WHITE, borderColor: HAIR, borderWidth: 0.8 });
        TX(`None of the ${n1} similar listings asks less${fewer}.`, HM + 12, sy - 24, 8.5, serifB, NAVY);
      }
      sy -= (alive.length ? oh : 40) + 10;

      // The verdict, as a suggestion -- never a claim about the dealer.
      const vSt = alive.length ? "raise" : "noted";
      const best = alive[0]?.r;
      const quote = `Your quote: ${askP ? fmtMoney(askP) : "no asking price shown"} for a ${[a.year, a.trim].filter(Boolean).join(" ") || vehTitle}${kmP ? ` with ${kmS(kmP)}` : ""}${dol ? `, listed ${dol} days` : ""}.`;
      const vTxt = alive.length
        ? `${quote} ${alive.length} similar ${ymm} ${alive.length === 1 ? "listing asks" : "listings ask"} less${fewer}; the lowest is ${nm(best)}${best.city ? ", " + best.city : ""} at ${fmtMoney(Number(best.price))}. A suggestion: bring this page and ask what separates this car from ${alive.length === 1 ? "that one" : `these ${alive.length}`}.`
        : `${quote} None of the ${n1} similar listings compared asks less${fewer}. Nothing to raise from this page.`;
      const vl = clamp(vTxt, sans, 7.2, CW - 110, 4);
      const vh = Math.max(40, 16 + vl.length * 9.4);
      rpath(HM, sy, CW, vh, 6, { color: LTBG[vSt], borderColor: LT[vSt], borderWidth: 0.9 });
      glyph(vSt, HM + 16, sy - vh / 2, 4, LT[vSt], WHITE);
      TX(WORDS[vSt], HM + 25, sy - vh / 2 - 2.5, 7, sansB, LT[vSt]);
      vl.forEach((ln: string, i: number) => TX(ln, HM + 92, sy - 15 - i * 9.4, 7.2, sans, INK));
      sy -= vh + 10;

      const how = `Every ${cond} ${yrs} ${ymm}${mvP.trimLabel ? " " + mvP.trimLabel : ""} that Alberta dealers advertised on their own pages` +
        (mvP.seenMin && mvP.seenMax ? `, read between ${fmtDateEn(mvP.seenMin)} and ${fmtDateEn(mvP.seenMax)}` : "") +
        (ot ? ` (${ot} other ${ot === 1 ? "trim" : "trims"} left out before check 1)` : "") +
        `. A car two dealers both list is counted once.` +
        (poolRows.length < n1 + okm + outPr ? ` The first ${poolRows.length} are shown.` : "") +
        ` Days on lot is shown only where a dealer's own inventory feed states it; we hold it for none of these, so it did not narrow anything.`;
      const LEAD = "How this was narrowed.";
      const hl = wrap(LEAD + " " + how, sans, 6.4, CW - 6);
      TX(LEAD, HM, sy - 6, 6.4, sansB, INK);
      hl.slice(0, 4).forEach((ln: string, i: number) => (i === 0 ? TX(ln.slice(LEAD.length + 1), HM + wSafe(sansB, LEAD + " ", 6.4), sy - 6, 6.4, sans, SOFT) : TX(ln, HM, sy - 6 - i * 8.4, 6.4, sans, SOFT)));
    } else {
      const nh = 110;
      rpath(HM, sy, CW, nh, 8, { color: PANEL2, borderColor: HAIR, borderWidth: 0.7 });
      hatch(HM + 1, sy - 1, CW - 2, nh - 2, HAIR, 9);
      TC("Not enough similar listings to narrow down", PW / 2, sy - 40, 12, serifB, NAVY);
      clamp(String(mcP.body || "No comparison set was read for this report."), sans, 7.4, CW - 80, 3).forEach((t: string, i: number) => TC(t, PW / 2, sy - 56 - i * 10, 7.4, sans, SOFT));
    }
    drawFooter();
    }

    // ── SUMMARY + THANK YOU ────────────────────────────────────────────────
    page = doc.addPage([PW, PH]); paper();
    let yy = drawHeader() - 14;
    TX(`SUMMARY  -  ${vehTitle.toUpperCase()}  -  ${cond.toUpperCase()}`, HM, yy, fit(`SUMMARY  -  ${vehTitle.toUpperCase()}  -  ${cond.toUpperCase()}`, sansB, 7, CW), sansB, BLUE);
    yy -= 18;
    TX("What to take into the conversation", HM, yy, 15, serifB, NAVY);
    yy -= 12;

    // At a glance: the four counts, then what is worth raising, by name.
    const heroH = 82;
    rpath(HM, yy, CW, heroH, 9, { color: NAVY });
    TX(`YOUR REPORT AT A GLANCE  -  ${cards.length} CHECKS`, HM + 14, yy - 15, 6.4, sansB, CYAN);
    const colN = CW / 4;
    ["raise", "clear", "noted", "unchecked"].forEach((st, i) => {
      const ccx = HM + colN * i + colN / 2, n = String((tally as any)[st]);
      const nw = wSafe(serifB, n, 20);
      glyph(st, ccx - nw / 2 - 9, yy - 34, 5, DK[st], NAVY);
      TX(n, ccx - nw / 2, yy - 41, 20, serifB, DK[st]);
      TC(WORDS[st] === "RAISE IT" ? "TO RAISE" : WORDS[st], ccx, yy - 52, 5.8, sansB, MUTE);
    });
    const raises = cards.filter((c: any) => c.state === "raise");
    const gist = raises.length ? `Worth raising: ${raises.map((c: any) => c.title).join(", ")}.` : "Nothing on this report is worth raising.";
    clamp(gist, sans, 7.2, CW - 28, 1).forEach((ln) => TX(ln, HM + 14, yy - 70, 7.2, sans, WHITE));
    yy -= heroH + 14;

    if (raises.length) {
      TX(`${raises.length === 1 ? "ONE THING" : raises.length + " THINGS"} WORTH RAISING`, HM, yy, 7.2, sansB, LT.raise);
      yy -= 7;
      for (const c of raises) {
        const detail = clamp(c.short, sans, 6.8, CW - 150, 1)[0] || "";
        const sug = clamp("SUGGESTION: " + c.suggestion, sans, 6.8, CW - 44, 1)[0] || "";
        const rh = 30;
        if (yy - rh < 200) { drawFooter(); page = doc.addPage([PW, PH]); paper(); yy = drawHeader() - 14; }
        rpath(HM, yy, CW, rh, 6, { color: WHITE, borderColor: HAIR, borderWidth: 0.8 });
        page.drawRectangle({ x: HM, y: yy - rh + 1, width: 3.5, height: rh - 2, color: LT.raise });
        page.drawCircle({ x: HM + 18, y: yy - rh / 2, size: 8, color: WHITE, borderColor: LT.raise, borderWidth: 1.2 });
        TC(c.n, HM + 18, yy - rh / 2 - 2.4, 6.8, sansB, NAVY);
        TX(c.title, HM + 32, yy - 11.5, 7.6, serifB, NAVY);
        const tw0 = wSafe(serifB, c.title, 7.6);
        TX(String(c.value || ""), HM + 32 + tw0 + 6, yy - 11.5, 6.6, sansB, LT.raise);
        const vw = wSafe(sansB, String(c.value || ""), 6.6);
        if (HM + 32 + tw0 + 6 + vw + 8 < PW - HM - 20) TX(clamp(detail, sans, 6.6, PW - HM - 12 - (HM + 32 + tw0 + 6 + vw + 8), 1)[0] || "", HM + 32 + tw0 + 6 + vw + 8, yy - 11.5, 6.6, sans, SOFT);
        if (sug.startsWith("SUGGESTION:")) {
          TX("SUGGESTION:", HM + 32, yy - 22.5, 6.8, sansB, BLUE);
          TX(sug.slice(12), HM + 32 + wSafe(sansB, "SUGGESTION: ", 6.8), yy - 22.5, 6.8, sans, NAVY);
        }
        yy -= rh + 5;
      }
      yy -= 6;
    }

    // What checked out, and what is noted or worth checking yourself.
    const clears = cards.filter((c: any) => c.state === "clear");
    const rest = cards.filter((c: any) => c.state === "noted" || c.state === "unchecked");
    const leftW = CW * 0.54, rightW = CW - leftW - 12, chipH = 24;
    const chip = (c: any, x: number, top: number, w: number, detail: string) => {
      rpath(x, top, w, chipH, 5, { color: LTBG[c.state], borderColor: LT[c.state], borderWidth: 0.8 });
      if (c.state === "unchecked") hatch(x + 1, top - 1, w - 2, chipH - 2, rgb(0.86, 0.86, 0.84), 5);
      glyph(c.state, x + 10, top - chipH / 2, 3.8, LT[c.state], WHITE);
      TX(`${c.n}  -  ${c.title}`, x + 19, top - 10, fit(`${c.n}  -  ${c.title}`, sansB, 7, w - 24), sansB, NAVY);
      TX(clamp(detail, sans, 6.2, w - 24, 1)[0] || "", x + 19, top - 18.5, 6.2, sans, SOFT);
    };
    const secTop = yy;
    if (clears.length) {
      TX("CHECKED AND CLEAR", HM, yy, 7.2, sansB, LT.clear);
      const cw2 = (leftW - 6) / 2;
      clears.forEach((c: any, i: number) => chip(c, HM + (i % 2) * (cw2 + 6), secTop - 7 - Math.floor(i / 2) * (chipH + 5), cw2, String(c.value || "")));
    }
    if (rest.length) {
      TX(rest.some((c: any) => c.state === "noted") ? "NOTED, OR WORTH CHECKING YOURSELF" : "WORTH CHECKING YOURSELF", HM + leftW + 12, secTop, 7.2, sansB, LT.noted);
      rest.forEach((c: any, i: number) => chip(c, HM + leftW + 12, secTop - 7 - i * (chipH + 5), rightW, c.suggestion || String(c.value || "")));
    }
    const leftRows = Math.ceil(clears.length / 2), rightRows = rest.length;
    yy = secTop - 7 - Math.max(leftRows, rightRows) * (chipH + 5) - 8;

    // Thank you. Research partner, never "partner in buying": what we do is
    // research. [[amvic-broker-registration]] Never assumes a signature.
    // [[no-assume-the-client-signs]]
    const tyH = 128;
    if (yy - tyH < 46) { drawFooter(); page = doc.addPage([PW, PH]); paper(); yy = drawHeader() - 14; }
    const tyTop = yy, NB = 32;
    for (let i = 0; i < NB; i++) {
      const k = i / (NB - 1);
      page.drawRectangle({ x: HM, y: tyTop - (i + 1) * (tyH / NB), width: CW, height: tyH / NB + 0.4, color: rgb(0.020 + (0.114 - 0.020) * k, 0.043 + (0.243 - 0.043) * k, 0.110 + (0.471 - 0.110) * k) });
    }
    for (let k = 0; k < 61; k++) {
      const i = k - 30, mid = HM + CW / 2;
      page.drawSvgPath(`M${mid + i * 2} ${-(tyTop - tyH + 30)} Q${mid + i * 3.4} ${-(tyTop - tyH + 12)} ${mid + i * 8} ${-(tyTop - tyH)}`, { x: 0, y: 0, borderColor: [FACE, rgb(0.310, 0.659, 1), rgb(0.624, 0.831, 1)][k % 3], borderWidth: 0.5, borderOpacity: 0.45 });
    }
    TX("THANK YOU", HM + 16, tyTop - 16, 6.4, sansB, CYAN);
    const thanks = `Thank you for choosing LotCheck as your ${cond}-car research partner.`;
    const tl = wrap(thanks, serifB, 13, CW - 150);
    tl.forEach((ln, i) => TX(ln, HM + 16, tyTop - 32 - i * 15, 13, serifB, WHITE));
    let by = tyTop - 32 - tl.length * 15 - 4;
    const lead = "You checked the numbers first. That is the hardest part, and it is done. ";
    const body = lead + "The dealer has a whole team working the numbers. Today you have the same numbers in your hand: the market, the sticker, the fine print. Whatever you decide, you are deciding with the facts in front of you. You've got this.";
    wrap(body, sans, 7.6, CW - 150).forEach((ln, i) => TX(ln, HM + 16, by - i * 10, 7.6, sans, i === 0 ? WHITE : MUTE));
    rpath(PW - HM - 108, tyTop - 12, 94, 30, 6, { color: WHITE });
    drawLogo(PW - HM - 104, tyTop - 16, 24);
    TX("Lot", PW - HM - 78, tyTop - 31, 11, serifB, NAVY);
    TX("Check", PW - HM - 78 + wSafe(serifB, "Lot", 11), tyTop - 31, 11, serifB, BLUE);
    TR("ON THE BUYER'S SIDE", PW - HM - 14, tyTop - 54, 5.8, sansB, CYAN);
    TR("OF THE TABLE", PW - HM - 14, tyTop - 62, 5.8, sansB, CYAN);
    page.drawLine({ start: { x: HM + 16, y: tyTop - tyH + 30 }, end: { x: PW - HM - 16, y: tyTop - tyH + 30 }, thickness: 0.5, color: rgb(0.25, 0.33, 0.52) });
    TX("Proudly built in Calgary.", HM + 16, tyTop - tyH + 18, 7, sansB, WHITE);
    TX("Thank you for supporting a local startup. Every check helps grow good jobs right here in Alberta.", HM + 16 + wSafe(sansB, "Proudly built in Calgary. ", 7), tyTop - tyH + 18, 7, sans, MUTE);
    // The disclosures the old detail section closed on, kept word for word:
    // tamper-evidence, how it was read (incl. AI), and what it does not cover.
    // [[defamation-proof-and-compliant]] [[make-it-dispute-proof]]
    const colophonText = "Analyzed once, never stored on our end. This report's ID is a fingerprint of its own contents" + (issued ? " issued " + issued.toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "") + " - change any figure and the ID changes, so it is tamper-evident. " + (verifyUrl ? "Use the link in your email to verify it at lotcheck.ca/verify - it recomputes the fingerprint and checks the signature, and nothing is stored on our end. " : "Verify it anytime at lotcheck.ca/verify using the link in this email. ") + (capImg && capPages > 0 ? "The sealed listing capture is printed on the pages that follow and attached as its own photo file. " : sealedShot ? "The sealed listing capture is attached to your email as its own photo file. " : "") + "Every figure traces to a public source you can re-check: recalls to Transport Canada, MSRP to the manufacturer catalogue, reviews to Google. Vehicle, price, and fee details were read from the dealer's page by an automated system, including AI reading the page or a screenshot when it couldn't be parsed directly - verify them against the original listing before you rely on them. LotCheck reviews the deal, not the car's history - pair it with a vehicle-history report before you buy.";
    wrap(colophonText, sans, 6, CW).slice(0, 7).forEach((ln: string, i: number) => TX(ln, HM, 44 + 7 * 7.6 - i * 7.6, 6, sans, FAINT));
    drawFooter();

    // ── PAGE 5: DETAILS ────────────────────────────────────────────────
    // Vic 09-25: the old detail pages are replaced by the 4-page design, and
    // what only they carried moves here, in the new style: the dealer's own
    // breakdown, every recall, the extras, the market count, older years,
    // insurance, AMVIC, the payment default. Same shared line builders as
    // /verify and the email, so the words cannot drift. [[two-authors-per-fact]]
    {
      // No line may assume the buyer signs. [[no-assume-the-client-signs]]
      const unsign = (s: unknown) => noEmDash(s).replace(/\bBefore you sign\b/g, "Before you commit").replace(/\bbefore you sign\b/g, "before you commit").replace(/\bbefore signing\b/gi, "before committing").replace(/\bBEFORE SIGNING\b/g, "BEFORE COMMITTING");
      const KW = 128, VX = HM + KW, VW = CW - KW;
      let dy = 0;
      const newPage = (first: boolean) => {
        page = doc.addPage([PW, PH]); paper();
        dy = drawHeader() - 14;
        TX(`DETAILS  -  ${vehTitle.toUpperCase()}`, HM, dy, fit(`DETAILS  -  ${vehTitle.toUpperCase()}`, sansB, 7, CW), sansB, BLUE);
        dy -= 19;
        if (first) { TX("Everything else we read on this listing", HM, dy, 15, serifB, NAVY); dy -= 18; }
      };
      const room = (h: number) => { if (dy - h < 52) { drawFooter(); newPage(false); } };
      // One section: a kicker, a headline, key/value rows, then plain text.
      const section = (kick: string, head: string, headCol: any, rows: { k: string; v: string; vf?: any; vc?: any }[], body?: string, note?: string) => {
        const hl = head ? wrap(unsign(head), serifB, 9.5, CW) : [];
        const rl = rows.map((r) => ({ k: wrap(unsign(r.k).toUpperCase(), sansB, 5.8, KW - 10), v: wrap(unsign(r.v), r.vf || sans, 7.2, VW), vf: r.vf, vc: r.vc }));
        const bl = body ? wrap(unsign(body), sans, 7, CW) : [];
        const nl2 = note ? wrap(unsign(note), serifI, 6.6, CW) : [];
        const h = 14 + hl.length * 12 + rl.reduce((s, r) => s + Math.max(r.k.length * 7.5, r.v.length * 9.2) + 3, 0) + bl.length * 9 + nl2.length * 8.4 + 12;
        room(Math.min(h, 300));
        TX(unsign(kick).toUpperCase(), HM, dy, 6.4, sansB, BLUE);
        dy -= 13;
        hl.forEach((ln) => { TX(ln, HM, dy, 9.5, serifB, headCol || NAVY); dy -= 12; });
        for (const r of rl) {
          room(Math.max(r.k.length * 7.5, r.v.length * 9.2) + 3);
          r.k.forEach((ln, i) => TX(ln, HM, dy - i * 7.5, 5.8, sansB, FAINT));
          r.v.forEach((ln, i) => TX(ln, VX, dy - i * 9.2, 7.2, r.vf || sans, r.vc || INK));
          dy -= Math.max(r.k.length * 7.5, r.v.length * 9.2) + 3;
        }
        bl.forEach((ln) => { room(9); TX(ln, HM, dy, 7, sans, SOFT); dy -= 9; });
        nl2.forEach((ln) => { room(8.4); TX(ln, HM, dy, 6.6, serifI, SOFT); dy -= 8.4; });
        dy -= 4;
        page.drawLine({ start: { x: HM, y: dy }, end: { x: PW - HM, y: dy }, thickness: 0.6, color: HAIR });
        dy -= 12;
      };
      const linesOf = (l: any) => (Array.isArray(l?.lines) ? l.lines : []).map((x: any) => ({ k: String(x.k || ""), v: String(x.v || "") }));
      newPage(true);

      if (a.financeContingent && a.financeContingent.contingent) {
        section("PRICE DEPENDS ON FINANCING WITH THE DEALER", "This price is tied to taking the dealer's financing", LT.raise,
          a.financeContingent.evidence ? [{ k: "The listing says", v: `"...${String(a.financeContingent.evidence).replace(/[^ -~]/g, " ")}..."`, vf: serifI }] : [],
          "The listing's own wording conditions the advertised price on financing through the dealer. Pay cash, or use your own bank, and the price can legitimately change - the discount is often funded by the dealer's commission on the loan, so it leaves with the loan.",
          'Ask: "What is the price if I pay cash or use my own bank - and if it changes, by exactly how much?" In writing.');
      }
      if (dealerFeeTotal(a) > 0) {
        const dli = a.dealerLineItems;
        const inside = dli.insideAdvertisedPrice;
        section("THE DEALER'S OWN PRICE BREAKDOWN",
          inside === true ? "The dealer itemised their price on the listing. These charges are already included in the advertised price - they are not added on top."
            : inside === false ? "The dealer itemised their price on the listing. These charges sit on top of the advertised price."
            : "The dealer itemised their price on the listing. It does not say whether these are inside the advertised price or on top of it - ask.",
          NAVY,
          [...dli.fees.map((f: any) => ({ k: String(f.name), v: "$" + Number(f.amount).toLocaleString("en-CA"), vf: monoB })),
           ...(dli.incentives || []).map((d: any) => ({ k: String(d.name), v: "-$" + Number(d.amount).toLocaleString("en-CA"), vf: monoB, vc: LT.clear }))],
          undefined,
          `The $${dealerFeeTotal(a).toLocaleString("en-CA")} ${dli.fees.length === 1 ? "fee is" : "fees are"} the dealer's own - not the manufacturer's and not a government charge - so ${dli.fees.length === 1 ? "it is" : "they are"} the line to ask about.`);
      }
      {
        const POINTS = tenPoints(a);
        const EXTRA = POINTS.slice(POINT_TITLES.length);
        if (EXTRA.length) {
          section(`ALSO CHECKED ON THIS LISTING (${EXTRA.length})`, "", NAVY, EXTRA.map((p: any) => ({ k: String(p.t), v: String(p.v), vf: monoB })));
        }
      }
      if (a.recalls?.checked && a.recalls.count > 0 && (a.recalls.items || []).length) {
        const rows = a.recalls.items.map((it: any) => recallDigest(it)).filter(Boolean).map((d: any) => ({ k: d.title, v: d.line }));
        section("OPEN RECALLS - TRANSPORT CANADA", `${a.recalls.count} open recall${a.recalls.count === 1 ? "" : "s"} on record`, LT.raise, rows,
          "Public safety-recall campaigns Transport Canada publishes for this year, make and model - government data, not our opinion. Confirm by VIN with the dealer; every listed repair is free of charge.",
          recallsShownNote(a.recalls.count, a.recalls.items.length) || undefined);
      }
      {
        const pd = pageDefaultLine(a);
        section("PAYMENT STARTING POINT", pd.headline, pd.state === "confirmed" ? NAVY : SOFT, [], pd.body);
      }
      {
        const line = marketCountLine(a);
        section("OTHER LISTINGS READ", line.headline, line.state === "confirmed" ? NAVY : SOFT, [], line.body);
      }
      if (a.olderYears) {
        const oyLine = olderYearsLine(a);
        const rows = linesOf(oyLine);
        section(oyLine.title, [oyLine.headline, oyLine.meta].filter(Boolean).join(" - "), oyLine.state === "confirmed" ? NAVY : SOFT, rows, rows.length ? undefined : oyLine.body, oyLine.note);
      }
      if (financeCoverageApplies(a)) {
        const fcLine = financeCoverageLine(a);
        const fr = linesOf(fcLine);
        section(fcLine.title, [fcLine.headline, fcLine.meta].filter(Boolean).join(" - "), NAVY, fr, fr.length ? undefined : fcLine.body, fcLine.note);
        const ipLine = insurancePremiumLine(a);
        const ir = linesOf(ipLine);
        section(ipLine.title, [ipLine.headline, ipLine.meta].filter(Boolean).join(" - "), NAVY, ir, ir.length ? undefined : ipLine.body, ipLine.note);
      }
      if (a.dealerLicence && a.dealerLicence.status) {
        const Lc = a.dealerLicence, good = Lc.state === "valid";
        section("DEALER LICENCE - AMVIC PUBLIC REGISTRY", String(Lc.status), good ? NAVY : LT.raise,
          [Lc.legalName ? { k: "Legal name", v: String(Lc.legalName) } : null, Lc.licenceNumber ? { k: "Licence", v: String(Lc.licenceNumber), vf: monoB } : null, Lc.expiryDate ? { k: "Expiry", v: String(Lc.expiryDate) } : null, { k: "Source", v: "AMVIC public licensee registry" }].filter(Boolean) as any[],
          undefined,
          good ? "AMVIC is Alberta's regulator; every business selling vehicles in the province must hold a licence. This dealer's registry entry currently reads as licensed."
            : "AMVIC's registry currently shows this status for the matched business. Records can lag and businesses do reapply, so this is not a verdict - but ask for the current licence number and status in writing before any deposit, and verify it yourself on AMVIC's public search.");
      }
      if (a.tradeInWidget && a.tradeInWidget.detected) {
        section("TRADE-IN TOOL ON THIS LISTING", `Instant trade-in appraisal widget${a.tradeInWidget.vendor ? ` (${a.tradeInWidget.vendor})` : ""}`, NAVY, [],
          "Its number is anchored to the wholesale side of the market (what dealers pay each other), it is non-binding, and it appears in exchange for your contact and vehicle details.",
          "If you have a trade: settle this vehicle's price first; get the trade offer in writing on its own line - never one blended payment; and check retail listings for your own car before disclosing anything.");
      }
      if (trimRangeOk(a.trimRange)) {
        const tr = a.trimRange;
        const allExcl = tr.t.every((x: any) => Number(x.b) === 1);
        const qpT = Number(a.quotedPrice) || 0;
        const aboveN = qpT > 0 ? tr.t.filter((x: any) => qpT > Number(x.m)).length : 0;
        const site = EMAIL_MAKE_SITE[tr.mk];
        section("MSRP PER TRIM", `${tr.y} ${tr.mk} ${tr.md} - the manufacturer's price per trim${allExcl ? " (before freight & fees)" : ""}`, NAVY,
          tr.t.slice(0, 12).map((x: any) => ({ k: x.p ? `${x.p} - ${x.n}` : String(x.n), v: `$${Number(x.m).toLocaleString("en-CA")}${Number(x.b) === 1 ? " + freight" : ""}`, vf: monoB })),
          qpT > 0 ? `The asking price $${qpT.toLocaleString("en-CA")} sits above ${aboveN} of ${tr.t.length} published trim prices.${tr.t.length > 12 ? ` Showing 12 of ${tr.t.length} published trims.` : ""}` : undefined,
          site ? "Source: confirm the range at " + site.replace(/^https:\/\/(www\.)?/, "") : undefined);
      }
      {
        const dl = daysOnLotLine(a), sv = sameVinElsewhereLine(a), pm = priceMovesLine(a);
        const rows = [
          a.daysOnLot && dl && !(Number(a.daysOnLot.days) > 0) ? { k: "Days on lot", v: dl.line } : null,
          sv ? { k: "Also advertised elsewhere", v: sv.line } : null,
          pm ? { k: "Advertised price moves", v: pm.line } : null,
        ].filter(Boolean) as any[];
        if (rows.length) section("LISTING HISTORY", "", NAVY, rows);
      }
      drawFooter();
    }

  }

  // ---- SEALED LISTING CAPTURE — evidence pages ----
  // The full-page photo of the listing, printed into the PDF itself so the
  // emailed report is self-contained evidence (nothing stored on our end,
  // nothing to go back to a server for). The tall capture is sliced across
  // pages at full content width — readable, not shrunk to a thumbnail. The
  // caption prints ONLY server-verified facts: the SHA-256 recomputed here
  // over these exact bytes, and the issue time from the SIGNED canonical —
  // never the client's claims (forged-evidence class, 2026-08-12 review).
  // Never fatal: a bad image already resolved to capImg = null above.
  if (capImg && sealedShot && capPages > 0) {
    try {
      const img = capImg;
      const scaledH = capScaledH;
      const HEAD_FIRST = CAP_HEAD_FIRST, HEAD_REST = CAP_HEAD_REST, MAXP = CAP_MAXP;
      // Page count mirrors the loop below exactly (shared, tested helper) so
      // "PAGE k OF N" can never disagree with the rendered page count. Same
      // capPages the footer promise was gated on.
      const totalPages = capPages;
      let off = 0, k = 0;
      while (off < scaledH - 2 && k < MAXP) {
        const headH = k === 0 ? HEAD_FIRST : HEAD_REST;
        const winTop = PH - M - headH;
        const slice = Math.min(winTop - M, scaledH - off);
        page = doc.addPage([PW, PH]); paper();
        // Draw the whole image shifted so slice k lands in this page's window,
        // then mask the overflow with paper (above the window and below the
        // slice) — pdf-lib has no clip helper, so the mask IS the clip.
        page.drawImage(img, { x: M, y: winTop - scaledH + off, width: W, height: scaledH });
        page.drawRectangle({ x: 0, y: winTop, width: PW, height: PH - winTop, color: PAPER });
        page.drawRectangle({ x: 0, y: 0, width: PW, height: Math.max(0, winTop - slice), color: PAPER });
        page.drawRectangle({ x: M, y: winTop - slice, width: W, height: slice, borderColor: HAIR, borderWidth: 0.7 });
        y = PH - M;
        T("SEALED LISTING CAPTURE" + (totalPages > 1 ? "  -  PAGE " + (k + 1) + " OF " + totalPages : ""), { size: 8.5, font: sansB, color: TEAL });
        y -= 15;
        if (k === 0) {
          para("Photo of the listing, captured for report " + pdfSafe(sealedShot.rid) + (sealedShot.issuedAt ? " issued " + new Date(sealedShot.issuedAt).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "") + ". Its SHA-256 fingerprint below was computed by LotCheck's server over this exact image and is sealed inside the signed report - alter one pixel and it stops matching. Check any copy at lotcheck.ca/verify.", { size: 8.5, font: serifI, color: SOFT, lead: 3 });
          // wrap(), not a single T() -- a long dealer URL (Okotoks Toyota,
          // 2026-08-21: "...2026-Toyota-RAV4_Plug_In_Hybri" cut off mid-word,
          // no "...", nothing wrong with the 80-char slice below it) simply
          // ran past the page's content width at 7.5pt mono and off the
          // printable margin. T() draws whatever string it's given at full
          // width with no wrap or clip -- it was never the slice that failed.
          if (sealedShot.sourceUrl) {
            const src = String(sealedShot.sourceUrl);
            const label = "Listing address (sealed in the signed report): " + (src.length > 80 ? src.slice(0, 77) + "..." : src);
            for (const ln of wrap(label, mono, 7.5, W)) { T(ln, { size: 7.5, font: mono, color: FAINT }); y -= 11; }
          }
          T("SHA-256 " + sealedShot.sha.slice(0, 64), { size: 7.5, font: mono, color: FAINT }); y -= 11;
        }
        off += slice; k++;
      }
      // No silent caps: if the capture outruns the page budget, say so — the
      // attached image file always carries the complete page.
      // "contains the complete page" was a claim this endpoint cannot make.
      // The attachment carries the whole CAPTURE; whether the capture is the
      // whole PAGE is carried by listingShotKind, which is not signed
      // (report-sign.ts seals only the hash) on an endpoint with no
      // authentication -- reading it would put client-supplied text into a
      // DKIM-signed LotCheck email.
      //
      // So state the one thing these pages themselves prove, as a number the
      // render loop just computed: how much of the sealed photo got printed.
      // True at any capture width, needs no canonical change, and does not
      // require knowing what the photo is a photo OF.
      // [[claims-must-stay-backed]]
      if (off < scaledH - 2) center("These pages print the top " + Math.max(1, Math.round((off / scaledH) * 100)) + "% of the sealed photo - the attached photo file is the complete capture.", 34, { size: 7.5, font: sans, color: FAINT });
    } catch (e) { console.warn("Capture pages skipped:", (e as Error)?.message); }
  }

  return await doc.save();
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const CORS_HEADERS = corsHeaders(origin);
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  // ── Gate 0: request shape ─────────────────────────────────────────────────
  // Cheapest checks first, so a hostile caller is turned away before we spend
  // anything. Nothing below this point runs for a request that fails here.
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed", message: "POST only." }, 405);
  }

  // A browser-set Origin from a site that is not ours means another page is
  // scripting this endpoint. Absent Origin is left to the signature gate (see
  // originAllowed's note on why rejecting on absence buys nothing).
  if (!originAllowed(origin)) {
    console.warn("email-quote-report: refused origin", origin);
    return json({ error: "origin_not_allowed", message: "This request didn't come from LotCheck." }, 403);
  }

  // Body cap BEFORE req.json(). The payload legitimately carries a base64
  // full-page screenshot, so it is large by design — but unbounded it is a
  // memory-exhaustion lever on an unauthenticated endpoint. Content-Length can
  // be absent or lie; this catches the honest-but-huge and the lazy-hostile,
  // and the JSON parse below is what bounds the rest.
  const declaredLen = Number(req.headers.get("content-length") || 0);
  if (declaredLen > MAX_BODY_BYTES) {
    return json({ error: "payload_too_large", message: "That report is too large to email." }, 413);
  }

  if (!RESEND_API_KEY) {
    console.error("RESEND_API_KEY is not set on this function.");
    return json({ error: "Email sending isn't configured yet." }, 500);
  }

  try {
    const { email, analysis, reportUrl: reportUrlIn, verifyUrl: verifyUrlIn } = await req.json();
    // Same rule as verifyUrl below: the email's primary CTA button must never
    // carry an off-domain target in a DKIM-signed LotCheck email — an
    // unvalidated client URL turns this endpoint into a phishing-mail minter
    // (escapeHtml stops markup injection, not hostile hrefs).
    const reportUrl: string | undefined =
      (typeof reportUrlIn === "string" && reportUrlIn.startsWith("https://lotcheck.ca/")) ? reportUrlIn : undefined;

    if (!email || !isValidEmail(email)) {
      return new Response(
        JSON.stringify({ error: "Please provide a valid email address." }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }
    if (!analysis || typeof analysis !== "object") {
      return new Response(
        JSON.stringify({ error: "No report to send — analyze a quote first." }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    // ── Gate 1: PROOF OF SCAN ────────────────────────────────────────────────
    // The one that holds. Every genuine report leaves the analyzer ECDSA-signed
    // by a key only this project's server has, and the gate recomputes the
    // canonical projection from THIS body before checking that signature — so
    // passing it proves not merely that some LotCheck report exists, but that
    // the exact vehicle, dealer, price, VIN and summary prose about to be
    // rendered into a DKIM-signed lotcheck.ca email are the ones we produced.
    //
    // FAIL CLOSED, and note this is the deliberate opposite of the free-check
    // breaker's fail-open stance (analyze-listing-url:157). That one guards
    // spend, where a database blip must not block a real buyer. This one guards
    // provenance, where degrading open means mailing an unverifiable document
    // as though we stood behind it. Costs an honest buyer nothing: their report
    // came from the analyzer seconds ago and is already signed.
    //
    // Placed before the capture parse, the PDF build and the Resend call, so a
    // rejected request costs one signature verification (~1ms) and no spend.
    const auth = await verifyReportAuthenticity(analysis, { keys: REPORT_PUBLIC_KEYS });
    if (!auth.ok) {
      // Logged with the machine code so the admin panel can show WHICH link
      // failed and keep it open until fixed; the caller gets only the buyer
      // sentence, which is identical across forgery causes by design.
      console.warn("email-quote-report: send refused", JSON.stringify({
        code: auth.code, ageMs: auth.ageMs, origin: origin || null,
      }));
      // 422, not 403: the request was well-formed and the caller may well be a
      // real buyer holding a stale report — the body is what we won't stand
      // behind, and the message tells them the (cheap, better) way forward.
      return json({ error: auth.code, message: auth.message }, 422);
    }

    const subject = analysis.vehicle
      ? `Your LotCheck report — ${analysis.vehicle}`
      : "Your LotCheck quote report";

    // Verify link — drives both the PDF QR and the email "verify it here" box.
    // The client's value is honoured ONLY when it points at LotCheck's own
    // verify page: this email is branded and DKIM-signed, and the verify link
    // is its trust anchor, so a client-chosen external URL (a lookalike page
    // that always shows green) must never ride in it. Anything else is
    // rebuilt server-side from the signed fields on the analysis.
    let verifyUrl: string | undefined =
      (typeof verifyUrlIn === "string" && verifyUrlIn.startsWith("https://lotcheck.ca/verify")) ? verifyUrlIn : undefined;
    if (!verifyUrl && analysis.verifyPayload) {
      verifyUrl = `https://lotcheck.ca/verify?d=${analysis.verifyPayload}`
        + (analysis.reportId ? `&id=${encodeURIComponent(analysis.reportId)}` : "")
        + (analysis.sig ? `&s=${analysis.sig}` : "")
        + (analysis.keyId ? `&k=${encodeURIComponent(analysis.keyId)}` : "");
    }

    // Sealed listing capture — parsed ONCE, then PROVEN sealed (SHA-256 of the
    // bytes recomputed here + ECDSA signature over the canonical checked)
    // before it may touch the email, the PDF, or the word "sealed". A capture
    // that fails any link in that chain is dropped entirely: this endpoint is
    // unauthenticated, and anything weaker lets an anonymous caller mint
    // LotCheck-branded "evidence" for a doctored image.
    let sealedShot: SealedShot | null = null;
    try {
      const parsed = parseListingShot(analysis);
      if (parsed) {
        sealedShot = await verifySealedShot(analysis, parsed);
        if (!sealedShot) console.warn("Capture dropped: not provably sealed (unsigned report, signature mismatch, or hash disagrees).");
      }
    } catch (e) {
      console.error("Capture verification skipped:", e);
    }

    // THE CAR'S PHOTOGRAPH -- taken from the SEAL, never from the request.
    //
    // verifyReportAuthenticity() above recomputed canonicalReport() from THIS
    // body and checked the signature over it. `ph` is inside that projection as
    // of v14, so by the time we reach here analysis.vehiclePhotoUrl is a URL WE
    // read off the dealer's page and signed -- not one the caller chose. That is
    // the whole reason it was put in the canonical.
    //
    // Then the anchor, sealed against sealed: the VIN the photo was published
    // beside must be the VIN this report is about. extractJsonLdVehicle()
    // returns the FIRST priced vehicle node and does not anchor to the page's
    // subject, so on a page carrying a similar-vehicles rail it can hand back a
    // neighbour's picture. Every other field off a wrong node is a figure we can
    // qualify; a photograph is a different car presented as this one.
    // [[ai-defamation-entity-match-lesson]]
    //
    // Measured on the 41 captured pages we hold: 23 publish a photo on a vehicle
    // node, all 23 publish a VIN on that same node, and 8 of the 41 declare more
    // than one vehicle. The anchor therefore costs no coverage and closes a
    // one-in-five risk.
    let vehiclePhoto: VehiclePhoto | null = null;
    try {
      if (photoAnchorOk(analysis)) {
        vehiclePhoto = await fetchVehiclePhoto(String(analysis.vehiclePhotoUrl).trim());
        if (!vehiclePhoto) console.warn("Vehicle photo dropped: not fetchable as a JPEG or PNG within the caps.");
      } else if (analysis.vehiclePhotoUrl) {
        console.warn("Vehicle photo dropped: not anchored to this report's VIN.");
      }
    } catch (e) {
      // A picture is never worth the report. [[no-single-point-of-failure]]
      console.warn("Vehicle photo skipped:", (e as Error)?.message);
    }

    // The PDF IS the report, so it is FATAL — never "best effort".
    //
    // This used to swallow the error and send the email anyway. That is the
    // worst possible outcome: the buyer gets a LotCheck email that promises a
    // report, opens it, and finds nothing attached. They believe they were
    // served, they don't re-run, and the failure is invisible to us because
    // nothing is recorded. An email with no report must never leave this
    // function (Vic, 2026-08-14: "that can never happen").
    //
    // So: retry once (the pdf-lib / fontkit / Poppins fetches are remote
    // imports and fail transiently), sanity-check the bytes, and if it still
    // can't be built, send NOTHING and tell the caller. The buyer keeps their
    // on-screen report and their credit — the credit is captured by the
    // analyze-* functions on delivery of the analysis, never here — so a
    // failure at this step costs them nothing but a retry.
    const MIN_PDF_BYTES = 1024; // a real multi-page report is tens of KB; anything smaller is a broken build, not a report
    const fnameVeh = (analysis.vehicle || "report").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "report";
    const attachments: Array<{ filename: string; content: string }> = [];
    let pdfBytes: Uint8Array | null = null;
    let pdfErr: unknown = null;
    for (let attempt = 1; attempt <= 2 && !pdfBytes; attempt++) {
      try {
        const bytes = await buildReportPdf(analysis, verifyUrl, sealedShot, vehiclePhoto);
        if (!bytes || bytes.byteLength < MIN_PDF_BYTES) {
          throw new Error(`PDF built but is implausibly small (${bytes?.byteLength ?? 0} bytes)`);
        }
        pdfBytes = bytes;
      } catch (e) {
        pdfErr = e;
        console.error(`PDF generation failed (attempt ${attempt}/2):`, e);
      }
    }
    if (!pdfBytes) {
      console.error("PDF generation failed twice — refusing to send a report email with no report attached.", pdfErr);
      return new Response(
        JSON.stringify({
          error: "pdf_generation_failed",
          message: "We couldn't build your PDF, so we didn't send the email — an email with no report attached is worse than none. Your on-screen report is unchanged and you haven't been charged for this. Please try sending it again in a moment.",
        }),
        { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }
    attachments.push({ filename: `LotCheck-${fnameVeh}-Report.pdf`, content: u8ToB64(pdfBytes) });
    // The buyer's portable copy of what the page looked like at report time.
    // The browser session that generated the report is the ONLY other place
    // this image exists (nothing stored server-side) — this attachment is what
    // makes the emailed report self-contained evidence. It has to be the
    // RAW captured bytes, not a copy re-encoded into the PDF: the sealed
    // SHA-256 (printed on the PDF's own capture page, and checked at
    // lotcheck.ca/verify) is over exactly this file, and re-embedding an
    // image into a PDF re-compresses it, which would change its hash and
    // break that check. That's also why it can't just be dropped in favour
    // of the copy already inside the PDF -- distinct from the naming
    // confusion this filename change addresses (2026-08-20), a real,
    // separate purpose (byte-exact tamper-check) is still why 2 files ship.
    if (sealedShot) attachments.push({ filename: `LotCheck-${fnameVeh}-Photo-Proof.${sealedShot.ext}`, content: sealedShot.b64 });

    const emailHtml = buildEmailHtml(analysis, reportUrl, verifyUrl, sealedShot);

    // Ledger: record the attempt BEFORE the send, hashing the exact bytes we
    // are about to hand to Resend. Recorded first so a send that times out
    // mid-flight still leaves evidence it was attempted; an unsealed row (no
    // provider answer) is itself the signal that we never heard back.
    // recipient_domain only — the address never reaches this table.
    const recipientDomain = email.trim().toLowerCase().split("@")[1] || "unknown";
    const pdfHash = await sha256Hex(pdfBytes);
    const htmlHash = await sha256Hex(new TextEncoder().encode(emailHtml));
    const deliveryId: string | null = await ledgerRpc("fn_record_delivery_attempt", {
      p_pdf_sha256: pdfHash,
      p_pdf_bytes: pdfBytes.byteLength,
      p_pdf_builder_ver: PDF_BUILDER_VER,
      p_recipient_domain: recipientDomain,
      p_html_sha256: htmlHash,
      p_capture_attached: !!sealedShot,
      p_signature_ok: !!sealedShot, // sealedShot is non-null only after verifySealedShot passed
    });

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [email],
        subject,
        html: emailHtml,
        // Invariant: attachments[0] is ALWAYS the report PDF — the fail-closed
        // guard above returns before we get here if it couldn't be built. Do
        // not reintroduce a conditional spread; that is how the empty-report
        // email shipped in the first place.
        attachments,
      }),
    });

    if (!resendRes.ok) {
      const errBody = await resendRes.text();
      console.error("Resend send failed:", resendRes.status, errBody);
      if (deliveryId) {
        await ledgerRpc("fn_record_delivery_result", {
          p_delivery_id: deliveryId,
          p_accepted: false,
          p_provider_msg_id: null,
          p_error_code: `resend_${resendRes.status}`,
        });
      }
      return new Response(
        JSON.stringify({ error: "Couldn't send that email. Please try again in a moment." }),
        { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    // Resend's message id is the ONLY token that ties our record to theirs, and
    // it exists for exactly this instant — the response body used to be dropped
    // on the floor here, which is why a dispute had nothing to correlate.
    let providerMsgId: string | null = null;
    try {
      const body = await resendRes.json();
      providerMsgId = typeof body?.id === "string" ? body.id : null;
    } catch (e) {
      console.warn("Resend returned a non-JSON success body:", e);
    }
    if (deliveryId) {
      await ledgerRpc("fn_record_delivery_result", {
        p_delivery_id: deliveryId,
        p_accepted: true,
        p_provider_msg_id: providerMsgId,
        p_error_code: providerMsgId ? null : "accepted_without_message_id",
      });
    }

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("email-quote-report error:", err);
    return new Response(
      JSON.stringify({ error: "Something went wrong sending that email." }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
});