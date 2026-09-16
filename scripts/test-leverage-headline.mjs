// The report's headline must be something a buyer can act on.
//
// Run: node --experimental-strip-types scripts/test-leverage-headline.mjs
import { leverageHeadline } from "../supabase/functions/_shared/leverage.ts";

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `\n        ${detail}`}`);
  cond ? pass++ : fail++;
};

// The report that prompted this: a 2026 Lexus NX 350 F SPORT 3 at $72,010 with
// nothing flagged. The old gauge read "2.7 / 10" in 38pt type.
{
  const h = leverageHeadline({ make: "Lexus", totalFlaggedCost: 0, recalls: { checked: true, count: 0 } });
  check("a report with nothing to name does not invent a number", h.total === null, JSON.stringify(h));
  check("...and says what was found rather than scoring it", h.state === "clean", h.state);
  check("...without claiming the car is fine", /not a guarantee about the car/.test(h.line), h.line);
  check("...and never prints a score out of ten", !/\bout of ten\b|\/10\b/i.test(h.line), h.line);
}

// Money the report can actually name.
{
  const h = leverageHeadline({ make: "Toyota", totalFlaggedCost: 2298, recalls: { checked: true, count: 1 } });
  check("flagged fees are the headline, in dollars", h.total === 2298, JSON.stringify(h));
  check("...labelled with what the money IS", /fees and add-ons this report flagged/.test(h.line), h.line);
  check("a recall rides as a FACT, never as a dollar figure",
    h.facts.some((f) => /recall/.test(f)) && h.dollars.every((d) => !/recall/i.test(d.label)),
    JSON.stringify(h));
}

// The ceiling claim: the one price finding with no "missing higher trim" out.
{
  const h = leverageHeadline({
    make: "Toyota", totalFlaggedCost: 0,
    ceilingClaim: { exceeds: true, over: 23581, ceiling: 62414, trim: "GR SPORT", trimsConsidered: 4 },
  });
  check("being priced above the whole lineup is named in dollars", h.total === 23581, JSON.stringify(h));
  check("...and the top of the ladder is shown, so the gap is checkable",
    h.dollars[0].detail.includes("$62,414"), JSON.stringify(h.dollars));
}

// Two dollar findings add up, and the sum is the sum.
{
  const h = leverageHeadline({
    make: "Toyota", totalFlaggedCost: 1500,
    ceilingClaim: { exceeds: true, over: 2500, ceiling: 60000, trimsConsidered: 3 },
  });
  check("multiple findings sum to the headline", h.total === 4000, JSON.stringify(h));
  check("...and each stays itemised, so the total is never a black box", h.dollars.length === 2, JSON.stringify(h.dollars));
}

// Facts without money.
{
  const h = leverageHeadline({ make: "Kia", totalFlaggedCost: 0, daysOnLot: { days: 97 }, recalls: { checked: true, count: 0 } });
  check("a fact with no price does not become a price", h.total === null && h.state === "noted", JSON.stringify(h));
  check("...and is still put in front of the buyer", /97 days on the lot/.test(h.line), h.line);
}

// FAIL-SAFE: a ceiling claim that does not exceed must contribute nothing.
{
  const h = leverageHeadline({ make: "Toyota", totalFlaggedCost: 0, ceilingClaim: { exceeds: false, over: null, ceiling: 62414, trimsConsidered: 4 } });
  check("a ceiling that is NOT exceeded adds no dollars", h.total === null, JSON.stringify(h));
}
// An unchecked recall count is not zero recalls.
{
  const h = leverageHeadline({ make: "Toyota", totalFlaggedCost: 0, recalls: { checked: false, count: 3 } });
  check("recalls we never checked are not reported as found", h.facts.length === 0, JSON.stringify(h.facts));
}

console.log(`\n${pass}/${pass + fail} passed${fail ? `  -- ${fail} FAILING` : "  all green"}`);
process.exit(fail ? 1 : 0);
