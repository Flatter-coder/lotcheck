// ============================================================================
// VALUE-report PDF — the signed, server-generated page for the "what's it worth"
// product. Self-contained: it DUPLICATES the PDF primitives (fonts, logo, seal,
// layout) from email-quote-report so building it can never touch — or regress —
// the live quote PDF (PDF_BUILDER_VER). A later cleanup can extract a shared
// _shared/pdf-kit.ts behind a byte-diff of the quote PDF; until then, duplication
// is the safe MVP (see the value-report scope). Editorial ink-on-cream, Poppins,
// the real gate+car logo, and the guilloché seal seeded from the ECDSA signature.
//
// Phase 1 renders ONLY what our own comps back: the retail-ASKING band + the
// market CPO premium. No trade/private tiering (unbacked). Recalls + warranty are
// Phase 2 (additive). Everything is basis-labeled "asking prices, not sold".
// ============================================================================

// ---- primitives (copied verbatim from email-quote-report so the seal/logo match) ----
export function pdfSafe(s: unknown): string {
  return String(s ?? "")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-").replace(/•/g, "-").replace(/…/g, "...")
    .replace(/[★☆⭐]/g, "*").replace(/▲/g, "^").replace(/▼/g, "v")
    .replace(/[✓✔⚑⚐]/g, "").replace(/[^\x20-\x7E -ÿ]/g, "");
}
export function u8ToB64(u8: Uint8Array): string {
  let s = ""; const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk) as unknown as number[]);
  return btoa(s);
}
function sealSeed(s: string): number { let h = 2166136261 >>> 0; const str = String(s || "lotcheck"); for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function sealRng(a: number): () => number { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function guillocheRings(seed: number, cx: number, cy: number, R: number, steps: number): string[] {
  const rnd = sealRng(seed);
  const petal = 4 + Math.floor(rnd() * 7), fine = 16 + Math.floor(rnd() * 26), ph = rnd() * 6.28318;
  const a1 = R * (0.10 + rnd() * 0.13), a2 = R * (0.04 + rnd() * 0.07);
  const ring = (scale: number, off: number) => { let d = ""; const n = steps; for (let i = 0; i <= n; i++) { const t = i / n * 6.28318; const rr = R * scale + a1 * Math.sin(petal * t + ph) + a2 * Math.sin(fine * t); const x = cx + (rr + off) * Math.cos(t), y = cy + (rr + off) * Math.sin(t); d += (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1) + " "; } return d; };
  return [ring(1, 0), ring(1, 2.4), ring(0.66, 0), ring(0.66, 1.9)];
}
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

// ---- the value-report page ----
export async function buildValuePdf(a: any, verifyUrl?: string): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("https://esm.sh/pdf-lib@1.17.1");
  const doc = await PDFDocument.create();
  let serif: any, serifB: any, serifI: any, sans: any, sansB: any;
  try {
    const fontkit = (await import("https://esm.sh/@pdf-lib/fontkit@1.1.1")).default;
    const P = await import("./poppins.ts");
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
  const monoB = await doc.embedFont(StandardFonts.CourierBold);

  const PAPER = rgb(0.976, 0.965, 0.925), INK = rgb(0.114, 0.106, 0.094),
        SOFT = rgb(0.365, 0.341, 0.298), FAINT = rgb(0.55, 0.52, 0.47),
        TEAL = rgb(0.09, 0.459, 0.42), GREEN = rgb(0.082, 0.502, 0.239),
        HAIR = rgb(0.82, 0.80, 0.73), TRACK = rgb(0.87, 0.85, 0.78),
        GREEN_BG = rgb(0.863, 0.988, 0.906), PURPLE = rgb(0.427, 0.231, 0.839),
        CORAL = rgb(0.651, 0.235, 0.149);

  const PW = 595.28, PH = 841.89, M = 56, W = PW - M * 2;
  let page = doc.addPage([PW, PH]);
  const paper = () => page.drawRectangle({ x: 0, y: 0, width: PW, height: PH, color: PAPER });
  paper();
  let y = PH - M;

  const money = (n: unknown) => { const v = Number(n); return (n == null || Number.isNaN(v)) ? "-" : "$" + Math.round(v).toLocaleString("en-CA"); };
  const RID = a.reportId || "LC-XXXX-XXX";
  const issued = a.issuedAt ? new Date(a.issuedAt) : null;
  const reportDate = issued ? issued.toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" })
    : new Date().toLocaleDateString("en-CA", { month: "long", year: "numeric" });

  const need = (h: number) => { if (y - h < M + 30) { page = doc.addPage([PW, PH]); paper(); y = PH - M; } };
  const T = (str: string, o: any = {}) => page.drawText(pdfSafe(str), { x: o.x ?? M, y: y - (o.size ?? 10), size: o.size ?? 10, font: o.font ?? sans, color: o.color ?? INK });
  const right = (str: string, o: any = {}) => { const s = pdfSafe(str), f = o.font ?? sans, sz = o.size ?? 10; page.drawText(s, { x: (o.rx ?? M + W) - f.widthOfTextAtSize(s, sz), y: y - sz, size: sz, font: f, color: o.color ?? INK }); };
  const center = (str: string, yy: number, o: any = {}) => { const s = pdfSafe(str), f = o.font ?? sans, sz = o.size ?? 10; page.drawText(s, { x: (o.cx ?? PW / 2) - f.widthOfTextAtSize(s, sz) / 2, y: yy, size: sz, font: f, color: o.color ?? INK }); };
  function wrap(str: string, f: any, size: number, maxW: number): string[] {
    const words = pdfSafe(str).split(/\s+/).filter(Boolean); const out: string[] = []; let cur = "";
    for (const w of words) { const t = cur ? cur + " " + w : w; if (f.widthOfTextAtSize(t, size) > maxW && cur) { out.push(cur); cur = w; } else cur = t; }
    if (cur) out.push(cur); return out;
  }
  const para = (str: string, o: any = {}) => { const f = o.font ?? serif, sz = o.size ?? 10, lead = o.lead ?? 5, mw = o.maxW ?? W, x = o.x ?? M; for (const ln of wrap(str, f, sz, mw)) { need(sz + lead); page.drawText(ln, { x, y: y - sz, size: sz, font: f, color: o.color ?? SOFT }); y -= sz + lead; } };
  const rule = (color = HAIR, th = 0.7, pad = 8) => { need(pad * 2); page.drawLine({ start: { x: M, y: y - pad }, end: { x: M + W, y: y - pad }, thickness: th, color }); y -= pad * 2 + 2; };
  const kicker = (str: string, col = TEAL) => { need(20); T(str, { size: 8.5, font: sansB, color: col }); y -= 15; };

  const drawLogo = (x0: number, yTop: number, w: number) => {
    const s = w / 320, ax = x0 + 145 * s, ay = yTop - 44 * s;
    for (const [path, c] of LOGO_POLYS) page.drawSvgPath(path, { x: ax, y: ay, scale: s, color: rgb(c[0], c[1], c[2]) });
  };
  const SEALSEED = sealSeed(a.sig || RID);
  const drawSeal = (cxAbs: number, cyCentre: number, S: number) => {
    page.drawEllipse({ x: cxAbs, y: cyCentre, xScale: S * 1.46, yScale: S * 1.46, borderColor: PURPLE, borderWidth: 1 });
    page.drawEllipse({ x: cxAbs, y: cyCentre, xScale: S * 1.34, yScale: S * 1.34, borderColor: TEAL, borderWidth: 0.5 });
    const rings = guillocheRings(SEALSEED, cxAbs, 0, S, 420);
    rings.forEach((d, i) => page.drawSvgPath(d, { x: 0, y: cyCentre, borderColor: i < 2 ? PURPLE : TEAL, borderWidth: i % 2 ? 0.35 : 0.6 }));
    page.drawText("LC", { x: cxAbs - monoB.widthOfTextAtSize("LC", S * 0.22) / 2, y: cyCentre - S * 0.22 / 2, size: S * 0.22, font: monoB, color: INK });
  };

  // ---- MASTHEAD ----
  drawLogo(M, y + 2, 38);
  T("LOTCHECK", { size: 15, font: serifB, color: INK, x: M + 48 });
  right("MARKET VALUE REPORT", { size: 8.5, font: sansB, color: SOFT });
  y -= 17;
  T("On the buyer's side of the table", { size: 9, font: serifI, color: SOFT, x: M + 48 });
  right(RID + "  ·  " + reportDate, { size: 9, font: sans, color: SOFT });
  y -= 20;
  rule(HAIR, 0.7, 4);

  // ---- VEHICLE ----
  const veh = a.vehicle || [a.year, a.make, a.model].filter(Boolean).join(" ");
  T(pdfSafe(veh + (a.trim ? " " + a.trim : "")), { size: 21, font: serifB }); y -= 27;
  const facts: string[] = [];
  if (a.odometerKm) facts.push(Number(a.odometerKm).toLocaleString("en-CA") + " km");
  facts.push(String(a.saleCondition || a.condition || "used"));
  if (a.province) facts.push(String(a.province).toUpperCase());
  T(facts.join("     "), { size: 11, font: sans, color: SOFT }); y -= 16;
  // VIN on every report (VIN-every-scan): absent -> stated, never blank.
  if (a.vin) { T("VIN  " + String(a.vin), { size: 10, font: monoB, color: INK }); }
  else { T("VIN  Not published - ask the dealer", { size: 10, font: sans, color: FAINT }); }
  y -= 22; rule(HAIR, 0.7, 4);

  // ---- THE VALUE BAND (retail asking) ----
  const mv = a.marketValue;
  if (mv && mv.average != null) {
    kicker("WHAT IT'S WORTH - RETAIL ASKING", GREEN);
    // green highlight behind the headline number
    const numStr = money(mv.average);
    const numW = serifB.widthOfTextAtSize(numStr, 34);
    page.drawRectangle({ x: M - 4, y: y - 34, width: numW + 12, height: 40, color: GREEN_BG });
    T(numStr, { size: 34, font: serifB, color: INK }); y -= 42;
    // Subtitle NAMES the real basis (present-without-creating-questions). With few
    // comps the engine may not narrow to the subject's mileage/trim; say so rather
    // than imply an adjustment that didn't happen. Basis comes from mv.source.
    const _src = String(mv.source || "");
    const subtitle = _src.includes("same trim, similar mileage") ? "Median asking price for the same trim at similar mileage"
      : _src.includes("same trim") ? "Median asking for the same trim - not adjusted for mileage"
      : _src.includes("similar mileage") ? "Median asking at similar mileage, across trims"
      : "Median asking across trims - not yet adjusted for this mileage";
    T(subtitle, { size: 10.5, font: sans, color: SOFT }); y -= 18;
    const lo = mv.low ?? mv.below, hi = mv.high ?? mv.above;
    if (lo != null && hi != null) { T("Full range " + money(lo) + " to " + money(hi) + "   -   most between " + money(mv.below) + " and " + money(mv.above), { size: 10.5, font: sans, color: INK }); y -= 17; }
    const n = Number(mv.comps) || 0;
    const asOf = mv.asOf ? new Date(mv.asOf).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" }) : null;
    T(n + " comparable Alberta listing" + (n === 1 ? "" : "s") + (asOf ? ", read " + asOf : ""), { size: 9.5, font: sans, color: FAINT }); y -= 20;

    // ---- CPO PREMIUM (the one tiering we can back) ----
    const cp = mv.cpoPremium;
    if (cp && Number(cp.premium) > 0) {
      T("CERTIFIED (CPO) PREMIUM", { size: 8.5, font: sansB, color: TEAL }); y -= 15;
      para("Certified pre-owned listings of this vehicle ask about " + money(cp.premium) + " more than comparable non-certified ones (" + (cp.basis || "comparable listings") + "). That is what the market prices the manufacturer's certification - the extra inspection and extended warranty - at right now.", { size: 10, font: serif, color: SOFT, lead: 4 });
      y -= 4;
    }
    rule(HAIR, 0.7, 4);
  }

  // ---- OPEN RECALLS (Transport Canada, fail-safe tri-state) ----
  const rc = a.recalls;
  if (rc) {
    kicker("OPEN RECALLS - TRANSPORT CANADA", TEAL);
    if (!rc.checked) {
      para("Couldn't reach the recall registry - not an all-clear. Check open recalls by VIN at Transport Canada before you sell.", { size: 10, font: serif, color: SOFT, lead: 4 });
    } else if (Number(rc.count) > 0) {
      T(rc.count + " open recall" + (rc.count === 1 ? "" : "s") + " on record for this model.", { size: 11, font: sansB, color: CORAL }); y -= 16;
      const items = rc.items || [];
      const CAP = 12; // list must match the count (recalls-detail-list-must-match-count); note any overflow
      for (const it of items.slice(0, CAP)) {
        need(14);
        let ds = "";
        if (it.date) { const dt = new Date(it.date); ds = isNaN(dt.getTime()) ? String(it.date).split(" ")[0] : dt.toLocaleDateString("en-CA", { month: "short", year: "numeric" }); }
        T("- " + pdfSafe(it.system || "Safety recall") + (ds ? "  (" + ds + ")" : ""), { size: 9.5, font: sans, color: SOFT }); y -= 13;
      }
      if (items.length > CAP) { need(14); T("  + " + (items.length - CAP) + " more - see the per-VIN check", { size: 9.5, font: sans, color: FAINT }); y -= 13; }
      para("These are free fixes at any dealer. Confirm which are still open on this exact VIN at the manufacturer's recall page or Transport Canada - clearing them makes a sale easier.", { size: 9, font: serif, color: SOFT, lead: 4 });
    } else if (rc.confirmed) {
      T("No open recalls on record (confirmed with Transport Canada).", { size: 11, font: sans, color: GREEN }); y -= 16;
    } else {
      para("Couldn't confirm recalls for this exact model - NOT an all-clear. Check by VIN at Transport Canada before you sell.", { size: 10, font: serif, color: SOFT, lead: 4 });
    }
    rule(HAIR, 0.7, 4);
  }

  // ---- REMAINING FACTORY WARRANTY (estimated) ----
  const rw = a.remainingWarranty;
  if (rw && (rw.basic || rw.powertrain)) {
    kicker("FACTORY WARRANTY REMAINING (ESTIMATED)", TEAL);
    const wline = (label: string, term: any) => {
      if (!term) return;
      const st = term.active ? "active" : "expired";
      let extra = "";
      if (term.active) {
        const yl = Math.max(0, Math.round(Number(term.yearsLeft)));
        const parts: string[] = [];
        if (yl > 0) parts.push("~" + yl + " yr");
        if (term.kmLeft != null) parts.push(Math.max(0, Math.round(Number(term.kmLeft))).toLocaleString("en-CA") + " km");
        if (parts.length) extra = " (" + parts.join(", ") + " left)";
      }
      need(15); T(label + ":  " + pdfSafe(term.term) + " - " + st + extra, { size: 10, font: sans, color: term.active ? INK : FAINT }); y -= 15;
    };
    wline("Basic", rw.basic);
    wline("Powertrain", rw.powertrain);
    para("Estimated from the model year" + (rw.odometerKm != null ? " and odometer" : " (odometer not provided)") + "; confirm exact coverage with the VIN at a dealer. Transferable coverage is a selling point.", { size: 9, font: serif, color: SOFT, lead: 4 });
    rule(HAIR, 0.7, 4);
  }

  // ---- HONESTY / BASIS ----
  para("These are dealers' ASKING prices for comparable used vehicles - not confirmed sale, trade-in, or wholesale prices, and not a formal appraisal. In Alberta advertised prices are all-in (every fee except GST). Every figure is read from live listings on the dates shown and refreshed from the current market - the same market a dealer prices against. This is a market read to inform your decision; the price is always yours to set.", { size: 9, font: serif, color: SOFT, lead: 4 });
  y -= 8;

  // ---- VERIFY QR + SEAL ----
  if (verifyUrl) {
    try {
      const qrcode = (await import("https://esm.sh/qrcode-generator@1.4.4")).default as any;
      const qr = qrcode(0, "M"); qr.addData(verifyUrl); qr.make();
      const count = qr.getModuleCount();
      const QS = 190, cell = QS / count;
      need(QS + 40);
      const qx = PW / 2 - QS / 2, qbot = y - QS;
      page.drawRectangle({ x: qx - 7, y: qbot - 7, width: QS + 14, height: QS + 14, color: rgb(1, 1, 1) });
      for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (qr.isDark(r, c)) {
        page.drawRectangle({ x: qx + c * cell, y: qbot + (count - 1 - r) * cell, width: cell + 0.4, height: cell + 0.4, color: INK });
      }
      const lw = QS * 0.19, lx = PW / 2 - lw / 2, ly = qbot + QS / 2 - lw / 2;
      page.drawRectangle({ x: lx - 4, y: ly - 4, width: lw + 8, height: lw + 8, color: rgb(1, 1, 1) });
      drawLogo(lx, ly + lw * 0.784, lw);
      drawSeal(M + 66, qbot + QS / 2 + 6, 34);
      center("UNIQUE SEAL", qbot + QS / 2 - 56, { size: 7, font: sansB, color: FAINT, cx: M + 66 });
      y = qbot - 14;
      center("Scan to verify - recomputes the fingerprint and checks LotCheck's signature.", y, { size: 8.5, font: sansB, color: SOFT });
      y -= 16;
    } catch (e) { console.warn("QR generation skipped:", (e as Error)?.message); }
  } else {
    drawSeal(PW / 2, y - 40, 34); y -= 92;
    center("This report is fingerprinted; a full signature is added when the signing key is configured.", y, { size: 8, font: sans, color: FAINT }); y -= 14;
  }

  rule(HAIR, 0.7, 6);
  center("LotCheck  -  Proudly built in Calgary  -  the machine on the buyer's side of the table.", y, { size: 8.5, font: sansB, color: SOFT }); y -= 12;
  center("Report " + RID + "  -  nothing stored on our end  -  verify anytime at lotcheck.ca/verify", y, { size: 8, font: sans, color: FAINT });

  return await doc.save();
}
