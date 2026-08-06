// supabase/functions/email-quote-report/index.ts
//
// Sends a Quote Check analysis to the address the buyer entered on the
// results screen. Takes the already-computed `analysis` object from the
// client (the same one already rendered on screen) rather than re-running
// the quote through Claude a second time -- cheaper, faster, and there's
// no reason to redo work that's already done.
//
// Nothing here writes to a database. The email is generated and sent in
// this one request, then the function's memory is gone -- consistent with
// Quote Check's existing "never saved on our end" line on the page.
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

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function isValidEmail(v: string): boolean {
  // Same simple pattern as the client-side check -- catches obvious typos
  // without the false-negative risk of a stricter regex. The client already
  // validates this, but a request can always come from somewhere other
  // than the real page, so it's checked again here.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
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

function buildEmailHtml(analysis: any, reportUrl?: string, verifyUrl?: string): string {
  const isNew = analysis.vehicleCondition === "new";
  const price = analysis.quotedPrice || analysis.msrp || 0;
  const blocks: string[] = [];

  // Price vs MSRP
  const hasCmp = !!(analysis.msrp && analysis.quotedPrice);
  const over = hasCmp && analysis.quotedPrice > analysis.msrp;
  const diff = hasCmp ? Math.abs(analysis.quotedPrice - analysis.msrp) : 0;
  blocks.push(`<div style="${CARD}"><table style="width:100%;"><tr>
    <td style="vertical-align:top;"><div style="${LBL}">MSRP</div><div style="font-size:20px;font-weight:800;color:#33305A;">${analysis.msrp ? money(analysis.msrp) : "Not shown on quote"}</div></td>
    <td style="vertical-align:top;"><div style="${LBL}">Quoted price</div><div style="font-size:20px;font-weight:800;color:${hasCmp ? (over ? "#A63C25" : "#17756B") : "#33305A"};">${analysis.quotedPrice ? money(analysis.quotedPrice) : "Not found"}</div>
      ${hasCmp ? `<div style="font-size:12px;font-weight:700;color:${over ? "#A63C25" : "#17756B"};margin-top:3px;">${diff === 0 ? "= Exactly at MSRP" : over ? "▲ " + money(diff) + " over MSRP" : "▼ " + money(diff) + " under MSRP"}</div>` : ""}</td>
  </tr></table></div>`);

  // Flagged banner
  if (analysis.totalFlaggedCost > 0) {
    blocks.push(`<div style="background:#FDEAE5;border:1px solid #F2836B55;border-radius:12px;padding:14px 16px;margin-bottom:14px;">
      <div style="color:#A63C25;font-weight:800;font-size:14px;">⚠️ ${money(analysis.totalFlaggedCost)} in flagged add-ons</div>
      <div style="font-size:12px;color:#5B5885;margin-top:4px;">Commonly overpriced items worth questioning or negotiating down.</div></div>`);
  }

  // Leverage score
  if (analysis.leverageScore?.computed) {
    blocks.push(`<div style="background:#E3F4F1;border:1px solid #2FA79A55;border-radius:14px;padding:16px;margin-bottom:14px;">
      <div style="${LBL}">Negotiation leverage</div>
      <div style="font-size:26px;font-weight:900;color:#17756B;">${analysis.leverageScore.score}<span style="font-size:14px;color:#706D96;"> /10</span></div>
      <div style="${NOTE}">${escapeHtml(analysis.leverageScore.note)}</div></div>`);
  }

  // Recalls
  const rc = analysis.recalls;
  if (rc) {
    if (!rc.checked) {
      blocks.push(`<div style="${CARD}"><div style="${LBL}">Open recalls · Transport Canada</div><div style="font-size:13px;color:#5B5885;">Couldn't reach the recall registry — check directly at Transport Canada before you sign.</div></div>`);
    } else if (rc.count === 0 && rc.confirmed === false) {
      // Zero rows, but the model never matched Transport Canada's records -- NOT a clean bill.
      blocks.push(`<div style="background:#FCF3E0;border:1px solid #E0A80055;border-radius:14px;padding:16px;margin-bottom:14px;"><div style="${LBL}">Open recalls · Transport Canada</div><div style="font-size:14px;font-weight:800;color:#9A6B00;">Couldn't confirm recalls for this exact model</div><div style="${NOTE}">This is not an all-clear — check open recalls directly by VIN at Transport Canada before you sign.</div></div>`);
    } else if (rc.count === 0) {
      blocks.push(`<div style="background:#E3F4F1;border:1px solid #2FA79A55;border-radius:14px;padding:16px;margin-bottom:14px;"><div style="${LBL}">Open recalls · Transport Canada</div><div style="font-size:15px;font-weight:800;color:#17756B;">✓ No open recalls found</div></div>`);
    } else {
      const items = (rc.items || []).slice(0, 4).map((it: any) => {
        const yr = it.date ? " · " + new Date(it.date).getFullYear() : "";
        return `<div style="font-size:12px;color:#33305A;margin-top:8px;padding-top:8px;border-top:1px solid #F2836B33;"><b>${escapeHtml(it.system || "Recall")}${isNaN(new Date(it.date).getFullYear()) ? "" : yr}</b>${it.summary ? `<div style="color:#5B5885;margin-top:2px;line-height:1.5;">${escapeHtml(it.summary)}</div>` : ""}</div>`;
      }).join("");
      blocks.push(`<div style="background:#FDEAE5;border:1px solid #F2836B55;border-radius:14px;padding:16px;margin-bottom:14px;">
        <div style="${LBL}">Open recalls · Transport Canada</div>
        <div style="font-size:19px;font-weight:900;color:#A63C25;">${rc.count} open recall${rc.count > 1 ? "s" : ""}</div>${items}
        <div style="font-size:11px;color:#706D96;margin-top:10px;">Recalls are repaired free of charge — confirm the fix status with the dealer before you sign.</div></div>`);
    }
  }

  // Odometer
  if (analysis.odometerCheck?.checked) {
    const flag = analysis.odometerCheck.flag;
    blocks.push(`<div style="background:${flag ? "#FDEAE5" : "#fff"};border:1px solid ${flag ? "#F2836B55" : "#eee"};border-radius:14px;padding:16px;margin-bottom:14px;">
      <div style="${LBL}">Odometer</div>
      <div style="font-size:18px;font-weight:900;color:${flag ? "#A63C25" : "#33305A"};">${Number(analysis.odometerCheck.km).toLocaleString()} km${flag ? " ⚠" : ""}</div>
      <div style="${NOTE}">${escapeHtml(analysis.odometerCheck.note)}</div></div>`);
  }

  // VIN
  if (analysis.vinCheck?.present) {
    const ok = analysis.vinCheck.valid;
    blocks.push(`<div style="background:${ok ? "#fff" : "#FDEAE5"};border:1px solid ${ok ? "#eee" : "#F2836B55"};border-radius:14px;padding:16px;margin-bottom:14px;">
      <div style="${LBL}">VIN check${analysis.vinCheck.vin ? " · " + escapeHtml(analysis.vinCheck.vin) : ""}</div>
      <div style="font-size:14px;font-weight:800;color:${ok ? "#17756B" : "#A63C25"};">${ok ? "✓ Valid VIN pattern" : "⚠ VIN doesn't validate"}</div>
      <div style="${NOTE}">${escapeHtml(analysis.vinCheck.reason)}</div></div>`);
  }

  // EVAP rebate (precomputed client-side, attached to payload)
  const ev = analysis.evapRebate;
  if (ev) {
    if (ev.eligible) {
      blocks.push(`<div style="background:#E3F4F1;border:1px solid #2FA79A55;border-radius:14px;padding:16px;margin-bottom:14px;">
        <div style="font-size:13px;font-weight:800;color:#17756B;margin-bottom:6px;">🎉 EVAP rebate eligible</div>
        <div style="font-size:18px;font-weight:900;color:#33305A;">${money(ev.total)} available</div>
        <div style="${NOTE}">${money(ev.federal)} federal${ev.provincial > 0 ? " + " + money(ev.provincial) + " " + escapeHtml(ev.prov_name || "provincial") : ""}${ev.note ? " — " + escapeHtml(ev.note) : ""}</div></div>`);
    } else if (ev.ineligibleReason) {
      blocks.push(`<div style="background:#FCF3E0;border:1px solid #E0A80055;border-radius:14px;padding:16px;margin-bottom:14px;">
        <div style="font-size:13px;font-weight:800;color:#9A6B00;margin-bottom:6px;">⚡ EV/PHEV rebate check</div>
        <div style="${NOTE}">${escapeHtml(ev.ineligibleReason)}</div></div>`);
    }
  }

  // Financing math
  if (analysis.financingCheck?.checked) {
    const ok = analysis.financingCheck.consistent;
    blocks.push(`<div style="background:${ok ? "#fff" : "#FDEAE5"};border:1px solid ${ok ? "#eee" : "#F2836B55"};border-radius:14px;padding:16px;margin-bottom:14px;">
      <div style="${LBL}">Financing math</div>
      <div style="font-size:14px;font-weight:800;color:${ok ? "#17756B" : "#A63C25"};">${ok ? "✓ Payments reconcile" : "⚠ Numbers don't add up"}</div>
      <div style="${NOTE}">${escapeHtml(analysis.financingCheck.note)}</div></div>`);
  }

  // Financing examples (two rates)
  const fr = analysis.financeRates;
  if (fr && (fr.dealer || fr.manufacturer) && price > 0) {
    let inner = `<div style="${LBL}">Financing examples · on ${money(price)}</div>
      <div style="font-size:12px;color:#5B5885;line-height:1.55;padding:8px 10px;background:#FBF5EC;border:1px solid #eee;border-radius:10px;margin:4px 0 6px;"><b style="color:#33305A;">What's APR?</b> The Annual Percentage Rate is the yearly cost of borrowing — the interest on top of the price. Lower is better. Rates are colour-coded: <span style="color:#17756B;font-weight:900;">low</span> · <span style="color:#9A6B00;font-weight:900;">average</span> · <span style="color:#A63C25;font-weight:900;">high</span>.</div>`;
    if (fr.manufacturer) {
      inner += isNew
        ? financeBlockEmail(`${escapeHtml(analysis.make || "")} advertised rate`, `The manufacturer's rate on a new ${escapeHtml(analysis.make || "vehicle")} — aim for this.`, fr.manufacturer.apr, price, false)
        : financeBlockEmail(`${escapeHtml(analysis.make || "")}'s new-vehicle rate`, `Reference only: this is the NEW-vehicle rate. This vehicle is USED, so it doesn't apply — used financing is set by the dealer and usually higher.`, fr.manufacturer.apr, price, true);
    }
    if (fr.dealer) {
      inner += financeBlockEmail("This dealer's rate", "What this listing is actually offering you.", fr.dealer.apr, price, false);
    }
    if (isNew && fr.dealer && fr.manufacturer && fr.dealer.apr - fr.manufacturer.apr > 0.1) {
      const rd = fr.dealer.apr / 1200, rm = fr.manufacturer.apr / 1200;
      const extra = Math.round((price * rd / (1 - Math.pow(1 + rd, -60)) - price * rm / (1 - Math.pow(1 + rm, -60))) * 60);
      inner += `<div style="background:#FDEAE5;border:1px solid #F2836B55;border-radius:12px;padding:12px 14px;margin-top:10px;"><div style="font-size:12px;color:#A63C25;font-weight:800;line-height:1.5;">⚠ This dealer's rate is ${(fr.dealer.apr - fr.manufacturer.apr).toFixed(2)}% above ${escapeHtml(analysis.make || "the manufacturer")}'s advertised rate — roughly ${money(extra)} more over 60 months. Ask them to match it.</div></div>`;
    }
    inner += `<div style="font-size:11px;color:#706D96;margin-top:10px;line-height:1.5;">Estimates only, before tax — one rate applied across terms for illustration; actual rates vary by term, promo, and credit. Confirm with the dealer.</div>`;
    blocks.push(`<div style="${CARD}">${inner}</div>`);
  }

  // Dealer reviews
  const ds = analysis.dealerSentiment;
  if (ds && (ds.highlights || []).length) {
    const hl = (ds.highlights || []).slice(0, 5).map((h: any) => `<div style="padding:6px 0;border-top:1px solid #eee;"><span style="color:#17756B;font-weight:800;font-size:12px;">★${h.rating}</span> <span style="font-size:13px;color:#33305A;line-height:1.5;">${escapeHtml(h.text)}</span></div>`).join("");
    blocks.push(`<div style="${CARD}"><table style="width:100%;"><tr>
      <td style="font-size:13px;font-weight:800;color:#5B5885;">What customers say about ${escapeHtml(ds.dealerName || "this dealer")}</td>
      <td style="text-align:right;font-size:12px;color:#706D96;white-space:nowrap;">${ds.rating ? "★ " + Number(ds.rating).toFixed(1) : ""}${ds.reviewCount ? " · " + Number(ds.reviewCount).toLocaleString() + " reviews" : ""}</td>
    </tr></table>${hl}<div style="font-size:11px;color:#706D96;margin-top:8px;">Based on public Google reviews.</div></div>`);
  }

  // Standard (included) warranty
  if (analysis.standardWarranty?.coverage) {
    blocks.push(`<div style="background:#E3F4F1;border:1px solid #2FA79A55;border-radius:14px;padding:16px;margin-bottom:14px;">
      <div style="font-size:13px;font-weight:800;color:#17756B;margin-bottom:4px;">✓ Included manufacturer warranty${analysis.standardWarranty.verified ? "" : ""}</div>
      <div style="font-size:14px;color:#33305A;">${escapeHtml(analysis.standardWarranty.coverage)}</div>
      ${analysis.standardWarranty.note ? `<div style="${NOTE}">${escapeHtml(analysis.standardWarranty.note)}</div>` : ""}</div>`);
  }

  // Add-ons
  if ((analysis.addOns || []).length > 0) {
    const rows = (analysis.addOns || []).map((a: any) => `<tr>
      <td style="padding:8px 0;border-top:1px solid #eee;font-size:13px;color:#33305A;">${a.verdict === "flagged" ? "🔻 " : ""}${escapeHtml(a.name)}<div style="font-size:12px;color:#706D96;margin-top:2px;line-height:1.4;">${escapeHtml(a.reason)}</div></td>
      <td style="padding:8px 0;border-top:1px solid #eee;text-align:right;font-weight:700;color:${a.verdict === "flagged" ? "#A63C25" : "#33305A"};white-space:nowrap;">${money(a.price)}</td></tr>`).join("");
    blocks.push(`<div style="${CARD}"><div style="font-size:13px;font-weight:800;color:#5B5885;margin-bottom:8px;">Add-ons &amp; fees</div><table style="width:100%;border-collapse:collapse;">${rows}</table></div>`);
  }

  // Extended/sold warranty
  if (analysis.warranty?.offered) {
    blocks.push(`<div style="${CARD}"><div style="font-size:13px;font-weight:800;color:#5B5885;margin-bottom:6px;">Warranty / protection plan</div>
      <div style="color:#33305A;font-size:14px;margin-bottom:4px;">${escapeHtml(analysis.warranty.offered)}${analysis.warranty.price ? " — " + money(analysis.warranty.price) : ""}</div>
      <div style="font-size:12px;color:#706D96;">${escapeHtml(analysis.warranty.assessment)}</div></div>`);
  }

  // Bottom line
  if (analysis.summary) {
    blocks.push(`<div style="background:#E3F4F1;border:1px solid #2FA79A55;border-radius:14px;padding:18px;margin-bottom:14px;">
      <div style="font-size:13px;font-weight:800;color:#17756B;margin-bottom:8px;">Bottom line</div>
      <div style="color:#33305A;font-size:14px;line-height:1.6;">${escapeHtml(analysis.summary)}</div></div>`);
  }

  // What to say (counter-script) — the actionable capstone, email-safe layout.
  const cs = analysis.counterScript;
  if (cs && Array.isArray(cs.moves) && cs.moves.length) {
    const items = cs.moves.map((mv: any, i: number) =>
      `<div style="padding:7px 0;border-top:${i > 0 ? "1px solid rgba(51,48,90,.1)" : "none"};font-size:13px;color:#33305A;line-height:1.5;"><b style="color:#17756B;">${i + 1}.</b> ${escapeHtml(String(mv?.say || ""))}</div>`
    ).join("");
    blocks.push(`<div style="background:#fff;border:1px solid #17756B55;border-radius:14px;padding:18px;margin-bottom:14px;">
      <div style="font-size:13px;font-weight:800;color:#17756B;margin-bottom:4px;">${cs.clean ? "Say this to confirm" : "What to say — your counter-script"}</div>
      <div style="font-size:12px;color:#706D96;margin-bottom:6px;">${cs.clean ? "This deal looks straight — just lock in the number:" : "Read these to the dealer, in order. Say them and hold."}</div>
      ${items}</div>`);
  }

  return `
  <div style="font-family:'Nunito',system-ui,-apple-system,sans-serif;background:#FBF5EC;padding:24px;">
    <div style="max-width:560px;margin:0 auto;">
      <div style="font-weight:800;font-size:18px;color:#33305A;margin-bottom:4px;">LotCheck Quote Check</div>
      <div style="font-size:13px;color:#706D96;margin-bottom:16px;">${escapeHtml(analysis.vehicle || "Your quote")}</div>
      ${reportUrl ? `<div style="margin-bottom:18px;"><a href="${escapeHtml(reportUrl)}" style="display:inline-block;background:#17756B;color:#fff;font-weight:800;font-size:14px;text-decoration:none;padding:12px 22px;border-radius:10px;">View your interactive report</a><div style="font-size:11px;color:#706D96;margin-top:6px;">Flip through it in your browser, or open the attached PDF.</div></div>` : ""}
      ${verifyUrl ? `<div style="margin-bottom:18px;padding:12px 14px;background:#fff;border:1px solid #eee;border-radius:12px;"><div style="font-size:12px;color:#33305A;font-weight:800;">${analysis.reportId ? escapeHtml(analysis.reportId) : "Your report"} — tamper-evident</div><div style="font-size:12px;color:#5B5885;line-height:1.5;margin:4px 0 8px;">If a dealer ever questions this report, <a href="${escapeHtml(verifyUrl)}" style="color:#17756B;font-weight:700;">verify it here</a> — the ID is a fingerprint of the report's contents, so any altered figure changes it. We store nothing; the check runs from the link itself.</div></div>` : ""}
      ${blocks.join("\n")}
      <div style="text-align:center;margin-top:20px;font-size:11px;color:#706D96;">
        Sent once to the address you entered — not saved on our end.
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
    .replace(/[★☆⭐]/g, "*").replace(/▲/g, "^").replace(/▼/g, "v")
    .replace(/[✓✔⚑⚐]/g, "").replace(/[^\x20-\x7E -ÿ]/g, "");
}
// Chunked base64 for the PDF bytes (Deno's btoa needs a binary string).
function u8ToB64(u8: Uint8Array): string {
  let s = ""; const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk) as unknown as number[]);
  return btoa(s);
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
function tenPoints(a: any): Array<{ t: string; v: string; tone: "pass" | "flag" | "muted" }> {
  const money = (n: unknown) => { const v = Number(n); return (!n || Number.isNaN(v)) ? "-" : "$" + v.toLocaleString("en-CA"); };
  const qp = Number(a.quotedPrice) || 0, ms = Number(a.msrp) || 0, delta = (qp && ms) ? qp - ms : 0;
  const pv = (a.priceVerified !== undefined) ? !!a.priceVerified : (qp > 0);
  const P: Array<{ t: string; v: string; tone: "pass" | "flag" | "muted" }> = [];
  if (ms && pv && delta !== 0) P.push({ t: "Price vs MSRP", v: (delta < 0 ? money(-delta) + " UNDER" : money(delta) + " OVER"), tone: delta <= 0 ? "pass" : "flag" });
  else if (ms && pv && delta === 0) P.push({ t: "Price vs MSRP", v: "AT MSRP", tone: "pass" });
  else P.push({ t: "Price vs MSRP", v: pv ? "-" : "PRICE UNVERIFIED", tone: pv ? "muted" : "flag" });
  if (a.recalls?.checked && a.recalls.count > 0) P.push({ t: "Transport Canada recalls", v: a.recalls.count + " OPEN", tone: "flag" });
  else if (a.recalls?.checked && a.recalls.count === 0 && a.recalls.confirmed !== false) P.push({ t: "Transport Canada recalls", v: "NONE OPEN", tone: "pass" });
  else if (a.recalls?.checked) P.push({ t: "Transport Canada recalls", v: "UNCONFIRMED", tone: "muted" });
  else P.push({ t: "Transport Canada recalls", v: "COULDN'T VERIFY", tone: "muted" });
  if ((a.addOns || []).length) { const fl = a.addOns.filter((x: any) => x.verdict === "flagged").length; P.push({ t: "Add-ons & fee audit", v: fl ? fl + " FLAGGED" : "TRANSPARENT", tone: fl ? "flag" : "pass" }); }
  else P.push({ t: "Add-ons & fee audit", v: "NONE LISTED", tone: "muted" });
  const fr = a.financeRates;
  if (fr?.dealer) { const high = fr.manufacturer && fr.dealer.apr - fr.manufacturer.apr > 0.1; P.push({ t: "Financing APR (this dealer)", v: fr.dealer.apr + "%" + (high ? " HIGH" : ""), tone: high ? "flag" : "muted" }); }
  else P.push({ t: "Financing APR", v: "NOT SHOWN", tone: "muted" });
  if (a.financingCheck?.checked) P.push({ t: "Financing math", v: a.financingCheck.consistent ? "RECONCILES" : "DOESN'T ADD UP", tone: a.financingCheck.consistent ? "pass" : "flag" });
  else P.push({ t: "Financing math", v: "NOT CHECKED", tone: "muted" });
  if (a.odometerCheck?.checked) P.push({ t: "Odometer", v: Number(a.odometerCheck.km).toLocaleString() + " km" + (a.odometerCheck.flag ? " FLAG" : ""), tone: a.odometerCheck.flag ? "flag" : "pass" });
  else P.push({ t: "Odometer", v: a.vehicleCondition === "new" ? "N/A (NEW)" : "NOT ON QUOTE", tone: "muted" });
  if (a.vinCheck?.present) P.push({ t: "VIN check", v: a.vinCheck.valid ? "VALID" : "CHECK PATTERN", tone: a.vinCheck.valid ? "pass" : "flag" });
  else P.push({ t: "VIN check", v: "NOT ON QUOTE", tone: "muted" });
  if (a.evapRebate?.eligible) P.push({ t: "EV / PHEV rebate", v: money(a.evapRebate.total) + " ELIGIBLE", tone: "pass" });
  else if (a.evapRebate && a.evapRebate.ineligibleReason) P.push({ t: "EV / PHEV rebate", v: "NOT ELIGIBLE", tone: "muted" });
  else P.push({ t: "EV / PHEV rebate", v: (a.fuelType === "BEV" || a.fuelType === "PHEV") ? "-" : "N/A (GAS)", tone: "muted" });
  if (a.standardWarranty?.coverage) P.push({ t: "Included warranty", v: "INCLUDED", tone: "pass" });
  else P.push({ t: "Included warranty", v: "NOT SHOWN", tone: "muted" });
  if (a.dealerSentiment?.rating) P.push({ t: "Dealer reputation", v: Number(a.dealerSentiment.rating).toFixed(1) + "* / " + Number(a.dealerSentiment.reviewCount || 0).toLocaleString(), tone: Number(a.dealerSentiment.rating) >= 4 ? "pass" : "muted" });
  else P.push({ t: "Dealer reputation", v: "NOT FOUND", tone: "muted" });
  return P.slice(0, 10);
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

async function buildReportPdf(a: any, verifyUrl?: string): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("https://esm.sh/pdf-lib@1.17.1");
  const doc = await PDFDocument.create();
  const serif  = await doc.embedFont(StandardFonts.TimesRoman);
  const serifB = await doc.embedFont(StandardFonts.TimesRomanBold);
  const serifI = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const sans   = await doc.embedFont(StandardFonts.Helvetica);
  const sansB  = await doc.embedFont(StandardFonts.HelveticaBold);
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

  // ---- MASTHEAD ----
  drawLogo(M, y + 2, 38);
  T("LOTCHECK", { size: 15, font: serifB, color: INK, x: M + 48 });
  // Seal sits in the far-right corner; the title + No. are right-aligned to a
  // margin LEFT of it (rx) so they never collide with the stamp.
  drawSeal(M + W - 20, y - 11, 13);
  right("QUOTE CHECK REPORT", { rx: M + W - 52, size: 8.5, font: sansB, color: SOFT });
  y -= 20;
  right("No. " + RID, { rx: M + W - 52, size: 8.5, font: mono, color: FAINT });
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
  Tat(priceVerified ? "MSRP (VERIFIED)" : "CATALOG MSRP", figTop - 9, { x: rx, size: 8, font: sansB, color: FAINT });
  Tat(ms ? money(ms) : "-", figTop - 34, { x: rx, size: 25, font: monoB, color: priceVerified ? TEAL : SOFT });
  Tat(priceVerified ? "manufacturer suggested" : "reference figure - not the sticker", figTop - 48, { x: rx, size: 8, font: sans, color: FAINT });
  page.drawLine({ start: { x: M + colW, y: figTop - 6 }, end: { x: M + colW, y: figTop - 50 }, thickness: 0.7, color: HAIR });
  y = figTop - 58;
  if (delta) {
    const label = (delta > 0 ? "+" + money(delta) + " OVER MSRP" : money(Math.abs(delta)) + " UNDER MSRP");
    T(label, { size: 11, font: sansB, color: delta > 0 ? CORAL : TEAL });
    if (!priceVerified) { const wl = sansB.widthOfTextAtSize(label, 11); Tat("(vs catalog MSRP - listing price not yet verified)", y - 11, { x: M + wl + 6, size: 8.5, font: sans, color: FAINT }); }
    y -= 22;
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
    if (ms) { const refLbl = priceVerified ? "MSRP " + money(ms) : "CATALOG MSRP " + money(ms); const refAsk = (priceVerified && qp) ? "   -   ASKING " + money(qp) : ""; center(refLbl + refAsk, gy - 65, { size: 8.5, font: mono, color: SOFT, cx }); }
    const noteX = cx + r + 26, noteW = M + W - noteX;
    if (a.leverageScore.note) { let ny2 = y - 20; for (const ln of wrap(a.leverageScore.note, serifI, 11, noteW)) { page.drawText(ln, { x: noteX, y: ny2 - 11, size: 11, font: serifI, color: SOFT }); ny2 -= 16; } }
    y = gy - 78;
    rule();
  }

  // ---- 10-POINT AUDIT (always exactly 10) ----
  kicker("10-POINT AUDIT");
  const toneColor: Record<string, any> = { pass: TEAL, flag: CORAL, muted: FAINT };
  for (const p of tenPoints(a)) {
    need(19); T(p.t, { size: 10.5, font: serif, color: p.tone === "muted" ? SOFT : INK }); right(p.v, { size: 9.5, font: monoB, color: toneColor[p.tone] || INK }); y -= 16.5;
  }
  rule();

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
  para("Analyzed once, never stored on our end. This report's ID is a fingerprint of its own contents" + (issued ? " issued " + issued.toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "") + " - change any figure and the ID changes, so it is tamper-evident. " + (verifyUrl ? "Scan the code above (or use the link in your email) to verify it at lotcheck.ca/verify - it recomputes the fingerprint and checks the signature, and nothing is stored on our end. " : "Verify it anytime at lotcheck.ca/verify using the link in this email. ") + "Every figure traces to a public source you can re-check: recalls to Transport Canada, MSRP to the manufacturer catalogue, reviews to Google. LotCheck reviews the deal, not the car's history - pair it with a vehicle-history report before you buy.", { size: 8, color: FAINT, font: sans, lead: 3 });
  need(40);
  { const w = 34; drawLogo(PW / 2 - w / 2, y - 2, w); }
  y -= 30;
  center("LOTCHECK  -  " + RID + "  -  lotcheck.ca/verify", y - 8, { size: 7.5, font: sansB, color: FAINT });

  return await doc.save();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (!RESEND_API_KEY) {
    console.error("RESEND_API_KEY is not set on this function.");
    return new Response(
      JSON.stringify({ error: "Email sending isn't configured yet." }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }

  try {
    const { email, analysis, reportUrl, verifyUrl: verifyUrlIn } = await req.json();

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

    const subject = analysis.vehicle
      ? `Your LotCheck report — ${analysis.vehicle}`
      : "Your LotCheck quote report";

    // Verify link — drives both the PDF QR and the email "verify it here" box.
    // Prefer the link the client sent; if it's missing, rebuild it from the
    // signed fields on the analysis so a client that forgot to send it still
    // gets a working QR (no single point of failure). Same shape as the
    // client's verifyLinkFor(): d = payload, id/s/k optional.
    let verifyUrl: string | undefined =
      (typeof verifyUrlIn === "string" && /^https?:\/\//.test(verifyUrlIn)) ? verifyUrlIn : undefined;
    if (!verifyUrl && analysis.verifyPayload) {
      verifyUrl = `https://lotcheck.ca/verify?d=${analysis.verifyPayload}`
        + (analysis.reportId ? `&id=${encodeURIComponent(analysis.reportId)}` : "")
        + (analysis.sig ? `&s=${analysis.sig}` : "")
        + (analysis.keyId ? `&k=${encodeURIComponent(analysis.keyId)}` : "");
    }

    // PDF attachment — never fatal: if generation fails, send the email anyway.
    let attachments: Array<{ filename: string; content: string }> | undefined;
    try {
      const bytes = await buildReportPdf(analysis, verifyUrl);
      const fnameVeh = (analysis.vehicle || "report").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "report";
      attachments = [{ filename: `LotCheck-${fnameVeh}.pdf`, content: u8ToB64(bytes) }];
    } catch (e) {
      console.error("PDF generation failed (sending email without attachment):", e);
    }

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
        html: buildEmailHtml(analysis, reportUrl, verifyUrl),
        ...(attachments ? { attachments } : {}),
      }),
    });

    if (!resendRes.ok) {
      const errBody = await resendRes.text();
      console.error("Resend send failed:", resendRes.status, errBody);
      return new Response(
        JSON.stringify({ error: "Couldn't send that email. Please try again in a moment." }),
        { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
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