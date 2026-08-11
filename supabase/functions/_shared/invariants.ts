// The ASSERT node: deterministic, model-free gates that every analysis object
// must pass before it is signed and shipped. No network, no Claude, no clock --
// pure functions over the analysis, so every rule here is testable and can be
// locked with a regression case (see invariants.test.ts).
//
// WHY THIS FILE EXISTS. These rules already shipped, but as one-off `if` blocks
// buried inside analyze-listing-url's request handler -- the same "quoted price
// and 'contact for price' can't both be true" check was written THREE separate
// times (the JSON-LD fallback path, the Scrapfly rescue path, and inside
// enrichAnalysis), and ZERO times on the analyze-quote path. An invariant that
// lives in one branch of one function isn't an invariant; it's a patch. Pulling
// them here means:
//   - a fix lands once and covers every path (see no-regressions-durable-fixes),
//   - each rule has a name, so a violation is greppable in the logs,
//   - each rule has a test, so a fixed bug can't quietly come back.
//
// TWO SEVERITIES, deliberately:
//   "repair" -- the correct value is derivable, so we fix it in place. Only used
//               where the shipped code already repaired it the same way.
//   "flag"   -- something looks wrong but guessing the right answer would risk
//               fabricating. We log and move on; the report still renders.
// Nothing here throws and nothing here blocks a report. A gate that can take
// the whole report down would violate report-never-empty.

// ── VIN ──────────────────────────────────────────────────────────────────────
// Moved here from BOTH analyze-listing-url and analyze-quote, which each carried
// a byte-identical copy -- so a correction to one silently missed the other.
// This is now the single definition; both import it.
//
// A North American VIN carries its own ISO 3779 check digit in position 9,
// computed from the other 16 characters; a valid VIN's check digit always
// reconciles, so a mismatch means a typo/transposition on the listing (or a
// fabricated VIN). Also enforces the format rules (17 chars, and I/O/Q are
// never used). Returns a structured result the report can surface as
// "VIN pattern valid". See vin-every-scan.
export interface VinCheck {
  present: boolean;
  valid?: boolean;
  vin?: string;
  reason?: string;
}

export function normalizeVin(vinRaw: unknown): string | null {
  if (typeof vinRaw !== "string" || !vinRaw.trim()) return null;
  return vinRaw.trim().toUpperCase().replace(/\s+/g, "");
}

export function validateVin(vinRaw: unknown): VinCheck {
  const vin = normalizeVin(vinRaw);
  if (!vin) return { present: false };
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
    const reason = vin.length !== 17
      ? `A VIN must be 17 characters; this one is ${vin.length}.`
      : `This VIN contains a letter (I, O, or Q) that VINs never use -- likely a mis-read.`;
    return { present: true, valid: false, vin, reason };
  }
  const translit: Record<string, number> = {
    A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:1,K:2,L:3,M:4,N:5,P:7,R:9,S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9,
    "0":0,"1":1,"2":2,"3":3,"4":4,"5":5,"6":6,"7":7,"8":8,"9":9,
  };
  const weights = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += translit[vin[i]] * weights[i];
  const rem = sum % 11;
  const expected = rem === 10 ? "X" : String(rem);
  const actual = vin[8];
  const valid = actual === expected;
  return {
    present: true,
    valid,
    vin,
    reason: valid
      ? "VIN check digit validates -- the number is internally consistent."
      : `VIN check digit doesn't validate (position 9 is "${actual}", should be "${expected}") -- likely a typo or transposed character on the listing. Worth confirming the exact VIN with the dealer.`,
  };
}

// ── Invariants ───────────────────────────────────────────────────────────────

export type Severity = "repair" | "flag";

// Context the analysis object can't carry on its own. Kept explicit rather than
// inferred: PRICE_NOT_ACCUSED_UNCONFIRMED must NOT run mid-pipeline (the price
// may still be recovered by a later rescue), so it only fires when a caller
// deliberately says "the render check is done, here's what it found."
export interface InvariantCtx {
  priceRenderChecked?: boolean;
  renderConfirmed?: boolean;
}

export interface Invariant {
  id: string;
  severity: Severity;
  why: string;
  applies(a: any, ctx: InvariantCtx): boolean;
  holds(a: any, ctx: InvariantCtx): boolean;
  repair?(a: any): void;
}

const num = (v: unknown): number => Number(v);
const hasPrice = (a: any): boolean => num(a?.quotedPrice) > 0;

export const INVARIANTS: Invariant[] = [
  {
    // Okotoks false-claim family. If we captured an asking price then the page,
    // by definition, advertised one -- a "contact for price" claim can never
    // stand next to it, whichever extraction path produced either value.
    id: "PRICE_DISCLOSURE_MATCHES_PRICE",
    severity: "repair",
    why: "an advertised price and a 'contact for price' claim can't both be true",
    applies: (a) => hasPrice(a),
    holds: (a) => a.priceDisclosure !== "contact_for_price",
    repair: (a) => { a.priceDisclosure = "advertised"; },
  },
  {
    // The accusation gate. Naming price-gating is a real safeguard (see
    // price-gating-tactic), but a garbled text scrape and a genuinely hidden
    // price are indistinguishable WITHOUT looking at the rendered page. We
    // never accuse on ambiguity: unconfirmed downgrades to "not_shown".
    id: "PRICE_NOT_ACCUSED_UNCONFIRMED",
    severity: "repair",
    why: "price-gating may only be named when the rendered page was inspected and confirmed price-less",
    applies: (a, ctx) => ctx.priceRenderChecked === true
      && a.priceDisclosure === "contact_for_price"
      && !hasPrice(a),
    holds: (_a, ctx) => ctx.renderConfirmed === true,
    repair: (a) => { a.priceDisclosure = "not_shown"; },
  },
  {
    // VIN is a MUST on every scan and must be shown on every surface, so the
    // check that backs that display can never be missing or stale relative to
    // the VIN it claims to describe. Self-healing: recompute from the VIN.
    id: "VIN_CHECK_MATCHES_VIN",
    severity: "repair",
    why: "every scan with a VIN must carry the check that the report displays",
    applies: (a) => normalizeVin(a?.vin) !== null,
    holds: (a) => a.vinCheck?.present === true && a.vinCheck.vin === normalizeVin(a.vin),
    repair: (a) => { a.vinCheck = validateVin(a.vin); },
  },
  {
    // A catalog MSRP is either pinned to the exact trim or it's an honest
    // "starting at" floor -- the UI label flips on msrpBasis. An unlabelled
    // catalog figure would render a floor as if it were the trim's real MSRP.
    id: "CATALOG_MSRP_BASIS_LABELLED",
    severity: "flag",
    why: "a 'starting at' floor must never be presented as the exact trim MSRP",
    applies: (a) => a?.msrpSource === "catalog" && num(a.msrp) > 0,
    holds: (a) => a.msrpBasis === "exact" || a.msrpBasis === "starting_at",
  },
  {
    // Inflated-sticker tactic. When we name it, the arithmetic has to survive a
    // dealer reading it at the table: the anchor price must be the TRUE
    // manufacturer figure, and overBy must be the stated-minus-true gap.
    id: "MSRP_INFLATION_ANCHORED",
    severity: "flag",
    why: "a named inflation claim must reconcile against the manufacturer figure it anchors to",
    applies: (a) => !!a?.msrpInflation,
    holds: (a) => {
      const i = a.msrpInflation;
      return num(i.dealerStated) > num(i.manufacturer)
        && num(i.overBy) === Math.round(num(i.dealerStated) - num(i.manufacturer))
        && num(a.msrp) === num(i.manufacturer);
    },
  },
  {
    // Provenance, not correctness: a figure the report shows should be able to
    // say where it came from. Flag-only because a listing-supplied MSRP
    // legitimately has no source tag today -- this measures that gap rather
    // than inventing an attribution for it.
    id: "MSRP_HAS_PROVENANCE",
    severity: "flag",
    why: "every displayed figure should name its authority (make-it-dispute-proof)",
    applies: (a) => num(a?.msrp) > 0,
    holds: (a) => typeof a.msrpSource === "string" && a.msrpSource.length > 0,
  },
  {
    // Days-on-lot is a leverage claim ("listed at least N days"), so it must
    // carry the source that backs the floor and the plain-language label the
    // report shows next to it.
    id: "DAYS_ON_LOT_HAS_PROVENANCE",
    severity: "flag",
    why: "a leverage claim must name the inventory data it rests on",
    applies: (a) => !!a?.daysOnLot && num(a.daysOnLot.days) > 0,
    holds: (a) => !!a.daysOnLot.source && !!a.daysOnLot.sourceLabel,
  },
];

export interface InvariantResult {
  repaired: string[];
  flagged: string[];
}

// Runs every invariant, repairing what is safely derivable and logging the
// rest. Never throws -- an invariant that itself blows up is reported as a
// flag, because a broken gate must not be able to take down a report.
export function assertInvariants(analysis: any, ctx: InvariantCtx = {}): InvariantResult {
  const repaired: string[] = [];
  const flagged: string[] = [];
  if (!analysis || typeof analysis !== "object") return { repaired, flagged };

  for (const inv of INVARIANTS) {
    let violated = false;
    try {
      if (!inv.applies(analysis, ctx)) continue;
      violated = !inv.holds(analysis, ctx);
    } catch (e) {
      flagged.push(`${inv.id} (threw: ${(e as Error)?.message})`);
      continue;
    }
    if (!violated) continue;

    if (inv.severity === "repair" && inv.repair) {
      try { inv.repair(analysis); repaired.push(inv.id); }
      catch (e) { flagged.push(`${inv.id} (repair threw: ${(e as Error)?.message})`); }
    } else {
      flagged.push(inv.id);
    }
  }

  if (repaired.length) console.log(`invariants repaired: ${repaired.join(", ")}`);
  if (flagged.length) console.warn(`invariants flagged: ${flagged.join(", ")}`);
  return { repaired, flagged };
}
