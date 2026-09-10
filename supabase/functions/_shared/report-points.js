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
// finance-contingent pricing) are real and are shown — but they are labelled
// "also checked", numbered in their own sequence, and never counted as one of
// the ten. A report that calls a trim-price card "point 12 / 14" has made the
// ten meaningless.
//
// `title` must match the report surfaces verbatim. `marketing` is the buyer-
// facing phrasing for the landing page. check:points asserts both directions.
//
// Point 4, "AMVIC": retitled from "Financing APR" 2026-09-09 (Vic:
// "Financing APR needs to be replace with AMVIC check"), then wired to real
// AMVIC-registry data 2026-09-10 (Vic: "make it real AMVIC data") after a
// live report showed the AMVIC-titled point still carrying a 4.9% financing
// rate -- the 09-09 pass renamed the label only, per that day's explicit
// "just replace the words ... the rest do not touch". Backed by
// dealerLicenceLine() in report-lines.js, the same regulator lookup that
// used to be the separate "Dealer licence · AMVIC" also-checked extra --
// that extra is retired, folded into this point, to avoid the same fact
// appearing twice under two different labels.
export const REPORT_POINTS = [
  { key: "price_vs_msrp",  title: "Price vs MSRP",             marketing: "MSRP verification against manufacturer data" },
  { key: "recalls",        title: "Transport Canada recalls",  marketing: "Open-recall lookup (Transport Canada)" },
  { key: "fees",           title: "Add-ons & fee audit",       marketing: "Fee itemization audit" },
  { key: "dealer_licence", title: "AMVIC",                     marketing: "AMVIC business licence verification" },
  { key: "finance_math",   title: "Financing math",            marketing: "Financing math check" },
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
  "MSRP verified", "Open recalls", "Fee audit", "AMVIC", "Financing math",
  "Odometer check", "VIN pattern", "EV rebate check", "Warranty validity", "Dealer reputation",
];

// A point's title may vary by BRANCH (the email names the dealer when it has
// one) as long as it still starts with the canonical title.
export const POINT_TITLES = REPORT_POINTS.map((p) => p.title);
