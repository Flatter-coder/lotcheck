// THE CARD THE BUYER OPENS AT THE DESK.
//
// A LotCheck report is long because it has to be: every figure names its source
// and says what it is. That is right for the twenty minutes before you go, and
// wrong for the ninety seconds while a salesperson slides paperwork across a
// table. This builds the short version.
//
// IT IS A VIEW, NOT AN AUTHOR. Every item here is already somewhere in the full
// report, computed by the module that owns it -- docfee.ts for the fee, the
// recall check for recalls, leverage.ts for the dollars, deal.ts for the words.
// Nothing is derived here that is not derived there, and no claim appears on
// this card that the report does not already make. A short surface that invents
// its own findings is a second author, and two authors per fact is the shape
// behind 21 of 22 defects in the 2026-09-03 audit. [[two-authors-per-fact]]
//
// AND IT DOES NOT COUNT TO THREE. Every mockup of this idea says "3 things to
// check", which is a number chosen for the layout. This prints what the report
// found: one item, or five, or none. If it is none it says so plainly and
// refuses to turn that into a verdict about the car.

import { leverageHeadline } from "./leverage.ts";

export type SignItem = {
  /** RAISE -- worth money or a real risk. NOTE -- true and worth knowing. */
  tone: "raise" | "note";
  /** Four or five words. The buyer is reading this standing up. */
  label: string;
  /** The figure or fact, already computed elsewhere. */
  detail: string;
};

export type BeforeYouSign = {
  items: SignItem[];
  /** The exact words, from the counter-script. Never rewritten here. */
  questions: string[];
  /** The dollars, from leverage.ts. Null when the report can name none. */
  total: number | null;
  /** One line for the top of the card. */
  line: string;
};

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const money = (n: number): string => "$" + Math.round(n).toLocaleString("en-CA");

export function beforeYouSign(a: any): BeforeYouSign {
  const items: SignItem[] = [];
  const head = leverageHeadline(a);

  // Money the report already flagged, itemised the way the report itemises it.
  for (const d of head.dollars) {
    items.push({ tone: "raise", label: "Money on the table", detail: `${money(num(d.amount))} ${d.label}` });
  }

  // A fee sitting at or above the manufacturer's own published maximum. The
  // provenance check rides along: a single-model ceiling is named for what it
  // is rather than called the brand's maximum. [[fee-catalog]]
  const df = a?.docFeeCheck;
  if (df && num(df.mfrCeiling) > 0) {
    const brandBacked = df.mfrCeilingProvenance !== "single-model";
    const where = df.mfrCeilingRegion ? ` in ${df.mfrCeilingRegion}` : "";
    // TWO PHRASINGS, because one of them must NOT carry the figure. The
    // at-the-cap branch already opens with the fee, and there the fee and the
    // ceiling are the SAME NUMBER, so folding the amount into the authority
    // printed "$999 is exactly Toyota's published maximum in AB of $999" -- the
    // same figure twice in nine words, which reads like two different figures
    // that happen to match. Caught on 2026-09-17 by the generated sample, the
    // first surface that ever ran this branch with docFee === mfrCeiling.
    const authority = brandBacked
      ? `${df.mfrCeilingMake}'s published maximum${where}`
      : `the maximum ${df.mfrCeilingMake} publishes for this model line`;
    const max = brandBacked
      ? `${df.mfrCeilingMake}'s published maximum${where} of ${money(num(df.mfrCeiling))}`
      : `the ${money(num(df.mfrCeiling))} maximum ${df.mfrCeilingMake} publishes for this model line`;
    items.push(num(df.mfrCeilingOverBy) > 0
      ? { tone: "raise", label: "Dealer fee over the cap", detail: `${money(num(df.docFee))} is ${money(num(df.mfrCeilingOverBy))} above ${max}.` }
      : { tone: "note", label: "Dealer fee at the cap", detail: `${money(num(df.docFee))} is exactly ${authority} — the most they allow a dealer to add.` });
  }

  // Open recalls. A fact, never a price: the remedy is free.
  const rc = a?.recalls;
  if (rc?.checked && num(rc.count) > 0) {
    const n = num(rc.count);
    items.push({ tone: "raise", label: `${n} open recall${n > 1 ? "s" : ""}`, detail: "Transport Canada lists it as outstanding. Ask for it to be done before delivery, not after." });
  }

  // A licence that is not currently valid. The regulator's own wording, verbatim
  // -- we never characterise it. [[no-accusation-language]]
  const lic = a?.dealerLicence;
  if (lic?.status && lic.state && lic.state !== "valid") {
    items.push({ tone: "raise", label: "Dealer licence", detail: `AMVIC's public registry currently shows "${lic.status}"${lic.legalName ? ` for ${lic.legalName}` : ""}. Ask for the current licence number in writing.` });
  }

  // Financing that does not reconcile, and a price conditional on financing.
  if (a?.financingCheck?.checked && a.financingCheck.consistent === false) {
    items.push({ tone: "raise", label: "Financing doesn't add up", detail: "The rate, term and payment on this listing do not reconcile. Ask for the amortisation in writing." });
  }
  if (a?.financeContingent?.contingent) {
    items.push({ tone: "raise", label: "Price is financing-tied", detail: "This price depends on financing through the dealer. Ask what the cash price is." });
  }

  // No VIN on a new car: you cannot confirm WHICH car this is.
  const isNew = String(a?.vehicleCondition || "").toLowerCase() === "new";
  if (isNew && a?.vinCheck?.present !== true) {
    items.push({ tone: "note", label: "No VIN published", detail: "On a new vehicle the VIN is what identifies the exact build. Ask for it and the factory build sheet before any deposit." });
  }

  // Facts with no dollar figure that the report already surfaced.
  for (const f of head.facts) {
    if (/recall/i.test(f)) continue;                       // already an item above
    items.push({ tone: "note", label: "Worth knowing", detail: f });
  }

  const moves = Array.isArray(a?.counterScript?.moves) ? a.counterScript.moves : [];
  const questions = moves.map((m: any) => String(m?.say || "")).filter(Boolean);

  // The count is the count. No layout ever decides it.
  const raises = items.filter((i) => i.tone === "raise").length;
  const line = raises > 0
    ? `${raises} thing${raises > 1 ? "s" : ""} to raise before you sign.`
    : items.length > 0
      ? "Nothing here carries a price, but these are worth knowing before you sign."
      : "This report found nothing to raise. That is what these checks found, not a guarantee about the car — read the full report before you sign.";

  return { items, questions, total: head.total, line };
}
