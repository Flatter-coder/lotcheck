// Deterministic extraction of a dealer's ADVERTISED finance APR from listing
// page text. Plain ES module so it runs in Deno and in the Node test suite.
//
// WHY. In a 10-listing benchmark (2026-08-11) the dealer's own APR was missing
// from 4 of 10 reports even though several pages printed it, because only the
// SM360 platform feed and the LLM pass supplied it. The dealer-vs-manufacturer
// rate comparison is one of the few places a buyer can see real money being
// taken quietly -- in that same benchmark the dealer rate beat the OEM rate in
// 3 of 3 comparable cases (+0.30, +1.50, +1.30 points) -- so a missed APR is a
// missed finding, not a cosmetic gap.
//
// NEVER guess. A number is only accepted when the page ties it to FINANCING.
// Lease rates, APR ranges "from 3.99% to 9.99%", credit-card style copy and
// "0% down" are all rejected: a wrong rate in a report is worse than none.

// Words that mean "this rate is for financing/purchase".
const FINANCE_CTX = /(financ\w*|purchase\s+financ\w*|apr|annual\s+percentage\s+rate|o\.?a\.?c\.?)/i;
// Words that mean the nearby rate is NOT a straight purchase-finance rate.
const DISQUALIFY = /(lease|leasing|cash\s*back|line\s+of\s+credit|credit\s+card|deposit|down\s*payment|trade|insurance|gst|tax)/i;

const clean = (s) => String(s || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");

/**
 * @param {string} text  page text or HTML
 * @returns {{apr:number, evidence:string}|null}
 */
export function extractAdvertisedApr(text) {
  const t = clean(text);
  if (!t) return null;

  // A quoted RANGE ("from 3.99% to 9.99% APR") advertises a spread, not this
  // car's rate -- neither end of it may be reported. Mark the whole span so
  // BOTH numbers are skipped, not just the first.
  const rangeSpans = [];
  const rangeRe = /\d{1,2}(?:\.\d{1,2})?\s*%\s*(?:to|-|–|—)\s*\d{1,2}(?:\.\d{1,2})?\s*%/gi;
  let rm;
  while ((rm = rangeRe.exec(t)) !== null) rangeSpans.push([rm.index, rm.index + rm[0].length]);
  const inRange = (i) => rangeSpans.some(([a, b]) => i >= a && i <= b);

  const candidates = [];
  // A percentage with financing context within ~60 chars either side.
  const re = /(\d{1,2}(?:\.\d{1,2})?)\s*%/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const apr = Number(m[1]);
    // 0% promos are real; anything above 30% is not a Canadian car APR.
    if (!(apr >= 0 && apr <= 30)) continue;
    const from = Math.max(0, m.index - 70);
    const window = t.slice(from, Math.min(t.length, m.index + 70));
    if (!FINANCE_CTX.test(window)) continue;
    if (DISQUALIFY.test(window)) continue;
    if (inRange(m.index)) continue;
    candidates.push({ apr, evidence: window.trim().slice(0, 120) });
  }
  if (!candidates.length) return null;

  // Several rates on one page (multiple terms) -> the lowest is the advertised
  // headline rate, which is the one the dealer is holding out as their offer.
  candidates.sort((a, b) => a.apr - b.apr);
  return candidates[0];
}
