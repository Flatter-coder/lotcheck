// ============================================================================
// fee-schedule.ts — the government + manufacturer fee catalog behind an all-in
// price. Same discipline as docfee.ts: hardcoded, SOURCED, counsel-verifiable
// constants. Every figure carries where it came from and when it was captured.
//
// WHY THIS EXISTS. An Alberta advertised price is all-in: MSRP plus freight,
// A/C charge, levies, regulator fees and the dealer's admin fee, all inside the
// number. We already store the manufacturer's captured all_in_price per trim
// (20260815_msrp_all_in_price.sql). What we did NOT have is the DECOMPOSITION —
// the itemised fees that make up that all-in — and, most usefully, each brand's
// OWN published maximum dealer fee. This module is that catalog.
//
// SCOPE OF EACH FEE (from real Build & Price captures, cross-validated Toyota
// vs Lexus in Alberta on 2026-08-15 / 2026-08-25):
//   federal   — same across Canada, any brand          (A/C excise $100)
//   province  — same for every brand in that province  (AMVIC, tire levy, env, PPSA)
//   brand     — the manufacturer's published MAX dealer fee (Toyota $999, Lexus $995)
//   model     — freight / Delivery & Destination        (varies by make AND model)
//
// The universal trio proves the province-scope claim: A/C $100, AMVIC $10 and
// Tire Levy $25 were IDENTICAL on the Toyota RAV4 and the Lexus ES summaries.
// So seeding Alberta once covers those lines for all 31 makes; only freight and
// the dealer-fee ceiling are per-brand.
//
// HARD RULE (inherited from 20260815_msrp_all_in_price.sql): the AUTHORITATIVE
// all-in for a trim is the manufacturer's CAPTURED all_in_price, never the sum
// of these parts. Brands itemise differently — Toyota's proven $3,078 of adds
// omits the sub-$5 environmental fees Lexus lists. Use this catalog to EXPLAIN
// an all-in and to hold each brand's dealer-fee ceiling. Never use it to
// overwrite a captured all_in_price, and never fabricate a figure we have not
// captured from the manufacturer (freightFor/dealerFeeCeiling return null when
// we have no sourced row — a missing brand is a gap to capture, not to guess).
// ============================================================================

export type Scope = "federal" | "province" | "brand" | "model";
export type Applies = "always" | "finance" | "lease";

export interface Fee {
  component: string;   // stable key: ac_charge, amvic, tire_levy, env_filters, ...
  label: string;       // the manufacturer's own line label
  amount: number;      // CAD
  applies: Applies;    // "always", or financing-conditional (PPSA)
  scope: Scope;
  region?: string;     // province code (province scope; brand ceiling if province-qualified)
  make?: string;
  model?: string;
  source: string;      // where the figure was read
  // THE PAGE, NOT THE PROSE. `source` describes where a figure came from;
  // this is the URL a job can actually re-fetch. A figure whose source is
  // only a sentence cannot be re-read by anything, which is how eleven
  // freight charges sat unchecked from the day they were typed.
  // verify-freight-catalog.mjs reports a row without one as `no_source`.
  sourceUrl?: string;
  capturedOn: string;  // ISO date it was read
  // BRAND-SCOPE ROWS ONLY — how strong the evidence is, so a caller can match
  // the strength of its CLAIM to it:
  //   "policy"       the brand's own published policy statement ("dealer fees
  //                  of up to $X"), quoted verbatim in `source`. Safe to
  //                  describe as "<Make>'s own published maximum".
  //   "single-model" a figure itemised on ONE model's build/price sheet. Real,
  //                  and safe to flag a fee ABOVE it, but it does not evidence
  //                  a brand-wide maximum and must not be called one.
  provenance?: "policy" | "single-model";
  note?: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const norm = (s: unknown): string => String(s ?? "").trim().toLowerCase();

// ── Federal — one A/C excise, same for any brand nationwide ─────────────────
const FEDERAL: Fee[] = [
  { component: "ac_charge", label: "Air Conditioning Charge", amount: 100, applies: "always", scope: "federal",
    source: "Toyota & Lexus Canada Build & Price — identical $100", capturedOn: "2026-08-25",
    note: "Federal excise on factory air conditioning; same for any brand nationwide." },
];

// ── Province — same for every brand sold in that province ───────────────────
// Alberta only for now (home market). Other provinces differ (no AMVIC in ON,
// different tire levies, etc.) and must be captured before they are added.
const PROVINCE: Record<string, Fee[]> = {
  AB: [
    { component: "amvic", label: "AMVIC", amount: 10, applies: "always", scope: "province", region: "AB",
      source: "Toyota & Lexus Canada B&P (Alberta) — identical $10", capturedOn: "2026-08-25" },
    { component: "tire_levy", label: "Tire Levy", amount: 25, applies: "always", scope: "province", region: "AB",
      source: "Toyota & Lexus Canada B&P (Alberta) — identical $25", capturedOn: "2026-08-25" },
    { component: "env_filters", label: "Environmental Handling Fee - Filters", amount: 1.10, applies: "always", scope: "province", region: "AB",
      source: "Lexus Canada B&P (Alberta)", capturedOn: "2026-08-25",
      note: "Itemised by Lexus; a brand's captured all-in may not list the sub-$5 env fees." },
    { component: "env_lube", label: "Environmental Handling Fee - Lube Oil", amount: 1.08, applies: "always", scope: "province", region: "AB",
      source: "Lexus Canada B&P (Alberta)", capturedOn: "2026-08-25",
      note: "Itemised by Lexus; a brand's captured all-in may not list the sub-$5 env fees." },
    // PPSA only when the deal is financed or leased; the amount differs between them.
    { component: "ppsa_fee", label: "PPSA Fee", amount: 14, applies: "finance", scope: "province", region: "AB",
      source: "Toyota & Lexus Canada B&P (Alberta, financed)", capturedOn: "2026-08-25" },
    { component: "ppsa_fee", label: "PPSA Fee", amount: 10, applies: "lease", scope: "province", region: "AB",
      source: "Lexus Canada B&P (Alberta, lease)", capturedOn: "2026-08-25" },
    { component: "ppsa_service", label: "PPSA Service Fee", amount: 4, applies: "finance", scope: "province", region: "AB",
      source: "Lexus Canada B&P (Alberta)", capturedOn: "2026-08-25" },
    { component: "ppsa_service", label: "PPSA Service Fee", amount: 4, applies: "lease", scope: "province", region: "AB",
      source: "Lexus Canada B&P (Alberta)", capturedOn: "2026-08-25" },
  ],
};

// ── Brand — the manufacturer's OWN published maximum dealer fee ──────────────
// Not every OEM publishes one; absence here means "no sourced ceiling", never
// "no fee" (Ford, GMC, Honda, Jeep, Kia, Ram, Subaru confirmed to publish none).
// Most OEMs publish ONE national string ("dealer fees of up to $X"), so those
// rows carry no region and apply wherever docfee.ts fires (the all-in provinces).
// Each figure is the published MAXIMUM ("up to $X") read verbatim from an
// official source on the date shown; the flag fires only ABOVE it, so a dealer
// charging within "up to $X" is never flagged.
//
// A ROW MAY BE REGION-QUALIFIED. Toyota is the proven case: Toyota Canada runs
// separate regional storefronts and they do NOT publish the same number — the
// Prairies and Ontario pages say $999, British Columbia & Yukon says $990. A
// region-qualified row always beats the unqualified one for that province (see
// dealerFeeCeiling), so a reader is told their own region's figure and never a
// neighbouring province's.
//
// PROVENANCE RULE (2026-09-15). A ceiling is a claim about the BRAND, so it has
// to be read from a source that speaks for the brand. Until today Toyota's row
// was sourced to "Build & Price — 2026 RAV4", one model's configurator, and the
// report then told a 4Runner buyer that $999 was "Toyota's own published
// maximum". The figure turned out to be right, but the record could not carry
// the claim — it evidenced one model. Every brand-scope row now cites either a
// brand-level disclaimer or a capture corroborated across model lines, and says
// in `source` which of the two it is.
const DEALER_FEE_CEILING: Fee[] = [
  // Toyota — the Prairies (AB/SK/MB) and Ontario publish $999. Read verbatim
  // from Toyota Canada's own regional storefront legal page, which is
  // brand-level ("Your Dealer may charge additional fees for documentation,
  // administration and other products such as undercoat, which range $0 to
  // $999"), and corroborated in the per-model footnotes on EIGHT separate model
  // lines — 4Runner SR5, GR86, Camry, RAV4, Tundra, Tacoma, Highlander Hybrid,
  // Prius — each reading "up to $999 retailer administration fee". The 2026
  // 4Runner SR5 (VA5BRT A) Alberta footnote is the one that settles the report
  // that exposed this: Toyota itself prices that vehicle with $999 inside.
  //
  // NOTE THE SCOPE TOYOTA STATES: the $0–$999 covers "documentation,
  // administration AND OTHER PRODUCTS SUCH AS UNDERCOAT". It caps that whole
  // bundle, not a documentation fee on its own.
  { component: "dealer_fee_ceiling", label: "retailer administration fee (up to $999)", amount: 999, applies: "always", scope: "brand", make: "Toyota",
    source: "Toyota Canada regional storefront legal page (shoptoyota.ca/alberta/en/legal) — \"additional fees for documentation, administration and other products such as undercoat, which range $0 to $999\"; the same $999 in the per-model footnotes for 4Runner SR5, GR86, Camry, RAV4, Tundra, Tacoma, Highlander Hybrid and Prius, and on the Ontario storefront", capturedOn: "2026-09-15", provenance: "policy",
    note: "Published maximum. Covers documentation, administration and add-on products, not documentation alone. In an all-in province it must already be inside the advertised price. British Columbia & Yukon publish $990 — see the BC row." },
  // Toyota — British Columbia & Yukon publish a LOWER maximum. Same wording,
  // different figure, on Toyota Canada's own BC storefront. Without this row a
  // BC listing at $995 would have been told $999 was "Toyota's own published
  // maximum" for it, which is not what Toyota publishes there.
  { component: "dealer_fee_ceiling", label: "retailer administration fee (up to $990)", amount: 990, applies: "always", scope: "brand", make: "Toyota", region: "BC",
    source: "Toyota Canada BC & Yukon storefront legal page (shoptoyota.ca/british-columbia/en/legal) — \"additional fees for documentation, administration, and other products such as undercoat up to $990\"; the same $990 in the 2025 RAV4 LE AWD footnote", capturedOn: "2026-09-15", provenance: "policy",
    note: "British Columbia & Yukon only. Toyota publishes $999 in the Prairies and Ontario." },
  // Lexus — SINGLE-MODEL, and checked again on 2026-09-15 rather than left as a
  // gap nobody had looked at. Lexus Canada does NOT publish a dealer-fee maximum
  // the way Toyota does. Its own Alberta-scoped offer footnotes itemise the
  // mandatory adds — "$2,205 Delivery and Destination charge; $100 A/C charge;
  // regulatory fees (up to $46.28); lien registration fees (up to $79.00,
  // including lien registering agent fee); as well as all other applicable fees,
  // levies and duties (all of which may vary by region and dealer)" — with NO
  // administration-fee line at all, where every equivalent Toyota footnote reads
  // "up to $999 retailer administration fee". Same corporate entity (Lexus is a
  // division of Toyota Canada Inc.), different disclosure, so the $999 cannot be
  // carried across and no brand-level Lexus sentence exists to quote.
  //
  // The $995 stays: it is a real figure Lexus's own configurator applied to a
  // build, and a fee above it is still a backed comparison. It is tagged
  // single-model so no caller calls it "Lexus's own published maximum", and this
  // note records that the brand-level source was looked for and is not there —
  // an answered question, not an open one.
  { component: "dealer_fee_ceiling", label: "Dealer Fees", amount: 995, applies: "always", scope: "brand", make: "Lexus",
    source: "Lexus Canada Build & Price — 2026 ES 350h (Alberta)", capturedOn: "2026-08-25", provenance: "single-model",
    note: "A figure from ONE build summary, not a published brand maximum. Checked 2026-09-15: Lexus Canada's own offer fine print itemises delivery, A/C, regulatory and lien fees and carries no administration-fee line, so there is no brand-level \"up to $X\" to cite." },
  { component: "dealer_fee_ceiling", label: "dealer admin fee (up to $799)", amount: 799, applies: "always", scope: "brand", make: "Hyundai",
    source: "Hyundai Canada (hyundaicanada.com/en/special-offers/vehicles) — \"dealer admin. fees of up to $799\"", capturedOn: "2026-08-25", provenance: "policy",
    note: "\"Fees may vary by dealer.\" Some models publish $599; $799 is the highest published figure, used as the max." },
  { component: "dealer_fee_ceiling", label: "retailer administration fee (up to $795)", amount: 795, applies: "always", scope: "brand", make: "Mazda",
    source: "Mazda Canada (mazda.ca/en/vehicles/cx-5) — \"retailer administration fee (up to $795)\"", capturedOn: "2026-08-25", provenance: "policy" },
  { component: "dealer_fee_ceiling", label: "dealer admin fee (up to $750)", amount: 750, applies: "always", scope: "brand", make: "Volkswagen",
    source: "Volkswagen Canada (vw.ca/offers) — \"representative dealer admin fee (actual fee is set by dealers and varies, up to $750)\"", capturedOn: "2026-08-25", provenance: "policy",
    note: "Framed as a \"representative\" fee, but explicitly capped at \"up to $750\"." },
  { component: "dealer_fee_ceiling", label: "dealer fee (up to $699)", amount: 699, applies: "always", scope: "brand", make: "Chevrolet",
    source: "Chevrolet Canada Build & Price disclaimer (chevrolet.ca) — \"up to $699 dealer fee\"", capturedOn: "2026-08-25", provenance: "policy",
    note: "GM's B&P applies a $350 default in-build, but the published maximum is $699; we flag only ABOVE $699 to stay conservative." },
  { component: "dealer_fee_ceiling", label: "dealer fees (up to $621)", amount: 621, applies: "always", scope: "brand", make: "Nissan",
    source: "Nissan Canada (canada.nissannews.com, 2026 Rogue pricing) — \"dealer fees (up to $621)\"", capturedOn: "2026-08-25", provenance: "policy",
    note: "\"May vary by region and dealer.\"" },
  // Batch 2 (2026-08-26). MINI read verbatim in-session; BMW is the same BMW Group
  // policy (identical wording, verified via MINI); Buick/Cadillac carry GM's one
  // national B&P disclaimer, the same "up to $699 dealer fee" string as Chevrolet.
  { component: "dealer_fee_ceiling", label: "retailer administration fees (up to $595)", amount: 595, applies: "always", scope: "brand", make: "MINI",
    source: "MINI Canada (mini.ca/en/special-offers) — \"retailer administration fees (up to $595)\"", capturedOn: "2026-08-26", provenance: "policy" },
  { component: "dealer_fee_ceiling", label: "retailer administration fees (up to $595)", amount: 595, applies: "always", scope: "brand", make: "BMW",
    source: "BMW Canada (bmw.ca) — \"retailer administration fees (up to $595)\"; same BMW Group policy verified verbatim on MINI", capturedOn: "2026-08-26", provenance: "policy" },
  { component: "dealer_fee_ceiling", label: "dealer fee (up to $699)", amount: 699, applies: "always", scope: "brand", make: "Buick",
    source: "GM Canada Build & Price disclaimer (buick.ca) — \"up to $699 dealer fee\" (GM's national string, same as Chevrolet)", capturedOn: "2026-08-26", provenance: "policy",
    note: "Flag only ABOVE $699 (GM applies a lower default in-build)." },
  { component: "dealer_fee_ceiling", label: "dealer fee (up to $699)", amount: 699, applies: "always", scope: "brand", make: "Cadillac",
    source: "GM Canada Build & Price disclaimer (cadillaccanada.ca) — \"up to $699 dealer fee\" (GM's national string, same as Chevrolet)", capturedOn: "2026-08-26", provenance: "policy",
    note: "Flag only ABOVE $699 (GM applies a lower default in-build)." },
  // Held-list cleared 2026-08-26: verified verbatim at the official source.
  { component: "dealer_fee_ceiling", label: "retailer administration fee (up to $699)", amount: 699, applies: "always", scope: "brand", make: "Volvo",
    source: "Volvo Car Canada (volvocars.com/en-ca/offers) — \"retailer administration fee (up to $699)\"", capturedOn: "2026-08-26", provenance: "policy",
    note: "May vary by region and retailer." },
  { component: "dealer_fee_ceiling", label: "dealer fees (up to $921)", amount: 921, applies: "always", scope: "brand", make: "Infiniti",
    source: "Infiniti Canada (canada.infinitinews.com, 2025 QX60 pricing) — \"dealer fees (up to $921)\"", capturedOn: "2026-08-26", provenance: "policy",
    note: "Premium division — NOT Nissan's $621. May vary by region and dealer." },
  { component: "dealer_fee_ceiling", label: "Dealer/administrative fees of up to $799", amount: 799, applies: "always", scope: "brand", make: "Mitsubishi",
    source: "Mitsubishi Canada Build & Price disclaimer (mitsubishi-motors.ca) — \"Dealer/administrative fees of up to $799\"", capturedOn: "2026-08-26", provenance: "policy" },
  // GMC: GM's Build & Price is Akamai-blocked to every tool, so no GMC-specific
  // capture was possible. GM's dealer-fee disclaimer is corporate-GENERAL ("up to
  // $699 dealer fee"), verified verbatim on three sibling brands (Chevrolet, Buick,
  // Cadillac) that run the identical GM B&P engine. Added on that deduction; flag
  // only ABOVE $699. If GMC ever needs its own verbatim, it stays un-crawlable.
  { component: "dealer_fee_ceiling", label: "dealer fee (up to $699)", amount: 699, applies: "always", scope: "brand", make: "GMC",
    source: "GM Canada national B&P disclaimer — \"up to $699 dealer fee\" (verified on Chevrolet/Buick/Cadillac; GMC B&P Akamai-blocked from direct capture)", capturedOn: "2026-08-26", provenance: "policy",
    note: "Inferred from GM's corporate-wide disclaimer, not a GMC-specific page. Flag only ABOVE $699." },
];

// ── Model — freight / Delivery & Destination, per make AND model ────────────
const FREIGHT: Fee[] = [
  // ── Captured 2026-09-17, each figure read off an official Canadian page and
  //    then CONFIRMED by a second independent read of a different page. Seven
  //    more makes returned a figure that the second read could not corroborate
  //    and are deliberately absent -- see the note at the end of this block.
  //
  //    These are the first freight rows carrying a `sourceUrl`, which is what
  //    lets verify-freight-catalog.mjs re-read them daily. The twelve rows
  //    below them name their source in prose only, so nothing can check them;
  //    the verifier reports that as a backlog rather than as drift.
  // CAPTURED FROM BMW CANADA'S OWN CONFIGURATOR WITH PROVINCE = ALBERTA, and the
  // province is provable from the page itself: it itemises a "Motor Vehicle
  // Industry Council Fee" of $10, which is AMVIC. An earlier capture quoted BMW
  // at "up to $2,955" and was REFUSED for this catalogue because that page
  // itemised OMVIC -- it was the Ontario rendering of a province-selected
  // disclaimer, and the figure was a CEILING rather than a price.
  //
  // The same page prices the retailer administration fee at "(up to) $595",
  // which is exactly the BMW ceiling already in DEALER_FEE_CEILING -- an
  // independent confirmation of a figure captured weeks earlier elsewhere.
  //
  // WHY IT MATTERS BEYOND COVERAGE. A Calgary listing for the same nameplate at
  // the same $60,400 MSRP charges $4,395 freight and PDI -- $925 above what BMW
  // itself publishes for Alberta -- and prices its admin line at $989.75 against
  // BMW's published $595 maximum. Freight reads to a buyer as a fact of the car
  // rather than a number anyone chose, which makes it the easiest line in the
  // stack to load. This figure is what lets the report say so from the
  // manufacturer's own page instead of from an inference.
  { component: "freight", label: "Freight & PDI", amount: 3470, applies: "always", scope: "model", make: "BMW", model: "X3",
    region: "AB",
    sourceUrl: "https://www.bmw.ca/en/ssl/build-your-own.html",
    // freight and PDI together, MY2026, Alberta-scoped price overview.
    source: "BMW Canada configurator, Price Overview with Province = Alberta, captured 2026-09-17 -- \"MSRP $60,400 / Freight & PDI $3,470 / Retailer Administration Fee (up to) $595 / Air Conditioning Levy $100 / Tire Recycling Fee $20 / Motor Vehicle Industry Council Fee $10 / Total Selling Price $64,595\"", capturedOn: "2026-09-17" },
  { component: "freight", label: "Destination Charge", amount: 2950, applies: "always", scope: "model", make: "Porsche", model: "Macan",
    sourceUrl: "https://configurator.porsche.com/en-CA/3061/mode/model/95BAU1/exclusive-manufaktur",
    // freight/destination only, PDI not included. MY2026. Confirmed against a second source: https://configurator.porsche.com/en-CA/mode/model/95BBV1/group/26026
    source: "Porsche Canada, captured 2026-09-17 and confirmed by an independent second read \u2014 \"Estimated Total Price* $73,535 | Base price $67,700 | Price for Equipment $0 | Estimated Maximum Dealer Fee $2,750 | Est\"", capturedOn: "2026-09-17" },
  { component: "freight", label: "Freight and PDI", amount: 2000, applies: "always", scope: "model", make: "Honda", model: "CR-V",
    sourceUrl: "https://hondanews.ca/en-CA/hci-automobiles/releases/release-04150531cb93adf566aca863300f8f08-rugged-electrified-and-refreshed-best-selling-honda-cr-v-hybrid-gains-new-trailsport-hybrid-trim-and-more-standard-tech",
    // freight and PDI together. MY2026. Confirmed against a second source: https://www.honda.ca/en/stretch-lease
    source: "Honda Canada, captured 2026-09-17 and confirmed by an independent second read \u2014 \"Selling Price includes MSRP, $2000 for freight and PDI, a $100 A/C charge, Dealer Fees as determined by the dealer (whic\"", capturedOn: "2026-09-17" },
  { component: "freight", label: "Freight and PDI", amount: 2595, applies: "always", scope: "model", make: "Acura", model: "RDX",
    sourceUrl: "https://www.acura.ca/special-offers/",
    // freight and PDI together. MY2026. Confirmed against a second source: https://www.acura.ca/special-offers/alberta
    source: "Acura Canada, captured 2026-09-17 and confirmed by an independent second read \u2014 \"Monthly lease payment is $838.69 – which includes: $2,595.00 Freight and PDI; $100 A/C charge; Regulatory Fees (up to $1\"", capturedOn: "2026-09-17" },
  { component: "freight", label: "PDI Charge and freight (printed itemised: PDI $250 + freight", amount: 2125, applies: "always", scope: "model", make: "Mitsubishi", model: "Outlander",
    sourceUrl: "https://www.mitsubishi-motors-pr.ca/wp-content/uploads/2026/03/MY26-Outlander-1-Page-EN.pdf",
    // freight and PDI together. MY2026. Confirmed against a second source: https://www.mitsubishi-motors-pr.ca/wp-content/uploads/2026/03/MY26-Outlander-PHEV-Price-Guide-E
    source: "Mitsubishi Canada, captured 2026-09-17 and confirmed by an independent second read \u2014 \"PDI Charge $250, freight $1,875 May require body colour paint charge depending on colour.\"", capturedOn: "2026-09-17" },
  { component: "freight", label: "Destination & Delivery", amount: 2595, applies: "always", scope: "model", make: "Lincoln", model: "Nautilus",
    sourceUrl: "https://www.windowsticker.forddirect.com/windowsticker.pdf?vin=5LMPJ8KA0TJ051716",
    // freight/destination only, PDI not included. MY2026. Confirmed against a second source: https://www.windowsticker.forddirect.com/windowsticker.pdf?vin=5LMPJ8JA1TJ046803
    source: "Lincoln Canada, captured 2026-09-17 and confirmed by an independent second read \u2014 \"PRICE INFORMATION BASE PRICE $70,650.00 TOTAL OPTIONS/OTHER 10,550.00 TOTAL VEHICLE & OPTIONS/OTHER 81,200.00 DESTINATIO\"", capturedOn: "2026-09-17" },
  { component: "freight", label: "Freight and PDI", amount: 2800, applies: "always", scope: "model", make: "Polestar", model: "Polestar 2",
    sourceUrl: "https://www.polestar.com/en-ca/offers/new/polestar-2/",
    // freight and PDI together. MY2027. Confirmed against a second source: https://www.polestar.com/en-ca/polestar-2
    source: "Polestar Canada, captured 2026-09-17 and confirmed by an independent second read \u2014 \"Selling price is $72,800 which includes $69,900 MSRP, $2,800 Freight and PDI and $100 air conditioning charge (where app\"", capturedOn: "2026-09-17" },
  //
  // WHAT IS DELIBERATELY NOT HERE, and why. Seven makes returned a figure that
  // an independent second read could not corroborate, and ten published none at
  // all on any official Canadian page. Both are recorded as gaps rather than
  // filled with a plausible number, because a freight charge that is wrong by
  // a few hundred dollars turns into a markup accusation against a named dealer.
  //
  // BMW is the one worth reading twice. The figure on offer is "freight and PDI
  // (UP TO $2,955)" -- a ceiling, not a price -- and the page it was quoted from
  // itemised OMVIC, the ONTARIO regulator, so it was the Ontario rendering of a
  // province-selected disclaimer. Meanwhile real listings for the same nameplate
  // show $2,995 in Montreal, $3,380 in Aurora and $4,395 at BMW Royal Oak in
  // Calgary -- $1,440 above BMW's own published maximum. Storing $2,955 as a
  // fixed Alberta freight and subtracting it from an all-in price that actually
  // contains $4,395 would attribute the $1,440 difference to the dealer as
  // markup. That is the exact false accusation this catalogue exists to prevent,
  // so BMW stays absent until an Alberta-rendered capture settles it.
  //
  // Jaguar returned $2,345 and it is not here either: the figure is MY2023 and
  // for the F-TYPE, and a 2023 charge applied to a current car is stale.
  { component: "freight", label: "Delivery and Destination Charge", amount: 1930, applies: "always", scope: "model", make: "Toyota", model: "RAV4",
    source: "Toyota Canada Build & Price — 2026 RAV4", capturedOn: "2026-08-15" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 2205, applies: "always", scope: "model", make: "Lexus", model: "ES",
    source: "Lexus Canada Build & Price — 2026 ES 350h", capturedOn: "2026-08-25" },
  // Freight is model-specific and feeds only the labelled explainAllIn estimate
  // (never a dealer claim, never overwrites a captured all_in_price). Verified
  // verbatim via exa this session where marked; else the batch-1 official capture.
  { component: "freight", label: "Freight and PDI", amount: 2080, applies: "always", scope: "model", make: "Nissan", model: "Rogue",
    source: "Nissan Canada (canada.nissannews.com) — \"CA$2,080 freight and PDI\" (verified)", capturedOn: "2026-08-26" },
  { component: "freight", label: "Freight and PDI", amount: 2195, applies: "always", scope: "model", make: "Mazda", model: "CX-5",
    source: "Mazda Canada (mazda.ca) — \"$2,195 freight and PDI\" (verified)", capturedOn: "2026-08-26" },
  { component: "freight", label: "Freight and PDI", amount: 2495, applies: "always", scope: "model", make: "Infiniti", model: "QX60",
    source: "Infiniti Canada (canada.infinitinews.com) — \"CA$2,495 freight and PDI\" (verified)", capturedOn: "2026-08-26" },
  { component: "freight", label: "Freight and PDI", amount: 2770, applies: "always", scope: "model", make: "Volvo", model: "XC60",
    source: "Volvo Car Canada (volvocars.com/offers) — \"$2,770 freight and PDI\" (verified)", capturedOn: "2026-08-26" },
  { component: "freight", label: "Destination Freight Charge", amount: 2700, applies: "always", scope: "model", make: "Chevrolet", model: "Silverado 1500",
    source: "Chevrolet Canada Build & Price — itemized AB build summed to the dollar", capturedOn: "2026-08-26" },
  { component: "freight", label: "Freight & PDI", amount: 2200, applies: "always", scope: "model", make: "Hyundai", model: "Tucson",
    source: "Hyundai Canada Build & Price (official capture)", capturedOn: "2026-08-25" },
  { component: "freight", label: "Freight & PDI", amount: 2185, applies: "always", scope: "model", make: "Kia", model: "Sportage",
    source: "Kia Canada Build & Price (official capture)", capturedOn: "2026-08-25" },
  { component: "freight", label: "Freight & PDI", amount: 2195, applies: "always", scope: "model", make: "Ram", model: "1500",
    source: "Ram Canada (official capture)", capturedOn: "2026-08-25" },
  { component: "freight", label: "Freight & PDI", amount: 2295, applies: "always", scope: "model", make: "Subaru", model: "Outback",
    source: "Subaru Canada (official capture)", capturedOn: "2026-08-25" },
  { component: "freight", label: "Freight & PDI", amount: 2200, applies: "always", scope: "model", make: "Volkswagen", model: "Tiguan",
    source: "Volkswagen Canada (official capture)", capturedOn: "2026-08-25" },
];

// ── Public API ──────────────────────────────────────────────────────────────

function financingMatch(f: Fee, financed: boolean, leased: boolean): boolean {
  return f.applies === "always" || (f.applies === "finance" && financed) || (f.applies === "lease" && leased);
}

/** The government (federal + provincial) fixed fees that apply to ANY brand in
 *  `region`. Financing-conditional fees (PPSA) are included only when asked. */
export function governmentFees(
  region: string,
  opts: { financed?: boolean; leased?: boolean } = {},
): Fee[] {
  const r = String(region ?? "").toUpperCase();
  const financed = opts.financed === true;
  const leased = opts.leased === true;
  const prov = (PROVINCE[r] ?? []).filter((f) => financingMatch(f, financed, leased));
  return [...FEDERAL.filter((f) => financingMatch(f, financed, leased)), ...prov];
}

export function governmentFeesTotal(region: string, opts: { financed?: boolean; leased?: boolean } = {}): number {
  return round2(governmentFees(region, opts).reduce((s, f) => s + f.amount, 0));
}

/** One government fee amount by component key (null if not in this region /
 *  not applicable under the given financing). */
export function feeAmount(
  region: string,
  component: string,
  opts: { financed?: boolean; leased?: boolean } = {},
): number | null {
  const hit = governmentFees(region, opts).find((f) => f.component === component);
  return hit ? hit.amount : null;
}

/** The manufacturer's published maximum dealer fee, or null if we have not
 *  captured one for this make (never guessed).
 *
 *  REGION BEATS NATIONAL, by search order and not by array order. Toyota
 *  publishes $999 in the Prairies/Ontario and $990 in BC & Yukon, so a BC
 *  listing must resolve to the BC row even though the unqualified $999 row is
 *  written first. The old `find` took whichever row came first in the array —
 *  correct only by accident, and silently wrong the moment someone reordered
 *  the catalog or added a second region. Look for an exact region match, then
 *  fall back to the brand's unqualified row. */
export function dealerFeeCeiling(
  make: string,
  region = "AB",
): { amount: number; source: string; capturedOn: string; region?: string; provenance: "policy" | "single-model"; note?: string } | null {
  const m = norm(make);
  const r = String(region ?? "").toUpperCase();
  const forMake = DEALER_FEE_CEILING.filter((f) => norm(f.make) === m);
  const row = forMake.find((f) => f.region === r) ?? forMake.find((f) => !f.region);
  return row ? { amount: row.amount, source: row.source, capturedOn: row.capturedOn, region: row.region, provenance: row.provenance ?? "single-model", note: row.note } : null;
}

/** Freight for a make+model, or null if not captured (never guessed). */
export function freightFor(
  make: string,
  model: string,
): { amount: number; source: string; capturedOn: string } | null {
  const m = norm(make);
  const md = norm(model);
  const row = FREIGHT.find((f) => norm(f.make) === m && norm(f.model) === md);
  return row ? { amount: row.amount, source: row.source, capturedOn: row.capturedOn } : null;
}

/**
 * Every freight figure we hold, so the daily verifier can walk them.
 *
 * Returns copies: the catalogue is reviewed source, and a caller that could
 * mutate it could change what a report claims without a code review.
 */
export function freightCatalog(): Fee[] {
  return FREIGHT.map((f) => ({ ...f }));
}

/** True when we hold ANY per-brand fee (ceiling or freight) for this make. */
export function hasBrandFees(make: string): boolean {
  const m = norm(make);
  return DEALER_FEE_CEILING.some((f) => norm(f.make) === m) || FREIGHT.some((f) => norm(f.make) === m);
}

/** A neutral, backed comparison of an observed dealer/admin fee to the brand's
 *  OWN published maximum. DATA ONLY — the caller writes the copy, and it stays
 *  neutral: "Lexus publishes a $995 maximum; this listing shows $1,295", never
 *  an accusation. Returns null when we have no ceiling for the make (fail-safe:
 *  no ceiling → no claim). */
export function assessDealerFeeVsCeiling(
  make: string,
  region: string,
  observedFee: number,
): { ceiling: number; observed: number; over: boolean; overBy: number; source: string; capturedOn: string; ceilingRegion: string | null; provenance: "policy" | "single-model" } | null {
  const c = dealerFeeCeiling(make, region);
  const fee = Number(observedFee);
  if (!c || !Number.isFinite(fee) || fee <= 0) return null;
  const over = fee > c.amount;
  // `ceilingRegion` says whether this figure is the brand's ONE national
  // published maximum (null) or a region-specific one the caller must not
  // restate outside that region (e.g. Toyota BC's $990 against $999 elsewhere).
  return { ceiling: c.amount, observed: round2(fee), over, overBy: over ? round2(fee - c.amount) : 0, source: c.source, capturedOn: c.capturedOn, ceilingRegion: c.region ?? null, provenance: c.provenance };
}

/** An itemised view of what sits inside an all-in price, for buyer
 *  transparency. NOTE: `authoritative` is always false — the true all-in for a
 *  trim is the manufacturer's CAPTURED all_in_price. This EXPLAINS an all-in
 *  (and estimates one where none was captured); it never replaces a captured
 *  figure. Returns items only for the parts we actually hold. */
export function explainAllIn(input: {
  make: string;
  model: string;
  region?: string;
  financed?: boolean;
  leased?: boolean;
  msrp?: number | null;
}): {
  region: string;
  items: Array<{ component: string; label: string; amount: number; source: string }>;
  addsTotal: number;
  allInEstimate: number | null;
  authoritative: false;
  note: string;
} {
  const region = String(input.region ?? "AB").toUpperCase();
  const items: Array<{ component: string; label: string; amount: number; source: string }> = [];

  const fr = freightFor(input.make, input.model);
  if (fr) items.push({ component: "freight", label: "Delivery and Destination Charge", amount: fr.amount, source: fr.source });

  const c = dealerFeeCeiling(input.make, region);
  if (c) items.push({ component: "dealer_fee_ceiling", label: "Dealer Fees (maximum)", amount: c.amount, source: c.source });

  for (const f of governmentFees(region, { financed: input.financed, leased: input.leased })) {
    items.push({ component: f.component, label: f.label, amount: f.amount, source: f.source });
  }

  const addsTotal = round2(items.reduce((s, i) => s + i.amount, 0));
  const base = Number(input.msrp);
  return {
    region,
    items,
    addsTotal,
    allInEstimate: Number.isFinite(base) && base > 0 ? round2(base + addsTotal) : null,
    authoritative: false,
    note: "Estimate from the fee catalog; the authoritative all-in is the manufacturer's captured figure for the exact trim.",
  };
}
