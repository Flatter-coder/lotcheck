// Regression harness for the report-email authenticity gate (report-auth.ts).
// Same contract as capture.test.ts and invariants.test.ts: pure, offline,
// exercises the EXACT code that ships (imported, not copied), exits 1 on any
// failure.
//
// What each case pins is a way the open-relay defect could come back:
//   - the OPEN RELAY itself (an unsigned analysis must never be mailable),
//   - the CROSS-REPORT SPLICE (a genuine signature carried on a rewritten
//     body — the failure mode that makes "just check the signature" wrong),
//   - the REPLAY WINDOW (a signed report is not a permanent spam vehicle),
//   - the ORIGIN allowlist behaving as defence-in-depth, not as the gate.
//
// The suite signs with a THROWAWAY keypair generated here, injected via
// opts.keys. No private key material is committed, and the test never touches
// the network or the production registry.
//
// Run (Node 24+, from repo root):
//   node --experimental-strip-types supabase/functions/_shared/report-auth.test.ts
import {
  verifyReportAuthenticity,
  originAllowed,
  corsOrigin,
  REPORT_MAX_AGE_MS,
  REPORT_PUBLIC_KEYS,
  MAX_BODY_BYTES,
} from "./report-auth.ts";
import { canonicalReport } from "./report-sign.ts";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ok  ${name}`); }
  else { failures++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

function b64urlFromBytes(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── throwaway signing identity ──────────────────────────────────────────────
const pair = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
) as CryptoKeyPair;
const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
const TEST_KEYS = { t1: btoa(String.fromCharCode(...new Uint8Array(spki))) };

const NOW = Date.parse("2026-08-14T12:00:00.000Z");

/** Build a realistic analysis and sign it exactly as finalizeServerSide does. */
async function signedReport(overrides: Record<string, unknown> = {}) {
  const analysis: any = {
    vehicle: "2024 Hyundai IONIQ 5 Preferred AWD",
    dealerName: "Southgate Hyundai",
    dealerCity: "Edmonton",
    quotedPrice: 48995,
    msrp: 52499,
    priceVerified: true,
    leverageScore: { score: 7 },
    summary: "The asking price sits below the manufacturer's published MSRP for this trim.",
    vin: "KM8KRDAF4RU123456",
    odometerKm: 18420,
    issuedAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
  const canonical = JSON.stringify(canonicalReport(analysis));
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, pair.privateKey,
    new TextEncoder().encode(canonical) as unknown as ArrayBufferView,
  );
  analysis.sig = b64urlFromBytes(sig);
  analysis.keyId = "t1";
  return analysis;
}

const opts = { now: NOW, keys: TEST_KEYS };

// ── the happy path still works ──────────────────────────────────────────────
{
  const r = await verifyReportAuthenticity(await signedReport(), opts);
  check("a genuine freshly-signed report is mailable", r.ok && r.code === "ok", r.code);
}

// ── THE OPEN RELAY: the defect this module exists to close ──────────────────
{
  // Exactly the payload an attacker POSTs: a plausible report object, no sig.
  const r = await verifyReportAuthenticity({
    vehicle: "2024 Honda Civic", quotedPrice: 1, summary: "Click here to claim your refund",
    issuedAt: new Date(NOW).toISOString(),
  }, opts);
  check("an unsigned analysis is REJECTED (open-relay class)",
    !r.ok && r.code === "unsigned_report", r.code);
}
{
  const r = await verifyReportAuthenticity(null, opts);
  check("a null analysis is rejected", !r.ok && r.code === "unsigned_report", r.code);
}
{
  const a = await signedReport();
  delete a.keyId;
  const r = await verifyReportAuthenticity(a, opts);
  check("a signature with no keyId is rejected", !r.ok && r.code === "unsigned_report", r.code);
}
{
  const a = await signedReport();
  a.keyId = "k99";
  const r = await verifyReportAuthenticity(a, opts);
  check("an unknown keyId is rejected", !r.ok && r.code === "unknown_key", r.code);
}
{
  const a = await signedReport();
  a.sig = "not-a-real-signature";
  const r = await verifyReportAuthenticity(a, opts);
  check("a malformed signature is rejected, not thrown",
    !r.ok && r.code === "signature_mismatch", r.code);
}

// ── THE SPLICE: a REAL signature carried on a REWRITTEN body ────────────────
// This is the class that makes "just verify the signature" insufficient, and
// the reason the gate recomputes canonicalReport() from the submitted body.
// Every field below is one an attacker would want to control in a document
// that arrives DKIM-signed by lotcheck.ca.
for (const [field, value, label] of [
  ["summary", "LotCheck has verified this dealer is committing fraud. Wire your deposit to...", "defamation / phishing prose"],
  ["quotedPrice", 1, "the price the report is about"],
  ["dealerName", "A Competitor Motors", "which dealer gets accused"],
  ["vehicle", "2024 Toyota Camry", "which car the report describes"],
  ["vin", "1HGCV1F34LA000000", "the VIN"],
  ["msrp", 999999, "the MSRP the price is judged against"],
  ["odometerKm", 5, "the odometer"],
] as Array<[string, unknown, string]>) {
  const a = await signedReport();
  a[field] = value; // genuine sig + keyId retained, body rewritten
  const r = await verifyReportAuthenticity(a, opts);
  check(`splice rejected: tampered ${field} (${label})`,
    !r.ok && r.code === "signature_mismatch", r.code);
}

// ── replay window ───────────────────────────────────────────────────────────
{
  const a = await signedReport({ issuedAt: new Date(NOW - REPORT_MAX_AGE_MS - 60_000).toISOString() });
  const r = await verifyReportAuthenticity(a, opts);
  check("a report older than the window is rejected", !r.ok && r.code === "report_expired", r.code);
}
{
  const a = await signedReport({ issuedAt: new Date(NOW - REPORT_MAX_AGE_MS + 60_000).toISOString() });
  const r = await verifyReportAuthenticity(a, opts);
  check("a report just inside the window is accepted", r.ok, r.code);
}
{
  const a = await signedReport({ issuedAt: new Date(NOW + 60 * 60 * 1000).toISOString() });
  const r = await verifyReportAuthenticity(a, opts);
  check("a future-dated report is rejected", !r.ok && r.code === "report_future_dated", r.code);
}
{
  // Small forward skew must NOT reject a real buyer.
  const a = await signedReport({ issuedAt: new Date(NOW + 30_000).toISOString() });
  const r = await verifyReportAuthenticity(a, opts);
  check("a report seconds in the future is tolerated (clock skew)", r.ok, r.code);
}
{
  // issuedAt rides inside the canonical, so a null one signs fine — and must
  // then be caught by the freshness check rather than treated as timeless.
  const a = await signedReport({ issuedAt: null });
  const r = await verifyReportAuthenticity(a, opts);
  check("a signed report with no issuedAt is rejected, not treated as ageless",
    !r.ok && r.code === "missing_issued_at", r.code);
}

// ── freshness is checked AFTER the signature, never before ──────────────────
{
  // An attacker rewriting issuedAt to "now" on an old report must fail on the
  // signature, proving the age check reads a cryptographically bound field.
  const a = await signedReport({ issuedAt: new Date(NOW - REPORT_MAX_AGE_MS - 60_000).toISOString() });
  a.issuedAt = new Date(NOW).toISOString();
  const r = await verifyReportAuthenticity(a, opts);
  check("refreshing issuedAt on an expired report breaks the signature",
    !r.ok && r.code === "signature_mismatch", r.code);
}

// ── the gate never leaks which link broke ───────────────────────────────────
{
  const unsigned = await verifyReportAuthenticity({ issuedAt: new Date(NOW).toISOString() }, opts);
  const spliced = await verifyReportAuthenticity(
    await signedReport().then((a) => { a.summary = "x"; return a; }), opts);
  check("forgery messages are indistinguishable to a prober",
    unsigned.message === spliced.message && unsigned.code !== spliced.code);
}

// ── origin allowlist: defence in depth, and honest about its limits ─────────
check("production origin allowed", originAllowed("https://lotcheck.ca"));
check("www origin allowed", originAllowed("https://www.lotcheck.ca"));
check("vercel preview origin allowed", originAllowed("https://lotcheck-git-abc.vercel.app"));
check("localhost dev origin allowed", originAllowed("http://localhost:5173"));
check("a hostile site origin is refused", !originAllowed("https://evil.example.com"));
check("a lookalike domain is refused", !originAllowed("https://lotcheck.ca.evil.com"));
check("a suffix-confusion domain is refused", !originAllowed("https://notlotcheck.ca"));
check("a malformed origin is refused", !originAllowed("://::"));
check("absent origin defers to the signature gate (non-browser callers)", originAllowed(null));
check("CORS echoes an allowed origin", corsOrigin("https://www.lotcheck.ca") === "https://www.lotcheck.ca");
check("CORS never echoes a hostile origin",
  corsOrigin("https://evil.example.com") === "https://lotcheck.ca");
check("CORS is never the wildcard", corsOrigin(null) !== "*" && corsOrigin("*") !== "*");

// ── configuration invariants ────────────────────────────────────────────────
check("the production key registry is non-empty (gate would reject everything)",
  Object.keys(REPORT_PUBLIC_KEYS).length > 0);
check("k1 is still present (reports signed under it must keep verifying)",
  typeof REPORT_PUBLIC_KEYS.k1 === "string" && REPORT_PUBLIC_KEYS.k1.length > 80);
check("the body cap leaves room for a real capture but is bounded",
  MAX_BODY_BYTES >= 4_000_000 && MAX_BODY_BYTES <= 16_000_000);

// ── KNOWN RESIDUAL: fields outside the canonical are NOT bound ──────────────
// canonicalReport() is what the signature covers. Anything the email renders
// from OUTSIDE it can still be altered by a caller holding a genuine report.
// This case does not assert that the gap is acceptable — it PINS the gap so it
// cannot grow silently: if a future change starts rendering a new unbound field
// into the email, this stays green while the risk moves, so any new field added
// to the email body must either go into canonicalReport() or be listed here.
{
  const a = await signedReport();
  a.evapRebate = { amount: 5000, program: "attacker supplied" };
  const r = await verifyReportAuthenticity(a, opts);
  check("KNOWN GAP: non-canonical fields (evapRebate) do not break the signature", r.ok,
    "if this ever fails, canonicalReport() grew — good, update this case");
}

console.log(failures === 0
  ? "\nreport-auth: all checks passed"
  : `\nreport-auth: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
