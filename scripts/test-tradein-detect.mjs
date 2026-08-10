// Regression suite for the trade-in widget detector (S36).
// Run: node scripts/test-tradein-detect.mjs
import { matchTradeInWidget } from "../supabase/functions/_shared/tradein-detect.js";

const CASES = [
  ["Okotoks AccuTrade banner", `Value your trade now - IT'S FREE! <img alt="AccuTrade">`, "AccuTrade"],
  ["AccuTrade script embed", '<script src="https://cdn.accu-trade.com/widget.js"></script>', "AccuTrade"],
  ["TradePending snap", '<div id="tradepending-snap-offer"></div>', "TradePending"],
  ["KBB ICO", 'Get your Kelley Blue Book Instant Cash Offer today', "Kelley Blue Book Instant Cash Offer"],
  ["CBB trade value", 'Powered by Canadian Black Book trade-in values', "Canadian Black Book"],
  ["Generic value-your-trade", '<a href="/trade">Value Your Trade</a>', null],
  ["Generic whats-it-worth", "What's my car worth? Find out instantly", null],
  ["No widget (clean listing)", 'New 2027 Toyota Land Cruiser. $112,995. Call 403-555-0100.', "NONE"],
  ["Empty input", '', "NONE"],
];

let pass = 0, fail = 0;
for (const [label, text, expected] of CASES) {
  const r = matchTradeInWidget(text);
  const got = r === null ? "NONE" : r.vendor;
  const ok = got === expected && (r === null || r.detected === true);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  (expected ${expected}, got ${got})`);
  ok ? pass++ : fail++;
}
console.log(`
${pass}/${pass + fail} passed${fail ? " -- FAILING" : "  all green"}`);
process.exit(fail ? 1 : 0);
