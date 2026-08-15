// ============================================================================
// Report AUTHENTICITY gate — proof-of-scan for the report-email endpoint.
//
// WHY THIS EXISTS
// ---------------
// email-quote-report is unauthenticated by design: a buyer types an address on
// the results screen and we mail them their report. There is no account, so
// there is no session to check. Before this module, that meant the endpoint
// accepted ANY {email, analysis} pair from ANY caller and turned it into a
// DKIM-signed, LotCheck-branded PDF email from reports@lotcheck.ca.
//
// That is an open mail relay wearing our own domain's reputation. The three
// things it hands an attacker, in ascending order of how much they cost us:
//   1. Free email sending (Resend quota).
//   2. Unsolicited mail to strangers, sent "by" LotCheck (CASL exposure, and
//      spam complaints that land on OUR sending domain).
//   3. A LotCheck-branded document containing attacker-written text — a
//      fabricated "verified report" that defames a dealer, or a phishing mail
//      that is genuinely DKIM-signed by lotcheck.ca and so passes every
//      authenticity check a recipient's mail client can make.
// (3) is the one that cannot be bought back. Domain reputation and the
// trustworthiness of the phrase "this came from LotCheck" are the assets.
//
// THE GATE
// --------
// Every genuine report is already ECDSA P-256 signed by the server at the end
// of a scan (_shared/report-sign.ts). Only LotCheck's private key can produce
// that signature, so it is an unforgeable PROOF THAT A REAL SCAN HAPPENED. It
// was sitting unused. This module makes it the precondition for sending.
//
// The subtle part — and the reason this is not a three-line change — is WHAT
// the signature is checked against. Verifying the client's own
// `analysis.verifyPayload` proves only that SOME LotCheck report was signed at
// some point. An attacker who runs one honest scan (or opens any shared verify
// link) can keep that genuine (verifyPayload, sig, keyId) triple, rewrite
// `analysis.summary` to arbitrary text, and the email — which renders from
// `analysis`, not from the payload — carries their words under our signature.
// That is the same cross-report splice class already defended against for the
// sealed capture in email-quote-report's verifySealedShot.
//
// So the check here RECOMPUTES the canonical projection from the submitted
// analysis and verifies the signature over THAT. If it verifies, every field
// canonicalReport() covers — vehicle, dealer, price, leverage, recalls,
// add-ons, financing, reputation, market value, VIN, odometer, days-on-lot,
// price disclosure, MSRP basis, all-in pricing, disclaimers, issuedAt and the
// summary prose — is byte-for-byte what LotCheck signed. Change one character
// of any of them and the signature fails.
//
// FAIL CLOSED. A report we cannot prove we produced does not get mailed under
// our name. This is deliberately the opposite of the free-check breaker's
// fail-open stance (analyze-listing-url:157), and the difference is principled:
// that breaker guards SPEND, where a database blip must not block a paying
// customer. This guards CORRECTNESS AND PROVENANCE, where degrading open would
// mean mailing an unverifiable document as though it were verified — a false
// all-clear, which is the one failure mode this product may never have.
//
// STORES NOTHING. Pure cryptography over the request body: no lookup, no
// counter, no recipient record. It therefore leaves "analyzed once, never
// stored" (pinned by npm run check:copy) untouched, and adds no personal
// information under PIPA/PIPEDA.
// ============================================================================

import { canonicalReport } from "./report-sign.ts";

// Public verification keys — the same registry the web app ships in App.jsx
// and the PDF/verify path uses. Public material, safe to embed. Add retired
// keys here on rotation so reports signed before a rotation keep verifying.
export const REPORT_PUBLIC_KEYS: Record<string, string> = {
  k1: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAErEpWm/YsbAN9i9RkuGAPDadAp8BJ+i3j7V1WVUtvsQgmBN04hEQksYdyUksotL6LYOrPAnRkpqh6DXmMlTI7FA==",
};

// How long a signed report stays mailable.
//
// The overwhelmingly common path is: scan finishes, buyer types their address,
// report is mailed seconds later. The window exists for the rarer honest case
// — a buyer reopens their own report from the `#r=` link in a previous email
// and mails it again — while making sure a single leaked signed report is not
// a permanent spam vehicle. It also, usefully, bounds the blast radius of a
// future change to canonicalReport()'s shape: reports signed under an older
// projection stop verifying, and this window caps how long that can matter to
// exactly one day rather than forever.
//
// Tuning note: raising this lengthens both the replay window and the
// canonical-drift window; lowering it starts rejecting legitimate re-sends.
// A rejected buyer is told to re-run the check, which is cheap for them and
// returns fresher data — the honest degradation.
export const REPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Clock skew tolerance for a report that claims to be issued in the future.
// Small: issuedAt is stamped by our own server, so real skew is milliseconds.
export const REPORT_FUTURE_SKEW_MS = 5 * 60 * 1000;

// Hard ceiling on the request body. The endpoint accepts a base64 listing
// screenshot inside `analysis`, so the body is legitimately large — but
// unbounded it is a memory-exhaustion lever on an unauthenticated endpoint,
// and the check must happen BEFORE req.json() parses anything. Real reports
// with a full-page capture land around 1–3 MB; 8 MB is generous headroom.
export const MAX_BODY_BYTES = 8_000_000;

// Origins the browser app is served from. This is defence in depth ONLY: any
// non-browser client can set Origin to whatever it likes, so this stops other
// websites scripting our endpoint and casual abuse, and stops nothing else.
// The signature gate below is the control that actually holds. Preview deploys
// are allowed because they must be able to exercise the real send path.
const ALLOWED_ORIGIN_EXACT = new Set([
  "https://lotcheck.ca",
  "https://www.lotcheck.ca",
  "http://localhost:5173",
  "http://localhost:4173",
  "http://127.0.0.1:5173",
]);
const ALLOWED_ORIGIN_SUFFIX = [".vercel.app"];

// A request with NO Origin header is not rejected here. Origin is browser-set;
// its absence means "not a browser", which is exactly what a curl attacker
// looks like AND what a legitimate server-side caller looks like. Rejecting on
// absence buys nothing (the attacker simply sets one) while breaking honest
// non-browser use, so the decision is deferred to the signature gate, which
// treats both callers identically and correctly.
export function originAllowed(origin: string | null | undefined): boolean {
  if (!origin) return true;
  if (ALLOWED_ORIGIN_EXACT.has(origin)) return true;
  try {
    const host = new URL(origin).hostname;
    return ALLOWED_ORIGIN_SUFFIX.some((suf) => host.endsWith(suf));
  } catch {
    return false;
  }
}

// The CORS origin to echo back. Never "*" once credentials-shaped headers are
// in play, and echoing the caller's own allowed origin keeps preview deploys
// working without widening the policy.
export function corsOrigin(origin: string | null | undefined): string {
  return origin && originAllowed(origin) ? origin : "https://lotcheck.ca";
}

// Machine-readable outcomes. These are surfaced as `code` on the 4xx response
// and logged, so the admin panel can show WHICH link failed rather than a
// generic rejection — every failure emits a code that stays open until fixed.
export type ReportAuthCode =
  | "ok"
  | "unsigned_report"
  | "unknown_key"
  | "signature_mismatch"
  | "missing_issued_at"
  | "report_expired"
  | "report_future_dated";

export interface ReportAuthResult {
  ok: boolean;
  code: ReportAuthCode;
  /** Buyer-facing sentence. Never leaks which internal check failed. */
  message: string;
  /** Age of the report at check time, ms. Null when it never got that far. */
  ageMs: number | null;
}

function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// One buyer-facing sentence for every failure. Deliberately identical in shape
// across causes: a caller probing the endpoint learns nothing about which link
// in the chain broke, while the real buyer gets an action that works.
const BUYER_MESSAGE: Record<ReportAuthCode, string> = {
  ok: "",
  unsigned_report: "This report can't be verified as one of ours, so we won't email it. Run the check again and send it from the fresh result.",
  unknown_key: "This report can't be verified as one of ours, so we won't email it. Run the check again and send it from the fresh result.",
  signature_mismatch: "This report can't be verified as one of ours, so we won't email it. Run the check again and send it from the fresh result.",
  missing_issued_at: "This report can't be verified as one of ours, so we won't email it. Run the check again and send it from the fresh result.",
  report_expired: "This report is more than a day old. Run the check again — prices and listings move, and the fresh one is the one worth having.",
  report_future_dated: "This report can't be verified as one of ours, so we won't email it. Run the check again and send it from the fresh result.",
};

function fail(code: ReportAuthCode, ageMs: number | null = null): ReportAuthResult {
  return { ok: false, code, message: BUYER_MESSAGE[code], ageMs };
}

/**
 * Prove the submitted analysis is a report LotCheck actually produced, recently.
 *
 * @param analysis  the client-submitted report object, untrusted
 * @param opts.now  current epoch ms (injectable so the test suite is not
 *                  wall-clock dependent — the repo's tests are pure and offline)
 * @param opts.keys public key registry (injectable so tests can sign with a
 *                  throwaway keypair instead of shipping a private key)
 * @param opts.maxAgeMs freshness window override
 */
export async function verifyReportAuthenticity(
  analysis: any,
  opts: { now?: number; keys?: Record<string, string>; maxAgeMs?: number } = {},
): Promise<ReportAuthResult> {
  const now = opts.now ?? Date.now();
  const keys = opts.keys ?? REPORT_PUBLIC_KEYS;
  const maxAgeMs = opts.maxAgeMs ?? REPORT_MAX_AGE_MS;

  if (!analysis || typeof analysis !== "object") return fail("unsigned_report");

  const sig = analysis.sig;
  const keyId = analysis.keyId;
  if (typeof sig !== "string" || !sig) return fail("unsigned_report");
  if (typeof keyId !== "string" || !keyId) return fail("unsigned_report");

  const pubB64 = keys[keyId];
  if (!pubB64) return fail("unknown_key");

  // The load-bearing line. canonicalReport() is recomputed from the SUBMITTED
  // body, so the signature is checked against what this email will actually
  // render — not against a payload the caller also controls.
  let verified = false;
  try {
    const canonical = JSON.stringify(canonicalReport(analysis));
    const spki = Uint8Array.from(atob(pubB64), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      "spki",
      spki as unknown as ArrayBufferView,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      b64urlToBytes(sig) as unknown as ArrayBufferView,
      new TextEncoder().encode(canonical) as unknown as ArrayBufferView,
    );
  } catch {
    // A malformed signature, key, or unserialisable analysis all land here.
    // Indistinguishable from a forgery as far as this gate is concerned.
    return fail("signature_mismatch");
  }
  if (!verified) return fail("signature_mismatch");

  // Only NOW is issuedAt trustworthy: it rides inside the canonical, so the
  // verification above is what makes reading it off `analysis` safe. Checking
  // freshness before the signature would be reading an attacker-set field.
  const issuedAt = analysis.issuedAt;
  if (typeof issuedAt !== "string" || Number.isNaN(Date.parse(issuedAt))) {
    return fail("missing_issued_at");
  }
  const ageMs = now - Date.parse(issuedAt);
  if (ageMs < -REPORT_FUTURE_SKEW_MS) return fail("report_future_dated", ageMs);
  if (ageMs > maxAgeMs) return fail("report_expired", ageMs);

  return { ok: true, code: "ok", message: "", ageMs };
}
