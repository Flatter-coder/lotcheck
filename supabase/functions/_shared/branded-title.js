// branded-title.js — is this vehicle's title branded, and did the page say so?
//
// WHY THIS EXISTS. On 2026-09-12 a real customer report was produced for a 2017
// Tesla Model X whose dealer page states, in plain text:
//
//   "This unit is RECERTIFIED and carries a REBUILT TITLE due to previous
//    rear-end damage (NO STRUCTURAL DAMAGE)."
//
// The report never mentioned it. Not in the ten-point check, not in the prose,
// nowhere — because `analyze-listing-url` contained ZERO references to rebuilt
// or salvage and the status never entered the pipeline at all. It is the single
// most decision-relevant fact about that car: in Alberta the brand is permanent
// ("This status will follow the vehicle for the rest of its useful life"), it
// must be disclosed by every future seller, and it drives insurability,
// financing and resale. For an EV it also removes manufacturer support — Tesla
// classes a branded car "Unsupported" and disables Supercharging until two paid
// inspections pass.
//
// THREE STATES, NEVER TWO. Silence is not a clean title.
//   "branded"    the page itself says salvage / rebuilt / reconstructed
//   "clean"      the page itself says clean / clear / no brand
//   "not-stated" the page says nothing — which is a gap in OUR read, never a
//                clean bill. Alberta's Automotive Business Regulation s.31.1
//                entitles the buyer to that disclosure IN WRITING before
//                purchase, so "not stated" converts into a question to ask,
//                not a reassurance. [[make-recalls-fail-safe]]
//                [[present-without-creating-questions]]
//
// NEVER AN ACCUSATION. A branded title is a lawful, disclosable status and
// plenty of rebuilt cars are sound. The report states the status and its
// consequences; it never implies the dealer concealed anything — the page that
// triggered this disclosed it prominently and correctly. [[no-accusation-language]]

// "Rebuilt" is the trap. A rebuilt ENGINE, transmission, motor or differential
// is a mechanical repair with no bearing on the registration, and those phrases
// are everywhere in used listings ("rebuilt transmission, new tires"). Calling
// that a branded title would invent a permanent defect on a clean car — the
// worst error this module can make, so the word alone is never enough.
const MECHANICAL_AFTER = /\b(engine|motor|transmission|trans|gearbox|differential|diff|axle|carburet|injector|head|turbo|pump|alternator|starter|suspension|calliper|caliper)\b/i;
const MECHANICAL_BEFORE = /\b(engine|motor|transmission|trans|gearbox|differential|diff|axle|turbo|pump)\s+(?:was\s+|is\s+|been\s+)?$/i;

// The words that DO refer to the registration/title itself.
const TITLE_NOUN = /\b(title|titled|status|brand|branded|registration|registered|history|vehicle)\b/i;

// Phrases that are unambiguous on their own — no proximity test needed.
const EXPLICIT = [
  /\brebuilt\s+title\b/i,
  /\bsalvage\s+title\b/i,
  /\btitle\s+is\s+(?:rebuilt|salvage|branded)\b/i,
  /\bbranded\s+title\b/i,
  /\btitle\s+brand(?:ed)?\b/i,
  /\bsalvage\s+(?:status|brand|vehicle|certificate)\b/i,
  /\brebuilt\s+status\b/i,
  /\breconstructed\s+(?:title|vehicle)\b/i,
  /\bnon[-\s]?repairable\b/i,
  /\binsurance\s+(?:write[-\s]?off|total\s+loss)\b/i,
  /\bpreviously\s+written\s+off\b/i,
  /\bwritten\s+off\s+by\s+(?:an?\s+)?insur/i,
  /\bcertificate\s+of\s+salvage\b/i,
];

// The page asserting the opposite. Checked FIRST: a lot advertising "we never
// sell salvage or rebuilt vehicles" must not be read as declaring this one is.
const NEGATED = [
  /\b(?:no|not|never|non)[-\s]?(?:a\s+)?(?:salvage|rebuilt|branded|reconstructed)\b/i,
  /\b(?:clean|clear)\s+title\b/i,
  /\btitle\s+is\s+(?:clean|clear)\b/i,
  /\bno\s+(?:title\s+)?brand(?:s|ed)?\b/i,
  /\bnever\s+(?:been\s+)?(?:in\s+)?(?:an\s+)?accident/i,
  /\bwe\s+(?:do\s+not|don't|never)\s+(?:sell|buy|carry|deal\s+in)\b[^.]{0,40}\b(?:salvage|rebuilt|branded)/i,
];

const CLEAN_CLAIM = [
  /\b(?:clean|clear)\s+title\b/i,
  /\btitle\s+is\s+(?:clean|clear)\b/i,
  /\bno\s+title\s+brand(?:s|ed)?\b/i,
  /\bnot\s+(?:a\s+)?(?:salvage|rebuilt|branded)\b/i,
];

const WINDOW = 40;   // characters either side for the proximity test

/**
 * Classify a listing page's own statement about title branding.
 *
 * @param {string} text  the page's visible text
 * @returns {{status:"branded"|"clean"|"not-stated", brand:string|null, quote:string|null, basis:string}}
 *   `quote` is the page's own words, verbatim, so the report can show the buyer
 *   what it read rather than asking them to trust a label.
 *   [[fine-print-capture-rule]] [[make-it-dispute-proof]]
 */
export function readBrandedTitle(text) {
  const t = String(text || "");
  if (!t.trim()) return { status: "not-stated", brand: null, quote: null, basis: "no page text to read" };

  // ---- 1. an explicit branded phrase ---------------------------------------
  for (const re of EXPLICIT) {
    const m = re.exec(t);
    if (!m) continue;
    const around = t.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60);
    // "we do not sell rebuilt title vehicles" and friends.
    if (NEGATED.some((n) => n.test(around))) continue;
    return {
      status: "branded",
      brand: brandWord(m[0]),
      quote: sentenceAround(t, m.index),
      basis: `the page states "${m[0].trim()}"`,
    };
  }

  // ---- 2. salvage/rebuilt NEAR a title noun --------------------------------
  // Catches "REBUILT | RECERTIFIED ... status" shapes the explicit list misses,
  // without letting a rebuilt gearbox through.
  const loose = /\b(salvage|salvaged|rebuilt|reconstructed)\b/gi;
  let m;
  while ((m = loose.exec(t)) !== null) {
    const before = t.slice(Math.max(0, m.index - WINDOW), m.index);
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + WINDOW);
    if (MECHANICAL_AFTER.test(after.slice(0, 24))) continue;   // "rebuilt engine"
    if (MECHANICAL_BEFORE.test(before)) continue;              // "engine was rebuilt"
    const around = before + m[0] + after;
    if (NEGATED.some((n) => n.test(around))) continue;
    if (!TITLE_NOUN.test(around)) continue;                    // needs a title noun nearby
    return {
      status: "branded",
      brand: brandWord(m[0]),
      quote: sentenceAround(t, m.index),
      basis: `the page uses "${m[0]}" about this vehicle`,
    };
  }

  // ---- 3. the page claims a clean title ------------------------------------
  for (const re of CLEAN_CLAIM) {
    const c = re.exec(t);
    if (c) {
      return { status: "clean", brand: null, quote: sentenceAround(t, c.index), basis: `the page states "${c[0].trim()}"` };
    }
  }

  // ---- 4. silence. NOT a clean title. --------------------------------------
  return {
    status: "not-stated",
    brand: null,
    quote: null,
    basis: "the listing does not state whether this vehicle's title has ever been branded",
  };
}

function brandWord(s) {
  const l = String(s).toLowerCase();
  if (/non[-\s]?repairable/.test(l)) return "non-repairable";
  if (/salvag/.test(l)) return "salvage";
  if (/reconstruct/.test(l)) return "reconstructed";
  if (/rebuilt/.test(l)) return "rebuilt";
  if (/write[-\s]?off|total\s+loss|written\s+off/.test(l)) return "insurance write-off";
  return "branded";
}

// The dealer's own sentence, so the report quotes rather than paraphrases.
function sentenceAround(t, i) {
  const start = Math.max(0, t.lastIndexOf(".", i) + 1);
  let end = t.indexOf(".", i);
  if (end < 0 || end - i > 400) end = Math.min(t.length, i + 240);
  return t.slice(start, end + 1).replace(/\s+/g, " ").trim().slice(0, 320) || null;
}

/**
 * The report card for point "Title status".
 * Tone follows the same convention as every other point: flag = the buyer must
 * look at this, pass = verified fine, muted = we could not establish it.
 */
export function brandedTitleLine(bt) {
  const b = bt || { status: "not-stated" };
  if (b.status === "branded") {
    const word = (b.brand || "branded").toUpperCase();
    return {
      value: `${word} TITLE`,
      tone: "flag",
      line: `The listing states this vehicle's title is ${b.brand || "branded"}${b.quote ? ` — "${b.quote}"` : ""}. In Alberta a salvage or rebuilt brand is permanent: Alberta states it "will follow the vehicle for the rest of its useful life", and every future seller must disclose it, so it affects what you can sell it for as well as what you pay now. It is not a defect in itself and the brand is lawful and properly disclosed here — but insurers may decline collision and comprehensive cover, lenders may decline to finance it, and a manufacturer may treat the vehicle as unsupported for warranty or charging purposes. Ask for the salvage inspection certificate, the repair invoices, and written confirmation from YOUR insurer and lender before you commit.`,
    };
  }
  if (b.status === "clean") {
    return {
      value: "NO BRAND STATED",
      tone: "pass",
      line: `The listing states the title carries no brand${b.quote ? ` — "${b.quote}"` : ""}. That is the seller's own statement, not a registry search: Alberta's registry is the authority, so get it in writing on the bill of sale before you rely on it.`,
    };
  }
  return {
    value: "NOT STATED",
    tone: "muted",
    line: `This listing does not say whether the vehicle's title has ever been branded salvage or rebuilt, and we did not find a statement either way. That is a gap in what the page published — NOT a clean bill. Alberta's Automotive Business Regulation entitles you to that disclosure in writing before you buy, so ask for it outright and get the answer on the bill of sale.`,
  };
}
