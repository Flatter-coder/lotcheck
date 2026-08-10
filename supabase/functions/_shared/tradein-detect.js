// S36 -- trade-in instant-offer widget detection (dealer-tactics-safeguards.md).
// Plain ES module (no Deno imports) so it runs in BOTH the edge functions and
// the Node regression suite (scripts/test-tradein-detect.mjs) -- same pattern
// as trim-match.js. Deterministic marker match, purely factual, dispute-proof.
export function matchTradeInWidget(text) {
  if (!text) return null;
  if (/accu-?trade/i.test(text)) return { detected: true, vendor: "AccuTrade" };
  if (/trade-?pending|snap.?offer/i.test(text)) return { detected: true, vendor: "TradePending" };
  if (/instant cash offer|kelley blue book[^.]{0,40}trade/i.test(text)) return { detected: true, vendor: "Kelley Blue Book Instant Cash Offer" };
  if (/canadian ?black ?book[^.]{0,40}(trade|value)/i.test(text)) return { detected: true, vendor: "Canadian Black Book" };
  if (/value your trade|trade-?in value|what'?s my (car|vehicle|trade) worth|appraise my (car|vehicle|trade)/i.test(text)) return { detected: true, vendor: null };
  return null;
}
