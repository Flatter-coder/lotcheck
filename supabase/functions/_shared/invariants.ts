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

// The sale-condition rule is IMPORTED, never restated here. It already existed
// as a copy-pasted expression in three branches of analyze-listing-url and was
// missing from a fourth; a gate carrying a fifth copy would be a gate asserting
// a stale version of the rule it is supposed to enforce. See msrp-basis.ts.
import { applyConditionToMsrp, msrpIsPresentTense } from "./msrp-basis.ts";
import { PAGE_DEFAULT_SOURCES } from "./page-default.js";

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
    // A catalog MSRP is either pinned to the exact trim, an honest "starting
    // at" floor, or -- on a vehicle that is no longer new -- the ORIGINAL
    // sticker it wore when it was. The UI label flips on msrpBasis, so an
    // unlabelled catalog figure would render a floor as the trim's real MSRP.
    //
    // "original_when_new" was missing from that list, which pointed this rule
    // backwards at the defect sitting right beneath it: every CORRECTLY handled
    // used listing raised a violation, while a used listing wrongly carrying
    // "exact" -- the fabricated "thousands under MSRP" -- raised nothing at
    // all. A signal that fires on the right answer and stays silent on the
    // wrong one is worse than no signal, because it trains the reader to skip
    // it.
    id: "CATALOG_MSRP_BASIS_LABELLED",
    severity: "flag",
    why: "a 'starting at' floor must never be presented as the exact trim MSRP",
    applies: (a) => a?.msrpSource === "catalog" && num(a.msrp) > 0,
    holds: (a) => a.msrpBasis === "exact" || a.msrpBasis === "starting_at"
      || a.msrpBasis === "original_when_new",
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
    // The half of CATALOG_MSRP_BASIS_LABELLED that was never written. Labelling
    // the basis is only half the job; the label also has to match the CAR. On a
    // vehicle that is no longer new the manufacturer figure is what it cost when
    // new, and carrying "exact" instead makes every surface read it as today's
    // sticker -- which is how a used listing came back "$28,400 under MSRP"
    // (Advantage Ford Mach-E, 2026-08-11). That is a bargain we invented, and it
    // flatters the dealer at the buyer's expense.
    //
    // REPAIRS rather than flags. The correct value is derivable and the shipped
    // code already derives it exactly this way at every write site, which is
    // this file's stated bar for a repair. A flag would let the false claim ship
    // while logging that it did -- warn-instead-of-refuse, which is one of the
    // documented ways a defect gets marked fixed and stays open.
    //
    // Repairs the WHOLE state, not just the label. The original-sticker context
    // the report renders and the padded-sticker accusation are condition-
    // dependent for the same reason the comparison is: a used car's stated MSRP
    // is its original as-optioned sticker while our catalog row is a base trim,
    // so that gap is a data gap, not a tactic (no-accusation-language). Fixing
    // the label alone would leave the accusation standing beside it -- and the
    // Scrapfly rescue path builds msrpInflation directly, without going through
    // applyConditionToMsrp, so this is the only thing standing between that path
    // and a padded-sticker accusation on a used car.
    //
    // Deliberately ordered AFTER MSRP_INFLATION_ANCHORED. Withholding the claim
    // removes it, and a rule that runs first would take the arithmetic check's
    // input away with it -- silently retiring a diagnostic about OUR maths that
    // still matters on every new car. Both signals fire; neither eats the other.
    //
    // "dealer_stated" is exempt on purpose: it cannot carry an over/under claim
    // anyway, and relabelling it would lose the fact that the DEALER said it.
    id: "MSRP_BASIS_MATCHES_CONDITION",
    severity: "repair",
    why: "a manufacturer MSRP on a vehicle that is no longer new is the ORIGINAL sticker, and may never license an over/under claim",
    applies: (a) => num(a?.msrp) > 0
      && (a.msrpSource === "catalog" || a.msrpSource === "manufacturer_site")
      && a.msrpBasis !== "dealer_stated"
      && !msrpIsPresentTense(a),
    holds: (a) => a.msrpBasis === "original_when_new",
    repair: (a) => {
      const outcome = applyConditionToMsrp(
        {
          msrp: a.msrp, basis: a.msrpBasis, trim: a.msrpTrim ?? null,
          sourceUrl: a.msrpSourceUrl ?? null, inflation: a.msrpInflation ?? null,
        },
        {
          vehicleCondition: a.vehicleCondition, saleCondition: a.saleCondition,
          saleConditionHint: a.saleConditionHint, odometerKm: a.odometerKm, year: a.year,
        },
      );
      a.msrpBasis = outcome.basis;
      if (outcome.originalMsrp) a.originalMsrp = outcome.originalMsrp;
      // Deleted rather than set to null: this object gets canonicalized and
      // signed, so introducing a key that wasn't there changes the payload.
      if (a.msrpInflation && !outcome.inflation) delete a.msrpInflation;
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
  {
    // "Of N other listings read, M advertise below this one" is a count of
    // things we read. A confirmed count that cannot say what it is of --
    // which vehicle, which province, read when, against which price -- is a
    // bare number, and a bare number is exactly what present-without-
    // creating-questions forbids. Flag, never guess the missing basis.
    id: "MARKET_COUNT_HAS_PROVENANCE",
    severity: "repair",
    why: "a count of other listings must name what it is of: identity, province, read dates, the price it was counted against, and an arithmetic that closes",
    applies: (a) => a?.marketCount?.state === "confirmed",
    holds: (a) => {
      const m = a.marketCount;
      const n = num(m.n), below = num(m.below), same = num(m.same);
      return n > 0 && !!m.province && !!m.seenMax && !!m.year && !!m.make && !!m.model && num(m.price) > 0
        && below + same <= n
        && (m.dealers == null || (num(m.dealers) > 0 && num(m.dealers) <= n))
        && ((m.scope !== "trim" && m.scope !== "trim_family") || !!m.trimLabel)
        && !m.truncated
        && (a.quotedPrice == null || Math.abs(num(m.price) - num(a.quotedPrice)) < 1);
    },
    // A count that cannot name its basis is demoted to unchecked: the card then
    // says no listing set was read, which is the only claim still backed.
    repair: (a) => { a.marketCount = { ...a.marketCount, state: "unchecked", reason: "provenance_missing" }; },
  },
  {
    // "If you do nothing, this page gives you N months..." is a claim about
    // the page's PRE-SELECTED state. Only the page's own feed, embedded
    // settings or visible sentence can back that (page-default.js); the
    // model's financing read cannot say what was pre-selected, and an
    // injected value (the old hardcoded "monthly") is not a reading. A
    // confirmed default from anywhere else is demoted to unchecked -- the card
    // then says "Not read -- ask the dealer" instead of asserting a default.
    id: "PAGE_DEFAULT_READ_FROM_PAGE",
    severity: "repair",
    why: "a 'this page pre-selects' claim may only come from the page's own data or text, never the model",
    applies: (a) => a?.pageDefault?.state === "confirmed",
    holds: (a) => a.pageDefault.checked === true && PAGE_DEFAULT_SOURCES.has(String(a.pageDefault.source))
      && ((a.pageDefault.termMonths != null && num(a.pageDefault.termMonths) > 0)
        || (a.pageDefault.apr != null && num(a.pageDefault.apr) >= 0)),
    repair: (a) => {
      a.pageDefault = { ...a.pageDefault, state: "unchecked", reason: "source_not_page", termMonths: null, paymentFrequency: null, apr: null, downPayment: null, paymentAmount: null };
    },
  },
  {
    // Kramer Mazda family, narrative half. The NUMBERS get gap-filled after
    // whichever pass wrote the prose, so a report could show "$43,481 · price
    // verified" beside a verdict insisting the listing "contains no pricing
    // information at all" (albertahonda.com 2027 HR-V EX-L, 2026-08-14 --
    // vision pass wrote the summary from a capture that predated the price
    // recovery). A report that contradicts itself is worse than one that says
    // less: verify the TEXT against the verified figures before anything
    // ships, and when they disagree the figures win -- the prose is rebuilt
    // from them, never the other way around.
    id: "SUMMARY_MATCHES_PRICE",
    severity: "repair",
    why: "the narrative may never deny a price the report itself displays",
    // The three original alternatives cover a summary that says the price is
    // ABSENT. They miss the shape a price-GATED page produces, which is what
    // the D2C recovery work newly makes reachable: the rendered page says
    // "Call for pricing" / "contact the dealer for pricing", the vision pass
    // faithfully writes that into the summary, and THEN the structured-data
    // gap-fill recovers a real number -- leaving prose that tells the buyer to
    // phone for a price the report prints two inches above. Same defect class
    // as the HR-V case in the comment above, just reached by a different
    // route, so it belongs in the same guard rather than a parallel one.
    applies: (a) => hasPrice(a) && typeof a.summary === "string"
      && (/\bno (?:pricing|price|advertised(?: selling| asking)? price)\b(?![-–])|\bprice (?:is |was )?not (?:shown|disclosed|advertised|published|present)\b|\b(?:doesn'?t|does not|do not) disclose\b[^.]{0,60}\bpric/i.test(a.summary)
        || /\b(?:call|contact|ask|inquire|enquire)\b[^.]{0,40}\bfor\b[^.]{0,20}\bpric/i.test(a.summary)
        || /\bprice\b[^.]{0,30}\b(?:on request|upon request|available on request|hidden|withheld|gated)\b/i.test(a.summary)),
    holds: () => false,
    repair: (a) => {
      const price = Math.round(num(a.quotedPrice)).toLocaleString("en-CA");
      const vehicle = typeof a.vehicle === "string" && a.vehicle.trim() ? a.vehicle.trim() : "This vehicle";
      a.summary = `${vehicle} is advertised at $${price} on the dealer's own listing page. The figures on this report were read from the page's own data and rendered view. Confirm the out-the-door total, any add-on fees, and financing details directly with the dealer before signing anything.`;
    },
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
