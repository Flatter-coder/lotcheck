// Regression harness for per-checkpoint outcomes.
//
// The rule this file exists to defend: `not_applicable` is the ONLY outcome
// excluded from the failure rate, so it is the only lever that could turn the
// verification ledger back into decoration. Every N/A must rest on a POSITIVE
// fact about the vehicle. An absent value is `not_attempted`, and that is RED.
//
// The reports that prompted this all looked "successful": an IONIQ 9 with a
// wrong MSRP, a Kia with no MSRP at all, four scans showing two green while
// missing most of what the buyer paid for. If a case here starts passing that
// should not, a hollow report is being counted as a complete one again.
//
// Pure and offline -- no network, no clock, no database.
//
// Run (Node 24+, from repo root):
//   node --experimental-strip-types supabase/functions/_shared/verification-checkpoints.test.ts
import { deriveCheckpoints, CHECKPOINTS, GREEN, RED } from "./verification-checkpoints.ts";
import type { Outcome, Checkpoint } from "./verification-checkpoints.ts";

let pass = 0, fail = 0;
const fails: string[] = [];
function record(ok: boolean, label: string, detail = "") {
  if (ok) pass++;
  else { fail++; fails.push(`${label}${detail ? ` — ${detail}` : ""}`); }
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        ${detail}`}`);
}
const get = (a: any, feature: "quote" | "listing_url", cp: Checkpoint) =>
  deriveCheckpoints(a, feature).find((r) => r.checkpoint === cp)!;
function expect(a: any, feature: "quote" | "listing_url", cp: Checkpoint, want: Outcome, label: string) {
  const got = get(a, feature, cp);
  record(got.outcome === want, label, `${cp} → ${got.outcome} (wanted ${want}); detail: ${got.detail}`);
}

// ---- shape ----------------------------------------------------------------
{
  const rows = deriveCheckpoints({}, "listing_url");
  record(rows.length === 13, "all 13 checkpoints are emitted", `got ${rows.length}`);
  record(new Set(rows.map((r) => r.checkpoint)).size === 13, "no checkpoint is emitted twice");
  record(CHECKPOINTS.every((c) => rows.some((r) => r.checkpoint === c)),
    "every declared checkpoint is covered",
    `missing: ${CHECKPOINTS.filter((c) => !rows.some((r) => r.checkpoint === c)).join(",")}`);
  record(rows.every((r) => GREEN.has(r.outcome) || RED.has(r.outcome) || r.outcome === "not_applicable"),
    "every outcome is classifiable as green, red or n/a");
}

// ---- THE CORE RULE: an empty analysis must be almost entirely RED ----------
// This is the single most important case in the file. A report that resolved
// nothing must not be able to present as anything but a failure.
{
  const rows = deriveCheckpoints({}, "listing_url");
  const green = rows.filter((r) => GREEN.has(r.outcome));
  const na = rows.filter((r) => r.outcome === "not_applicable");
  record(green.length === 0, "an empty analysis produces ZERO green checkpoints",
    `green: ${green.map((r) => r.checkpoint).join(",")}`);
  record(na.length === 0, "an empty analysis produces ZERO not-applicable checkpoints",
    `n/a: ${na.map((r) => `${r.checkpoint}(${r.detail})`).join(", ")} — N/A must come from a positive fact, never from absence`);
}

// ---- MSRP: the checkpoint that exposes the catalog ------------------------
const newRav4 = { year: 2026, make: "Toyota", model: "RAV4", vehicleCondition: "new" };
expect({ ...newRav4, msrp: 42000, msrpSource: "catalog", msrpBasis: "exact" }, "listing_url", "msrp", "verified",
  "MSRP found in the catalog is verified");
expect(newRav4, "listing_url", "msrp", "error",
  "a NEW vehicle with no MSRP is an ERROR — this is the catalog gap, not an excuse");
expect({ make: "Toyota" }, "listing_url", "msrp", "not_attempted",
  "MSRP with incomplete year/make/model is not_attempted, not error");
expect({ year: 2019, make: "Honda", model: "Civic", vehicleCondition: "used",
         msrpUnavailable: { reason: "used_original_msrp_not_held" } }, "listing_url", "msrp", "not_applicable",
  "a USED vehicle whose original MSRP we do not hold is a real N/A");
// The trap: N/A must not leak to new cars just because the reason string is set.
expect({ ...newRav4, msrpUnavailable: { reason: "used_original_msrp_not_held" } }, "listing_url", "msrp", "error",
  "a NEW vehicle can NEVER take the used-car N/A path");

// ---- Recalls: a zero is only a clean bill if the model was confirmed ------
expect({ recalls: { checked: true, confirmed: true, count: 2 } }, "listing_url", "recalls", "verified",
  "open recalls found is verified");
expect({ recalls: { checked: true, confirmed: true, count: 0, matchedModel: "RAV4" } }, "listing_url", "recalls", "checked_no_match",
  "zero recalls WITH a confirmed model match is green — we proved TC knows the model");
expect({ recalls: { checked: true, confirmed: false, count: 0, queriedModel: "RAV-4" } }, "listing_url", "recalls", "error",
  "zero recalls with an UNCONFIRMED model is RED — indistinguishable from a typo, never a clean bill");
expect({ recalls: { checked: false, error: "registry unreachable" } }, "listing_url", "recalls", "error",
  "an unreachable recall registry is an error");
expect({}, "listing_url", "recalls", "not_attempted", "no recall object at all is not_attempted");

// ---- EV rebate: N/A only from a KNOWN fuel type ---------------------------
expect({ fuelType: "BEV" }, "listing_url", "ev_rebate", "verified", "a BEV resolves the EV-rebate checkpoint");
expect({ fuelType: "PHEV" }, "quote", "ev_rebate", "verified", "a PHEV resolves it too");
expect({ fuelType: "Gas" }, "listing_url", "ev_rebate", "not_applicable", "a gas car genuinely has no EV rebate — a real N/A");
expect({ fuelType: "gas" }, "quote", "ev_rebate", "not_applicable", "fuel type casing differs between functions and must not change the verdict");
expect({ fuelType: "Hybrid" }, "listing_url", "ev_rebate", "not_applicable", "a plain hybrid has no federal EV rebate");
expect({}, "listing_url", "ev_rebate", "not_attempted",
  "an UNKNOWN fuel type is RED, never N/A — we cannot say either way, and that is a miss");
expect({ fuelType: "" }, "listing_url", "ev_rebate", "not_attempted", "an empty fuel type is not a known fuel type");

// ---- Odometer -------------------------------------------------------------
expect({ odometerCheck: { checked: true }, odometerKm: 84000 }, "listing_url", "odometer", "verified", "a checked odometer is verified");
expect({ vehicleCondition: "new" }, "listing_url", "odometer", "not_applicable", "a NEW vehicle has no odometer history — a real N/A");
expect({ vehicleCondition: "used" }, "listing_url", "odometer", "not_attempted", "a USED vehicle with no odometer read is RED");
expect({}, "listing_url", "odometer", "not_attempted", "unknown condition does not earn the new-vehicle N/A");

// ---- VIN ------------------------------------------------------------------
expect({ vinCheck: { present: true, valid: true }, vin: "5YFB4MDE8SP123456" }, "listing_url", "vin", "verified", "a valid VIN is verified");
expect({ vinCheck: { present: true, valid: false, reason: "bad check digit" } }, "listing_url", "vin", "error", "a malformed VIN is an error");
expect({ vinCheck: { present: false } }, "listing_url", "vin", "not_attempted",
  "a dealer publishing no VIN still counts as a miss for us — that is what drives recovery from the page payload");

// ---- Fee audit: an empty list only counts if we read the priced block -----
expect({ addOns: [{ name: "doc fee" }] }, "listing_url", "fees", "verified", "itemised add-ons are verified");
expect({ addOns: [], docFeeCheck: { kind: "over_cap" } }, "listing_url", "fees", "verified", "a doc-fee assessment resolves the fee audit");
expect({ addOns: [], quotedPrice: 41999 }, "listing_url", "fees", "checked_no_match",
  "an empty fee list IS green when we got a price out of the same block");
expect({ addOns: [] }, "listing_url", "fees", "not_attempted",
  "an empty fee list with NO price proves nothing — this is the false all-clear we are killing");
expect({}, "listing_url", "fees", "not_attempted", "no add-on list at all is not_attempted");

// ---- Financing + APR ------------------------------------------------------
expect({ financing: { rate: 5.99 }, financingCheck: { checked: true, consistent: true } }, "listing_url", "financing", "verified",
  "reconciled financing math is verified");
expect({ financingCheck: { checked: true, consistent: false } }, "listing_url", "financing", "verified",
  "financing that does NOT reconcile still RESOLVED the check — finding the discrepancy is the point");
expect({ quotedPrice: 41999 }, "listing_url", "financing", "not_applicable",
  "a PRICED listing that discloses no financing has no arithmetic to check");
expect({}, "listing_url", "financing", "not_attempted",
  "no financing AND no price means we read nothing — absence must not buy an N/A");
expect({ financing: { paymentAmount: 200 } }, "listing_url", "financing", "not_attempted",
  "financing disclosed but too incomplete to reconcile is RED");
expect({ financeRates: { dealer: { apr: 6.99 } } }, "listing_url", "apr", "verified", "an advertised dealer APR resolves it");
expect({ financeRates: { dealer: null, manufacturer: { apr: 3.99 } } }, "listing_url", "apr", "verified",
  "the manufacturer promo rate as a labelled reference also resolves it");
expect({ financeRates: { dealer: null, manufacturer: null } }, "listing_url", "apr", "not_attempted", "no rate on either side is RED");

// ---- Leverage: a score with nothing behind it is not a pass ---------------
expect({ leverageScore: { computed: true, score: 7.5, basis: ["msrp", "days_on_lot"] } }, "listing_url", "leverage", "verified",
  "a leverage score built on real inputs is verified");
expect({ leverageScore: { computed: true, score: 2.0, basis: [] } }, "listing_url", "leverage", "not_attempted",
  "a leverage score computed from NO verified inputs is RED — the score is always emitted, so its presence proves nothing");

// ---- Days on lot: N/A for uploads, RED for URLs ---------------------------
expect({}, "quote", "days_on_lot", "not_applicable", "an uploaded PDF has no live listing to age — a real N/A");
expect({ daysOnLot: { days: 91, source: "dealer_platform_feed" } }, "listing_url", "days_on_lot", "verified",
  "days on lot read from the platform is verified");
expect({}, "listing_url", "days_on_lot", "not_attempted",
  "'this platform does not expose it' is RED, not N/A — it is the argument for our own first-seen tracker");

// ---- AMVIC ----------------------------------------------------------------
expect({ dealerLicence: { state: "licensed", licenceNumber: "12345" } }, "listing_url", "amvic", "verified", "a matched AMVIC licence is verified");
expect({ dealerName: "Capital Chevrolet" }, "listing_url", "amvic", "not_attempted", "no confident AMVIC match is RED");
expect({ dealerName: "Capital Chevrolet" }, "quote", "amvic", "not_attempted",
  "the upload path does not run AMVIC at all — that reads as a miss, not N/A, because every feature is meant to ship to every surface");

// ---- Warranty -------------------------------------------------------------
expect({ standardWarranty: { verified: true, coverage: "3yr/60,000km" } }, "listing_url", "warranty", "verified", "a verified warranty is green");
expect({ remainingWarranty: { make: "Honda" } }, "listing_url", "warranty", "verified", "computed remaining coverage on a used car is green");
expect({ standardWarranty: { verified: false }, make: "Rivian" }, "listing_url", "warranty", "error", "a make with no warranty on file is an error");
expect({}, "listing_url", "warranty", "not_attempted", "no warranty resolved at all is not_attempted");

// ---- Reputation -----------------------------------------------------------
expect({ dealerName: "South Trail Kia" }, "listing_url", "reputation", "not_attempted",
  "reputation is not resolved by the analyze function — get-dealer-sentiment has the last word");

// ---- A GOOD report: the shape we are aiming at ---------------------------
// Every checkpoint green or provably N/A. If this ever fails, the bar moved.
{
  const good = {
    year: 2026, make: "Toyota", model: "RAV4", vehicleCondition: "new",
    msrp: 42000, msrpSource: "catalog", msrpBasis: "exact",
    odometerCheck: undefined,
    recalls: { checked: true, confirmed: true, count: 0, matchedModel: "RAV4" },
    addOns: [{ name: "doc fee", amount: 799 }],
    fuelType: "Hybrid",
    vin: "5YFB4MDE8SP123456", vinCheck: { present: true, valid: true },
    standardWarranty: { verified: true, coverage: "3yr/60,000km" },
    financing: { rate: 6.99 }, financingCheck: { checked: true, consistent: true },
    financeRates: { dealer: { apr: 6.99 }, manufacturer: { apr: 3.99 } },
    leverageScore: { computed: true, score: 6.5, basis: ["msrp", "days_on_lot"] },
    daysOnLot: { days: 91, source: "dealer_platform_feed" },
    dealerName: "Country Hills Toyota", dealerLicence: { state: "licensed", licenceNumber: "12345" },
  };
  const rows = deriveCheckpoints(good, "listing_url");
  const red = rows.filter((r) => RED.has(r.outcome) && r.checkpoint !== "reputation");
  record(red.length === 0, "a COMPLETE report has no red checkpoints (reputation aside — it is written elsewhere)",
    `red: ${red.map((r) => `${r.checkpoint}=${r.outcome} (${r.detail})`).join("; ")}`);
}

// ---- detail is always present on a red row -------------------------------
// A red row without a reason cannot be worked on, and ranking by failure rate
// is only useful if each failure names what to fix.
{
  const rows = [...deriveCheckpoints({}, "listing_url"), ...deriveCheckpoints({}, "quote")];
  const silent = rows.filter((r) => RED.has(r.outcome) && !r.detail);
  record(silent.length === 0, "every RED checkpoint explains itself",
    `silent: ${silent.map((r) => r.checkpoint).join(",")}`);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} verification checkpoints: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log("\nFailures:"); for (const l of fails) console.log("  - " + l); }
const code = fail > 0 ? 1 : 0;
// @ts-ignore - runtime-dependent globals
(globalThis.Deno?.exit ?? globalThis.process?.exit)?.(code);
