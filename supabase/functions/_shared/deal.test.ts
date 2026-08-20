// Regression harness for _shared/deal.ts, and specifically for the dealer-APR
// trust gate (trustedDealerApr / TRUSTED_APR_SOURCES).
//
// THE INCIDENT (2026-08-19, easytermauto.ca, a 2024 Ford Bronco Sport). The
// live page discloses NO financing rate anywhere -- confirmed by fetching it
// directly and by running the deterministic extractAdvertisedApr() text
// scanner against the real HTML, which returned null. Yet the shipped report:
//   - showed "25% · HIGH" as the dealer's rate on the canonical report badge
//   - claimed "20.01% above Ford's advertised 4.99% — about $23,275 more
//     over 60 months. Ask them to match it."
//   - told the buyer to literally say to the dealer: "I see a 4.99% promo
//     rate advertised — I'd want that, not 25%."
// The 25% traced back to analysis.financing.rate with NO evidence -- not the
// SM360 feed, not the Convertus VMS blob, not the deterministic page-text
// regex (apr-extract.js), which only accepts a number sitting within ~70
// characters of real financing vocabulary. It could only have been the LLM's
// own unconfirmed read of the page, despite the extraction prompt's explicit
// "never guess or invent a number" instruction -- prompts are not a
// structural guarantee. Nothing downstream checked before turning that number
// into a named, quantified accusation against a real business.
//
// THE FIX. financeRates.dealer now carries a `source` alongside `apr`:
// sm360_feed / convertus_vms / page_text are evidenced (real data the dealer
// or platform published); "llm" or no source at all is not. Only an
// evidenced source may power buildCounterScript's "Rate" move or
// computeFinancingTrap's dollar-savings estimate -- an unevidenced rate is
// treated exactly as if the dealer disclosed nothing, same principle as
// dealer-vs-manufacturer MSRP claims (msrp-claim.ts) and the same "missing
// beats wrong" standard applied everywhere else in this codebase.
//
// Pure and offline -- no network, no clock, no database.
//
// Run (Node 24+, from repo root):
//   node --experimental-strip-types supabase/functions/_shared/deal.test.ts
import { buildCounterScript, computeFinancingTrap } from "./deal.ts";

let pass = 0, fail = 0;
const fails: string[] = [];
function record(ok: boolean, label: string, detail = "") {
  if (ok) pass++;
  else { fail++; fails.push(`${label}${detail ? ` — ${detail}` : ""}`); }
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        ${detail}`}`);
}

const BASE = {
  make: "Ford",
  quotedPrice: 36999,
  financeRates: { manufacturer: { apr: 4.99 } },
};

// ---- buildCounterScript: the "Rate" move ----------------------------------
{
  const a = { ...BASE, financeRates: { ...BASE.financeRates, dealer: { apr: 25, source: "llm" } }, financing: { rate: 25 } };
  const cs = buildCounterScript(a);
  const rateMove = cs.moves.find((m) => m.topic === "Rate");
  record(rateMove === undefined, "llm-only 25% APR generates NO counter-script 'Rate' move",
    JSON.stringify(rateMove));
}
{
  // The pre-2026-08-19 shape: financeRates.dealer.apr with no source field
  // at all (a stale cached report, or any code path that forgets to tag it).
  const a = { ...BASE, financeRates: { ...BASE.financeRates, dealer: { apr: 25 } } };
  const cs = buildCounterScript(a);
  const rateMove = cs.moves.find((m) => m.topic === "Rate");
  record(rateMove === undefined, "a dealer.apr with NO source tag at all is treated as untrusted, not trusted by default",
    JSON.stringify(rateMove));
}
{
  const a = { ...BASE, financeRates: { ...BASE.financeRates, dealer: { apr: 6.99, source: "sm360_feed" } } };
  const cs = buildCounterScript(a);
  const rateMove = cs.moves.find((m) => m.topic === "Rate");
  record(!!rateMove && rateMove.say.includes("6.99%") && rateMove.say.includes("4.99%"),
    "an sm360_feed-evidenced dealer APR above the promo rate DOES generate the Rate move",
    JSON.stringify(rateMove));
}
{
  const a = { ...BASE, financeRates: { ...BASE.financeRates, dealer: { apr: 6.5, source: "convertus_vms" } } };
  const cs = buildCounterScript(a);
  record(!!cs.moves.find((m) => m.topic === "Rate"), "convertus_vms is also evidenced");
}
{
  const a = { ...BASE, financeRates: { ...BASE.financeRates, dealer: { apr: 5.5, source: "page_text" } } };
  const cs = buildCounterScript(a);
  record(!!cs.moves.find((m) => m.topic === "Rate"), "page_text (the deterministic regex backstop) is also evidenced");
}
{
  // A trusted rate that ISN'T actually above the promo rate must not fire.
  const a = { ...BASE, financeRates: { ...BASE.financeRates, dealer: { apr: 4.99, source: "sm360_feed" } } };
  const cs = buildCounterScript(a);
  record(!cs.moves.find((m) => m.topic === "Rate"), "a trusted rate at/below the promo rate does not fire the Rate move");
}

// ---- buildCounterScript: the "Warranty" move ------------------------------
// 2026-08-20 incident: a 2022 RAV4 at 106,000 km got the generic "I'll pass
// on the extended warranty -- the factory coverage is plenty for now" line
// even though Toyota's real basic (3yr/60,000km) and powertrain (5yr/
// 100,000km) coverage would both already be expired on this exact car --
// false reassurance aimed at the buyer who might most want the extended plan.
{
  const a = { ...BASE, warranty: { offered: true }, standardWarranty: { coverage: "5-year/100,000km" },
    remainingWarranty: { basic: { active: false }, powertrain: { active: false } } };
  const cs = buildCounterScript(a);
  const move = cs.moves.find((m) => m.topic === "Warranty");
  record(!!move && /already run out/.test(move.say) && !/plenty for now/.test(move.say),
    "factory coverage confirmed EXPIRED (both basic and powertrain inactive) does not say 'plenty for now'",
    JSON.stringify(move));
}
{
  const a = { ...BASE, warranty: { offered: true }, standardWarranty: { coverage: "5-year/100,000km" },
    remainingWarranty: { basic: { active: false }, powertrain: { active: true } } };
  const cs = buildCounterScript(a);
  const move = cs.moves.find((m) => m.topic === "Warranty");
  record(!!move && /plenty for now/.test(move.say),
    "powertrain coverage STILL active (even with basic expired) keeps the original 'pass on it' framing",
    JSON.stringify(move));
}
{
  // No remainingWarranty at all (unknown make, no odometer, etc.) -- must not
  // assert expiry it can't back, keeps the original framing.
  const a = { ...BASE, warranty: { offered: true }, standardWarranty: { coverage: "5-year/100,000km" } };
  const cs = buildCounterScript(a);
  const move = cs.moves.find((m) => m.topic === "Warranty");
  record(!!move && /plenty for now/.test(move.say),
    "unknown remaining-warranty status falls back to the original framing rather than guessing expired");
}

// ---- computeFinancingTrap: the dollar-savings / "trap" estimate -----------
{
  const a = {
    ...BASE,
    msrp: 36999, msrpBasis: "exact",
    financeRates: { ...BASE.financeRates, dealer: { apr: 25, source: "llm" } },
    financing: { rate: 25, termMonths: 60 },
    reconciliation: { discountsTotal: 1000, addonsTotal: 0 },
  };
  const trap = computeFinancingTrap(a);
  record(trap != null && trap.dealerApr === null,
    "an llm-only rate never reaches computeFinancingTrap's dealerApr -- no fabricated dollar figure",
    JSON.stringify(trap));
  record(trap != null && trap.mode === "awareness",
    "with no trusted dealer rate, the trap falls back to 'awareness' mode (a question, not a quantified accusation)",
    JSON.stringify(trap));
}
{
  const a = {
    ...BASE,
    msrp: 36999, msrpBasis: "exact",
    financeRates: { ...BASE.financeRates, dealer: { apr: 9.99, source: "sm360_feed" } },
    financing: { rate: 9.99, termMonths: 60 },
    reconciliation: { discountsTotal: 1000, addonsTotal: 0 },
  };
  const trap = computeFinancingTrap(a);
  record(trap != null && trap.mode === "quantified" && trap.dealerApr === 9.99 && trap.extraInterest! > 0,
    "an sm360_feed-evidenced rate above the promo rate DOES quantify the trade-off",
    JSON.stringify(trap));
}

if (fail) { console.error(`\n${fail} failure(s):\n` + fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
console.log(`\n✅ deal.ts (dealer-APR trust gate): ${pass} passed, 0 failed`);
