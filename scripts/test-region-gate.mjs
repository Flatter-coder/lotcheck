// Regression harness for the Alberta-only region gate.
//
// The two failure modes this pins, which point in opposite directions:
//
//   Blocking a real Albertan.  IP geolocation is not truth — Canadian carriers
//   backhaul through regional hubs, so a Calgary phone can resolve to Toronto.
//   A blocked customer has no way to tell us and simply leaves. So an UNKNOWN
//   region must be served, a missing secret must be served, and a self-declared
//   Albertan must be served.
//
//   Letting the gate be bypassed by typing.  The analyze functions spend real
//   vendor money, so the region cannot be a client claim. Only an HMAC token
//   minted by Vercel — which actually sees the IP — counts.
//
// Run: node scripts/test-region-gate.mjs
import {
  evaluateRegion, signRegionToken, verifyRegionToken, gateRequest,
  regionName, SERVED_REGIONS,
} from "../supabase/functions/_shared/region-gate.js";

let pass = 0, fail = 0;
const fails = [];
function check(ok, label, detail = "") {
  if (ok) pass++; else { fail++; fails.push(label); }
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        ${detail}`}`);
}
const SECRET = "test-secret-not-the-real-one";
const NOW = 1_776_000_000_000; // fixed clock; the gate must never depend on wall time

// ---- the policy ------------------------------------------------------------
check(evaluateRegion({ country: "CA", region: "AB" }).served, "Alberta is served");
check(evaluateRegion({ country: "ca", region: "ab" }).served, "casing does not change the verdict");
check(evaluateRegion({ country: " CA ", region: " AB " }).served, "whitespace does not change the verdict");

for (const [r, name] of [["BC", "British Columbia"], ["SK", "Saskatchewan"], ["MB", "Manitoba"],
                         ["ON", "Ontario"], ["QC", "Quebec"], ["NS", "Nova Scotia"], ["NU", "Nunavut"]]) {
  const v = evaluateRegion({ country: "CA", region: r });
  check(!v.served && v.reason === "other_province" && v.regionLabel === name,
    `${name} is not served, and is named in the copy`, JSON.stringify(v));
}
check(evaluateRegion({ country: "US", region: "FL" }).reason === "other_country",
  "outside Canada is distinguishable from another province — Florida is the expansion target");

// ---- THE RULE THAT PROTECTS ALBERTANS -------------------------------------
// Every one of these is a case where we could not establish the province. The
// gate must serve them. Refusing on absence would silently turn away customers
// whose carrier hid them, and they would never tell us.
for (const input of [
  {}, { country: "CA" }, { region: "AB" }, { country: "", region: "" },
  { country: null, region: null }, { country: "CA", region: "" },
]) {
  const v = evaluateRegion(input);
  check(v.served && v.reason === "unknown",
    `an unresolvable location is SERVED, never refused: ${JSON.stringify(input)}`, JSON.stringify(v));
}

// ---- the signed attestation ------------------------------------------------
{
  const t = await signRegionToken({ country: "CA", region: "AB", secret: SECRET, nowMs: NOW });
  const v = await verifyRegionToken(t, SECRET, NOW);
  check(v.valid && v.country === "CA" && v.region === "AB", "a valid token verifies", JSON.stringify(v));

  check((await verifyRegionToken(t, "wrong-secret", NOW)).reason === "bad_signature",
    "a token signed with another key is rejected");
  check((await verifyRegionToken(t, SECRET, NOW + 3601 * 1000)).reason === "expired",
    "an expired token is rejected — a region claim must not outlive its session");

  // The forgery attempt that matters: swap the region, keep the signature.
  const forged = t.replace("CA|AB|", "CA|BC|");
  check((await verifyRegionToken(forged, SECRET, NOW)).reason === "bad_signature",
    "editing the region invalidates the signature — the gate cannot be bypassed by typing");

  for (const bad of ["", null, undefined, "garbage", "CA|AB", "CA|AB|notanumber|sig", "a|b|c|d|e"]) {
    const v2 = await verifyRegionToken(bad, SECRET, NOW);
    check(!v2.valid, `a malformed token is rejected: ${JSON.stringify(bad)}`, JSON.stringify(v2));
  }
  check(!(await verifyRegionToken(t, "", NOW)).valid, "no secret means no valid attestation");
}

// ---- the request decision --------------------------------------------------
{
  const ab = await signRegionToken({ country: "CA", region: "AB", secret: SECRET, nowMs: NOW });
  const bc = await signRegionToken({ country: "CA", region: "BC", secret: SECRET, nowMs: NOW });

  const a = await gateRequest({ token: ab, secret: SECRET, nowMs: NOW });
  check(a.allow && a.enforced, "an attested Albertan is allowed, and it is recorded as enforced", JSON.stringify(a));

  const b = await gateRequest({ token: bc, secret: SECRET, nowMs: NOW });
  check(!b.allow && b.regionLabel === "British Columbia",
    "an attested British Columbian is refused, and we can name the province", JSON.stringify(b));

  // FAIL OPEN — both of these are OUR failure, and charging an Albertan for our
  // misconfiguration is the worse error.
  const noSecret = await gateRequest({ token: bc, secret: "", nowMs: NOW });
  check(noSecret.allow && !noSecret.enforced && noSecret.reason === "no_secret",
    "with no secret configured the gate FAILS OPEN and says so", JSON.stringify(noSecret));

  const noToken = await gateRequest({ token: null, secret: SECRET, nowMs: NOW });
  check(noToken.allow && !noToken.enforced && noToken.reason === "attestation_absent",
    "with no attestation the gate FAILS OPEN and says so", JSON.stringify(noToken));

  const expired = await gateRequest({ token: bc, secret: SECRET, nowMs: NOW + 3601 * 1000 });
  check(expired.allow && !expired.enforced, "an expired attestation fails open rather than refusing");

  // THE APPEAL. Geolocation is wrong often enough that this is the difference
  // between a gate and a wall.
  const appeal = await gateRequest({ token: bc, secret: SECRET, selfDeclared: true, nowMs: NOW });
  check(appeal.allow && appeal.reason === "self_declared" && appeal.region === "BC",
    "a self-declared Albertan is served, and the ORIGINAL region is still recorded so leakage is measurable",
    JSON.stringify(appeal));
}

// ---- expansion is a data change, not a code change ------------------------
check(SERVED_REGIONS.length === 1 && SERVED_REGIONS[0].region === "AB",
  "Alberta is currently the only served region — adding Florida is one row",
  JSON.stringify(SERVED_REGIONS));
check(regionName("CA", "AB") === "Alberta" && regionName("CA", "ZZ") === null,
  "an unknown subdivision has no invented name");

console.log(`\n${fail === 0 ? "✅" : "❌"} region gate: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log("\nFailures:"); for (const l of fails) console.log("  - " + l); }
process.exit(fail > 0 ? 1 : 0);
