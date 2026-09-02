// ============================================================================
// Server-side report identity + SIGNATURE (provenance).
//
// The report ID is a SHA-256 fingerprint of the report's canonical contents
// (tamper-evidence / integrity). The SIGNATURE is an ECDSA P-256 signature of
// that same canonical string, made with a private key held only on the server
// (REPORT_SIGNING_PRIVATE_KEY). The public key is embedded in the web app, so
// /verify can prove a report genuinely came from LotCheck — cryptographically,
// with no lookup and nothing stored.
//
// Signing is BEST-EFFORT: if the key isn't configured (or anything throws), we
// return an unsigned-but-still-fingerprinted report. Reports never fail to
// generate because of signing. Must stay byte-consistent with the client's
// canonicalReport() only for the UNSIGNED fallback path; for signed reports the
// server is authoritative (it emits the payload the client ships verbatim).
// ============================================================================

const KEY_ID = "k1"; // bump + keep old public keys in the client on rotation

function num(x: unknown): number | null {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}
// Null-preserving: num(null) is 0, which would seal a figure the page never
// showed. Used for every nullable number in the v6 fields.
function nn(x: unknown): number | null {
  return x == null ? null : num(x);
}

// Canonical, fixed-order projection of ONLY what the report shows. Mirrors the
// client's canonicalReport(). This exact string is hashed AND signed.
export function canonicalReport(a: any): any {
  return {
    // v4: marketValue now also carries the true low/high range (lo/hi), the comp
    // count (n) and the capture date (as), so /verify can show the used-value band
    // gauge with the same dollars-and-dates the report card shows -- not just a
    // bare median. v3 also projects fcx + source, which had drifted onto the
    // client copy only. v2 added leverage's traceable note (lvn) and each add-on's
    // reason. Every bump is additive-only -- /verify re-hashes whatever bytes are
    // EMBEDDED in its own link, never rebuilds canonicalReport() from a live
    // object, so links signed under v1..v3 keep verifying exactly as issued.
    // v5: `gate` records that the dealer's rendered page refused to display a
    // price while the page's own machine-readable data carried one (D2C
    // "Call for pricing" -> priceWithoutCustomFees). It belongs INSIDE the
    // signed canonical because it is a material claim about the listing, and
    // /verify must be able to show it as sealed rather than as a re-assertion.
    // v6: `mc` (other listings read: how many, how many advertise below this
    // one, from how many dealers, read when) and `dflt` (the page's own
    // pre-selected payment scenario: term, frequency, rate, down payment, and
    // the page data it was read from). Both are claims about the listing that
    // the server computed from its own reads, so they are sealed like fcx/gate.
    v: 6,
    vehicle: a.vehicle || [a.year, a.make, a.model].filter(Boolean).join(" ") || null,
    dealer: { name: a.dealerName || null, city: a.dealerCity || null },
    price: { asking: num(a.quotedPrice), msrp: num(a.msrp), verified: a.priceVerified !== undefined ? !!a.priceVerified : (num(a.quotedPrice) as number) > 0 },
    leverage: a.leverageScore && a.leverageScore.score != null ? Number(a.leverageScore.score) : null,
    lvn: a.leverageScore?.note || null,
    recalls: a.recalls && a.recalls.checked ? { count: a.recalls.count || 0, confirmed: a.recalls.confirmed !== false, items: (a.recalls.items || []).map((it: any) => ({ system: it.system || null, date: it.date || null })) } : null,
    addOns: (a.addOns || []).map((x: any) => ({ name: x.name || null, price: num(x.price), verdict: x.verdict || null, reason: x.reason || null })),
    finance: a.financeRates ? { dealer: a.financeRates.dealer && a.financeRates.dealer.apr != null ? a.financeRates.dealer.apr : null, manufacturer: a.financeRates.manufacturer && a.financeRates.manufacturer.apr != null ? a.financeRates.manufacturer.apr : null, math: a.financingCheck && a.financingCheck.checked ? !!a.financingCheck.consistent : null } : null,
    reputation: a.dealerSentiment && a.dealerSentiment.rating ? { rating: Number(a.dealerSentiment.rating), reviews: Number(a.dealerSentiment.reviewCount || 0) } : null,
    marketValue: a.marketValue && a.marketValue.average != null ? { avg: num(a.marketValue.average), below: num(a.marketValue.below), above: num(a.marketValue.above), lo: num(a.marketValue.low), hi: num(a.marketValue.high), mileage: num(a.marketValue.mileage), source: a.marketValue.source || null, n: num(a.marketValue.comps), as: a.marketValue.asOf || null } : null,
    summary: a.summary || null,
    // #14 photo proof lock: the listing screenshot's SHA-256 rides INSIDE the
    // signed canonical -- alter the image and the seal breaks.
    shot: a.listingShotSha256 || null,
    // Full-report verify: everything the report claims travels in the signed
    // payload so /verify can display it all (compact keys keep the QR small).
    vin: a.vin || null,
    odo: num(a.odometerKm),
    dol: a.daysOnLot && Number(a.daysOnLot.days) > 0 ? { d: Math.round(Number(a.daysOnLot.days)), s: a.daysOnLot.since || null } : null,
    pd: a.priceDisclosure || null,
    gate: a.priceGatedButRecovered ? { m: a.priceGateMessage || null, g: !!a.priceGateGoogleAdsBacked } : null,
    basis: a.msrpBasis ? { b: a.msrpBasis, t: a.msrpTrim || null, y: a.msrpYear || null } : null,
    allIn: a.allInPricing?.body || null,
    disc: a.disclaimerCheck ? { e: !!a.disclaimerCheck.escapeHatch, x: !!a.disclaimerCheck.contradiction } : null,
    // fcx + source were on the CLIENT copy only, since 4e3a733 ("Flag when the
    // advertised price depends on financing with the dealer") added them there
    // and never touched this file. The server COMPUTES financeContingent and
    // simply never projected it, so the finance-contingent flag -- one of the
    // dealer tactics this product exists to surface -- could not appear on
    // /verify for any signed report. Same defect the v2 bump was fixing, two
    // fields further down. Copied verbatim from the client so the shapes match.
    fcx: a.financeContingent?.contingent ? { r: a.financeContingent.reasons || [] } : null,
    // nn(): a missing figure stays null (num(null) would seal a $0 down payment
    // or a 0% rate the page never showed). Every field the sentence depends on
    // rides here, so /verify renders the same sentence as the report.
    mc: a.marketCount ? { st: a.marketCount.state || null, sc: a.marketCount.scope || null, n: nn(a.marketCount.n), b: nn(a.marketCount.below), s: nn(a.marketCount.same), d: nn(a.marketCount.dealers), from: a.marketCount.seenMin || null, to: a.marketCount.seenMax || null, pv: a.marketCount.province || null, x: !!a.marketCount.subjectExcluded, p: nn(a.marketCount.price), tl: a.marketCount.trimLabel || null, pt: a.marketCount.powertrain || null, mn: nn(a.marketCount.modelN), mb: nn(a.marketCount.modelBelow), rs: a.marketCount.reason || null, w: nn(a.marketCount.windowDays), as: a.marketCount.asOf || null, tr: !!a.marketCount.truncated, up: nn(a.marketCount.unpriced) } : null,
    dflt: a.pageDefault ? { st: a.pageDefault.state || null, t: nn(a.pageDefault.termMonths), f: a.pageDefault.paymentFrequency || null, a: nn(a.pageDefault.apr), d: nn(a.pageDefault.downPayment), p: nn(a.pageDefault.paymentAmount), src: a.pageDefault.source || null, at: a.pageDefault.readAt || null, pm: a.pageDefault.purchaseMethod || null, rs: a.pageDefault.reason || null, q: a.pageDefault.qualifier || null, cob: nn(a.pageDefault.costOfBorrowing) } : null,
    source: (a.sourceUrl || a.capturedAt) ? { url: a.sourceUrl || null, capturedAt: a.capturedAt || null } : null,
    issuedAt: a.issuedAt || null,
  };
}

// Canonical projection for a VALUE report (the sell/what's-it-worth product), a
// SEPARATE additive-only namespace from canonicalReport so /verify can tell them
// apart (t:'value') and links signed under either keep verifying. Phase 1 signs
// ONLY what we can back from our own comps: the retail-ASKING band + the market
// CPO premium (certified vs non-certified). No trade/private tiering is signed —
// that has no backed data source. recalls/warranty are Phase 2 (additive).
export function canonicalValueReport(a: any): any {
  const mv = a.marketValue;
  const cpo = mv && mv.cpoPremium;
  return {
    t: "value",
    v: 2,
    vehicle: a.vehicle || [a.year, a.make, a.model].filter(Boolean).join(" ") || null,
    trim: a.trim || null,
    year: num(a.year),
    odo: num(a.odometerKm),
    cond: a.saleCondition || a.condition || null,
    prov: a.province ? String(a.province).toUpperCase() : null,
    vin: a.vin || null,
    // Retail ASKING band (avg=median, below/above=p25/p75, lo/hi=true range, n=comps).
    band: mv && mv.average != null ? {
      avg: num(mv.average), below: num(mv.below), above: num(mv.above),
      lo: num(mv.low), hi: num(mv.high), n: num(mv.comps), as: mv.asOf || null,
    } : null,
    // Market CPO premium: certified median − non-certified median (both from our
    // comps). Only present for a certified subject with enough comps on both sides.
    cpo: cpo ? {
      prem: num(cpo.premium), base: num(cpo.nonCertifiedMedian),
      cmed: num(cpo.certifiedMedian), nn: num(cpo.nNonCertified), nc: num(cpo.nCertified),
    } : null,
    // v2 (additive) — recalls (tri-state, mirrors the quote canonical) + remaining
    // factory warranty. checked:false / confirmed:false stay distinct from a clean
    // bill (make-recalls-fail-safe); a miss must never read as "none open".
    recalls: a.recalls && a.recalls.checked ? {
      count: a.recalls.count || 0,
      confirmed: a.recalls.confirmed !== false,
      items: (a.recalls.items || []).map((it: any) => ({ system: it.system || null, date: it.date || null })),
    } : null,
    rw: a.remainingWarranty ? {
      basic: a.remainingWarranty.basic ? { t: a.remainingWarranty.basic.term, yl: num(a.remainingWarranty.basic.yearsLeft), kl: num(a.remainingWarranty.basic.kmLeft), a: !!a.remainingWarranty.basic.active } : null,
      pt: a.remainingWarranty.powertrain ? { t: a.remainingWarranty.powertrain.term, yl: num(a.remainingWarranty.powertrain.yearsLeft), kl: num(a.remainingWarranty.powertrain.kmLeft), a: !!a.remainingWarranty.powertrain.active } : null,
    } : null,
    issuedAt: a.issuedAt || null,
  };
}

function b64urlFromBytes(buf: ArrayBuffer): string {
  let s = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  const bin = atob(s); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i); return arr;
}
function b64urlEncodeStr(str: string): string {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
// gzip a string -> bytes. Used to shrink the verify payload so the QR that
// carries it is scannable (the whole signed report rides in the URL). The
// SIGNATURE is still made over the raw canonical string, never the gzip bytes,
// so /verify decompresses first, then checks the signature.
async function gzipBytes(str: string): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const w = cs.writable.getWriter();
  w.write(new TextEncoder().encode(str));
  w.close();
  const ab = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(ab);
}
async function sha256Hex(str: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function makeReportId(fpHex: string): string {
  return "LC-" + fpHex.slice(0, 4).toUpperCase() + "-" + fpHex.slice(4, 7).toUpperCase();
}

// Import the private key once and cache it for the isolate's lifetime.
let _privKey: CryptoKey | null | undefined; // undefined = untried, null = unavailable
async function getPrivateKey(): Promise<CryptoKey | null> {
  if (_privKey !== undefined) return _privKey;
  try {
    const b64 = (globalThis as any).Deno?.env?.get("REPORT_SIGNING_PRIVATE_KEY");
    if (!b64) { _privKey = null; return null; }
    const pkcs8 = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    _privKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  } catch (e) {
    console.warn("Report signing key unavailable:", (e as Error)?.message);
    _privKey = null;
  }
  return _privKey;
}

// Stamp issuedAt (if absent) + reportId + verifyPayload onto `analysis`, and
// sign it when the key is configured. Idempotent — a cached, already-finalized
// analysis is returned untouched. Never throws; on any failure the report is
// still returned (unsigned).
export async function finalizeServerSide(
  analysis: any,
  canonicalFn: (a: any) => any = canonicalReport,
): Promise<any> {
  try {
    if (!analysis) return analysis;
    if (analysis.reportId && analysis.verifyPayload) {
      // Already finalized (e.g. cache hit). Migrate legacy UNCOMPRESSED payloads
      // to gzip so their verify QR is scannable — same canonical, so reportId and
      // signature are unchanged.
      try {
        const bytes = b64urlToBytes(analysis.verifyPayload);
        if (!(bytes[0] === 0x1f && bytes[1] === 0x8b)) {
          const canon = new TextDecoder().decode(bytes);
          analysis.verifyPayload = b64urlFromBytes((await gzipBytes(canon)).buffer);
        }
      } catch { /* leave payload as-is */ }
      return analysis;
    }
    if (!analysis.issuedAt) analysis.issuedAt = new Date().toISOString();
    const canonical = JSON.stringify(canonicalFn(analysis));
    analysis.reportId = makeReportId(await sha256Hex(canonical));
    // Compress the payload so the verify QR is scannable. Fall back to the raw
    // (uncompressed) payload if CompressionStream is unavailable — /verify auto-
    // detects the gzip header, so either form verifies.
    try { analysis.verifyPayload = b64urlFromBytes((await gzipBytes(canonical)).buffer); }
    catch { analysis.verifyPayload = b64urlEncodeStr(canonical); }
    const key = await getPrivateKey();
    if (key) {
      const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(canonical));
      analysis.sig = b64urlFromBytes(sig);
      analysis.keyId = KEY_ID;
    }
  } catch (e) {
    console.warn("finalizeServerSide failed (returning report unsigned):", (e as Error)?.message);
  }
  return analysis;
}
