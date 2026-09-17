// What this listing charges to deliver the car, against what the manufacturer
// publishes for the same model in the same province.
//
// WHY THIS EXISTS. Vic, 2026-09-17, holding two pages side by side for the same
// 2026 BMW X3 30 xDrive at the same $60,400 MSRP:
//
//   BMW Canada's own configurator, Province = Alberta
//     Freight & PDI                              $3,470
//     Retailer Administration Fee (up to)          $595
//
//   BMW Royal Oak, Calgary, the listing a buyer actually reads
//     Freight and PDI                            $4,395
//     "Other Fees"                               $989.75
//
// $925 more on the freight line and $394.75 over BMW's own published admin
// maximum. His read: freight is where fees hide. It is the best line in the
// whole stack to load, because a buyer who would argue about a $989 admin fee
// will not argue about freight -- freight reads as a fact of the car, a
// pass-through nobody chose, rather than a number someone set.
//
// WHAT THIS IS CAREFUL ABOUT, and why the copy is shaped the way it is.
//
// We have been wrong in the OTHER direction on this exact surface. A bundled
// "Fees & Accessories $3,330" line was mostly NOT the dealer's money -- $2,205
// of Lexus freight, $100 federal A/C, $30 of provincial levies -- and the
// counter-script told the buyer to read aloud: "please take off the $3,330 in
// dealer add-ons". We printed the manufacturer's own freight as dealer markup.
// [[fee-decomposition-and-capture]]
//
// So this line never says a dealer added anything. It states two published
// figures and the arithmetic between them, names the manufacturer's own page as
// the authority, and asks the buyer to ask. The difference may be a genuinely
// different destination cost, a model-year change, or a figure we captured for a
// different trim. The buyer is the one holding the context, and the dealer is
// the one who can answer. [[no-accusation-language]] [[make-it-dispute-proof]]
//
// It also refuses rather than guesses. No published figure for the model, no
// readable freight line on the listing, or a province we did not establish --
// each returns a state that says which, and no comparison is drawn.

import { freightFor } from "./fee-schedule.ts";

export type FreightState =
  | "compared"        // both figures known, and they agree
  | "above"           // the listing charges more than the maker publishes
  | "listing_only"    // read the listing's figure; hold no published one
  | "published_only"  // hold a published figure; the listing states none
  | "not_read";       // neither

export interface FreightLine {
  state: FreightState;
  listing: number | null;
  published: number | null;
  delta: number | null;        // listing - published, when both are known
  make: string | null;
  model: string | null;
  source: string | null;       // the manufacturer page the published figure came from
  capturedOn: string | null;
  headline: string;
  explain: string;
}

// The labels a Canadian listing uses for this line. Deliberately the same
// vocabulary fee-vocab.ts maps to "freight_pdi", kept here so this module can be
// tested without the fee pipeline.
const FREIGHT_LABEL = /(freight|pdi|pre[- ]?delivery|destination|delivery and destination|transport(ation)?\s*charge)/i;

// Labels that CONTAIN a freight word but are not the freight line. "Delivery"
// alone is how some platforms label a home-delivery service charge, and folding
// that into a freight comparison would compare two different things.
const NOT_FREIGHT = /(home delivery|delivery credit|free delivery|delivery fee waived)/i;

const money = (n: number) => "$" + Math.round(n).toLocaleString("en-CA");

/** The listing's own freight figure, from its itemised lines. Null when absent. */
export function listingFreight(a: any): number | null {
  const pools: any[] = [];
  if (Array.isArray(a?.addOns)) pools.push(...a.addOns.map((x: any) => ({ name: x?.name, amount: x?.price })));
  if (Array.isArray(a?.dealerLineItems?.fees)) pools.push(...a.dealerLineItems.fees.map((f: any) => ({ name: f?.label ?? f?.name, amount: f?.amount })));
  for (const p of pools) {
    const label = String(p?.name || "");
    if (!FREIGHT_LABEL.test(label) || NOT_FREIGHT.test(label)) continue;
    const n = Number(p?.amount);
    // A freight charge is never a small number, and never a vehicle price.
    if (Number.isFinite(n) && n >= 900 && n <= 9000) return n;
  }
  return null;
}

export function freightLine(a: any): FreightLine {
  const make = a?.make ? String(a.make) : null;
  const model = a?.model ? String(a.model) : null;
  const listing = listingFreight(a);
  const pub = make && model ? freightFor(make, model) : null;
  const published = pub ? pub.amount : null;

  const base = {
    listing, published, make, model,
    source: pub ? pub.source : null,
    capturedOn: pub ? pub.capturedOn : null,
    delta: null as number | null,
  };

  if (listing == null && published == null) {
    return {
      ...base, state: "not_read", headline: "NOT READ",
      explain: "This listing does not state a freight and PDI charge we could read, and we hold no published figure for this model. Ask the dealer what the freight and PDI line is, and what it covers.",
    };
  }

  if (listing == null && published != null) {
    return {
      ...base, state: "published_only", headline: money(published),
      explain: `${make} publishes ${money(published)} for freight and PDI on this model. This listing does not state its own freight line, so there is nothing to compare it against — ask for the figure in writing before you agree a price.`,
    };
  }

  if (listing != null && published == null) {
    return {
      ...base, state: "listing_only", headline: money(listing),
      explain: `This listing charges ${money(listing)} for freight and PDI. We hold no published figure from ${make || "the manufacturer"} for this model, so we are not comparing it to anything — ask the dealer to show you the manufacturer's own number.`,
    };
  }

  // Both known.
  const delta = Math.round((listing as number) - (published as number));
  if (delta <= 0) {
    return {
      ...base, delta, state: "compared", headline: money(listing as number),
      explain: `${make} publishes ${money(published as number)} for freight and PDI on this model. This listing charges ${money(listing as number)}, which is at or below it.`,
    };
  }

  return {
    ...base, delta, state: "above", headline: `${money(listing as number)} · ${money(delta)} above published`,
    // Two figures and the arithmetic between them. No claim about who added what
    // or why -- that is the dealer's to answer and the buyer's to ask.
    explain: `${make} publishes ${money(published as number)} for freight and PDI on this model. This listing charges ${money(listing as number)} — ${money(delta)} more. Freight is a pass-through, so ask what the difference covers and ask for it in writing.`,
  };
}
