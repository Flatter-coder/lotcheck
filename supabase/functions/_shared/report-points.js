// THE TEN POINTS — one list, so the advertisement and the report cannot drift.
//
// WHY THIS EXISTS. There were TWO hand-maintained lists of ten, written in
// different files at different times, neither derived from the other, and they
// did not match. The landing page advertised "Negotiation leverage score" as a
// point — it is the VERDICT computed FROM the points, and has never been one of
// them. Meanwhile "Financing APR", a real point the report delivers, was
// advertised nowhere. So a buyer was promised one check we never run as a point
// and not told about one we do. [[claims-must-stay-backed]]
//
// TEN IS THE FLOOR, NOT THE CEILING. Vic, 2026-08-27: "its always good thing to
// over deliver specially if helps buyer even more, minimum 10 points we will
// keep increasing ... yes we advertising 10 points". Extra checks a listing
// supports (MSRP per trim, comparable listings, days on lot, trade-in widget,
// finance-contingent pricing, AMVIC licence) are real and are shown — but they
// are labelled "also checked", numbered in their own sequence, and never
// counted as one of the ten. A report that calls a trim-price card "point 12 /
// 14" has made the ten meaningless.
//
// `title` must match the report surfaces verbatim. `marketing` is the buyer-
// facing phrasing for the landing page. check:points asserts both directions.

export const REPORT_POINTS = [
  { key: "price_vs_msrp", title: "Price vs MSRP",             marketing: "MSRP verification against manufacturer data" },
  { key: "recalls",       title: "Transport Canada recalls",  marketing: "Open-recall lookup (Transport Canada)" },
  { key: "fees",          title: "Add-ons & fee audit",       marketing: "Fee itemization audit" },
  { key: "apr",           title: "Financing APR",             marketing: "Financing APR against the published rate" },
  { key: "finance_math",  title: "Financing math",            marketing: "Financing math check" },
  { key: "odometer",      title: "Odometer",                  marketing: "Odometer consistency check" },
  { key: "vin",           title: "VIN check",                 marketing: "VIN pattern validity check" },
  { key: "rebate",        title: "EV / PHEV rebate",          marketing: "EV rebate eligibility" },
  { key: "warranty",      title: "Included warranty",         marketing: "Warranty validity" },
  { key: "reputation",    title: "Dealer reputation",         marketing: "Dealer reputation from real reviews" },
];

// The short labels the landing page's animated lane cycles through, in the same
// order. Kept beside the list they label so one cannot be edited without the
// other being visibly stale.
export const REPORT_POINT_SHORT = [
  "MSRP verified", "Open recalls", "Fee audit", "Financing APR", "Financing math",
  "Odometer check", "VIN pattern", "EV rebate check", "Warranty validity", "Dealer reputation",
];

// A point's title may vary by BRANCH (the email names the dealer when it has
// one) as long as it still starts with the canonical title.
export const POINT_TITLES = REPORT_POINTS.map((p) => p.title);
