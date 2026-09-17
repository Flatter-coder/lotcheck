// A SUBTRACTION NEEDS BOTH SIDES ON ONE BASIS -- on EVERY surface that subtracts.
// Run: node --experimental-strip-types scripts/test-msrp-freight-basis.mjs
//
// THE DEFECT. report-bands.js carried a careful paragraph about all-in pricing
// and a sameBasis guard implementing it, in the branch that says "We could not
// pin this listing to an exact manufacturer configuration". The branch that
// prints the HERO number went from msrpBasis === exact straight to qp - ms.
// On the 4Runner shape -- $72,371 advertised all-in in Alberta against the
// $69,207 ex-freight figure we hold -- it published:
//
//     +$3,164 OVER
//
// Toyota prices that vehicle with $1,930 delivery, $100 A/C, $20 tire levy, $10
// AMVIC and up to $999 retailer admin INSIDE the advertised figure. Nearly the
// whole $3,164 is those lines. The dealer had not marked the car up.
//
// The fix had landed in the path that DECLINES to make a claim and not in the
// path that MAKES one. So these cases are written against both surfaces at
// once: every one runs through reportBands() AND qualifyMsrpClaim(), and a rule
// that holds on one but not the other is a failure here.

import { reportBands } from "../supabase/functions/_shared/report-bands.js";
import { qualifyMsrpClaim } from "../supabase/functions/_shared/msrp-claim.ts";
import { referenceBasis } from "../supabase/functions/_shared/msrp-basis.js";
import { buildCounterScript } from "../supabase/functions/_shared/deal.ts";

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `\n        ${detail}`}`);
  cond ? pass++ : fail++;
};

const base = { make: "Toyota", model: "4Runner", trim: "TRD Off-Road", year: 2026,
               vehicleCondition: "new", msrpBasis: "exact", vinCheck: { present: true } };
const band = (a) => reportBands(a).find((x) => x.key === "price_vs_msrp");
const claim = (a) => qualifyMsrpClaim(a);
const DOLLAR = String.fromCharCode(36);

// ---- the defect itself, on both surfaces -------------------------------------
{
  const a = { ...base, quotedPrice: 72371, msrp: 69207, msrpAllIn: null, allInPricing: { body: "AMVIC" } };
  const b = band(a), c = claim(a);
  check("an all-in ask against an ex-freight MSRP makes NO over-claim (hero band)",
    b.state !== "raise" && !/OVER/.test(String(b.value)), `${b.state} ${b.value}`);
  check("...and the hero band never prints the phantom gap",
    !b.note.includes(DOLLAR + "3,164") && !String(b.value).includes("3,164"), `${b.value} | ${b.note}`);
  check("...and msrp-claim refuses it too", c.comparable === false && !!c.refusal, JSON.stringify(c.refusal));
  check("...and the refusal blames our catalogue, not the dealer",
    /gap in our catalogue/.test(b.note) && !/dealer (has|is) (marked|charging)/i.test(b.note), b.note);
}

// ---- what must STILL be said -------------------------------------------------
{
  const over = { ...base, quotedPrice: 74371, msrp: 69207, msrpAllIn: 72285, allInPricing: { body: "AMVIC" } };
  const b = band(over), c = claim(over);
  check("an all-in ask against a CAPTURED all-in MSRP still reports the gap",
    b.state === "raise" && String(b.value).includes("2,086"), `${b.state} ${b.value}`);
  check("...and names the basis it used", /all-in/.test(b.note), b.note);
  check("...and msrp-claim agrees it is comparable", c.comparable === true && c.delta === 2086, JSON.stringify({ comparable: c.comparable, delta: c.delta }));

  const under = { ...base, quotedPrice: 71000, msrp: 69207, msrpAllIn: 72285, allInPricing: { body: "AMVIC" } };
  check("a genuine under-MSRP price is still reported", band(under).state === "clear" && /UNDER/.test(band(under).value), band(under).value);

  const sk = { ...base, quotedPrice: 72371, msrp: 69207, allInPricing: null, msrpPriceBasis: "excl_freight" };
  check("outside an all-in province a stamped ex-freight row still compares",
    band(sk).state === "raise" && claim(sk).comparable === true, `${band(sk).state} ${band(sk).value}`);
}

// ---- the 854 rows with no recorded basis ------------------------------------
{
  const a = { ...base, quotedPrice: 72371, msrp: 69207, allInPricing: null, msrpPriceBasis: null };
  const b = band(a), c = claim(a);
  check("a reference with NO recorded price_basis carries no subtraction",
    b.state !== "raise" && c.comparable === false, `${b.state} ${b.value} | claim ${c.comparable}`);
  check("...and says what is missing, in the buyer's words",
    /includes freight and PDI/.test(b.note), b.note);
  const incl = { ...base, quotedPrice: 72371, msrp: 69207, allInPricing: null, msrpPriceBasis: "incl_freight" };
  check("a freight-inclusive reference carries no subtraction either",
    band(incl).state !== "raise" && claim(incl).comparable === false, band(incl).value);
}

// ---- an absence is never green ----------------------------------------------
{
  const a = { ...base, quotedPrice: 72371, msrp: 69207, msrpAllIn: null, allInPricing: { body: "AMVIC" } };
  check("a refused comparison is NOTED, never CLEAR", band(a).state === "noted", band(a).state);
  check("...and still shows the asking price it read", band(a).note.includes("72,371"), band(a).note);
}

// ---- one decision, not three -------------------------------------------------
{
  // Every case above must be the SAME answer referenceBasis gives. If a surface
  // ever re-derives this, it can drift -- which is exactly how the hero band
  // ended up disagreeing with msrp-claim.ts for a month.
  const cases = [
    { ...base, quotedPrice: 72371, msrp: 69207, msrpAllIn: null, allInPricing: { body: "AMVIC" } },
    { ...base, quotedPrice: 74371, msrp: 69207, msrpAllIn: 72285, allInPricing: { body: "AMVIC" } },
    { ...base, quotedPrice: 72371, msrp: 69207, allInPricing: null, msrpPriceBasis: "excl_freight" },
    { ...base, quotedPrice: 72371, msrp: 69207, allInPricing: null, msrpPriceBasis: null },
    { ...base, quotedPrice: 72371, msrp: 69207, allInPricing: null, msrpPriceBasis: "incl_freight" },
  ];
  const agree = cases.every((a) => referenceBasis(a).comparable === (claim(a).comparable === true)
    && referenceBasis(a).comparable === (band(a).state === "raise" || band(a).state === "clear"));
  check("the hero band, msrp-claim and referenceBasis agree on all five cases", agree,
    JSON.stringify(cases.map((a) => ({ rb: referenceBasis(a).comparable, claim: claim(a).comparable, band: band(a).state }))));
}

// ---- the words the buyer says out loud --------------------------------------
// S14 in deal.ts puts a figure in the buyer's mouth to say to a NAMED licensee.
// It was a raw qp - msrp and checked only msrpBasis, so on the 4Runner shape it
// scripted them to recite roughly $3,000 of mandatory freight and levies as the
// dealer's markup. The worst surface this defect reached.
{
  const say = (a) => {
    const s = buildCounterScript(a);
    const moves = Array.isArray(s) ? s : (s?.moves || []);
    return moves.map((m) => String(m?.say || "")).join(" | ");
  };
  const bad = { ...base, quotedPrice: 72371, msrp: 69207, msrpAllIn: null, allInPricing: { body: "AMVIC" }, priceVerified: true };
  check("the counter-script never recites a cross-basis gap as markup",
    !/over MSRP/i.test(say(bad)), say(bad).slice(0, 220));
  const good = { ...base, quotedPrice: 74371, msrp: 69207, msrpAllIn: 72285, allInPricing: { body: "AMVIC" }, priceVerified: true };
  check("...but still says it when the bases match",
    /over MSRP/i.test(say(good)), say(good).slice(0, 220));
}

console.log(`\n${pass}/${pass + fail} passed${fail ? `  -- ${fail} FAILING` : "  all green"}`);
process.exit(fail ? 1 : 0);
