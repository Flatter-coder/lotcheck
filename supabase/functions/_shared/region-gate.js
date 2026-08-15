// Where LotCheck is served, and how that verdict is proven to the server.
//
// LotCheck is an ALBERTA product today. The rebate logic is Alberta's EVAP, the
// all-in advertising rule is AMVIC's, the licence check is the AMVIC registry,
// and the dealer-fee benchmarks are Alberta's. Running a report for a Manitoba
// buyer would produce Alberta answers to a Manitoba question, which is worse
// than declining.
//
// TWO THINGS THIS FILE IS CAREFUL ABOUT.
//
// 1. IP GEOLOCATION IS NOT TRUTH. Canadian carriers backhaul through regional
//    hubs, so a Calgary phone on Telus can resolve to Toronto. Starlink,
//    corporate VPNs and business ISPs are worse. A hard block therefore turns
//    away real Alberta customers who have no way to tell us. That is why the
//    verdict is APPEALABLE (see `selfDeclared` below) and why an unknown region
//    is allowed rather than refused: we would rather serve a handful of
//    out-of-province visitors than refuse one Albertan
//    (no-single-point-of-failure -- availability failures degrade gracefully).
//
// 2. THE REGION IS NOT A CLIENT CLAIM. The browser cannot be trusted to report
//    its own province, and the analyze functions spend real vendor money. So
//    Vercel -- which actually terminates the connection and sees the IP --
//    mints a short-lived HMAC token, and the edge function verifies it. A
//    forged region costs an attacker a signing key they do not have.
//
// Expansion is a data change, not a code change (locale-abstraction-rule): add
// a row to SERVED_REGIONS and the gate, the copy and the waitlist all follow.

/** Regions LotCheck actually serves. Adding Florida means adding a row here. */
export const SERVED_REGIONS = [
  { country: "CA", region: "AB", label: "Alberta" },
];

/** Province/state names for copy, so a blocked visitor is told where they look to be. */
export const REGION_NAMES = {
  "CA-AB": "Alberta",       "CA-BC": "British Columbia", "CA-SK": "Saskatchewan",
  "CA-MB": "Manitoba",      "CA-ON": "Ontario",          "CA-QC": "Quebec",
  "CA-NB": "New Brunswick", "CA-NS": "Nova Scotia",      "CA-PE": "Prince Edward Island",
  "CA-NL": "Newfoundland and Labrador", "CA-YT": "Yukon",
  "CA-NT": "Northwest Territories",     "CA-NU": "Nunavut",
};

export const norm = (v) => String(v ?? "").trim().toUpperCase();

/** Human name for a country/region pair, or null when we cannot name it. */
export function regionName(country, region) {
  const c = norm(country), r = norm(region);
  if (!c || !r) return null;
  return REGION_NAMES[`${c}-${r}`] ?? null;
}

/**
 * The policy. Returns { served, reason, regionLabel }.
 *
 * `served: true` means the check may run. Note the deliberate asymmetry:
 *   - a KNOWN served region  -> served
 *   - a KNOWN other region   -> not served, and we can name it in the copy
 *   - an UNKNOWN region      -> SERVED. We could not establish where they are,
 *     and refusing on absence would block Albertans whose carrier hid them.
 *     Absence of evidence is not evidence of absence -- the same discipline the
 *     MSRP claim gate applies in the other direction, because there the cost of
 *     being wrong is an accusation and here it is a lost customer.
 */
export function evaluateRegion({ country, region } = {}) {
  const c = norm(country), r = norm(region);
  if (!c || !r) {
    return { served: true, reason: "unknown", regionLabel: null };
  }
  const hit = SERVED_REGIONS.some((s) => s.country === c && s.region === r);
  if (hit) return { served: true, reason: "served", regionLabel: regionName(c, r) };
  return {
    served: false,
    reason: c === "CA" ? "other_province" : "other_country",
    regionLabel: regionName(c, r) ?? (c === "CA" ? "another province" : "outside Canada"),
  };
}

// ---- the signed attestation ------------------------------------------------
// HMAC-SHA256 over "country|region|exp". Web Crypto, so the identical code runs
// on Vercel's edge runtime and in Deno. The payload carries no personal data --
// no IP, no city, no visitor id -- only the coarse region and an expiry.

const enc = new TextEncoder();

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw", enc.encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );
}

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Mint a token. `ttlSeconds` is short: a region claim should not outlive a session. */
export async function signRegionToken({ country, region, secret, nowMs, ttlSeconds = 3600 }) {
  const exp = Math.floor((nowMs ?? Date.now()) / 1000) + ttlSeconds;
  const payload = `${norm(country)}|${norm(region)}|${exp}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload));
  return `${payload}|${b64url(sig)}`;
}

/**
 * Verify a token. Returns { valid, country, region, reason }.
 * A malformed, expired or mis-signed token is simply "no attestation" — the
 * caller decides what to do, and the caller fails OPEN (see the note above).
 */
export async function verifyRegionToken(token, secret, nowMs) {
  try {
    if (!token || !secret) return { valid: false, reason: "absent" };
    const parts = String(token).split("|");
    if (parts.length !== 4) return { valid: false, reason: "malformed" };
    const [country, region, expStr, sig] = parts;
    const exp = Number(expStr);
    if (!Number.isFinite(exp)) return { valid: false, reason: "malformed" };
    if (exp * 1000 < (nowMs ?? Date.now())) return { valid: false, reason: "expired" };

    const payload = `${country}|${region}|${expStr}`;
    const expected = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload));
    if (b64url(expected) !== sig) return { valid: false, reason: "bad_signature" };

    return { valid: true, country, region, reason: "ok" };
  } catch {
    return { valid: false, reason: "error" };
  }
}

/**
 * The server-side decision for one request.
 *
 * FAILS OPEN, on purpose and in exactly two cases: no signing secret is
 * configured, or no valid attestation was presented. Both are OUR failures, and
 * charging an Albertan for our misconfiguration is the worse error. A visitor
 * we positively place outside Alberta is refused.
 *
 * `selfDeclared` is the appeal. A visitor told they look out-of-province can say
 * "I'm in Alberta" and proceed; the claim is recorded so leakage is measurable
 * rather than invisible.
 */
export async function gateRequest({ token, secret, selfDeclared = false, nowMs } = {}) {
  if (!secret) {
    return { allow: true, enforced: false, reason: "no_secret", region: null, country: null };
  }
  const v = await verifyRegionToken(token, secret, nowMs);
  if (!v.valid) {
    return { allow: true, enforced: false, reason: `attestation_${v.reason}`, region: null, country: null };
  }
  const verdict = evaluateRegion({ country: v.country, region: v.region });
  if (verdict.served) {
    return { allow: true, enforced: true, reason: verdict.reason, region: v.region, country: v.country };
  }
  if (selfDeclared) {
    return { allow: true, enforced: true, reason: "self_declared", region: v.region, country: v.country };
  }
  return {
    allow: false, enforced: true, reason: verdict.reason,
    region: v.region, country: v.country, regionLabel: verdict.regionLabel,
  };
}
