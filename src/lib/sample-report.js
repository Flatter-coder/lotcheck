// THE ADVERT OUTLIVED THE PRODUCT.
//
// WHAT BROKE. The Quote Check page carried a card headed "Sample LotCheck
// Report / What a finished check looks like", and inside it three dials: a
// LEVERAGE gauge reading 8.2 of 10, a fee gauge at $899 against a marker
// labelled "TYP $499", and a recall dial. Every number was hand-written into
// the JSX, and the block carried a SAMPLE badge.
//
// The badge was doing less work than it looked like. By 2026-09-16 the real
// report had no leverage gauge at all -- PR #486 replaced the 0-10 score with
// the dollars themselves, because an abstract score is a number a buyer cannot
// act on [[design-must-be-self-explanatory]]. It also has no "typical doc fee"
// anywhere: the fee is compared against the MANUFACTURER'S OWN PUBLISHED
// MAXIMUM, a figure we hold with a source and a capture date, never against an
// invented market average. So a buyer read the sample, paid, and received a
// different product measured a different way.
//
// SAMPLE IS A CLAIM ABOUT THE NUMBERS, NOT A LICENCE ABOUT THE PRODUCT. It
// says "these figures are invented". It does not say "this format is invented",
// and nobody reads it that way -- the whole point of the card is to show what
// arrives. Hand-writing the format made the advert a SECOND AUTHOR of what a
// LotCheck report is, and two authors per fact is the shape behind 21 of 22
// defects in the 2026-09-03 audit. [[two-authors-per-fact]]
//
// It is also the failure named in [[run-every-gate-before-done]] from the other
// side: a DELETED surface passes every negative check written about it. Nothing
// failed when the leverage gauge was removed from the report, because the only
// copy still standing was the one in the ad, and no test knew it was there.
//
// THE FIX IS NOT BETTER SAMPLE NUMBERS. It is to stop writing the sample. This
// file holds INPUTS -- an invented vehicle and invented findings -- and the
// page renders them through beforeYouSign(), the same builder the real report
// calls. The sample cannot drift from the product again, because it IS the
// product, run on made-up inputs. When a builder changes, the sample changes
// with it or the build fails.
//
// WHAT MAY GO IN HERE. Invented inputs only: no dollar figure below is a
// measurement of anything, and none of it is rendered directly -- every string
// a visitor reads is composed by the builder from these numbers. There is no
// dealer name and no VIN, because a sample must not resolve to a real business
// or a real car [[ai-defamation-entity-match-lesson]], and no figure here is
// presented anywhere as a market rate.
//
// THE FEE IS AT THE CAP, NOT OVER IT, AND THAT IS DELIBERATE. Showing an
// invented Toyota dealer charging over Toyota's published maximum would use a
// real brand to illustrate misconduct nobody committed [[no-accusation-language]].
// Sitting exactly on the published ceiling demonstrates the same check, is the
// commoner real outcome, and accuses no one.

/** @type {Record<string, any>} */
export const SAMPLE_ANALYSIS = {
  sample: true,

  year: 2024,
  make: "Toyota",
  model: "RAV4",
  trim: "XLE",
  vehicleCondition: "used",

  // Fees and add-ons the report flagged, in total. leverage.ts renders this as
  // "$1,794 in fees and add-ons this report flagged".
  totalFlaggedCost: 1794,

  // A documentation fee sitting EXACTLY on the manufacturer's published
  // maximum. The ceiling, the make, the region and the provenance are the same
  // fields fee-schedule.ts fills on a real scan, so the sample exercises the
  // brand-level wording path rather than the single-model one.
  docFeeCheck: {
    checked: true,
    docFee: 999,
    mfrCeiling: 999,
    mfrCeilingOverBy: 0,
    mfrCeilingMake: "Toyota",
    mfrCeilingProvenance: "policy",
    mfrCeilingRegion: "AB",
  },

  // Recalls are a FACT, never a price -- the remedy is free. The builder
  // enforces that; this only supplies the count.
  recalls: { checked: true, count: 2 },

  daysOnLot: { days: 74 },

  // Not applicable to this sample, spelled out rather than left undefined so
  // the fixture shows which checks it deliberately does not exercise.
  financingCheck: { checked: true, consistent: true },
  financeContingent: { contingent: false },
  vinCheck: { present: true },
  dealerLicence: { state: "valid", status: "Licensed" },

  // The questions are the counter-script's own words. They are written to be
  // safe to say out loud to a named licensee, so the sample must not paraphrase
  // them into something sharper than what the product actually hands a buyer.
  counterScript: {
    moves: [
      { say: "Your listing shows $999 in documentation fees. That is exactly Toyota's published maximum — is there room on it?" },
      { say: "Transport Canada lists two open recalls on this vehicle. Can both be completed before I take delivery?" },
      { say: "This one has been advertised for 74 days. What is the number that moves it today?" },
    ],
  },
};
