// The desk card must never be the first place a claim appears.
// Run: node --experimental-strip-types scripts/test-before-you-sign.mjs
import { beforeYouSign } from "../supabase/functions/_shared/before-you-sign.ts";

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `\n        ${detail}`}`);
  cond ? pass++ : fail++;
};
const all = (r) => r.items.map((i) => `${i.label} ${i.detail}`).join(" | ");

// It prints the count it found, not the count a mockup wanted.
{
  const one = beforeYouSign({ recalls: { checked: true, count: 1 }, vinCheck: { present: true } });
  check("one finding says one, not three", /^1 thing to raise/.test(one.line), one.line);
  const many = beforeYouSign({
    totalFlaggedCost: 2298, recalls: { checked: true, count: 2 },
    financingCheck: { checked: true, consistent: false },
    financeContingent: { contingent: true }, vinCheck: { present: true },
  });
  check("four findings say four", /^4 things to raise/.test(many.line), many.line);
  check("...and every one of them is listed", many.items.filter((i) => i.tone === "raise").length === 4, all(many));
}

// Nothing found is not a pass.
{
  const clean = beforeYouSign({ vehicleCondition: "used", totalFlaggedCost: 0, recalls: { checked: true, count: 0 }, vinCheck: { present: true } });
  check("an empty card never certifies the car",
    /not a guarantee about the car/.test(clean.line), clean.line);
  check("...and does not print a dollar figure", clean.total === null, String(clean.total));
}

// Recalls are a fact, never a price.
{
  const r = beforeYouSign({ recalls: { checked: true, count: 2 }, vinCheck: { present: true } });
  check("an open recall is raised", /2 open recalls/.test(all(r)), all(r));
  const recallItems = r.items.filter((x) => /recall/i.test(x.label + " " + x.detail));
  check("...and is never given a dollar figure",
    r.total === null && recallItems.length > 0 && recallItems.every((x) => !(x.label + " " + x.detail).includes("$")),
    "the remedy is free; a price on a recall would be one we invented. " + JSON.stringify(recallItems));
  const never = beforeYouSign({ recalls: { checked: false, count: 3 }, vinCheck: { present: true } });
  check("recalls we never checked are not raised", !/open recall/.test(all(never)), all(never));
}

// The fee ceiling carries its provenance, exactly as the full report does.
{
  const policy = beforeYouSign({ vinCheck: { present: true }, docFeeCheck: { docFee: 999, mfrCeiling: 999, mfrCeilingAt: true, mfrCeilingOverBy: 0, mfrCeilingMake: "Toyota", mfrCeilingProvenance: "policy" } });
  check("a policy-backed ceiling may be called the brand's published maximum",
    /Toyota's published maximum of \$999/.test(all(policy)), all(policy));
  const single = beforeYouSign({ vinCheck: { present: true }, docFeeCheck: { docFee: 1295, mfrCeiling: 995, mfrCeilingOverBy: 300, mfrCeilingMake: "Lexus", mfrCeilingProvenance: "single-model" } });
  check("a single-model ceiling is never called the brand's maximum",
    !/Lexus's published maximum/.test(all(single)), all(single));
  check("...and still carries the $300 the buyer can act on", /\$300 above/.test(all(single)), all(single));
  const bc = beforeYouSign({ vinCheck: { present: true }, docFeeCheck: { docFee: 995, mfrCeiling: 990, mfrCeilingOverBy: 5, mfrCeilingMake: "Toyota", mfrCeilingProvenance: "policy", mfrCeilingRegion: "BC" } });
  check("a region-specific ceiling names its region", /maximum in BC of \$990/.test(all(bc)), all(bc));
}

// The regulator's own wording, never ours.
{
  const lic = beforeYouSign({ vinCheck: { present: true }, dealerLicence: { status: "Expired - Required to Reapply", state: "expired", legalName: "SOME MOTORS LTD." } });
  check("a licence problem quotes the registry verbatim",
    /"Expired - Required to Reapply"/.test(all(lic)), all(lic));
  check("...and never characterises the dealer",
    !/unlicensed|illegal|not licensed/i.test(all(lic)), all(lic));
  const ok = beforeYouSign({ vinCheck: { present: true }, dealerLicence: { status: "Issued", state: "valid", legalName: "SOME MOTORS LTD." } });
  check("a valid licence is not raised as a problem", !/licence/i.test(all(ok)), all(ok));
}

// A new car with no VIN.
{
  const n = beforeYouSign({ vehicleCondition: "new", vinCheck: { present: false } });
  check("a new car with no VIN is noted", /No VIN published/.test(all(n)), all(n));
  const u = beforeYouSign({ vehicleCondition: "used", vinCheck: { present: false } });
  check("a used car with no VIN is left to the full report's VIN card",
    !/No VIN published/.test(all(u)), all(u));
}

// The words are the counter-script's, unaltered.
{
  const SAY = "Please take the $1,499 protection package off — I don't want it.";
  const r = beforeYouSign({ vinCheck: { present: true }, counterScript: { moves: [{ topic: "Add-ons", say: SAY }] } });
  check("the questions come from the counter-script verbatim", r.questions[0] === SAY, JSON.stringify(r.questions));
  check("no question is invented here",
    beforeYouSign({ vinCheck: { present: true } }).questions.length === 0, "an empty counter-script must yield no questions");
}

console.log(`\n${pass}/${pass + fail} passed${fail ? `  -- ${fail} FAILING` : "  all green"}`);
process.exit(fail ? 1 : 0);
