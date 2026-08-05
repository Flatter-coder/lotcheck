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

// Canonical, fixed-order projection of ONLY what the report shows. Mirrors the
// client's canonicalReport(). This exact string is hashed AND signed.
export function canonicalReport(a: any): any {
  return {
    v: 1,
    vehicle: a.vehicle || [a.year, a.make, a.model].filter(Boolean).join(" ") || null,
    dealer: { name: a.dealerName || null, city: a.dealerCity || null },
    price: { asking: num(a.quotedPrice), msrp: num(a.msrp), verified: a.priceVerified !== undefined ? !!a.priceVerified : (num(a.quotedPrice) as number) > 0 },
    leverage: a.leverageScore && a.leverageScore.score != null ? Number(a.leverageScore.score) : null,
    recalls: a.recalls && a.recalls.checked ? { count: a.recalls.count || 0, confirmed: a.recalls.confirmed !== false, items: (a.recalls.items || []).map((it: any) => ({ system: it.system || null, date: it.date || null })) } : null,
    addOns: (a.addOns || []).map((x: any) => ({ name: x.name || null, price: num(x.price), verdict: x.verdict || null })),
    finance: a.financeRates ? { dealer: a.financeRates.dealer && a.financeRates.dealer.apr != null ? a.financeRates.dealer.apr : null, manufacturer: a.financeRates.manufacturer && a.financeRates.manufacturer.apr != null ? a.financeRates.manufacturer.apr : null, math: a.financingCheck && a.financingCheck.checked ? !!a.financingCheck.consistent : null } : null,
    reputation: a.dealerSentiment && a.dealerSentiment.rating ? { rating: Number(a.dealerSentiment.rating), reviews: Number(a.dealerSentiment.reviewCount || 0) } : null,
    marketValue: a.marketValue && a.marketValue.average != null ? { avg: num(a.marketValue.average), below: num(a.marketValue.below), above: num(a.marketValue.above), mileage: num(a.marketValue.mileage), source: a.marketValue.source || null } : null,
    summary: a.summary || null,
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
export async function finalizeServerSide(analysis: any): Promise<any> {
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
    const canonical = JSON.stringify(canonicalReport(analysis));
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
