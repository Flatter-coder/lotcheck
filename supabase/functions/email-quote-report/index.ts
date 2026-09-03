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
const PDF_BUILDER_VER = "2026-09-03d";

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
  const pv = (a.priceVerified !== undefined) ? !!a.priceVerified : (a.quotedPrice > 0);
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
      : (pv ? "" : `<div style="font-size:12px;color:#fca5a5;">price unverified</div>`);
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
  const pv = (a.priceVerified !== undefined) ? !!a.priceVerified : (a.quotedPrice > 0);
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

  // 3 -- Financing APR (compact; glow if the dealer rate beats the maker's advertised)
  // Dealer APR only powers the "high"/dollar-gap claim when it carries
  // evidence (sm360_feed/convertus_vms/page_text -- see App.jsx
  // TRUSTED_APR_SOURCES and _shared/deal.ts's trustedDealerApr, kept in
  // sync). An unconfirmed LLM read ("llm", or the pre-2026-08-19 shape with
  // no source) accused a dealer of a 25% rate and a $23,275 markup for a
  // page that discloses no APR anywhere (easytermauto.ca).
  const fr = a.financeRates;
  const frDealerTrusted = fr?.dealer?.apr != null && ["sm360_feed", "convertus_vms", "page_text"].includes(fr.dealer.source) ? fr.dealer.apr : null;
  if (fr && (frDealerTrusted != null || fr.manufacturer)) {
    const high = frDealerTrusted != null && fr.manufacturer && (frDealerTrusted - fr.manufacturer.apr > 0.1);
    let body = "";
    if (frDealerTrusted != null) body += `<div style="font-size:18px;font-weight:900;color:${high ? "#A63C25" : "#33305A"};">${frDealerTrusted}% APR <span style="font-size:12px;font-weight:700;color:${high ? "#A63C25" : "#706D96"};">${high ? "· high" : "· this dealer"}</span></div>`;
    if (high) {
      const rd = frDealerTrusted / 1200, rm = fr.manufacturer.apr / 1200;
      const extra = Math.round((price * rd / (1 - Math.pow(1 + rd, -60)) - price * rm / (1 - Math.pow(1 + rm, -60))) * 60);
      body += `<div style="font-size:12.5px;color:#33305A;margin-top:5px;line-height:1.5;">${(frDealerTrusted - fr.manufacturer.apr).toFixed(2)}% above ${escapeHtml(a.make || "the manufacturer")}'s advertised ${fr.manufacturer.apr}% — about <b>${money(extra)}</b> more over 60 months. Ask them to match it.</div>`;
    } else if (fr.manufacturer) {
      body += `<div style="font-size:12px;color:#706D96;margin-top:4px;">${escapeHtml(a.make || "Manufacturer")} advertises ${fr.manufacturer.apr}% on new.</div>`;
    }
    deck.push({ label: "Financing APR", tone: high ? "flag" : "muted", glow: high, body });
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
      const items = (rc.items || []).slice(0, 3).map((it: any) => {
        const yr = it.date && !Number.isNaN(new Date(it.date).getFullYear()) ? " · " + new Date(it.date).getFullYear() : "";
        return `<div style="font-size:12px;color:#33305A;margin-top:6px;padding-top:6px;border-top:1px solid #F2836B33;"><b>${escapeHtml(it.system || "Recall")}${yr}</b>${it.summary ? `<div style="color:#5B5885;margin-top:2px;line-height:1.45;">${escapeHtml(it.summary)}</div>` : ""}</div>`;
      }).join("");
      deck.push({ label: "Recalls · Transport Canada", tone: "flag", glow: true, body: `<div style="font-size:18px;font-weight:900;color:#A63C25;">${rc.count} open recall${rc.count > 1 ? "s" : ""}</div>${items}<div style="font-size:11px;color:#706D96;margin-top:8px;">Repaired free of charge — confirm the fix status before you sign.</div>` });
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

  // 5b2 -- AMVIC dealer licence (#11): the regulator's own status, verbatim.
  if (a.dealerLicence && a.dealerLicence.status) {
    const L = a.dealerLicence, good = L.state === "valid";
    deck.push({ label: "Dealer licence - AMVIC", tone: good ? "pass" : "flag", glow: !good, body:
      `<div style="font-size:18px;font-weight:900;color:${good ? "#17756B" : "#A63C25"};">${escapeHtml(L.status)}</div>` +
      `<div style="font-size:12px;color:#706D96;margin-top:2px;">${L.legalName ? escapeHtml(L.legalName) + " &middot; " : ""}${L.licenceNumber ? "Licence " + escapeHtml(L.licenceNumber) + " &middot; " : ""}AMVIC public registry</div>` +
      `<div style="font-size:12.5px;color:#33305A;margin-top:6px;line-height:1.5;">${good ? "AMVIC is Alberta's regulator and its registry currently shows this business as licensed - that's what you want to see." : "AMVIC's registry currently shows this status. Ask the dealer to confirm their current licence number and status in writing before any deposit, and check it yourself at amvic.org."}</div>` });
  }

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
import { verifyReportAuthenticity, originAllowed, corsOrigin, REPORT_PUBLIC_KEYS, MAX_BODY_BYTES } from "../_shared/report-auth.ts";
import { qualifyMsrpClaim } from "../_shared/msrp-claim.ts";
import { dealerReputationPoint } from "../_shared/point-state.ts";
import { POINT_TITLES } from "../_shared/report-points.js";
import { financingMathNote, marketCountLine, pageDefaultLine, marketCompareLine, olderYearsLine, financeCoverageLine, financeCoverageApplies, insurancePremiumLine, financingAprNote, financingAprValue, fmtDateEn } from "../_shared/report-lines.js";

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
  const qp = Number(a.quotedPrice) || 0, ms = Number(a.msrp) || 0, delta = (qp && ms) ? qp - ms : 0;
  const pv = (a.priceVerified !== undefined) ? !!a.priceVerified : (qp > 0);
  const P: Array<{ t: string; v: string; tone: "pass" | "flag" | "muted" }> = [];
  const msrpExactTp = ms > 0 && a.msrpBasis === "exact";
  if (!qp && a.priceDisclosure === "contact_for_price") P.push({ t: "Price vs MSRP", v: "HIDDEN BY DEALER", tone: "flag" });
  else if (ms && pv && msrpExactTp && delta !== 0) P.push({ t: "Price vs MSRP", v: (delta < 0 ? money(-delta) + " UNDER" : money(delta) + " OVER"), tone: delta <= 0 ? "pass" : "flag" });
  else if (ms && pv && msrpExactTp && delta === 0) P.push({ t: "Price vs MSRP", v: "AT MSRP", tone: "pass" });
  // No over/under claim on a non-exact basis -- but the WORDING has to match the
  // basis too. "FROM $68,400" on a used car's original-when-new figure implies
  // you could buy one from that price, which is its own false claim.
  else if (ms && !msrpExactTp) P.push({ t: "Price vs MSRP",
    v: a.msrpBasis === "original_when_new" ? money(ms) + " WHEN NEW"
     : a.msrpBasis === "dealer_stated"     ? money(ms) + " AS STATED BY DEALER"
     : a.msrpBasis === "starting_at"       ? "FROM " + money(ms)
     :                                       money(ms) + " UNVERIFIED",
    tone: "muted" });
  else if (pv && qp) P.push({ t: "Price vs MSRP", v: "MSRP UNVERIFIED", tone: "muted" });
  else P.push({ t: "Price vs MSRP", v: "PRICE UNVERIFIED", tone: "flag" });
  // NOTE: the market comparison ("How this vehicle compares with the Alberta
  // market", report-lines.js marketCompareLine) is NOT one of the fixed 10
  // audit points -- it is a context module (like days-on-lot) and renders as
  // its own deck card + a PDF narrative section. Pushing it here would overflow
  // P.slice(0,10) and silently drop the last real point (Dealer reputation).
  // Kept out on purpose.
  if (a.recalls?.checked && a.recalls.count > 0) P.push({ t: "Transport Canada recalls", v: a.recalls.count + " OPEN", tone: "flag" });
  else if (a.recalls?.checked && a.recalls.count === 0 && a.recalls.confirmed !== false) P.push({ t: "Transport Canada recalls", v: "NONE OPEN", tone: "pass" });
  else if (a.recalls?.checked) P.push({ t: "Transport Canada recalls", v: "UNCONFIRMED", tone: "muted" });
  else P.push({ t: "Transport Canada recalls", v: "COULDN'T VERIFY", tone: "muted" });
  if ((a.addOns || []).length) { const fl = a.addOns.filter((x: any) => x.verdict === "flagged").length; P.push({ t: "Add-ons & fee audit", v: fl ? fl + " FLAGGED" : "TRANSPARENT", tone: fl ? "flag" : "pass" }); }
  // A dealer who publishes their own breakdown is TRANSPARENT, not "none
  // listed". This keyed only on addOns, which never carried the listing's own
  // itemisation, so the 2025 Mazda CX-90's openly-stated $795 Admin. Fee
  // reported as nothing at all.
  else if (dealerFeeTotal(a) > 0) P.push({ t: "Add-ons & fee audit", v: "ITEMIZED", tone: "muted" });
  // AND "WE LOOKED" IS NOT "WE COULD NOT LOOK". The Advantage Ford Acadia was
  // reported to a buyer as "NONE LISTED -- no dealer extras were itemized" on a
  // page printing Doc Fee +$899 and an AMVIC levy, because that report came off
  // the JSON-LD path and a fee box is rendered html, not schema.org markup. The
  // report knew it was incomplete -- its own bottom line said so -- and still
  // published the gap as a finding. Now the absence is only claimed when the
  // page was actually read. [[report-never-empty]] means backed, not filled in.
  else if (a.feesRead === true) P.push({ t: "Add-ons & fee audit", v: "NONE LISTED", tone: "muted" });
  else P.push({ t: "Add-ons & fee audit", v: "NOT READ", tone: "muted" });
  const fr = a.financeRates;
  // See the fuller comment at the deck-card version above: an untrusted
  // (LLM-only) dealer APR falls through to the same states as if none were
  // disclosed at all, same as every other surface.
  const frDealerVerified = fr?.dealer?.apr != null && ["sm360_feed", "convertus_vms", "page_text"].includes(fr.dealer.source) ? fr.dealer.apr : null;
  if (frDealerVerified != null) { const high = fr.manufacturer && frDealerVerified - fr.manufacturer.apr > 0.1; P.push({ t: "Financing APR (this dealer)", v: frDealerVerified + "%" + (high ? " HIGH" : ""), tone: high ? "flag" : "muted" }); }
  else if (fr?.manufacturer) P.push({ t: "Financing APR", v: fr.manufacturer.apr + "% OEM REF", tone: "muted" }); // manufacturer promo APR as a reference when the dealer shows none
  // A page whose calculator opens at a rate has not "advertised none".
  else P.push({ t: "Financing APR", v: financingAprValue(a, null, null, false), tone: "muted" });
  if (a.financingCheck?.checked) P.push({ t: "Financing math", v: a.financingCheck.consistent ? "RECONCILES" : "DOESN'T ADD UP", tone: a.financingCheck.consistent ? "pass" : "flag" });
  // No dealer terms is not "nothing to say": we hold the manufacturer's own
  // published rate and price, so the payment is arithmetic we can do ourselves.
  else if (a.referenceFinancing?.atAsking) P.push({ t: "Financing math", v: "$" + Math.round(a.referenceFinancing.atAsking.monthly).toLocaleString() + "/MO REF", tone: "muted" });
  else P.push({ t: "Financing math", v: "NO TERMS QUOTED", tone: "muted" });
  if (a.odometerCheck?.checked) P.push({ t: "Odometer", v: Number(a.odometerCheck.km).toLocaleString() + " km" + (a.odometerCheck.flag ? " FLAG" : ""), tone: a.odometerCheck.flag ? "flag" : "pass" });
  else P.push({ t: "Odometer", v: a.vehicleCondition === "new" ? "N/A (NEW)" : "NOT LISTED", tone: "muted" });
  if (a.vinCheck?.present) P.push({ t: "VIN check", v: a.vinCheck.valid ? "VALID" : "CHECK PATTERN", tone: a.vinCheck.valid ? "pass" : "flag" });
  else P.push({ t: "VIN check", v: "NOT PUBLISHED", tone: "muted" });
  if (a.evapRebate?.eligible) P.push({ t: "EV / PHEV rebate", v: money(a.evapRebate.total) + " ELIGIBLE", tone: "pass" });
  else if (a.evapRebate && a.evapRebate.ineligibleReason) P.push({ t: "EV / PHEV rebate", v: "NOT ELIGIBLE", tone: "muted" });
  else if (a.fuelType === "BEV" || a.fuelType === "PHEV") { const over = (Number(a.quotedPrice) || Number(a.msrp) || 0) > 50000; P.push({ t: "EV / PHEV rebate", v: over ? "OVER $50K CAP" : "CHECK ELIGIBILITY", tone: "muted" }); }
  else P.push({ t: "EV / PHEV rebate", v: "N/A (GAS)", tone: "muted" });
  if (a.standardWarranty?.coverage) P.push({ t: "Included warranty", v: "INCLUDED", tone: "pass" });
  else P.push({ t: "Included warranty", v: "SEE FACTORY TERMS", tone: "muted" });
  // THREE states, not two. "NOT FOUND" used to cover a lookup that never ran,
  // which printed "No public reviews were found" about Charlesglen Toyota --
  // a dealer with 4.7 stars from 5,930 Google reviews.
  { const dr = dealerReputationPoint(a.dealerSentiment); P.push({ t: "Dealer reputation", v: dr.value, tone: dr.tone }); }

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
  if (Number(a.daysOnLot?.days) > 0) {
    const d = Math.round(Number(a.daysOnLot.days));
    P.push({ t: "Days on lot", v: `${d} DAY${d === 1 ? "" : "S"}${a.daysOnLot.atLeast ? "+" : ""}`, tone: d >= 90 ? "flag" : "muted" });
  }
  if (a.dealerLicence?.status) {
    P.push({ t: "Dealer licence · AMVIC", v: String(a.dealerLicence.status).toUpperCase(), tone: a.dealerLicence.state === "ok" ? "pass" : "muted" });
  }
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
  const qp = Number(a.quotedPrice) || 0, ms = Number(a.msrp) || 0, delta = (qp && ms) ? qp - ms : 0;
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
      if (qp && ms && exact) return gatedNote + (delta > 0
        ? `MSRP is the manufacturer's own sticker for this exact version. The dealer is asking ${money(delta)} more than sticker - anything over sticker is pure negotiation room.`
        : delta === 0
          ? "MSRP is the manufacturer's own sticker for this exact version. This asks exactly sticker - not a markup, but not a deal either."
          : `MSRP is the manufacturer's own sticker for this exact version. This asks ${money(-delta)} below sticker - a real discount; confirm nothing was added back in fees.`);
      // Was hardcoded to the "starting at" story, which is wrong prose for a used
      // car's original MSRP or a dealer-stated figure. The gate owns the reason.
      if (ms) return gatedNote + (qualifyMsrpClaim(a).refusal
        ?? `The manufacturer's price for this model starts at ${money(ms)} for the base version. This exact car carries extra options, so no over/under call is made - use the base figure as your reference and make the dealer justify everything above it.`);
      return gatedNote + "The manufacturer's sticker couldn't be verified for this exact car, so no comparison is made - never trust a savings claim you can't check.";
    }
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
    case "Financing APR": case "Financing APR (this dealer)":
      // Worded once in report-lines.js so this sentence can never contradict
      // the Payment starting point card in the same email or PDF.
      return financingAprNote(a, (a.financeRates?.dealer?.apr != null && ["sm360_feed", "convertus_vms", "page_text"].includes(a.financeRates.dealer.source)) ? a.financeRates.dealer.apr : null);
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
      return a.standardWarranty?.coverage
        ? "Every new vehicle already includes the factory warranty at no charge. When the finance office pitches an extended warranty, remember this coverage is already yours for free."
        : "Factory warranty terms couldn't be confirmed from this listing. Ask exactly what's covered and for how long, in writing, before considering paid coverage.";
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

async function buildReportPdf(a: any, verifyUrl?: string, sealedShot?: SealedShot | null): Promise<Uint8Array> {
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

  const PAPER = rgb(0.976, 0.965, 0.925), INK = rgb(0.114, 0.106, 0.094),
        SOFT = rgb(0.365, 0.341, 0.298), FAINT = rgb(0.55, 0.52, 0.47),
        TEAL = rgb(0.09, 0.459, 0.42), CORAL = rgb(0.651, 0.235, 0.149),
        HAIR = rgb(0.82, 0.80, 0.73), TRACK = rgb(0.87, 0.85, 0.78),
        PURPLE = rgb(0.427, 0.231, 0.839), PURPLE_LT = rgb(0.545, 0.361, 0.965);

  const PW = 595.28, PH = 841.89, M = 56, W = PW - M * 2;
  let page = doc.addPage([PW, PH]);
  const paper = () => page.drawRectangle({ x: 0, y: 0, width: PW, height: PH, color: PAPER });
  paper();
  let y = PH - M;

  const money = (n: unknown) => { const v = Number(n); return (!n || Number.isNaN(v)) ? "-" : "$" + v.toLocaleString("en-CA"); };
  const priceVerified = (a.priceVerified !== undefined) ? !!a.priceVerified : (Number(a.quotedPrice) > 0);
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
    for (const w of words) { const t = cur ? cur + " " + w : w; if (f.widthOfTextAtSize(t, size) > maxW && cur) { out.push(cur); cur = w; } else cur = t; }
    if (cur) out.push(cur); return out;
  }
  const para = (str: string, o: any = {}) => { const f = o.font ?? serif, sz = o.size ?? 10, lead = o.lead ?? 5, mw = o.maxW ?? W, x = o.x ?? M; for (const ln of wrap(str, f, sz, mw)) { need(sz + lead); page.drawText(ln, { x, y: y - sz, size: sz, font: f, color: o.color ?? SOFT }); y -= sz + lead; } };
  const rule = (color = HAIR, th = 0.7, pad = 8) => { need(pad * 2); page.drawLine({ start: { x: M, y: y - pad }, end: { x: M + W, y: y - pad }, thickness: th, color }); y -= pad * 2 + 2; };
  const kicker = (str: string) => { need(20); T(str, { size: 8.5, font: sansB, color: TEAL }); y -= 16; };
  const advance = (h: number) => { y -= h; };

  // ---- BRAND MARK ---- the real LotCheck logo (isometric gate + car driving
  // through), drawn from the SAME polygons as the site's animated mark so print
  // matches the web. x0 = left edge, yTop = PDF y of the top edge, w = target
  // width in pt. Source viewBox is "-145 -44 320 182"; rgba fills are pre-
  // composited over the cream paper. Vector-drawn, crisp at any size.
  const LOGO_POLYS: [string, [number, number, number]][] = [
    ["M0 -36 L170 49 L30 119 L-140 34Z",[0.7216,0.8706,0.7216]],
    ["M-140 48 L30 133 L30 119 L-140 34Z",[0.6275,0.7961,0.6275]],
    ["M170 63 L30 133 L30 119 L170 49Z",[0.5333,0.6745,0.5333]],
    ["M-50 5 L100 80 L52 104 L-98 29Z",[0.851,0.8588,0.9373]],
    ["M-4 -26 L8 -20 L-4 -14 L-16 -20Z",[0.7137,0.6706,0.8941]],
    ["M-16 22 L-4 28 L-4 -14 L-16 -20Z",[0.6196,0.5686,0.8235]],
    ["M8 22 L-4 28 L-4 -14 L8 -20Z",[0.5294,0.4863,0.702]],
    ["M-72 8 L-60 14 L-72 20 L-84 14Z",[0.7137,0.6706,0.8941]],
    ["M-84 56 L-72 62 L-72 20 L-84 14Z",[0.6196,0.5686,0.8235]],
    ["M-60 56 L-72 62 L-72 20 L-60 14Z",[0.5294,0.4863,0.702]],
    ["M1 -38.5 L11 -33.5 L-77 10.5 L-87 5.5Z",[0.7608,0.7216,0.9216]],
    ["M-87 16.5 L-77 21.5 L-77 10.5 L-87 5.5Z",[0.6745,0.6275,0.8549]],
    ["M11 -22.5 L-77 21.5 L-77 10.5 L11 -33.5Z",[0.5725,0.5333,0.7255]],
    ["M6 17 L-82 61 L-82 17 L6 -27Z",[0.8018,0.8968,0.8544]],
    ["M-13 33.5 L40 60 L13 73.5 L-40 47Z",[0.8984,0.8873,0.8678]],
    ["M-12 25 L34 48 L12 59 L-34 36Z",[0.9569,0.5882,0.5098]],
    ["M-34 44 L12 67 L12 59 L-34 36Z",[0.8902,0.4824,0.3922]],
    ["M34 56 L12 67 L12 59 L34 48Z",[0.7569,0.4078,0.3333]],
    ["M-5 23.5 L17 34.5 L1 42.5 L-21 31.5Z",[0.9569,0.5882,0.5098]],
    ["M-21 39.5 L1 50.5 L1 42.5 L-21 31.5Z",[0.8902,0.4824,0.3922]],
    ["M17 42.5 L1 50.5 L1 42.5 L17 34.5Z",[0.7569,0.4078,0.3333]],
    ["M17 42.5 L1 50.5 L1 43.5 L17 35.5Z",[0.902,0.9569,0.9647]],
    ["M-18 40 L-1 48.5 L-1 43.5 L-18 35Z",[0.8667,0.9294,0.949]],
    ["M-25 43.5 L-18 47 L-22 49 L-29 45.5Z",[0.3843,0.3647,0.5098]],
    ["M-29 50.5 L-22 54 L-22 49 L-29 45.5Z",[0.251,0.2314,0.3922]],
    ["M-18 52 L-22 54 L-22 49 L-18 47Z",[0.2157,0.1961,0.3333]],
    ["M1 56.5 L8 60 L4 62 L-3 58.5Z",[0.3843,0.3647,0.5098]],
    ["M-3 63.5 L4 67 L4 62 L-3 58.5Z",[0.251,0.2314,0.3922]],
    ["M8 65 L4 67 L4 62 L8 60Z",[0.2157,0.1961,0.3333]],
    ["M30 55 L25 57.5 L25 54.5 L30 52Z",[1,0.9529,0.7882]],
  ];
  const drawLogo = (x0: number, yTop: number, w: number) => {
    const s = w / 320, ax = x0 + 145 * s, ay = yTop - 44 * s;
    for (const [path, c] of LOGO_POLYS) page.drawSvgPath(path, { x: ax, y: ay, scale: s, color: rgb(c[0], c[1], c[2]) });
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
    page.drawText("LC", { x: cxAbs - monoB.widthOfTextAtSize("LC", S * 0.22) / 2, y: cyCentre - S * 0.22 / 2, size: S * 0.22, font: monoB, color: INK });
  };

  const qp = Number(a.quotedPrice) || 0, ms = Number(a.msrp) || 0, delta = qp && ms ? qp - ms : 0;
  // MSRP basis, NOT quotedPrice verification -- "VERIFIED" must mean exact-trim
  // match, never a base-trim "starting at" floor, or the header makes an
  // over/under claim the audit detail below it explicitly disclaims.
  const msrpExact = ms > 0 && a.msrpBasis === "exact";

  // ---- MASTHEAD ----
  drawLogo(M, y + 2, 38);
  T("LOTCHECK", { size: 15, font: serifB, color: INK, x: M + 48 });
  // SEAL POSITION IS MEASURED, NOT GUESSED. This was drawSeal(M + W - 116, ...)
  // with S=15, whose outer ring reaches cx + S*1.46 = cx + 21.9 -> its right
  // edge landed at M+W-94, while `right()` starts "QUOTE CHECK REPORT" at
  // M+W-(text width ~118) = M+W-118. The seal was therefore drawn UNDER both
  // header lines, and a 420-segment guilloché behind 8.5pt type reads as
  // shimmering, illegible text -- reported from a real emailed report as
  // "letters are shining", on the artifact a buyer forwards to a dealer.
  // Measure the widest header line and seat the seal clear to its left.
  const HDR_TITLE = "QUOTE CHECK REPORT", HDR_NO = "No. " + RID;
  const hdrW = Math.max(sansB.widthOfTextAtSize(pdfSafe(HDR_TITLE), 8.5), mono.widthOfTextAtSize(pdfSafe(HDR_NO), 8.5));
  const SEAL_S = 15, SEAL_GAP = 12;
  drawSeal(M + W - hdrW - SEAL_GAP - SEAL_S * 1.46, y - 9, SEAL_S);
  right(HDR_TITLE, { size: 8.5, font: sansB, color: SOFT });
  y -= 20;
  right(HDR_NO, { size: 8.5, font: mono, color: FAINT });
  y -= 2;
  page.drawLine({ start: { x: M, y }, end: { x: M + W, y }, thickness: 1.4, color: INK });
  y -= 22;

  // ---- HEADLINE ----
  T(priceVerified ? "STATUS  -  VERIFIED QUOTE" : "STATUS  -  PRICE UNVERIFIED", { size: 8.5, font: sansB, color: priceVerified ? TEAL : CORAL });
  y -= 20;
  const headline = a.vehicle || [a.year, a.make, a.model].filter(Boolean).join(" ") || "Your Quote";
  for (const ln of wrap(headline, serifB, 26, W)) { need(30); T(ln, { size: 26, font: serifB, color: INK }); y -= 30; }
  y -= 2;
  const dek = [a.dealerName, a.dealerCity].filter(Boolean).join(", ");
  if (dek) { T(dek + "   -   " + reportDate, { size: 10.5, font: serifI, color: SOFT }); y -= 18; }
  rule(INK, 0.7, 6);

  // ---- THE DEAL ----
  advance(4);
  const colW = W / 2, figTop = y;
  Tat("ASKING PRICE", figTop - 9, { size: 8, font: sansB, color: FAINT });
  Tat(qp ? money(qp) : "Not shown", figTop - 34, { size: 25, font: monoB, color: INK });
  Tat("before tax & fees", figTop - 48, { size: 8, font: sans, color: FAINT });
  const rx = M + colW + 14;
  // "CATALOG MSRP" was printed over figures that came from the DEALER, which
  // both overstates their provenance and contradicts the email wrapping this
  // PDF. The label follows the basis now, from the one shared rule.
  const pdfClaim = qualifyMsrpClaim(a);
  Tat(msrpExact ? "MSRP (VERIFIED)" : pdfClaim.label.toUpperCase(), figTop - 9, { x: rx, size: 8, font: sansB, color: FAINT });
  Tat(ms ? money(ms) : "-", figTop - 34, { x: rx, size: 25, font: monoB, color: msrpExact ? TEAL : SOFT });
  Tat(msrpExact ? "manufacturer suggested" : "reference figure - not the sticker", figTop - 48, { x: rx, size: 8, font: sans, color: FAINT });
  page.drawLine({ start: { x: M + colW, y: figTop - 6 }, end: { x: M + colW, y: figTop - 50 }, thickness: 0.7, color: HAIR });
  y = figTop - 58;
  if (delta && a.msrpBasis === "exact") {
    const label = (delta > 0 ? "+" + money(delta) + " OVER MSRP" : money(Math.abs(delta)) + " UNDER MSRP");
    T(label, { size: 11, font: sansB, color: delta > 0 ? CORAL : TEAL });
    if (!priceVerified) { const wl = sansB.widthOfTextAtSize(label, 11); Tat("(vs catalog MSRP - listing price not yet verified)", y - 11, { x: M + wl + 6, size: 8.5, font: sans, color: FAINT }); }
    y -= 22;
  }
  // Where the buyer checks us. The PDF is the artifact that gets forwarded to
  // the dealer, so the citation has to travel WITH the number -- a figure the
  // reader cannot re-verify is one they have to take on trust, and this whole
  // product exists because nobody should have to.
  if (a.msrpSourceUrl) {
    for (const ln of wrap(`Verify this MSRP on ${a.make || "the manufacturer"}'s own page: ${a.msrpSourceUrl}`, sans, 8.5, W)) {
      need(12); T(ln, { size: 8.5, font: sans, color: SOFT }); y -= 11;
    }
    // That linked page shows the manufacturer's ALL-IN "from" price (freight/
    // PDI, A/C charge, tire levy, etc. already added in), not this ex-freight
    // trim MSRP -- the two numbers are EXPECTED to differ. Without this line,
    // a reader who clicks through sees a bigger number and reasonably reads it
    // as this report being wrong. Confirmed live 2026-08-21 (Vic, RAV4 PHEV GR
    // SPORT AWD): the linked Toyota page shows $60,578 against this card's
    // $57,500 -- both correct, on different bases (msrpAllIn is the same
    // hand-verified catalog row, not a re-derived guess).
    if (Number(a.msrpAllIn) > (Number(ms) || 0)) {
      const gap = Math.round(Number(a.msrpAllIn) - (Number(ms) || 0));
      for (const ln of wrap(`That page shows the ALL-IN total, ${money(a.msrpAllIn)} -- about ${money(gap)} more, covering freight/PDI, the A/C charge and other levies on top of the ${money(ms)} base MSRP above. Same trim, different basis, not a mismatch.`, sans, 8.5, W)) {
        need(12); T(ln, { size: 8.5, font: sans, color: SOFT }); y -= 11;
      }
    }
    y -= 6;
  }
  rule();

  // ---- LEVERAGE GAUGE (vector semicircle) ----
  if (a.leverageScore) {
    need(160);
    const score = Math.max(0, Math.min(10, Number(a.leverageScore.score) || 0));
    kicker("NEGOTIATION LEVERAGE");
    const cx = M + 92, gy = y - 96, r = 78, seg = 64;
    const pt = (ang: number): [number, number] => [cx + r * Math.cos(ang), gy + r * Math.sin(ang)];
    for (let i = 0; i < seg; i++) { const [x0, y0] = pt(Math.PI - (i / seg) * Math.PI), [x1, y1] = pt(Math.PI - ((i + 1) / seg) * Math.PI); page.drawLine({ start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, thickness: 7, color: TRACK }); }
    const f = score / 10, nAng = Math.PI - f * Math.PI, vSeg = Math.max(1, Math.round(seg * f));
    for (let i = 0; i < vSeg; i++) { const [x0, y0] = pt(Math.PI - (i / seg) * Math.PI), [x1, y1] = pt(Math.PI - ((i + 1) / seg) * Math.PI); page.drawLine({ start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, thickness: 7, color: TEAL }); }
    center("0", gy - 4, { size: 8.5, font: monoB, color: SOFT, cx: cx - r });
    center("5", gy + r + 7, { size: 8.5, font: monoB, color: SOFT, cx });
    center("10", gy - 4, { size: 8.5, font: monoB, color: SOFT, cx: cx + r });
    const [nx, ny] = [cx + r * 0.72 * Math.cos(nAng), gy + r * 0.72 * Math.sin(nAng)];
    page.drawLine({ start: { x: cx, y: gy }, end: { x: nx, y: ny }, thickness: 2.6, color: INK });
    page.drawCircle({ x: cx, y: gy, size: 5, color: INK });
    center(score.toFixed(1), gy - 36, { size: 38, font: sansB, color: INK, cx });
    center("LEVERAGE  /  OUT OF 10", gy - 49, { size: 7.5, font: sansB, color: FAINT, cx });
    if (ms) { const refLbl = msrpExact ? "MSRP " + money(ms) : "CATALOG MSRP " + money(ms); const refAsk = (msrpExact && qp) ? "   -   ASKING " + money(qp) : ""; center(refLbl + refAsk, gy - 65, { size: 8.5, font: mono, color: SOFT, cx }); }
    const noteX = cx + r + 26, noteW = M + W - noteX;
    if (a.leverageScore.note) { let ny2 = y - 20; for (const ln of wrap(a.leverageScore.note, serifI, 11, noteW)) { page.drawText(ln, { x: noteX, y: ny2 - 11, size: 11, font: serifI, color: SOFT }); ny2 -= 16; } }
    y = gy - 78;
    rule();
  }

  // ---- THE AUDIT: at least 10, more when the report has more to say ----
  // The heading states the REAL count rather than a hardcoded "10", because
  // ten is the advertised FLOOR, not the delivered number (see tenPoints()).
  // A hardcoded 10 over a longer list is the same self-contradiction the app
  // shipped: "The 10-point verification" printed above 14 tiles.
  const POINTS = tenPoints(a);
  // TEN, THEN THE EXTRAS -- under their own heading.
  //
  // This printed `${POINTS.length}-POINT AUDIT`, which is derived and honest
  // about the count but calls an "MSRP per trim" card a verification point and
  // disagrees with the ten we advertise. The ten are a defined core; everything
  // a particular listing additionally supported is real, is printed in full
  // (Vic: "yes add them to pdf file all 14"), and is named for what it is.
  // Same split as the on-screen heatmap, from the same canonical list.
  const CORE = POINTS.slice(0, POINT_TITLES.length);
  const EXTRA = POINTS.slice(POINT_TITLES.length);
  kicker(`${CORE.length}-POINT AUDIT`);
  const toneColor: Record<string, any> = { pass: TEAL, flag: CORAL, muted: FAINT };
  const renderPoint = (p: { t: string; v: string; tone: string }) => {
    // THE LABEL IS ALWAYS LEGIBLE. It used to render in SOFT whenever the tone
    // was muted, so a muted row arrived as faded title + faint value + soft
    // body -- the whole row receding at once. Vic caught it on a PDF where
    // "Financing math -- $2,075/MO REF" was the most actionable number on the
    // page and the hardest line to read on it.
    //
    // A row's LABEL carries no verdict; it is just the name of the check, and a
    // reader scanning the audit has to be able to find it. Only the VALUE
    // carries tone. Fixes every muted row, not just this one.
    need(19); T(p.t, { size: 10.5, font: serif, color: INK }); right(p.v, { size: 9.5, font: monoB, color: toneColor[p.tone] || INK }); y -= 16.5;
    // "What this means" — the printed twin of the on-screen explanation box,
    // indented under its point in small italic so the audit stays scannable.
    const ex = pointExplain(p.t, a);
    if (ex) { para(ex, { size: 8.5, font: serifI, color: SOFT, lead: 3, x: M + 10, maxW: W - 10 }); advance(4); }
  };
  for (const p of CORE) renderPoint(p);
  if (EXTRA.length) {
    kicker(`ALSO CHECKED ON THIS LISTING (${EXTRA.length})`);
    for (const p of EXTRA) renderPoint(p);
  }
  rule();

  // ---- THE DEALER'S OWN PRICE BREAKDOWN ----
  // Printed because the dealer published it. Where the page's arithmetic
  // proves the fees are already inside the advertised price, the copy says so
  // and never implies they were added on top. The buyer's useful takeaway is
  // which line is the dealer's own -- that is the one they can ask about.
  if (dealerFeeTotal(a) > 0) {
    const dli = a.dealerLineItems;
    kicker("THE DEALER'S OWN PRICE BREAKDOWN");
    const inside = dli.insideAdvertisedPrice;
    para(inside === true
        ? "The dealer itemised their price on the listing. These charges are already included in the advertised price - they are not added on top."
      : inside === false
        ? "The dealer itemised their price on the listing. These charges sit on top of the advertised price."
        : "The dealer itemised their price on the listing. It does not say whether these are inside the advertised price or on top of it - ask.",
      { size: 9, font: sans, color: SOFT, lead: 3 });
    advance(4);
    for (const f of dli.fees) {
      need(15);
      T(pdfSafe(String(f.name)), { size: 9.5, font: sans, color: INK });
      right("$" + Number(f.amount).toLocaleString("en-CA"), { size: 9.5, font: monoB, color: INK });
      y -= 14;
    }
    for (const d of (dli.incentives || [])) {
      need(15);
      T(pdfSafe(String(d.name)), { size: 9.5, font: sans, color: SOFT });
      right("-$" + Number(d.amount).toLocaleString("en-CA"), { size: 9.5, font: monoB, color: TEAL });
      y -= 14;
    }
    advance(3);
    para(`The $${dealerFeeTotal(a).toLocaleString("en-CA")} ${dli.fees.length === 1 ? "fee is" : "fees are"} the dealer's own - not the manufacturer's and not a government charge - so ${dli.fees.length === 1 ? "it is" : "they are"} the line to ask about.`,
      { size: 8.5, font: serifI, color: SOFT, lead: 3 });
    rule();
  }

  // ---- MSRP PER TRIM — the factory range (client-derived, shape-validated;
  // standing requirement 2026-08-19: the buyer sees the manufacturer's range
  // with the source named, even when the dealer hides the trim) ----
  if (trimRangeOk(a.trimRange)) {
    const tr = a.trimRange;
    const qpT = Number(a.quotedPrice) || 0;
    const aboveN = qpT > 0 ? tr.t.filter((x: any) => qpT > Number(x.m)).length : 0;
    const allExcl = tr.t.every((x: any) => Number(x.b) === 1);
    need(64 + tr.t.length * 13);
    kicker("MSRP PER TRIM");
    T(`${tr.y} ${pdfSafe(tr.mk)} ${pdfSafe(tr.md)} - the manufacturer's price per trim${allExcl ? " (before freight & fees)" : ""}`, { size: 10.5, font: sansB }); y -= 18;
    // Capped VIEW, honest COUNT. The on-screen card, the flipbook and this PDF
    // used to truncate at three different numbers (all, 10, 12) and none said
    // so, giving one signed report several answers to "how many trims does the
    // manufacturer publish".
    const TRIM_ROWS_SHOWN = 12;
    for (const x of tr.t.slice(0, TRIM_ROWS_SHOWN)) {
      need(13);
      T(pdfSafe(x.p ? `${x.p} · ${x.n}` : x.n), { size: 9, font: sans, color: SOFT });
      right(`$${Number(x.m).toLocaleString("en-CA")}${Number(x.b) === 1 ? " + freight" : ""}`, { size: 9, font: sansB });
      y -= 13;
    }
    if (tr.t.length > TRIM_ROWS_SHOWN) {
      advance(2);
      T(`Showing ${TRIM_ROWS_SHOWN} of ${tr.t.length} published trims.`, { size: 7.5, font: mono, color: FAINT });
      y -= 11;
    }
    if (qpT > 0) { advance(3); para(`The asking price $${qpT.toLocaleString("en-CA")} sits above ${aboveN} of ${tr.t.length} published trim prices.${allExcl ? " Catalog prices exclude freight & fees - compare like-for-like." : ""}`, { size: 8.5, font: serifI, color: SOFT, lead: 3 }); }
    const site = EMAIL_MAKE_SITE[tr.mk];
    if (site) { advance(2); T("Source: confirm the range at " + site.replace(/^https:\/\/(www\.)?/, ""), { size: 7.5, font: mono, color: FAINT }); y -= 11; }
    rule();
  }

  // ---- DAYS ON LOT — the motivated-seller clock (dealer's own inventory data)
  // Rendered as the same alert card the app shows (white frame, tier-coloured
  // panel, first-seen date box, traffic light, CTA chip) so the PDF carries the
  // report's visual language, not a plain-text shadow of it.
  if (a.daysOnLot && Number(a.daysOnLot.days) > 0) {
    const d = Math.round(Number(a.daysOnLot.days));
    const dolMonths = d >= 60 ? (d / 30.4).toFixed(1).replace(/\.0$/, "") : null;
    // Same tiers as the app card: green < 31, amber 31-89, red 90+.
    const tier = d >= 90 ? 2 : d >= 31 ? 1 : 0;
    const ACC = [rgb(0.557, 0.835, 0), rgb(1, 0.69, 0.125), rgb(1, 0.231, 0.361)][tier];
    const DK = rgb(0.078, 0.078, 0.078), DK2 = rgb(0.165, 0.165, 0.165);
    const sinceD = a.daysOnLot.since ? new Date(a.daysOnLot.since + "T00:00:00") : null;
    const M3 = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

    const CARD_W = 330, CX = (PW - CARD_W) / 2, PADX = 20;
    const bodyTxt =
      `${dolMonths ? `About ${dolMonths} months` : `${d.toLocaleString("en-CA")} days`} on the dealer's lot` +
      `${a.daysOnLot.since ? ` - first seen ${a.daysOnLot.since}` : ""}. Source: ${a.daysOnLot.sourceLabel || "dealer inventory data"}. ` +
      (tier === 2
        ? "Well past the typical turn window - every extra week costs the dealer real money. Concrete discount leverage."
        : tier === 1
          ? "A month-plus on the lot - worth asking what they'll do on price to move it."
          : "Recently listed - limited sitting-time leverage on this unit.");
    const bodyW = CARD_W - PADX * 2 - 34;   // right inset clears the traffic light
    const bodyLines = wrap(bodyTxt, sans, 9, bodyW);
    const STRIP = 44, TITLE_H = 26, LINE_H = 12.5, CHIP_H = 20;
    const panelH = 16 + TITLE_H + bodyLines.length * LINE_H + 12 + CHIP_H + 16;
    const CARD_H = STRIP + panelH;

    need(CARD_H + 46);
    kicker("DAYS ON LOT");
    const top = y;                          // PDF y of the card's top edge
    // white frame + dark border
    page.drawRectangle({ x: CX, y: top - CARD_H, width: CARD_W, height: CARD_H, color: rgb(1, 1, 1), borderColor: DK, borderWidth: 2 });
    // tier-coloured content panel
    page.drawRectangle({ x: CX + 2, y: top - CARD_H + 2, width: CARD_W - 4, height: panelH - 2, color: ACC });
    // brand mark on the white strip
    drawLogo(CX + 12, top - 6, 34);
    // first-seen date box (dark, accent-bordered), straddling strip and panel
    const DB = 54, DBX = CX + CARD_W - DB - 16, DBY = top - 12;
    page.drawRectangle({ x: DBX, y: DBY - DB, width: DB, height: DB, color: DK, borderColor: ACC, borderWidth: 1 });
    if (sinceD) {
      center(`${M3[sinceD.getMonth()]} ${sinceD.getFullYear()}`, DBY - 15, { cx: DBX + DB / 2, size: 6.5, font: sansB, color: ACC });
      center(String(sinceD.getDate()), DBY - 34, { cx: DBX + DB / 2, size: 17, font: serifB, color: ACC });
      center("FIRST SEEN", DBY - 46, { cx: DBX + DB / 2, size: 5.5, font: sansB, color: ACC });
    } else {
      center(`${d.toLocaleString("en-CA")}d`, DBY - 34, { cx: DBX + DB / 2, size: 15, font: serifB, color: ACC });
    }
    // traffic light below the date box — the tier's bulb is lit
    const TLX = DBX + DB / 2, TLTOP = DBY - DB - 10, BULB = 5.5, GAP = 16;
    page.drawRectangle({ x: TLX - 10, y: TLTOP - GAP * 2 - 10 - BULB, width: 20, height: GAP * 2 + BULB * 2 + 10, color: DK, borderColor: DK2, borderWidth: 1 });
    ([[rgb(1, 0.231, 0.361), tier === 2], [rgb(1, 0.69, 0.125), tier === 1], [rgb(0.557, 0.835, 0), tier === 0]] as const)
      .forEach(([col, on], i) => {
        page.drawCircle({ x: TLX, y: TLTOP - BULB - 2 - i * GAP, size: BULB, color: on ? col : DK2 });
      });
    // headline + body inside the panel
    let cy = top - STRIP - 16;
    Tat(`${d.toLocaleString("en-CA")} DAYS ON LOT`, cy - 17, { x: CX + PADX, size: 17, font: serifB, color: DK });
    cy -= TITLE_H + 6;
    for (const ln of bodyLines) { Tat(ln, cy - 9, { x: CX + PADX, size: 9, font: sans, color: DK }); cy -= LINE_H; }
    // CTA chip (dark, accent text) — mirrors the app card's chip
    const chipTxt = d >= 31 ? "ASK FOR A DISCOUNT" : "FRESH ON THE LOT";
    const chipW = sansB.widthOfTextAtSize(chipTxt, 8) + 20;
    page.drawRectangle({ x: CX + PADX, y: cy - CHIP_H - 6, width: chipW, height: CHIP_H, color: DK });
    Tat(chipTxt, cy - CHIP_H + 1, { x: CX + PADX + 10, size: 8, font: sansB, color: ACC });
    y = top - CARD_H - 12;

    para(a.daysOnLot.atLeast === true
      ? "This is how long we have seen this exact car listed in our own daily tracking. It may have been sitting longer before we first saw it, so treat it as a floor rather than a total. Dealers pay interest on unsold stock every week, so the longer one sits, the more motivated they are to move it."
      : "This is how long this exact car has sat unsold, counted by the dealer's own inventory system - not our guess. Dealers pay interest on unsold stock every week, so the longer one sits, the more motivated they are to move it.",
      { size: 8.5, font: serifI, color: SOFT, lead: 3 });
    const careAsk = dolCareAskTxt(d).trim();
    if (careAsk) { advance(3); para(careAsk, { size: 8.5, font: serif, color: SOFT, lead: 3 }); }
    rule();
  } else {
    // The PDF omitted this section entirely when we could not read a date, so a
    // buyer never learned the question existed. An unanswered check still gets
    // its heading and a usable instruction.
    need(60);
    kicker("DAYS ON LOT");
    T("Not published - ask the dealer", { size: 14, font: serifB, color: SOFT }); y -= 19;
    para("This dealer's platform does not expose an inventory date, and we have not yet seen this VIN in our own daily tracking.", { size: 9, color: SOFT, lead: 4 });
    advance(2);
    para("Ask them outright: \"How long has this exact car been on your lot?\" A car that has sat 90+ days is carrying real cost for them, and it is an easy question to answer and an awkward one to dodge. We could not read it here, so we are not guessing at it.",
      { size: 8.5, font: serifI, color: SOFT, lead: 3 });
    rule();
  }

  // ---- HOW THIS VEHICLE COMPARES WITH THE ALBERTA MARKET ----
  // Three plain lines (this vehicle / similar listings in Alberta / difference)
  // from the shared builder (report-lines.js marketCompareLine): the words in
  // this PDF are the words in the HTML deck and on screen. A context section
  // like DAYS ON LOT, not one of the fixed audit points, and it renders
  // whenever a comparison set exists -- the not-enough state still gets its
  // heading and its reason. T/para run every string through pdfSafe, so the
  // builder's em dashes print as hyphens (the PDF fonts encode WinAnsi only).
  if (a.marketValue) {
    const line = marketCompareLine(a);
    const lines: Array<{ k: string; v: string }> = Array.isArray(line.lines) ? line.lines : [];
    const headColor = line.light === "red" ? CORAL : line.light === "green" ? TEAL : INK;
    need(96);
    kicker(line.title.toUpperCase());
    T(noEmDash(line.headline), { size: 13, font: serifB, color: headColor }); y -= 18;
    if (line.lightLabel) { T(noEmDash(line.lightLabel), { size: 9, font: sans, color: SOFT }); y -= 14; }
    for (const l of lines) {
      need(28);
      T(noEmDash(l.k).toUpperCase(), { size: 8, font: sansB, color: FAINT }); y -= 11;
      para(noEmDash(l.v), { size: 9.5, color: INK, lead: 3 });
      advance(3);
    }
    if (line.note) para(noEmDash(line.note), { size: 8.5, font: serifI, color: SOFT, lead: 3 });
    rule();
  }

  // ---- WHAT OLDER MODEL YEARS ASK TODAY ----
  // The model-year ladder as one line (this vehicle / one, two, three years
  // older) from the shared builder (report-lines.js olderYearsLine): the words
  // in this PDF are the words in the HTML deck and on screen. A context section
  // like the comparison above, and it renders whenever the ladder exists -- the
  // not-read and not-enough states still get their heading and their reason.
  // T/para run every string through pdfSafe; the builder's em dashes print as
  // hyphens (the PDF fonts encode WinAnsi only).
  if (a.olderYears) {
    const oyLine = olderYearsLine(a);
    const oyLines: Array<{ k: string; v: string }> = Array.isArray(oyLine.lines) ? oyLine.lines : [];
    need(96);
    kicker(oyLine.title.toUpperCase());
    // para(), not T(): T draws one unwrapped line, and this headline can be a
    // full sentence -- it would run off the right edge of the page.
    para(noEmDash(oyLine.headline), { size: 13, font: serifB, color: oyLine.state === "confirmed" ? INK : SOFT, lead: 4 });
    advance(4);
    if (oyLine.meta) { T(noEmDash(oyLine.meta), { size: 9, font: sans, color: SOFT }); y -= 14; }
    for (const l of oyLines) {
      need(28);
      T(noEmDash(l.k).toUpperCase(), { size: 8, font: sansB, color: FAINT }); y -= 11;
      para(noEmDash(l.v), { size: 9.5, color: INK, lead: 3 });
      advance(3);
    }
    // The not-read state carries its reason in the body and no lines, so the
    // body is what prints when there is no line to print.
    if (!oyLines.length && oyLine.body) para(noEmDash(oyLine.body), { size: 9, color: SOFT, lead: 4 });
    if (oyLine.note) para(noEmDash(oyLine.note), { size: 8.5, font: serifI, color: SOFT, lead: 3 });
    rule();
  }

  // ---- INSURANCE BEFORE YOU SIGN ----
  // A sequencing warning from Alberta's insurance regulator, from the shared
  // builder (report-lines.js financeCoverageLine): the words in this PDF are
  // the words in the HTML deck and on screen. A context section like the two
  // above, not one of the fixed audit points, and it carries no figure, no
  // traffic light and no band -- five labelled lines and a citation.
  //
  // Alberta only: financeCoverageApplies() gates every surface identically,
  // because the line cites Alberta statute and an Alberta regulator.
  //
  // BOTH states print the same five lines ("confirmed" when the listing itself
  // shows financing, "general" when it does not), so the headline keeps INK in
  // both -- there is no unread half here to grey out. T/para run every string
  // through pdfSafe; the builder's em dashes print as hyphens (the PDF fonts
  // encode WinAnsi only).
  if (financeCoverageApplies(a)) {
    const fcLine = financeCoverageLine(a);
    const fcLines: Array<{ k: string; v: string }> = Array.isArray(fcLine.lines) ? fcLine.lines : [];
    need(96);
    kicker(fcLine.title.toUpperCase());
    // para(), not T(): T draws one unwrapped line, and this headline is a full
    // sentence -- it would run off the right edge of the page.
    para(noEmDash(fcLine.headline), { size: 13, font: serifB, color: INK, lead: 4 });
    advance(4);
    if (fcLine.meta) { T(noEmDash(fcLine.meta), { size: 9, font: sans, color: SOFT }); y -= 14; }
    for (const l of fcLines) {
      need(28);
      T(noEmDash(l.k).toUpperCase(), { size: 8, font: sansB, color: FAINT }); y -= 11;
      para(noEmDash(l.v), { size: 9.5, color: INK, lead: 3 });
      advance(3);
    }
    // Same never-empty rule as the sections above: if the builder ever returned
    // no lines, its body sentence is what prints.
    if (!fcLines.length && fcLine.body) para(noEmDash(fcLine.body), { size: 9, color: SOFT, lead: 4 });
    if (fcLine.note) para(noEmDash(fcLine.note), { size: 8.5, font: serifI, color: SOFT, lead: 3 });
    rule();
  }

  // ---- YOUR PREMIUM AFTER THIS PURCHASE ----
  // The COST sibling of the section above, from the shared builder
  // (report-lines.js insurancePremiumLine): the words in this PDF are the words
  // in the HTML deck and on screen. A context section like the ones above, not
  // one of the fixed audit points, and it carries no figure, no traffic light
  // and no band -- four labelled lines and a citation.
  //
  // Alberta only: financeCoverageApplies() gates every surface identically,
  // because the line cites Alberta statute and an Alberta regulator.
  //
  // The builder reads NOTHING from the listing -- it is regulator copy,
  // identical for every Alberta report -- so there is ONE state and the
  // headline keeps INK; there is no unread half to grey out. T/para run every
  // string through pdfSafe, which folds the builder's curly quotes around the
  // regulator's quoted sentence to straight quotes and its em dashes to
  // hyphens (the PDF fonts encode WinAnsi only).
  if (financeCoverageApplies(a)) {
    const ipLine = insurancePremiumLine(a);
    const ipLines: Array<{ k: string; v: string }> = Array.isArray(ipLine.lines) ? ipLine.lines : [];
    need(96);
    kicker(ipLine.title.toUpperCase());
    // para(), not T(): T draws one unwrapped line, and this headline is a full
    // sentence -- it would run off the right edge of the page.
    para(noEmDash(ipLine.headline), { size: 13, font: serifB, color: INK, lead: 4 });
    advance(4);
    if (ipLine.meta) { T(noEmDash(ipLine.meta), { size: 9, font: sans, color: SOFT }); y -= 14; }
    for (const l of ipLines) {
      need(28);
      T(noEmDash(l.k).toUpperCase(), { size: 8, font: sansB, color: FAINT }); y -= 11;
      para(noEmDash(l.v), { size: 9.5, color: INK, lead: 3 });
      advance(3);
    }
    // Same never-empty rule as the sections above: if the builder ever returned
    // no lines, its body sentence is what prints.
    if (!ipLines.length && ipLine.body) para(noEmDash(ipLine.body), { size: 9, color: SOFT, lead: 4 });
    if (ipLine.note) para(noEmDash(ipLine.note), { size: 8.5, font: serifI, color: SOFT, lead: 3 });
    rule();
  }

  // ---- OTHER LISTINGS READ -- the count, from the shared builder ----
  // Outside the market-value conditional above so it ALWAYS RENDERS: an unread
  // or empty set still gets its heading, its headline and the reason -- the
  // same never-empty rule as the DAYS ON LOT else-branch.
  {
    const line = marketCountLine(a);
    need(60);
    kicker("OTHER LISTINGS READ");
    T(noEmDash(line.headline), { size: 13, font: serifB, color: line.state === "confirmed" ? INK : SOFT }); y -= 18;
    para(noEmDash(line.body), { size: 9, color: SOFT, lead: 4 });
    rule();
  }

  // ---- DEALER LICENCE (#11) — AMVIC public registry, verbatim status ----
  if (a.dealerLicence && a.dealerLicence.status) {
    const L = a.dealerLicence, good = L.state === "valid";
    need(70);
    kicker("DEALER LICENCE - AMVIC PUBLIC REGISTRY");
    T(String(L.status), { size: 14, font: serifB, color: good ? INK : CORAL }); y -= 19;
    para(`${L.legalName ? L.legalName + " - " : ""}${L.licenceNumber ? "licence " + L.licenceNumber + " - " : ""}${L.expiryDate ? "expiry " + L.expiryDate + " - " : ""}source: AMVIC public licensee registry.`, { size: 9, color: SOFT, lead: 4 });
    advance(2);
    para(good
      ? "AMVIC is Alberta's regulator; every business selling vehicles in the province must hold a licence. This dealer's registry entry currently reads as licensed."
      : "AMVIC's registry currently shows this status for the matched business. Records can lag and businesses do reapply, so this is not a verdict - but ask for the current licence number and status in writing before any deposit, and verify it yourself on AMVIC's public search.",
      { size: 8.5, font: serifI, color: SOFT, lead: 3 });
    rule();
  }

  // ---- FINANCE-CONTINGENT PRICE (S37) ----
  if (a.financeContingent && a.financeContingent.contingent) {
    need(80);
    kicker("PRICE DEPENDS ON FINANCING WITH THE DEALER");
    T("This price is tied to taking the dealer's financing", { size: 13, font: serifB, color: INK }); y -= 18;
    para("The listing's own wording conditions the advertised price on financing through the dealer. Pay cash, or use your own bank, and the price can legitimately change - the discount is often funded by the dealer's commission on the loan, so it leaves with the loan.", { size: 9, color: SOFT, lead: 4 });
    if (a.financeContingent.evidence) { advance(2); para(`"...${String(a.financeContingent.evidence).replace(/[^ -~]/g, " ")}..."`, { size: 8.5, font: serifI, color: SOFT, lead: 3 }); }
    advance(2);
    para('Ask before you go in: "What is the price if I pay cash or use my own bank - and if it changes, by exactly how much?" In writing.', { size: 9, color: INK, lead: 4 });
    rule();
  }

  // ---- PAYMENT DEFAULT -- the page's own pre-selected payment scenario ----
  // ALWAYS RENDERS, same rule: "not published" and "not read" are answers.
  {
    const line = pageDefaultLine(a);
    need(60);
    kicker("PAYMENT STARTING POINT");
    T(noEmDash(line.headline), { size: 13, font: serifB, color: line.state === "confirmed" ? INK : SOFT }); y -= 18;
    para(noEmDash(line.body), { size: 9, color: SOFT, lead: 4 });
    rule();
  }

  // ---- TRADE-IN TOOL (S36) — wholesale-anchored widget on the listing ----
  if (a.tradeInWidget && a.tradeInWidget.detected) {
    need(70);
    kicker("TRADE-IN TOOL ON THIS LISTING");
    T(`Instant trade-in appraisal widget${a.tradeInWidget.vendor ? ` (${a.tradeInWidget.vendor})` : ""}`, { size: 13, font: serifB, color: INK }); y -= 18;
    para("Its number is anchored to the wholesale side of the market (what dealers pay each other), it is non-binding, and it appears in exchange for your contact and vehicle details.", { size: 9, color: SOFT, lead: 4 });
    advance(2);
    para("If you have a trade: settle this vehicle's price first; get the trade offer in writing on its own line - never one blended payment; and check retail listings for your own car before disclosing anything.", { size: 8.5, font: serifI, color: SOFT, lead: 3 });
    rule();
  }

  // ---- RECALL DETAIL ----
  if (a.recalls?.checked && a.recalls.count > 0 && (a.recalls.items || []).length) {
    kicker("OPEN RECALLS - TRANSPORT CANADA");
    para("Public safety-recall campaigns Transport Canada publishes for this year, make and model - government data, not our opinion. Confirm by VIN with the dealer; every listed repair is free of charge.", { size: 9, color: SOFT, lead: 4 });
    advance(4);
    for (const it of a.recalls.items.slice(0, 5)) {
      const yr = it.date ? " (" + (new Date(it.date).getFullYear() || "") + ")" : "";
      need(16); T("-  " + (it.system || "Recall") + yr, { size: 10, font: serifB, color: CORAL }); y -= 14;
      if (it.summary) para(it.summary, { size: 9, color: SOFT, lead: 3, x: M + 12, maxW: W - 12 });
      advance(3);
    }
    rule();
  }

  // ---- EV / PHEV REBATE ----
  const ev = a.evapRebate;
  if (ev && ev.eligible) {
    need(80);
    kicker("EV / PHEV REBATE");
    const rTop = y;
    Tat("REBATE AVAILABLE", rTop - 9, { size: 8, font: sansB, color: FAINT });
    Tat(money(ev.total), rTop - 34, { size: 25, font: monoB, color: TEAL });
    const bx = M + W / 2 + 14;
    Tat("BREAKDOWN", rTop - 9, { x: bx, size: 8, font: sansB, color: FAINT });
    Tat(money(ev.federal) + " federal" + (ev.provincial > 0 ? "  +  " + money(ev.provincial) + " " + (ev.prov_name || "provincial") : ""), rTop - 30, { x: bx, size: 12, font: serif, color: INK });
    page.drawLine({ start: { x: M + W / 2, y: rTop - 6 }, end: { x: M + W / 2, y: rTop - 40 }, thickness: 0.7, color: HAIR });
    y = rTop - 46;
    if (ev.note) para(ev.note, { size: 9, color: SOFT, lead: 4 });
    rule();
  }

  // ---- BOTTOM LINE ----
  if (a.summary) {
    need(60);
    kicker("THE BOTTOM LINE");
    page.drawLine({ start: { x: M, y: y - 2 }, end: { x: M, y: y - 46 }, thickness: 2.4, color: TEAL });
    for (const ln of wrap(a.summary, serifI, 13, W - 20)) { need(19); page.drawText(ln, { x: M + 16, y: y - 13, size: 13, font: serifI, color: INK }); y -= 19; }
    y -= 8;
    rule();
  }

  // ---- WHAT TO SAY (counter-script) ----
  if (a.counterScript && Array.isArray(a.counterScript.moves) && a.counterScript.moves.length) {
    const cs = a.counterScript;
    need(70);
    kicker(cs.clean ? "SAY THIS TO CONFIRM" : "WHAT TO SAY AT THE DEALERSHIP");
    para(cs.clean
      ? "This deal looks straight - no add-ons or traps flagged. Just lock in the number:"
      : "Read these to the dealer, in order. Each line comes from a finding above - say them and hold.",
      { size: 9.5, font: serifI, color: SOFT, lead: 4 });
    y -= 4;
    cs.moves.forEach((mv: any, i: number) => {
      const lines = wrap(pdfSafe(String(mv?.say || "")), serif, 11, W - 24);
      if (!lines.length) return;
      need(lines.length * 16 + 6);
      page.drawText((i + 1) + ".", { x: M, y: y - 11, size: 11, font: sansB, color: TEAL });
      for (const ln of lines) { page.drawText(ln, { x: M + 22, y: y - 11, size: 11, font: serif, color: INK }); y -= 16; }
      y -= 3;
    });
    y -= 6;
    rule();
  }

  // ---- CLOSING (thank-you) + FOOTER ----
  advance(8);
  need(64);
  center("Thank you for letting LotCheck check your quote.", y - 14, { size: 14, font: serifB, color: INK });
  y -= 24;
  for (const ln of wrap("You did the smart thing by looking before you signed. Walk in knowing your numbers, ask the questions above, and good luck at the table - we're rooting for you.", serifI, 10.5, W - 60)) { center(ln, y - 11, { size: 10.5, font: serifI, color: SOFT }); y -= 15; }
  y -= 6;

  // ---- VERIFY QR ---- scan the printed page to open the signed, self-contained
  // check. Guarded: a QR failure must never break the report. The payload rides
  // in the URL (nothing stored), so the code is dense -> printed large (~2").
  if (verifyUrl) {
    try {
      const qrcode = (await import("https://esm.sh/qrcode-generator@1.4.4")).default as any;
      // EC level "M" (15% recovery) — verified with a real QR decoder to stay
      // scannable WITH the centred logo, while keeping the module count coarse
      // enough to scan easily (EC-H made it needlessly dense). Payload is gzip-
      // compressed (report-sign) so a whole signed report still fits.
      const qr = qrcode(0, "M"); qr.addData(verifyUrl); qr.make();
      const count = qr.getModuleCount();
      const QS = 210, cell = QS / count;
      need(QS + 34);
      const qx = PW / 2 - QS / 2, qbot = y - QS;
      page.drawRectangle({ x: qx - 7, y: qbot - 7, width: QS + 14, height: QS + 14, color: rgb(1, 1, 1) });
      for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (qr.isDark(r, c)) {
        page.drawRectangle({ x: qx + c * cell, y: qbot + (count - 1 - r) * cell, width: cell + 0.4, height: cell + 0.4, color: INK });
      }
      // Centred LotCheck logo — white knockout box (EC-H recovers the covered
      // modules) + the real isometric mark, so the code is branded and scannable.
      const lw = QS * 0.19, lx = PW / 2 - lw / 2, ly = qbot + QS / 2 - lw / 2;
      page.drawRectangle({ x: lx - 4, y: ly - 4, width: lw + 8, height: lw + 8, color: rgb(1, 1, 1) });
      drawLogo(lx, ly + lw * 0.784, lw);
      // Unique seal beside the QR — the impossible-to-copy mark for THIS report.
      drawSeal(M + 66, qbot + QS / 2 + 6, 34);
      center("UNIQUE SEAL", qbot + QS / 2 - 56, { size: 7, font: sansB, color: FAINT, cx: M + 66 });
      y = qbot - 14;
      center("Scan to verify - recomputes the fingerprint and checks LotCheck's signature.", y, { size: 8.5, font: sansB, color: SOFT });
      y -= 16;
    } catch (e) { console.warn("QR generation skipped:", (e as Error)?.message); }
  }

  rule(HAIR, 0.7, 6);
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
  // THE COLOPHON RESERVES ITS SPACE BEFORE IT WRITES, not after.
  //
  // This block used to run para(...) and THEN need(40) for the logo + ID line.
  // para() reserves per LINE, so it can legally leave y as low as M+30 (86);
  // need(40) then fires for any y under 126 and opens a brand-new page whose
  // only ink is the logo and the ID. That is exactly what Vic saw on the 2025
  // Mazda CX-90 report (LC-436A-B5C): page 4 of 5 blank but for the logo and
  // "LOTCHECK - LC-436A-B5C - lotcheck.ca/verify".
  //
  // No section rendered empty -- every optional section is if-guarded and an
  // untaken branch draws nothing. It is a PHASE bug, and it only shows on a
  // SHORT report, because only then does the paragraph's last line land in the
  // orphan band. That is why it survived: the reports we look at most are the
  // long ones.
  //
  // Reserving the whole trailer up front means the paragraph and the mark it
  // belongs to either share a page or move to the next one together. A block
  // must not be able to open a page it cannot fill.
  const colophonText = "Analyzed once, never stored on our end. This report's ID is a fingerprint of its own contents" + (issued ? " issued " + issued.toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "") + " - change any figure and the ID changes, so it is tamper-evident. " + (verifyUrl ? "Scan the code above (or use the link in your email) to verify it at lotcheck.ca/verify - it recomputes the fingerprint and checks the signature, and nothing is stored on our end. " : "Verify it anytime at lotcheck.ca/verify using the link in this email. ") + (capImg && capPages > 0 ? "The sealed listing capture is printed on the pages that follow and attached as its own photo file. " : sealedShot ? "The sealed listing capture is attached to your email as its own photo file. " : "") + "Every figure traces to a public source you can re-check: recalls to Transport Canada, MSRP to the manufacturer catalogue, reviews to Google. Vehicle, price, and fee details were read from the dealer's page by an automated system, including AI reading the page or a screenshot when it couldn't be parsed directly - verify them against the original listing before you rely on them. LotCheck reviews the deal, not the car's history - pair it with a vehicle-history report before you buy.";
  const COLOPHON_H = 40 + 30;                      // logo + ID line, per the draws below
  {
    const lines = Math.max(1, Math.ceil(String(colophonText).length / 110));
    need(COLOPHON_H + lines * 11);
  }
  para(colophonText, { size: 8, color: FAINT, font: sans, lead: 3 });
  { const w = 34; drawLogo(PW / 2 - w / 2, y - 2, w); }
  y -= 30;
  center("LOTCHECK  -  " + RID + "  -  lotcheck.ca/verify", y - 8, { size: 7.5, font: sansB, color: FAINT });

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
        const bytes = await buildReportPdf(analysis, verifyUrl, sealedShot);
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