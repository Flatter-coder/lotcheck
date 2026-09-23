// GATE: "we could not tell" must never render as "not an all-in province".
//
// Whether the dealer's province advertises all-in decides whether freight and
// levies are already INSIDE the asking price. Get it wrong and roughly $3,000
// of mandatory charges is printed as the dealer's markup — and the error only
// ever runs in the direction that accuses them.
//
// THE INCIDENT. A Charlesglen RAV4 PHEV GR SPORT printed "$11,173 over MSRP"
// against a real gap of $8,095: Alberta advertises all-in, the city failed to
// extract, and Toyota's own $3,078 of freight and levies became the markup.
//
// THE FIX LANDED ON ONE PATH. analyze-listing-url got the three-state
// resolution and a positive basisUnknown finding. analyze-quote kept
// resolveAllInAuthority, which returns null for THREE different situations —
// the city did not resolve, the province resolved but does not advertise
// all-in, and we hold no benchmark — and `if (ai)` collapsed all three into an
// absent allInPricing, which qualifyMsrpClaim reads as "not all-in" and
// subtracts against.
//
// Measured on this branch, quote path, city missing:
//   BEFORE  comparable: true,  delta: 3164   -> "$3,164 OVER MSRP"
//   AFTER   comparable: false, basisUnknown  -> names what it could not settle
//
// An absent field is not evidence. That conflation is the whole defect.
//
// Run: node scripts/test-quote-basis-unknown.mjs
import { readFileSync } from "node:fs";
import { applyAllInResolution } from "../supabase/functions/_shared/jurisdiction.ts";
import { qualifyMsrpClaim } from "../supabase/functions/_shared/msrp-claim.ts";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`ok    ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "\n       " + detail : ""}`); }
};

// THE PRODUCTION FUNCTION ITSELF, not a copy of it.
//
// The first version of this gate re-implemented the resolution block inline,
// so a mutation to the real code (turning its else branch unreachable) left
// every behavioural assertion green — the suite was testing its own replica.
// That is the same defect as test:catalog-quality, in the gate written to
// stop a one-surface fix.
const resolve = (a) => applyAllInResolution(a);

// The Charlesglen shape: exact trim, ex-freight catalogue row, no all_in_price.
const QUOTE = { msrpBasis: "exact", quotedPrice: 72371, msrp: 69207, msrpPriceBasis: "excl_freight", make: "Toyota" };

// ---- the three states must be three states ------------------------------
{
  const unknown = resolve({ ...QUOTE, dealerCity: null });
  check("an unresolvable city sets basisUnknown", unknown.basisUnknown === true);
  check("...and does NOT claim the province is non-all-in",
    unknown.allInPricing == null && unknown.basisUnknown === true,
    "absent allInPricing alone is the ambiguity this gate exists to remove");

  const ab = resolve({ ...QUOTE, dealerCity: "Calgary, AB" });
  check("an all-in province resolves to allInPricing", !!ab.allInPricing && ab.allInPricing.code === "AB");
  check("...and never sets basisUnknown", ab.basisUnknown === undefined);
  check("...and names the regulator", ab.allInPricing.body === "AMVIC");

  const on = resolve({ ...QUOTE, dealerCity: "Toronto, ON" });
  check("Ontario also resolves as all-in", !!on.allInPricing && on.allInPricing.code === "ON");
}

// ---- and the CLAIM must follow from them --------------------------------
{
  const unknown = qualifyMsrpClaim(resolve({ ...QUOTE, dealerCity: null }));
  check("an unknown province refuses the over/under claim", unknown.comparable === false);
  check("...with no delta at all", unknown.delta === null, String(unknown.delta));
  check("...and says what it could not settle",
    /could not establish which province/i.test(unknown.refusal || ""), (unknown.refusal || "").slice(0, 100));

  const ab = qualifyMsrpClaim(resolve({ ...QUOTE, dealerCity: "Calgary, AB" }));
  check("Alberta with no captured all_in_price also refuses", ab.comparable === false);
  check("...for the ALL-IN reason, not the unknown-province one",
    /all-in/i.test(ab.refusal || "") && !/could not establish which province/i.test(ab.refusal || ""),
    (ab.refusal || "").slice(0, 100));
}

// ---- the figure a dealer would have been accused of ---------------------
// Pinned so the cost of a regression is legible, not abstract.
{
  const wouldHaveBeen = 72371 - 69207;
  check("the pre-fix subtraction was $3,164 on a car with no markup", wouldHaveBeen === 3164);
  const now = qualifyMsrpClaim(resolve({ ...QUOTE, dealerCity: null }));
  check("that figure is no longer produced", now.delta !== wouldHaveBeen);
}

// ---- comparison must still work where it is honest ----------------------
// A refusal everywhere would be a different failure, not a fix.
{
  // A Manitoba postal code resolves confidently to a NON-all-in province, so
  // the ex-freight basis on both sides is honest and the subtraction stands.
  //
  // Note: "Winnipeg, MB" as a dealerCity does NOT resolve — resolveJurisdiction
  // reads area codes, city names, full province names and postal letters, but
  // not a bare two-letter code sitting in the field. That costs claims rather
  // than inventing them (unknown now refuses), so it is recorded here and not
  // fixed in this change.
  const outsideAllIn = qualifyMsrpClaim(resolve({ ...QUOTE, dealerAddress: "123 Main St, Winnipeg R3C 4A5" }));
  check("a non-all-in province with a recorded ex-freight basis still compares",
    outsideAllIn.comparable === true && outsideAllIn.delta === 3164,
    `comparable=${outsideAllIn.comparable} delta=${outsideAllIn.delta}`);
}

// ---- the quote path must actually run this block ------------------------
// A three-state resolver nobody calls is the built-but-unwired shape.
{
  const src = readFileSync(new URL("../supabase/functions/analyze-quote/index.ts", import.meta.url), "utf8");
  check("analyze-quote calls the shared resolver", src.includes("applyAllInResolution(analysis)"));
  check("the two-state  collapse is gone from the quote path",
    !/const ai = resolveAllInAuthority([^)]*);s*if (ai)/.test(src),
    "that one line is the whole defect");

  // ONE COPY, NOT TWO THAT AGREE TODAY. The rule lived as a block in both
  // callers and they diverged: the listing path carried the three-state fix,
  // the quote path did not. Asserting that both contain the same TEXT would
  // just be the old arrangement with a gate on top.
  const listing = readFileSync(new URL("../supabase/functions/analyze-listing-url/index.ts", import.meta.url), "utf8");
  check("the listing path calls the SAME shared resolver",
    listing.includes("applyAllInResolution(analysis)"));
  check("neither caller keeps its own copy of the three-state logic",
    !/analysis.basisUnknown = true/.test(src) && !/analysis.basisUnknown = true/.test(listing),
    "a second copy is how these two drifted in the first place");

  const shared = readFileSync(new URL("../supabase/functions/_shared/jurisdiction.ts", import.meta.url), "utf8");
  check("the shared resolver is the only place that sets basisUnknown",
    /a.basisUnknown = true/.test(shared));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
