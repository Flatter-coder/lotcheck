// THE REPORT IS CANADIAN. THE MODEL IS NOT.
//
// WHAT THE BUYER RECEIVED, on a 2026 Lexus NX 350 F SPORT 3 at a dealer in
// Edmonton, in the verdict paragraph at the top of the report:
//
//     "...ask the dealer to itemize MSRP, freight/PDI, and any fees
//      (GST/title/tags are explicitly excluded per the page's own
//      disclaimer) before signing."
//
// "Title" and "tags" are United States terms. In Alberta the equivalents are a
// registration and a licence plate, issued by a provincial registry agent, and
// there is no "title" document at all. A buyer who takes that sentence to the
// desk is asking for paperwork that does not exist in their province, holding a
// report that claims to be built for Canadian buyers.
//
// IT DID NOT COME FROM OUR CODE. Nothing in this repo writes "title/tags" --
// check:copy scans source strings and it was clean. The sentence was written at
// request time by the extraction model, which has read far more American
// car-buying text than Canadian, and it reached the buyer because free-text
// summary is the one part of the report nothing deterministic had looked at.
// [[locale-abstraction-rule]]
//
// SO THIS RUNS AFTER GENERATION, like stripSettledContradictions. A prompt is a
// request; this is a guarantee.
//
// NARROW ON PURPOSE. Only terms with no Canadian reading at all are replaced,
// and each is replaced with the Canadian equivalent rather than deleted -- the
// sentence around it is usually fine and deleting it would lose real content.
// "Sales tax", "state" and "registration" are deliberately NOT here: each has a
// legitimate Canadian or general use ("the state of the vehicle"), and a rewrite
// that fires on a correct sentence is worse than the term it was chasing.

export type TermSwap = { from: RegExp; to: string; why: string };

export const US_TERMS: TermSwap[] = [
  // "title and tags", "title/tags", "tags and title" -- the US registration pair.
  { from: /\btitle\s*(?:\/|,|\s+(?:and|or)\s+)\s*tags?\b/gi, to: "registration and licensing",
    why: "US registration pair; Canada issues a registration and a plate, and has no title document" },
  { from: /\btags?\s*(?:\/|,|\s+(?:and|or)\s+)\s*title\b/gi, to: "registration and licensing",
    why: "US registration pair, reversed" },
  // A "title fee" / "tag fee" as a line item.
  { from: /\btitle\s+fees?\b/gi, to: "registration fee", why: "no title document exists in Canada" },
  { from: /\btag\s+fees?\b/gi, to: "licence plate fee", why: "US term for plate issuance" },
  // Article-aware, in that order: "the DMV" already carries its article, and
  // replacing the bare token first produced "the the provincial registry".
  { from: /\bthe\s+DMV\b/gi, to: "the provincial registry", why: "there is no DMV in Canada" },
  { from: /\bDMV\b/g, to: "the provincial registry", why: "there is no DMV in Canada" },
  { from: /\bdoc(?:ument(?:ary)?)?\s+stamps?\b/gi, to: "registration charges", why: "US-only instrument" },
];

/**
 * Replace US-only vehicle terminology in model-written copy with the Canadian
 * equivalent. Returns the text plus what was swapped, so the change is
 * auditable rather than silent -- the same contract stripSettledContradictions
 * uses for its removals.
 */
export function canadianiseTerms(text: unknown): {
  text: string; swapped: Array<{ from: string; to: string; why: string }>;
} {
  const original = String(text ?? "");
  if (!original) return { text: "", swapped: [] };

  let out = original;
  const swapped: Array<{ from: string; to: string; why: string }> = [];
  for (const t of US_TERMS) {
    // Collect what actually matched, so the audit record names the real words
    // rather than the pattern.
    const hits = out.match(t.from);
    if (!hits || !hits.length) continue;
    for (const h of [...new Set(hits)]) swapped.push({ from: h, to: t.to, why: t.why });
    out = out.replace(t.from, t.to);
  }
  return { text: out, swapped };
}
