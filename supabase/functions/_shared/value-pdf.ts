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
        CORAL = rgb(0.651, 0.235, 0.149), AMBER = rgb(0.706, 0.325, 0.035),
        AMBER_BG = rgb(0.988, 0.925, 0.82), CARD = rgb(0.992, 0.984, 0.965),
        SLATE = rgb(0.561, 0.541, 0.627), DOT = rgb(0.561, 0.541, 0.627);

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

  const modelWord = String(a.model || "vehicle");
  const modelLc = modelWord.toLowerCase();
  const fmtMonYr = (d: any): string => { const dt = new Date(d); return isNaN(dt.getTime()) ? String(d).split(" ")[0] : dt.toLocaleDateString("en-CA", { month: "short", year: "numeric" }); };
  // Clean-truncate verbose text (e.g. a Transport Canada recall summary) at a
  // sentence or word boundary, never mid-word, with an ellipsis.
  const clip = (s: any, n: number): string => {
    const t = pdfSafe(String(s ?? "").replace(/\s+/g, " ").trim());
    if (t.length <= n) return t;
    const cut = t.slice(0, n);
    const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
    const sp = cut.lastIndexOf(" ");
    const at = stop > n * 0.55 ? stop + 1 : (sp > 0 ? sp : n);
    return t.slice(0, at).trim().replace(/[,;:]$/, "") + "...";
  };

  // A three-exit value card, drawn at an absolute top Y (does NOT move `y`).
  const drawTierCard = (x0: number, w: number, topY: number, cfg: any) => {
    const h = 158;
    page.drawRectangle({ x: x0, y: topY - h, width: w, height: h, color: CARD, borderColor: cfg.hero ? GREEN : HAIR, borderWidth: cfg.hero ? 1.4 : 0.8 });
    page.drawRectangle({ x: x0, y: topY - h, width: 3.2, height: h, color: cfg.accent });
    let cy = topY - 15;
    page.drawText(pdfSafe(cfg.label), { x: x0 + 11, y: cy - 7, size: 7, font: sansB, color: SOFT }); cy -= 26;
    const rangeStr = money(cfg.low) + " - " + money(cfg.high);
    if (cfg.hero) { const rw = serifB.widthOfTextAtSize(rangeStr, 13.5); page.drawRectangle({ x: x0 + 7, y: cy - 12, width: rw + 8, height: 20, color: GREEN_BG }); }
    page.drawText(pdfSafe(rangeStr), { x: x0 + 11, y: cy - 10, size: 13.5, font: serifB, color: INK }); cy -= 26;
    const yStr = pdfSafe(cfg.yours), pillW = sansB.widthOfTextAtSize(yStr, 8) + 12;
    page.drawRectangle({ x: x0 + 11, y: cy - 11, width: pillW, height: 15, color: cfg.hero ? GREEN_BG : rgb(0.929, 0.914, 0.863) });
    page.drawText(yStr, { x: x0 + 17, y: cy - 8, size: 8, font: sansB, color: cfg.hero ? GREEN : SOFT }); cy -= 26;
    for (const ln of wrap(cfg.desc, sans, 8.3, w - 22)) { page.drawText(ln, { x: x0 + 11, y: cy - 8, size: 8.3, font: sans, color: SOFT }); cy -= 11; }
  };

  // Price-vs-mileage scatter, drawn with pdf primitives (no SVG). Advances `y`.
  const drawChart = (comps: any[], subjectKm: number, subjectPrice: number) => {
    const pts = (comps || []).map((c) => ({ km: Number(c.odometerKm), price: Number(c.price) })).filter((p) => p.km > 0 && p.price > 0);
    if (pts.length < 3 || !(subjectKm > 0) || !(subjectPrice > 0)) return;
    kicker("WHERE YOUR " + modelWord.toUpperCase() + " SITS IN THE MARKET", GREEN);
    const H = 196; need(H + 24);
    const boxTop = y, boxBot = y - H;
    const plotL = M + 44, plotR = M + W - 8, plotT = boxTop - 14, plotB = boxBot + 24;
    const allKm = [...pts.map((p) => p.km), subjectKm], allPr = [...pts.map((p) => p.price), subjectPrice];
    const xMax = Math.max(...allKm) * 1.08, xMin = 0;
    const yPad = ((Math.max(...allPr) - Math.min(...allPr)) * 0.15) || 2000;
    const yMax = Math.max(...allPr) + yPad, yMin = Math.max(0, Math.min(...allPr) - yPad);
    const sx = (km: number) => plotL + (km - xMin) / (xMax - xMin) * (plotR - plotL);
    const sy = (pr: number) => plotB + (pr - yMin) / (yMax - yMin) * (plotT - plotB);
    for (let i = 0; i <= 3; i++) { const pr = yMin + (yMax - yMin) * i / 3, yy = sy(pr); page.drawLine({ start: { x: plotL, y: yy }, end: { x: plotR, y: yy }, thickness: 0.4, color: TRACK }); page.drawText("$" + Math.round(pr / 1000) + "k", { x: M, y: yy - 3, size: 7.5, font: sans, color: FAINT }); }
    for (const km of [50000, 100000, 150000, 200000]) { if (km <= xMax) { const xx = sx(km); page.drawText(km / 1000 + "k", { x: xx - 8, y: plotB - 12, size: 7.5, font: sans, color: FAINT }); } }
    const sxSub = sx(subjectKm);
    for (let yy = plotB; yy < plotT; yy += 6) page.drawRectangle({ x: sxSub - 0.3, y: yy, width: 0.7, height: 3.2, color: GREEN });
    page.drawText("Your " + modelLc, { x: Math.min(sxSub - 16, plotR - 58), y: plotT + 1, size: 7.5, font: sansB, color: GREEN });
    for (const p of pts) page.drawEllipse({ x: sx(p.km), y: sy(p.price), xScale: 2.6, yScale: 2.6, color: DOT });
    page.drawEllipse({ x: sxSub, y: sy(subjectPrice), xScale: 3.6, yScale: 3.6, color: GREEN });
    y = boxBot - 4;
    page.drawEllipse({ x: M + 4, y: y - 3, xScale: 2.6, yScale: 2.6, color: DOT });
    page.drawText("Alberta " + modelLc + " listing", { x: M + 12, y: y - 6, size: 8, font: sans, color: SOFT });
    page.drawEllipse({ x: M + 150, y: y - 3, xScale: 3, yScale: 3, color: GREEN });
    page.drawText("Your " + modelLc + ", estimated", { x: M + 158, y: y - 6, size: 8, font: sans, color: SOFT });
    y -= 18;
  };

  // Named comps table + subject row. Advances `y`.
  const drawComps = (named: any[]) => {
    const rows = (named || []).filter((c) => Number(c.price) > 0);
    if (!rows.length) return;
    need(28 + rows.length * 15 + 26);
    const cX = { yt: M, km: M + 190, ask: M + 258, src: M + 340 };
    page.drawText("YEAR / TRIM", { x: cX.yt, y: y - 8, size: 8, font: sansB, color: SOFT });
    page.drawText("KM", { x: cX.km, y: y - 8, size: 8, font: sansB, color: SOFT });
    page.drawText("ASKING", { x: cX.ask, y: y - 8, size: 8, font: sansB, color: SOFT });
    page.drawText("SOURCE", { x: cX.src, y: y - 8, size: 8, font: sansB, color: SOFT });
    y -= 12; rule(HAIR, 0.5, 3);
    for (const c of rows) {
      need(15);
      page.drawText(pdfSafe((c.year || a.year || "") + " " + String(c.trim || "")).slice(0, 26), { x: cX.yt, y: y - 9, size: 9, font: sans, color: INK });
      page.drawText(c.odometerKm ? Number(c.odometerKm).toLocaleString("en-CA") : "-", { x: cX.km, y: y - 9, size: 9, font: sans, color: SOFT });
      page.drawText(money(c.price), { x: cX.ask, y: y - 9, size: 9, font: sansB, color: INK });
      page.drawText(pdfSafe([c.dealerName, c.city].filter(Boolean).join(", ") || "LotCheck crawl").slice(0, 32), { x: cX.src, y: y - 9, size: 8.5, font: sans, color: FAINT });
      y -= 15;
    }
    need(20);
    page.drawRectangle({ x: M - 4, y: y - 15, width: W + 8, height: 17, color: GREEN_BG });
    page.drawText(pdfSafe("Your " + (a.year || "") + " " + (a.trim || a.model || "")).slice(0, 26), { x: cX.yt, y: y - 10, size: 9, font: sansB, color: INK });
    page.drawText(a.odometerKm ? Number(a.odometerKm).toLocaleString("en-CA") : "-", { x: cX.km, y: y - 10, size: 9, font: sansB, color: INK });
    page.drawText("~" + money(a.retailEstimate), { x: cX.ask, y: y - 10, size: 9, font: sansB, color: GREEN });
    page.drawText("retail estimate", { x: cX.src, y: y - 10, size: 8.5, font: sansB, color: GREEN });
    y -= 20;
    para("Prices are dealer ASKING figures (Alberta advertises all-in under AMVIC rules), read from live listings on the dates shown. Outliers - a different generation, a wildly off odometer - are set aside as non-comparable.", { size: 8.5, font: serif, color: FAINT, lead: 3 });
    y -= 4;
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

  // ---- HEADLINE ----
  T("What your " + modelWord + " is actually worth", { size: 23, font: serifB }); y -= 30;
  para("A market read for this exact " + modelLc + " - same year, same trim, your mileage and condition - built from real Alberta listings today, not a black-box estimate.", { size: 10.5, font: serif, color: SOFT, lead: 4 });
  y -= 6;

  // ---- VEHICLE CHIP STRIP ----
  const veh = a.vehicle || [a.year, a.make, a.model].filter(Boolean).join(" ");
  T(pdfSafe(veh + (a.trim ? " " + a.trim : "")), { size: 13.5, font: sansB }); y -= 17;
  const facts: string[] = [];
  if (a.odometerKm) facts.push(Number(a.odometerKm).toLocaleString("en-CA") + " km");
  facts.push(String(a.saleCondition || a.condition || "used"));
  if (a.province) facts.push(String(a.province).toUpperCase());
  facts.push(a.vin ? "VIN " + String(a.vin) : "VIN not published");
  T(facts.join("      "), { size: 9.5, font: sans, color: SOFT }); y -= 15;
  if (a.topEnd) {
    const chip = "No accidents - full service history";
    const cw = sansB.widthOfTextAtSize(chip, 8.5) + 16;
    page.drawRectangle({ x: M, y: y - 12, width: cw, height: 16, color: GREEN_BG, borderColor: GREEN, borderWidth: 0.7 });
    page.drawText(chip, { x: M + 8, y: y - 8.5, size: 8.5, font: sansB, color: GREEN }); y -= 16;
  }
  y -= 8; rule(HAIR, 0.7, 4);

  // ---- THREE-EXIT VALUE STACK (what you'd GET) ----
  const tiers = a.tiers;
  if (tiers) {
    kicker("WHAT YOU'D GET FOR IT", GREEN);
    const gap = 12, cw = (W - gap * 2) / 3, cardH = 158; need(cardH + 6);
    const topY = y, yt = !!tiers.topEnd;
    drawTierCard(M, cw, topY, { label: "TRADE-IN / CASH OFFER", accent: SLATE, low: tiers.trade.low, high: tiers.trade.high, yours: yt ? "Yours: ~" + money(tiers.trade.high) + ", top end" : "Around ~" + money(tiers.trade.point), desc: "What a dealer or instant-offer service pays you. Fastest, lowest - they resell at wholesale.", hero: false });
    drawTierCard(M + cw + gap, cw, topY, { label: "PRIVATE SALE", accent: GREEN, low: tiers.privateParty.low, high: tiers.privateParty.high, yours: yt ? "Yours: ~" + money(tiers.privateParty.high) + ", top end" : "Around ~" + money(tiers.privateParty.point), desc: "What you could realistically get selling it yourself. More work, more money.", hero: true });
    drawTierCard(M + 2 * (cw + gap), cw, topY, { label: "DEALER RETAIL (LOT PRICE)", accent: PURPLE, low: tiers.retail.low, high: tiers.retail.high, yours: "Relist ~" + money(tiers.retail.high), desc: "What a lot would advertise your " + modelLc + " at - the top of the stack, not what you'd pocket.", hero: false });
    y = topY - cardH - 12;
    const pvPt = tiers.privateParty.point, tdPt = tiers.trade.point;
    if (yt) para("With no accidents and full service records, your " + modelLc + " sits at the TOP of each range: about " + money(tdPt) + " on a trade, or " + money(pvPt) + " selling it privately - roughly " + money(pvPt - tdPt) + " more in your pocket for selling it yourself.", { size: 10, font: serif, color: INK, lead: 4 });
    else para("On the figures we have, your " + modelLc + " sits mid-range: about " + money(tdPt) + " on a trade, or " + money(pvPt) + " selling it privately - roughly " + money(pvPt - tdPt) + " more for the work of selling it yourself.", { size: 10, font: serif, color: INK, lead: 4 });
    // Honesty flag: if the subject's mileage is OUTSIDE the comps' range (above
    // OR below), the number is read off the trend, not a same-mileage listing.
    if (a.mileageAdj && a.mileageAdj.extrapolated) {
      const km = Number(a.odometerKm), kmMax = Number(a.mileageAdj.kmMax), kmMin = Number(a.mileageAdj.kmMin);
      const kmStr = a.odometerKm ? Number(a.odometerKm).toLocaleString("en-CA") + " km" : "mileage";
      const dir = km > kmMax
        ? "beyond the comparable Alberta listings we have right now (they top out near " + Math.round(kmMax / 1000) + ",000 km)"
        : "below the comparable Alberta listings we have right now (they start near " + Math.round(kmMin / 1000) + ",000 km)";
      para("A note on confidence: your " + kmStr + " is " + dir + ", so this figure is read off the price-vs-mileage trend rather than a same-mileage listing - treat it as indicative. It sharpens as more listings near your mileage appear; a private-buyer inquiry is a good cross-check.", { size: 9, font: serifI, color: AMBER, lead: 4 });
    }
    y -= 4; rule(HAIR, 0.7, 4);
  }

  // ---- PRICE-VS-MILEAGE CHART + NAMED COMPS TABLE ----
  const mv = a.marketValue;
  drawChart(a.comps || a.namedComps || [], Number(a.odometerKm), Number(a.retailEstimate));
  drawComps(a.namedComps || a.comps || []);

  // ---- CPO PREMIUM (the one tiering we can back) ----
  const cp = mv && mv.cpoPremium;
  if (cp && Number(cp.premium) > 0) {
    kicker("CERTIFIED (CPO) PREMIUM", TEAL);
    para("Certified pre-owned listings of this " + modelLc + " ask about " + money(cp.premium) + " more than comparable non-certified ones (" + (cp.basis || "comparable listings") + "). That is what the market prices the manufacturer's certification - the extra inspection and extended warranty - at right now.", { size: 10, font: serif, color: SOFT, lead: 4 });
    y -= 4; rule(HAIR, 0.7, 4);
  }

  // ---- FACTORY WARRANTY - WHAT'S LEFT (basic / powertrain / corrosion) ----
  const rw = a.remainingWarranty;
  if (rw && (rw.basic || rw.powertrain || rw.corrosion)) {
    need(24); kicker("FACTORY WARRANTY - WHAT'S LEFT", TEAL);
    para("Straight from " + (a.make || "the manufacturer") + "'s own terms (estimated from the model year" + (a.odometerKm != null ? " and odometer" : "") + "). Every line is \"whichever comes first\" - at " + (a.odometerKm ? Number(a.odometerKm).toLocaleString("en-CA") + " km" : "this mileage") + " the kilometres, not the calendar, usually run coverage out first.", { size: 9.5, font: serif, color: SOFT, lead: 4 });
    y -= 2;
    const wrow = (label: string, term: any, note: string) => {
      if (!term) return;
      need(34);
      const active = !!term.active, badge = active ? "WORTH CHECKING" : "EXPIRED";
      const bcol = active ? AMBER : SLATE, bbg = active ? AMBER_BG : rgb(0.9, 0.89, 0.86);
      const bw = sansB.widthOfTextAtSize(badge, 7) + 12;
      page.drawRectangle({ x: M, y: y - 12, width: bw, height: 14, color: bbg });
      page.drawText(badge, { x: M + 6, y: y - 9, size: 7, font: sansB, color: bcol });
      right(pdfSafe(term.term || ""), { size: 9, font: sans, color: SOFT });
      y -= 17;
      T(label, { size: 10.5, font: sansB, color: active ? INK : SOFT }); y -= 14;
      para(note, { size: 9, font: serif, color: SOFT, lead: 3 }); y -= 3;
    };
    const kmOver = (rw.powertrain && rw.powertrain.kmLeft != null && Number(rw.powertrain.kmLeft) < 0) ? Math.abs(Math.round(Number(rw.powertrain.kmLeft))).toLocaleString("en-CA") : null;
    wrow("Basic (bumper-to-bumper)", rw.basic, rw.basic && rw.basic.active ? "Still active - a rare, real selling point on a used car; transferable to the buyer." : "Long past on both time and distance.");
    wrow("Powertrain - engine & transmission", rw.powertrain, rw.powertrain && rw.powertrain.active ? "Still active - engine and transmission still covered, and it transfers with the sale." : (kmOver ? "You're " + kmOver + " km past the kilometre cap, so this is used up regardless of the in-service date." : "Past its term - nothing left to transfer."));
    wrow("Rust-through (perforation)", rw.corrosion, rw.corrosion && rw.corrosion.active ? "The one time-only line (no kilometre limit) - still active only if you're within its term of the first-registration date, which a " + (a.make || "brand") + " dealer can confirm from your VIN. Worth checking before you sell." : "Past its term from the first-registration date.");
    rule(HAIR, 0.7, 4);
  }

  // ---- OPEN RECALL CAMPAIGNS (rich: campaign #, defect, remedy) ----
  const rc = a.recalls;
  if (rc) {
    need(24); kicker("OPEN RECALL CAMPAIGNS", CORAL);
    if (!rc.checked) {
      para("Couldn't reach the recall registry - not an all-clear. Check open recalls by VIN at Transport Canada before you sell.", { size: 10, font: serif, color: SOFT, lead: 4 });
    } else if (Number(rc.count) > 0) {
      const mk = a.make ? String(a.make) : "the manufacturer";
      para("This " + modelLc + " appears in " + rc.count + " Transport Canada recall campaign" + (rc.count === 1 ? "" : "s") + " on record. The definitive list of what's still open versus already done on YOUR VIN is the " + mk + " recall check - all are free fixes at any dealer.", { size: 9.5, font: serif, color: SOFT, lead: 4 });
      y -= 2;
      const items = rc.items || [];
      const CAP = 12; // list must match the count (recalls-detail-list-must-match-count)
      for (const it of items.slice(0, CAP)) {
        need(18);
        const num = it.recallNumber ? pdfSafe(String(it.recallNumber)) + " - " : "";
        const head = num + pdfSafe(it.system || "Safety recall") + (it.date ? "  (" + fmtMonYr(it.date) + ")" : "");
        page.drawText("-", { x: M, y: y - 9, size: 9.5, font: sansB, color: CORAL });
        for (const ln of wrap(head, sansB, 9.5, W - 14)) { page.drawText(ln, { x: M + 12, y: y - 9, size: 9.5, font: sansB, color: INK }); y -= 12.5; }
        const sum = it.summary ? clip(String(it.summary).replace(/^\s*Issue:\s*/i, ""), 230) : "";
        if (sum) for (const ln of wrap(sum, serif, 8.5, W - 16)) { need(11); page.drawText(ln, { x: M + 12, y: y - 8, size: 8.5, font: serif, color: SOFT }); y -= 10.5; }
        y -= 4;
      }
      if (items.length > CAP) { need(14); T("  + " + (items.length - CAP) + " more - the per-VIN check lists every one that applies.", { size: 9, font: sans, color: FAINT }); y -= 13; }
      // green suggestion box (positive advice is GREEN, not red)
      const sug = "A suggestion before you list it: look your VIN up at " + (a.make ? String(a.make).toLowerCase() + ".ca/recalls" : "the manufacturer's recall page") + " to see which of these still apply versus which are already taken care of. The fixes are free, and clearing them removes a reason for a buyer to haggle.";
      const sugLines = wrap(sug, serif, 9, W - 24);
      const boxH = sugLines.length * 12 + 16; need(boxH + 6);
      page.drawRectangle({ x: M - 6, y: y - boxH, width: W + 12, height: boxH, color: GREEN_BG, borderColor: GREEN, borderWidth: 0.8 });
      let sy2 = y - 12;
      for (const ln of sugLines) { page.drawText(ln, { x: M + 6, y: sy2, size: 9, font: serif, color: GREEN }); sy2 -= 12; }
      y -= boxH + 6;
    } else if (rc.confirmed) {
      T("No open recalls on record (confirmed with Transport Canada).", { size: 11, font: sans, color: GREEN }); y -= 16;
    } else {
      para("Couldn't confirm recalls for this exact model - NOT an all-clear. Check by VIN at Transport Canada before you sell.", { size: 10, font: serif, color: SOFT, lead: 4 });
    }
    rule(HAIR, 0.7, 4);
  }

  // ---- WHAT HOLDS THIS NUMBER UP (condition levers) ----
  {
    need(24); kicker("WHAT HOLDS THIS NUMBER UP", GREEN);
    para("The levers that move a used-car price most, and where yours land:", { size: 10, font: serif, color: SOFT, lead: 4 });
    const lever = (title: string, body: string) => {
      need(14);
      page.drawText("-", { x: M, y: y - 9, size: 9, font: sansB, color: GREEN });
      page.drawText(pdfSafe(title), { x: M + 12, y: y - 9, size: 9.5, font: sansB, color: INK }); y -= 13;
      for (const ln of wrap(body, serif, 9.5, W - 14)) { need(12); page.drawText(ln, { x: M + 12, y: y - 8, size: 9.5, font: serif, color: SOFT }); y -= 12; }
      y -= 3;
    };
    lever("No accident history", a.accidents === "none" ? "confirmed clean, which supports the top of every range above." : a.accidents === "unknown" ? "not provided - a clean, confirmable history is what would support the top of each range." : "a reported accident pulls toward the lower end; disclose it and price accordingly.");
    lever("Maintenance records", a.serviceHistory === "full" ? "documented service is real money to a private buyer and answers the \"high km\" worry before it's asked." : a.serviceHistory === "partial" ? "partial records help; a complete history would move you toward the top of the range." : "not provided - a full, documented history is worth real money to a private buyer.");
    lever("Condition & tires", "interior wear, tire life, and a set of winter tires/rims in Alberta can each nudge the private-sale number up.");
    lever("Recalls done", "clearing the open campaigns above (free) removes a reason for a buyer to hesitate or haggle.");
    lever("Season", "family haulers and " + modelLc + "s tend to sell a touch stronger heading into fall/winter.");
    rule(HAIR, 0.7, 4);
  }

  // ---- HOW THIS WAS BUILT ----
  {
    need(20); T("How this was built.", { size: 10, font: sansB, color: INK }); y -= 14;
    const n = Number(mv && mv.comps) || (a.comps ? a.comps.length : 0);
    para("Retail figures come from LotCheck's own daily read of Alberta dealers' advertised prices for the " + (a.year || "") + " " + modelWord + " (" + n + " comparable listing" + (n === 1 ? "" : "s") + "). " + (a.adjusted ? "Your " + (a.odometerKm ? Number(a.odometerKm).toLocaleString("en-CA") + " km" : "mileage") + " is read against the price-vs-mileage trend in those comps and stepped to your distance" : "There weren't enough same-mileage comps to fit a trend, so this is the median asking price, not yet adjusted for your mileage") + "; a clean, fully-documented history then places you at the top of that band. Private-sale and trade-in ranges apply typical Alberta spreads (private ~ 8-15% under dealer retail; trade ~ 15-25% under) to that retail band - a rule of thumb, not sold data. Warranty terms are quoted from " + (a.make || "the manufacturer") + "; recall data from Transport Canada's Motor Vehicle Safety Recalls Database. Nothing here is stored, and no personal details were used beyond the vehicle itself.", { size: 9, font: serif, color: SOFT, lead: 4 });
    y -= 6;
    // "live market read, not an appraisal" callout
    const cta = "This is a live market read, not an appraisal. The figures come from Alberta listings that are live right now and refreshed every day - the same current market a dealer prices against, working here on your side.";
    const ctaLines = wrap(cta, serif, 9.5, W - 24);
    const cH = ctaLines.length * 12 + 16; need(cH + 6);
    page.drawRectangle({ x: M - 6, y: y - cH, width: W + 12, height: cH, borderColor: HAIR, borderWidth: 0.8, color: CARD });
    let cyy = y - 12;
    for (const ln of ctaLines) { page.drawText(ln, { x: M + 6, y: cyy, size: 9.5, font: serif, color: SOFT }); cyy -= 12; }
    y -= cH + 8;
  }

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
