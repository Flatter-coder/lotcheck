// Is the advertised price conditional on financing WITH THE DEALER?
//
// Plain ES module so it runs in Deno and in the Node test suite.
//
// WHY. Our own tactics catalog documents this as one of the most common ways a
// good-looking price evaporates (S11 "in lieu of special financing", S18
// conditional-discount stacking: "a cash, no-trade, non-qualifying buyer gets
// the LEAST off but sees the biggest number in the ad"). A finance manager on
// the record: "cash it's 2.75, financing it's 2.7 because we make $750 off the
// bank." So the advertised discount is often FUNDED by finance reserve, and a
// buyer bringing their own money quietly loses it.
//
// This matters twice over:
//   1. On the report — the buyer must know the price they are looking at may
//      not be their price.
//   2. On a brokered stamped offer — an offer silent on this can be honoured to
//      the letter and still break (brokered-deal-scope.md 5n).
//
// NEVER guesses. Only fires on explicit conditional language, and always
// reports the evidence so the claim is checkable.

// Prose living inside <script> JSON blobs. EDealer-family pages (and ford.ca)
// carry their pricing disclaimers there rather than in visible markup, so
// dropping script content wholesale makes the fine print invisible — the same
// page shape that hid $7,062 of incentives in the 2026-08-11 benchmark.
// Only quoted strings that read like a SENTENCE survive (>=4 words), so code
// identifiers such as `financeCash` and CSS values can never trigger a flag.
function proseInScripts(html) {
  const out = [];
  const blocks = String(html).match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const b of blocks) {
    const strs = b.match(/"(?:[^"\\]|\\.){12,400}"/g) || [];
    for (const raw of strs) {
      let v = raw.slice(1, -1).replace(/\\[nrt]/g, " ").replace(/\\u003c/gi, "<").replace(/\\u003e/gi, ">").replace(/\\(.)/g, "$1");
      v = v.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      if (v.split(" ").filter((w) => /[a-z]{2,}/i.test(w)).length >= 4) out.push(v);
    }
  }
  return out.join(" . ");
}

const clean = (s) => {
  const src = String(s || "");
  const embedded = src.includes("<script") ? " . " + proseInScripts(src) : "";
  return (src
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ") + embedded)
    .replace(/\s+/g, " ");
};

// Phrases that state the price/discount depends on taking the dealer's finance.
const PATTERNS = [
  { re: /in\s+lieu\s+of\s+(?:special\s+)?financ\w*/i,                    label: "in lieu of special financing" },
  // A finance-gated incentive, but ONLY in a money context. Bare vocabulary is
  // not enough: calgaryhyundai.com's nav menu carries "Finance Credit
  // Application", which is a form, not a pricing condition. "credit" is dropped
  // entirely for the same reason ("credit application", "credit approval").
  { re: /(?:\$[\d,]{3,}|includes?|price|savings|discount|\boff\b)[^.]{0,60}\bfinance\s+(?:assist|cash|bonus|incentive|discount)\b/i, label: "finance-gated discount" },
  { re: /\bfinance\s+(?:assist|cash|bonus|incentive|discount)\b[^.]{0,60}(?:\$[\d,]{3,}|\bincluded\b|\boff\b|discount)/i, label: "finance-gated discount" },
  { re: /(?:when|if|once)\s+financ\w+\s+(?:with|through)\s+(?:us|the\s+dealer|dealer)/i, label: "conditional on financing with the dealer" },
  // "Must finance through X" ALONE is not this flag. Every promotional APR in
  // Canada requires the captive lender ("APR - Must finance through Ford Credit
  // Canada Company", live on ford.ca) — that conditions the RATE, not the price,
  // and flagging it would put an unbacked claim on the report. It only counts
  // when the PRICE or DISCOUNT is what hangs on it.
  { re: /(?:price|discount|savings|offer)[^.]{0,70}must\s+financ\w+\s+(?:with|through)/i, label: "financing required" },
  { re: /must\s+financ\w+\s+(?:with|through)[^.]{0,70}to\s+(?:get|receive|qualify\s+for)[^.]{0,20}(?:price|discount|savings)/i, label: "financing required" },
  { re: /(?:price|discount|offer)\s+(?:is\s+)?(?:only\s+)?(?:available|valid)\s+(?:with|when)\s+[^.]{0,40}financ/i, label: "price only with financing" },
  { re: /financ\w+\s+(?:with|through)\s+(?:us|dealer)[^.]{0,30}(?:required|to\s+(?:qualify|receive|get))/i, label: "financing required to qualify" },
  { re: /\bnon-?finance[d]?\s+price\b/i,                                  label: "separate non-financed price" },
  { re: /\bcash\s+price\b[^.]{0,60}\bfinanc/i,                            label: "cash price differs from financed price" },
  // NOT keyed on "O.A.C." alone — that appears on almost every Canadian
  // listing as financing boilerplate. It only counts when the PRICE is what
  // hangs on the approval.
  { re: /(?:credit\s+)?approval\s+required[^.]{0,40}(?:advertised\s+)?pric(?:e|ing)/i, label: "advertised price conditional on credit approval" },
];

/**
 * @param {string} text page text or HTML
 * @returns {{contingent:true, reasons:string[], evidence:string}|null}
 */
export function detectFinanceContingent(text) {
  const t = clean(text);
  if (!t) return null;
  const reasons = [];
  let evidence = "";
  for (const { re, label } of PATTERNS) {
    const m = t.match(re);
    if (!m) continue;
    if (!reasons.includes(label)) reasons.push(label);
    if (!evidence) {
      const i = Math.max(0, m.index - 60);
      evidence = t.slice(i, Math.min(t.length, m.index + m[0].length + 60)).trim();
    }
  }
  if (!reasons.length) return null;
  return { contingent: true, reasons, evidence: evidence.slice(0, 200) };
}
