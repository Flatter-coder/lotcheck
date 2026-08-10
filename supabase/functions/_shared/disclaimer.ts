// ============================================================================
// S35 — Pricing-disclaimer capture & assessment ("the fine print is OUR evidence").
//
// Dealers pre-position escape-hatch language in VDP fine print ("cannot
// guarantee accuracy… may differ in price", "subject to change without notice",
// "does not constitute an offer") to disown the advertised price later. AMVIC's
// Feb 2025 Director of Fair Trading bulletin holds that disclaimers do NOT
// exempt all-in pricing — telling consumers the advertised price may not be the
// real price is ITSELF misleading. So the captured disclaimer is proof of the
// dealer's posture, not a defence.
//
// Pure + defensive: reads analysis.pricingDisclaimer (verbatim text the
// extractor lifted from the page), classifies it, never throws. The captured
// text is the dealer's own words — dispute-proof by construction.
// ============================================================================

const ESCAPE_RE = /(cannot|can\s*not|can't|do(es)?\s+not)\s+guarantee|may\s+differ\s+in\s+(specification,?\s*)?price|subject\s+to\s+change\s+without\s+notice|does\s+not\s+constitute\s+an\s+offer|not\s+responsible\s+for\s+(any\s+)?(errors|inaccurac|typographical|misprint)|errors?\s+(and|&|or)\s+omissions|verify\s+(all\s+)?(information|pricing)\s+with\s+a\s+(dealership\s+)?sales/i;
const ALLIN_ACK_RE = /price[s]?,?\s*(for[^.]{0,80})?\s*includ(?:e[s]?|ing)[^.]{0,160}(transport|freight|administration|admin\s+fee|dealer-?installed|mandatory\s+fee)/i;
const ALLIN_DENY_RE = /price[s]?\s+may\s+not\s+include[^.]{0,160}(option|accessor|administration|admin|fee|charge)/i;

export interface DisclaimerCheck {
  text: string;                 // verbatim excerpt from the page (the evidence)
  escapeHatch: boolean;         // hedging language present
  allInAcknowledged: boolean;   // disclaimer recites the all-in inclusion rule
  contradiction: boolean;       // recites all-in AND claims fees may be extra
  note: string;                 // plain-language read (jurisdiction-aware)
}

export function assessDisclaimer(analysis: any): DisclaimerCheck | null {
  try {
    const raw = typeof analysis?.pricingDisclaimer === "string" ? analysis.pricingDisclaimer.trim() : "";
    if (raw.length < 40) return null; // too short to be real fine print
    const text = raw.slice(0, 900);
    const escapeHatch = ESCAPE_RE.test(text);
    const allInAcknowledged = ALLIN_ACK_RE.test(text);
    const contradiction = allInAcknowledged && ALLIN_DENY_RE.test(text);
    if (!escapeHatch && !contradiction) return null; // benign fine print -> no claim
    const inAllIn = !!analysis?.allInPricing?.body;
    const body = analysis?.allInPricing?.body || "the regulator";
    const note = contradiction
      ? `This fine print contradicts itself: it recites the all-in rule (prices include fees) and then says prices "may not include" those same fees. ${inAllIn ? `In an all-in province both can't be true — and ${body} has ruled that disclaimers don't exempt all-in pricing.` : "Ask which sentence applies to your deal, in writing."}`
      : inAllIn
        ? `The page's own fine print hedges the advertised price ("subject to change" / "cannot guarantee accuracy"). ${body}'s position (Feb 2025 bulletin): disclaimers do NOT exempt all-in pricing — telling buyers the advertised price may not be the real price is itself misleading. This disclaimer is the dealer's posture on record, not a defence.`
        : `The page's own fine print hedges the advertised price. Get the exact figure confirmed in writing before relying on it.`;
    return { text, escapeHatch, allInAcknowledged, contradiction, note };
  } catch {
    return null;
  }
}
