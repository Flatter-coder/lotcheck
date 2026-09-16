// The free-text summary must never reopen a question the report has already
// answered in a structured panel.
//
// WHAT THE BUYER RECEIVED, in ONE document, on a RAV4 Plug-In Hybrid GR SPORT:
//
//   panel:    EV / PHEV rebate                              NOT ELIGIBLE
//             "This electric/plug-in doesn't qualify (price cap or model
//              list). Don't let anyone imply a government discount that
//              isn't there."
//
//   summary:  "...it should be treated as a PHEV for rebate-eligibility
//              purposes -- worth confirming the plug-in battery/charging
//              specs with the dealer."
//
// One page tells the buyer the matter is closed; the next sends them to the
// sales desk to ask about it. Whichever they act on, we were the ones who put
// both there. On a $68,673 car the answer was never in doubt — the summary
// invented a live question out of a settled one.
//
// AND THE PROMPT CAUSED IT. analyze-listing-url's extraction prompt says, of a
// fuel-type contradiction on the page: "say so plainly in the summary field so
// the buyer knows to double check with the dealer." The model did exactly that.
// A few lines later the same prompt says not to contradict the rebate section —
// so the instructions themselves disagree, and the model cannot resolve that.
//
// SO THE FIX IS NOT MORE PROMPT. Prompts are a request; this is a guarantee.
// After generation, any sentence that reopens a SETTLED topic is removed and
// replaced with the settled fact, deterministically, before anything renders.
//
// The page inconsistency is still worth telling the buyer — it is real, and a
// mislabelled fuel type on a spec sheet is exactly the kind of thing they
// should raise. What it must NOT do is dress it up as an open rebate question.

import { canadianiseTerms } from "./canada-terms.ts";

export type SettledTopic = { topic: string; verdict: string; matcher: RegExp };

/**
 * Topics whose answer is computed elsewhere and is therefore not the summary's
 * to reopen. `matcher` is deliberately narrow: it fires on a sentence that
 * raises the topic as UNRESOLVED, not on any mention of it.
 */
export function settledTopics(a: any): SettledTopic[] {
  const out: SettledTopic[] = [];

  // Rebate eligibility, whichever way it landed.
  const rebateDecided = a?.evapRebate?.eligible === true ||
    (a?.evapRebate && !!a.evapRebate.ineligibleReason);
  if (rebateDecided) {
    const verdict = a.evapRebate.eligible
      ? "This vehicle's rebate eligibility is confirmed in the EV / PHEV rebate section above."
      : "This vehicle is not rebate-eligible - see the EV / PHEV rebate section above. There is nothing to confirm with the dealer.";
    out.push({
      topic: "rebate",
      verdict,
      // "rebate/eligib..." within reach of confirm/verify/check/ask/worth.
      matcher: /(rebate|eligib|izev|evap)[^.]{0,160}?\b(confirm|verif|check|ask|worth|should be treated|may qualify|might qualify)\b|\b(confirm|verif|check|ask|worth)\b[^.]{0,160}?(rebate|eligib|izev|evap)/i,
    });
  }

  // Recalls: if the check ran, the count is the answer.
  if (a?.recalls?.checked === true && a?.recalls?.confirmed !== false) {
    out.push({
      topic: "recalls",
      verdict: `Recalls were checked against Transport Canada - ${Number(a.recalls.count) || 0} open. See the recall section above.`,
      // Both directions: the verb can precede or follow the noun, and only
      // matching one way is how "confirm the recall status" slipped through.
      matcher: /recall[^.]{0,160}?\b(confirm|verif|check with|ask the dealer)\b|\b(confirm|verif|check with|ask the dealer)\b[^.]{0,160}?recall/i,
    });
  }


  // THE ITEMISATION WE ALREADY HOLD.
  //
  // A 2026 Lexus NX 350 F SPORT 3 at a dealer in Edmonton, advertised at
  // $72,010, reached a buyer with this verdict:
  //
  //   "...no separate base MSRP or discount was shown on the page, so ask
  //    the dealer to itemize MSRP, freight/PDI, and any fees ... before
  //    signing."
  //
  // We hold that itemisation. Lexus publishes the configuration at
  // $71,985.18 all-in in Alberta -- $55,080 base, the $13,573 F SPORT 3
  // package, $2,205 freight, $100 A/C, $10 AMVIC, $20 tire levy, $2.18
  // environmental and the $995 dealer fee -- and the $13,573 the listing
  // called 'Installed Options' is that package, already inside the price.
  // The report sent the buyer to the sales desk to ask for a number it was
  // holding, and framed a published package price as an unexplained add-on.
  //
  // Fires ONLY when the configuration is pinned exactly AND we hold the
  // manufacturer's own all-in for it. With no exact match the summary is
  // right to send them asking, and this stays silent.
  const exact = a?.msrpBasis === "exact";
  const allIn = Number(a?.msrpAllIn);
  if (exact && Number.isFinite(allIn) && allIn > 0) {
    const make = String(a?.make || "the manufacturer").trim() || "the manufacturer";
    const money = "$" + allIn.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    out.push({
      topic: "msrp_itemisation",
      verdict: `${make} publishes this exact configuration at ${money} all-in for this province, and it is in the Price vs MSRP section above - the base MSRP, freight, levies and the dealer fee are already inside that figure, so there is nothing here to ask the dealer to itemise.`,
      // Narrow: the sentence has to be ASKING for the breakdown, not merely
      // mentioning MSRP or freight. Both word orders, because matching one
      // way is how the recall version slipped through.
      matcher: /\b(itemi[sz]e|break\s?down)\b[^.]{0,160}?\b(msrp|freight|pdi|fees?)\b|\b(msrp|freight|pdi)\b[^.]{0,160}?\b(ask|request|confirm|get)\b[^.]{0,80}?\bdealer\b|\b(ask|request)\b[^.]{0,80}?\bdealer\b[^.]{0,120}?\b(itemi[sz]e|msrp|freight|pdi)\b/i,
    });
  }

  return out;
}

/** Split on sentence boundaries without losing the delimiter. */
function sentences(text: string): string[] {
  return String(text || "").split(/(?<=[.!?])\s+/).filter(Boolean);
}

/**
 * Remove summary sentences that reopen a settled topic. Returns the cleaned
 * text plus what was removed, so the removal is auditable rather than silent.
 */
export function stripSettledContradictions(summary: string, a: any): {
  text: string; removed: Array<{ topic: string; sentence: string }>;
} {
  const topics = settledTopics(a);
  if (!topics.length || !summary) return { text: String(summary || ""), removed: [] };

  const removed: Array<{ topic: string; sentence: string }> = [];
  const kept: string[] = [];

  for (const s of sentences(summary)) {
    const hit = topics.find((t) => t.matcher.test(s));
    if (hit) removed.push({ topic: hit.topic, sentence: s.trim() });
    else kept.push(s);
  }

  // State the settled fact once, for every topic the summary tried to reopen.
  const seen = new Set<string>();
  for (const r of removed) {
    if (seen.has(r.topic)) continue;
    seen.add(r.topic);
    const t = topics.find((x) => x.topic === r.topic);
    if (t) kept.push(t.verdict);
  }

  return { text: kept.join(" ").replace(/\s+/g, " ").trim(), removed };
}

/**
 * THE ONE PLACE A MODEL-WRITTEN SUMMARY IS CLEANED, so both analyze
 * functions get the same treatment.
 *
 * analyze-listing-url ran stripSettledContradictions; analyze-quote, which
 * also asks the model for a `summary` field, ran nothing at all. Same class
 * of defect, one surface fixed -- the shape the fixing history calls a
 * one-surface fix. Both call this now.
 *
 * Order matters: terminology is repaired FIRST, so a sentence that survives
 * the settled-topic pass is already in Canadian terms, and a sentence that
 * gets removed was matched on its meaning rather than on its spelling.
 */
export function sanitiseSummary(summary: unknown, a: any): {
  text: string;
  removed: Array<{ topic: string; sentence: string }>;
  swapped: Array<{ from: string; to: string; why: string }>;
} {
  const ca = canadianiseTerms(summary);
  const settled = stripSettledContradictions(ca.text, a);
  return { text: settled.text, removed: settled.removed, swapped: ca.swapped };
}
