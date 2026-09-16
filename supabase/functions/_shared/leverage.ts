// WHAT THE REPORT FOUND, IN DOLLARS -- because "2.7 / 10" is not a finding.
//
// WHAT THE BUYER RECEIVED, on a 2026 Lexus NX 350 F SPORT 3 advertised at
// $72,010 in Edmonton: a gauge reading
//
//     2.7 /10
//     NEGOTIATION LEVERAGE
//     Higher = more room to negotiate
//
// as the largest element on the page, beside the verdict. A buyer cannot act
// on 2.7. They cannot check it, quote it to a dealer, or tell whether 2.7 is
// good news. And 2.7 is not a measurement of anything in the world -- it is a
// weighted roll-up of findings that were each, individually, worth stating.
//
// [[design-must-be-self-explanatory]] is a HARD RULE: no abstract scores, real
// dollars and their basis. The score has been breaking it since it shipped,
// in the most prominent position the report has.
//
// THE FINDINGS WERE ALWAYS THERE. computeLeverageScore already builds a
// `basis` array of evidenced statements and then throws away their structure
// to produce a number. This keeps the structure: every component that carries
// a dollar figure is returned as a dollar figure, and everything else is
// returned as a fact in words.
//
// THE SCORE IS NOT DELETED. It stays in the signed canonical and on the API,
// because reports already issued carry it and /verify must still read them.
// It simply stops being the headline.
//
// ONE AUTHOR. computeLeverageScore exists TWICE -- once in analyze-listing-url
// and once in analyze-quote -- and the two have already drifted: the listing
// copy consults qualifyCeilingClaim and the MSRP gap, the quote copy does not.
// This module is the single author of the headline, so both surfaces say the
// same thing about the same car. [[two-authors-per-fact]]

import { qualifyCeilingClaim } from "./msrp-claim.ts";

export type LeverageItem = { label: string; amount: number | null; detail?: string };

export type LeverageHeadline = {
  /** Money the report can name, each with what it is. */
  dollars: LeverageItem[];
  /** Sum of `dollars`, or null when there are none. NEVER an estimate. */
  total: number | null;
  /** Findings that are real but carry no dollar figure. */
  facts: string[];
  /**
   * "named"   -- we can put a number on what we found.
   * "noted"   -- we found something worth saying, but no dollar figure.
   * "clean"   -- the checks ran and turned up nothing to flag.
   *
   * There is deliberately no "green"/"pass": this says what the REPORT found,
   * and a report that found nothing is not a certificate that nothing exists.
   */
  state: "named" | "noted" | "clean";
  /** One sentence, already written, safe to render as-is. */
  line: string;
};

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const money = (n: number): string =>
  "$" + Math.round(n).toLocaleString("en-CA");

/**
 * Pure. Reads the finished analysis and returns what the report can actually
 * put a number on. Never estimates, never rolls up into a score.
 */
export function leverageHeadline(a: any): LeverageHeadline {
  const dollars: LeverageItem[] = [];
  const facts: string[] = [];

  // Flagged fees and add-ons -- the report's own verdicts, already itemised.
  const flagged = num(a?.totalFlaggedCost);
  if (flagged > 0) {
    dollars.push({ label: "in fees and add-ons this report flagged", amount: flagged });
  }

  // Priced above the top of the lineup. This is the claim with no "missing
  // higher trim" escape hatch, so it may carry a number.
  // Asked HERE rather than read off a field, so this module does not depend
  // on whichever caller happened to attach it. qualifyCeilingClaim is the one
  // author of that question and it is pure; a caller that already holds the
  // answer may pass it in to save the work.
  let cc: any = a?.ceilingClaim;
  if (!cc) { try { cc = qualifyCeilingClaim(a); } catch { cc = null; } }
  const over = num(cc?.over);
  const ceiling = num(cc?.ceiling);
  if (cc?.exceeds && over > 0 && ceiling > 0) {
    dollars.push({
      label: `above the most expensive ${String(a?.make || "").trim() || "trim"} in our catalogue`,
      amount: over,
      detail: `the top of the ladder is ${money(ceiling)} all-in${cc?.trim ? ` (${cc.trim})` : ""}`,
    });
  }

  // Open recalls: a fact, never a dollar figure. Putting a price on a recall
  // would be inventing one -- the remedy is free.
  const rc = a?.recalls;
  if (rc?.checked && num(rc.count) > 0) {
    const n = num(rc.count);
    facts.push(`${n} open Transport Canada recall${n > 1 ? "s" : ""}`);
  }

  // Financing that does not reconcile. Real, and deliberately not priced: the
  // size of the discrepancy depends on terms the listing did not disclose.
  if (a?.financingCheck?.checked && a.financingCheck.consistent === false) {
    facts.push("financing numbers on the listing that do not reconcile");
  }

  // Days on lot -- a fact about the seller, not about the car's price.
  const dol = num(a?.daysOnLot?.days);
  if (dol >= 30) facts.push(`${dol} days on the lot`);

  const total = dollars.length ? Math.round(dollars.reduce((s, d) => s + num(d.amount), 0)) : null;
  const state: LeverageHeadline["state"] = total != null ? "named" : facts.length ? "noted" : "clean";

  let line: string;
  if (state === "named") {
    line = `${money(total as number)} ${dollars.map((d) => d.label).join(", and ")}.`;
    if (facts.length) line += ` Also: ${facts.join("; ")}.`;
  } else if (state === "noted") {
    line = `No fees were flagged and no pricing gap could be evidenced. Worth raising anyway: ${facts.join("; ")}.`;
  } else {
    // NOT a pass. It says what was checked and what came back, and nothing
    // about what was never looked at -- the ten-point rail above carries that.
    line = `Nothing in this report carries a dollar figure to negotiate against: no flagged fees, no pricing gap we can evidence, and no open recalls. That is what these checks found, not a guarantee about the car.`;
  }

  return { dollars, total, facts, state, line };
}
