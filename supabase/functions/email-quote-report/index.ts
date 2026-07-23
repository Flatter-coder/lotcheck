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

function buildEmailHtml(analysis: any): string {
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

  return `
  <div style="font-family:'Nunito',system-ui,-apple-system,sans-serif;background:#FBF5EC;padding:24px;">
    <div style="max-width:560px;margin:0 auto;">
      <div style="font-weight:800;font-size:18px;color:#33305A;margin-bottom:4px;">LotCheck Quote Check</div>
      <div style="font-size:13px;color:#706D96;margin-bottom:20px;">${escapeHtml(analysis.vehicle || "Your quote")}</div>
      ${blocks.join("\n")}
      <div style="text-align:center;margin-top:20px;font-size:11px;color:#706D96;">
        Sent once to the address you entered — not saved on our end.
        <br/><a href="https://lotcheck.ca/quote-check" style="color:#17756B;font-weight:700;">Check another quote</a>
      </div>
    </div>
  </div>`;
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
    const { email, analysis } = await req.json();

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
        html: buildEmailHtml(analysis),
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