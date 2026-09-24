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
  // ── FREIGHT ROWS ONLY ────────────────────────────────────────────────────
  // The model year the maker published this figure for. Freight moves between
  // years -- VW's own Alberta offers price the 2026 Atlas at $2,250 and the
  // 2027 at $2,450 -- so a figure is only the published one for its own year.
  // "current" is for a maker whose live price list names no model year (BMW's
  // configurator prices what is orderable TODAY): it answers any year we hold
  // no dated row for, because it is the maker's figure for the car it sells now.
  modelYear?: number | "current";
  // What the published figure COVERS. A listing's line is nearly always
  // "Freight and PDI". "freight_only" is a destination figure the maker does
  // NOT say includes pre-delivery inspection -- Porsche's "Destination Charge"
  // (PDI sits in its separate dealer fee), Ford's "destination & delivery" --
  // and comparing it to a Freight-and-PDI line could invent a PDI-sized
  // "above". freightLine names both figures and compares neither.
  covers?: "freight_pdi" | "freight_only";
  // Where the maker prints freight and PDI as TWO numbers (Mazda's own API:
  // Freight 1455, PDE 740). The verifier checks each against its own line.
  parts?: { freight: number; pdi: number };
  // How the verifier reads sourceUrl (default: dollar figures near freight
  // wording on the page). See figuresIn() in scripts/lib/freight-verify.mjs.
  read?: { embedded?: string; path?: string[]; key?: string; labels?: Record<string, string>; text?: boolean };
  // A source that answers a POST (Honda and Acura's price calculator takes
  // [{modelKey, modelYear}]); the job sends exactly this body.
  // A source that is not a plain GET: Honda and Acura's price calculator is a
  // POST of [{modelKey, modelYear}]; MINI's answers a form post and prices the
  // province named in its own preference cookie; BMW's price list wants the
  // x-api-key its configurator settings file hands every browser. The job
  // sends exactly this, and "{today}" in sourceUrl becomes the read date.
  request?: { method?: "GET" | "POST"; body?: unknown; contentType?: string; headers?: Record<string, string> };
  // Why this figure has NO re-readable source, in words. A row carries either
  // a sourceUrl or this -- never a guessed URL, and never neither.
  unsourced?: string;
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
  // HYUNDAI'S ELECTRIC MODELS BILL $599, NOT $799. The brand row above carries
  // $799 and notes "some models publish $599" without saying which. Hyundai's
  // own Build & Price API, asked for Alberta on 2026-09-22, answers
  // dealerAdminFee per trim: $799 on VENUE, KONA, TUCSON, SANTA FE, PALISADE,
  // ELANTRA, ELANTRA N and SONATA -- and $599 on IONIQ 5, IONIQ 9 and KONA
  // Electric. Every one of them, every trim.
  //
  // It matters because the brand ceiling is what a fee gets measured against.
  // A $799 administration fee on an IONIQ 9 reads as "at the cap" against the
  // brand row while Hyundai's own configurator bills $599 for that car -- $200
  // a buyer would have no reason to question. A model-scoped row outranks the
  // brand one, so these three are now measured against their own figure.
  { component: "dealer_fee_ceiling", label: "dealer admin fee", amount: 599, applies: "always", scope: "model", make: "Hyundai", model: "IONIQ 9",
    source: "Hyundai Canada Build & Price API (trimallpurchaseOptions, prov=AB) — dealerAdminFee 599 on every IONIQ 9 trim", capturedOn: "2026-09-22", provenance: "single-model",
    note: "Checked 2026-09-22: Hyundai DOES publish 599 at brand level, but as an unlabelled positional list -- \"admin fees of $799 /$799 /$799 /$799 /$799 /$799 /$799 /$599 /$599/ $599 /$599 are included\" -- with no model named against any figure. Seven at 799 and four at 599, and the sentence does not say which is which. The mapping comes from Hyundai's own Build & Price API, which answers 599 on every trim of this model and 799 on every gas and hybrid model. Brand wording exists; brand wording naming THIS model does not." },
  { component: "dealer_fee_ceiling", label: "dealer admin fee", amount: 599, applies: "always", scope: "model", make: "Hyundai", model: "IONIQ 5",
    source: "Hyundai Canada Build & Price API (trimallpurchaseOptions, prov=AB) — dealerAdminFee 599 on every IONIQ 5 trim", capturedOn: "2026-09-22", provenance: "single-model",
    note: "Checked 2026-09-22: Hyundai DOES publish 599 at brand level, but as an unlabelled positional list -- \"admin fees of $799 /$799 /$799 /$799 /$799 /$799 /$799 /$599 /$599/ $599 /$599 are included\" -- with no model named against any figure. Seven at 799 and four at 599, and the sentence does not say which is which. The mapping comes from Hyundai's own Build & Price API, which answers 599 on every trim of this model and 799 on every gas and hybrid model. Brand wording exists; brand wording naming THIS model does not." },
  { component: "dealer_fee_ceiling", label: "dealer admin fee", amount: 599, applies: "always", scope: "model", make: "Hyundai", model: "KONA Electric",
    source: "Hyundai Canada Build & Price API (trimallpurchaseOptions, prov=AB) — dealerAdminFee 599 on every KONA Electric trim", capturedOn: "2026-09-22", provenance: "single-model",
    note: "Checked 2026-09-22: Hyundai DOES publish 599 at brand level, but as an unlabelled positional list -- \"admin fees of $799 /$799 /$799 /$799 /$799 /$799 /$799 /$599 /$599/ $599 /$599 are included\" -- with no model named against any figure. Seven at 799 and four at 599, and the sentence does not say which is which. The mapping comes from Hyundai's own Build & Price API, which answers 599 on every trim of this model and 799 on every gas and hybrid model. Brand wording exists; brand wording naming THIS model does not." },
  // Hyundai's own delivery charge, per model, from the same API. The catalogue
  // previously held ONE Hyundai freight figure (Tucson $2,200, hand-captured
  // 2026-08-25) -- which this capture returns identically, and which is why
  // these are trusted.
  // MAZDA ITEMISES FREIGHT AND PDE SEPARATELY, and the report's "Freight & PDI"
  // is the two together. Mazda Canada's Trims API returns, per model and per
  // province: Freight, PDE, Administration Fee, A/C Tax, AMVIC (Alberta) or
  // OMVIC (Ontario), and a tire stewardship fee. The catalogue held no Mazda
  // freight figure at all before this.
  //
  // The same response carries Administration Fee 795, which independently
  // confirms the brand ceiling row below -- captured from marketing copy on
  // 2026-08-25, and reached again by a different route on 2026-09-22.
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
  // ── HOW A ROW GETS HERE (2026-09-24) ──────────────────────────────────────
  // Vic, 2026-09-17: "i want all manufacturers selling in Canada/Alberta
  // Freight and PDI ... build catalogue and scan daily for changes". On
  // 2026-09-24 the daily job reported 45 figures across 19 makes, 38 of them
  // naming their source in prose only -- so it re-read 7, and BMW was one make
  // with one model.
  //
  // Every row now carries:
  //   sourceUrl   a page or API on the MANUFACTURER'S OWN domain that the daily
  //               job re-reads with a plain GET, its honest User-Agent and
  //               robots.txt obeyed (test:freight-catalog checks the domain);
  //               or `unsourced`, saying in words why no such page exists.
  //               Never a guessed URL.
  //   modelYear   freight moves between years (VW Atlas: $2,250 for 2026,
  //               $2,450 for 2027), so a figure is the published one only for
  //               its own year, and freightFor() will not lend it to another.
  //   covers      whether PDI is inside the figure. A destination-only figure
  //               is a different line from a listing's "Freight and PDI".
  //   read        how the job reads the source: the maker's own JSON field by
  //               name, a line item by its label, a model by its JSON path, or
  //               (default) the dollar figure printed beside freight wording.
  //
  // WHAT IS NEVER HERE: a figure we assembled. Not all-in minus MSRP minus fees,
  // not a dealer's listing, not a window-sticker service, not a marketplace.
  // Where a maker prints freight and PDI as two lines (Mazda's API), both lines
  // are stored and checked separately, and the bundle is only their sum -- the
  // same pair Mazda itself prints as one "freight and PDI" figure on its model
  // pages. Freight is also never the A/C charge, the tire levy or AMVIC.

  // ── Hyundai ── the maker's own Build & Price API, Province = Alberta ──────
  // trimallpurchaseOptions answers `delivery` beside msrp and the fees, per
  // trim; every trim of a model carries the same figure, so the row cites the
  // first trim and the job reads the field by name. Hyundai's own words for the
  // line: "Delivery and Destination charge includes freight, P.D.I. and a full
  // tank of gas" (special-offers fine print), so it covers freight and PDI.
  //
  // THE OFFERS PAGE IS NOT THE SOURCE, deliberately. Its fine print lists the
  // charge positionally -- "$1,900 / $1,975 / $2,200 / ..." against a model
  // list in another sentence -- and is not the Alberta rendering (it names a
  // $15 tire charge; Alberta's is $25). By position it gives the SONATA $1,975,
  // where the Alberta API answers 2100 on all three 2026 SONATA trims. The API
  // is the maker's own per-model, per-province answer; a position is not.
  //
  // The API answers HTTP 400 to a request that names no language; the job
  // sends Accept-Language: en-CA, which is true, not a disguise.
  { component: "freight", label: "Delivery and Destination", amount: 2200, applies: "always", scope: "model", make: "Hyundai", model: "VENUE", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.hyundaicanada.com/api/backendservice/buildandprice/trimallpurchaseOptions?trimId=fa92b82a-b641-4ade-a08e-f0bf4fb4cfdc&prov=AB&lang=en", read: { key: "delivery" },
    source: "Hyundai Canada Build & Price API (trimallpurchaseOptions, prov=AB) -- delivery 2200 on all 3 2026 VENUE trim(s)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination", amount: 2200, applies: "always", scope: "model", make: "Hyundai", model: "KONA", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.hyundaicanada.com/api/backendservice/buildandprice/trimallpurchaseOptions?trimId=1d0b4fd6-8e06-4559-849f-4d0559a7b13f&prov=AB&lang=en", read: { key: "delivery" },
    source: "Hyundai Canada Build & Price API (trimallpurchaseOptions, prov=AB) -- delivery 2200 on all 3 2026 KONA trim(s)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination", amount: 2200, applies: "always", scope: "model", make: "Hyundai", model: "KONA", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.hyundaicanada.com/api/backendservice/buildandprice/trimallpurchaseOptions?trimId=6d39dcbc-4957-65ac-49d8-8f6d7177b0d9&prov=AB&lang=en", read: { key: "delivery" },
    source: "Hyundai Canada Build & Price API (trimallpurchaseOptions, prov=AB) -- delivery 2200 on all 4 2027 KONA trim(s)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination", amount: 2200, applies: "always", scope: "model", make: "Hyundai", model: "TUCSON", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.hyundaicanada.com/api/backendservice/buildandprice/trimallpurchaseOptions?trimId=caf5bc0d-1b70-4562-997a-c6c4bc99dbf1&prov=AB&lang=en", read: { key: "delivery" },
    source: "Hyundai Canada Build & Price API (trimallpurchaseOptions, prov=AB) -- delivery 2200 on all 4 2026 TUCSON trim(s)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination", amount: 2300, applies: "always", scope: "model", make: "Hyundai", model: "SANTA FE", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.hyundaicanada.com/api/backendservice/buildandprice/trimallpurchaseOptions?trimId=9523a7d9-5b69-4466-a201-64e4a4ae4d48&prov=AB&lang=en", read: { key: "delivery" },
    source: "Hyundai Canada Build & Price API (trimallpurchaseOptions, prov=AB) -- delivery 2300 on all 3 2026 SANTA FE trim(s)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination", amount: 2300, applies: "always", scope: "model", make: "Hyundai", model: "SANTA FE", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.hyundaicanada.com/api/backendservice/buildandprice/trimallpurchaseOptions?trimId=80524807-6423-41ed-b5dd-8f15af47c28a&prov=AB&lang=en", read: { key: "delivery" },
    source: "Hyundai Canada Build & Price API (trimallpurchaseOptions, prov=AB) -- delivery 2300 on all 3 2027 SANTA FE trim(s)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination", amount: 2400, applies: "always", scope: "model", make: "Hyundai", model: "PALISADE", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.hyundaicanada.com/api/backendservice/buildandprice/trimallpurchaseOptions?trimId=98ad5227-e42c-47e1-91ca-80470afb256e&prov=AB&lang=en", read: { key: "delivery" },
    source: "Hyundai Canada Build & Price API (trimallpurchaseOptions, prov=AB) -- delivery 2400 on all 5 2026 PALISADE trim(s)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination", amount: 2400, applies: "always", scope: "model", make: "Hyundai", model: "PALISADE", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.hyundaicanada.com/api/backendservice/buildandprice/trimallpurchaseOptions?trimId=01993d76-bbb0-88bf-a72b-bfa51f2d9e99&prov=AB&lang=en", read: { key: "delivery" },
    source: "Hyundai Canada Build & Price API (trimallpurchaseOptions, prov=AB) -- delivery 2400 on all 5 2027 PALISADE trim(s)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination", amount: 2300, applies: "always", scope: "model", make: "Hyundai", model: "IONIQ 5", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.hyundaicanada.com/api/backendservice/buildandprice/trimallpurchaseOptions?trimId=1341d283-0eea-4a3e-b3cc-4a319f9736d8&prov=AB&lang=en", read: { key: "delivery" },
    source: "Hyundai Canada Build & Price API (trimallpurchaseOptions, prov=AB) -- delivery 2300 on all 2 2026 IONIQ 5 trim(s)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination", amount: 2200, applies: "always", scope: "model", make: "Hyundai", model: "KONA Electric", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.hyundaicanada.com/api/backendservice/buildandprice/trimallpurchaseOptions?trimId=e50f68af-b3af-4e06-af05-eaeca8e39842&prov=AB&lang=en", read: { key: "delivery" },
    source: "Hyundai Canada Build & Price API (trimallpurchaseOptions, prov=AB) -- delivery 2200 on all 1 2026 KONA Electric trim(s)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination", amount: 1900, applies: "always", scope: "model", make: "Hyundai", model: "ELANTRA", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.hyundaicanada.com/api/backendservice/buildandprice/trimallpurchaseOptions?trimId=fdfb2547-2d96-47c7-bf9b-d5fa68fc3bb7&prov=AB&lang=en", read: { key: "delivery" },
    source: "Hyundai Canada Build & Price API (trimallpurchaseOptions, prov=AB) -- delivery 1900 on all 4 2026 ELANTRA trim(s)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination", amount: 1900, applies: "always", scope: "model", make: "Hyundai", model: "ELANTRA N", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.hyundaicanada.com/api/backendservice/buildandprice/trimallpurchaseOptions?trimId=461ebf3a-c454-40f7-82b7-4cb11d7a86f1&prov=AB&lang=en", read: { key: "delivery" },
    source: "Hyundai Canada Build & Price API (trimallpurchaseOptions, prov=AB) -- delivery 1900 on all 4 2026 ELANTRA N trim(s)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination", amount: 2100, applies: "always", scope: "model", make: "Hyundai", model: "SONATA", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.hyundaicanada.com/api/backendservice/buildandprice/trimallpurchaseOptions?trimId=1b99bbe8-a49c-4ca8-b6e1-5d5766f81bc0&prov=AB&lang=en", read: { key: "delivery" },
    source: "Hyundai Canada Build & Price API (trimallpurchaseOptions, prov=AB) -- delivery 2100 on all 3 2026 SONATA trim(s)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination", amount: 2400, applies: "always", scope: "model", make: "Hyundai", model: "IONIQ 9", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.hyundaicanada.com/api/backendservice/buildandprice/trimallpurchaseOptions?trimId=46f9deb5-db62-41a0-9956-8e2c0cb3bce4&prov=AB&lang=en", read: { key: "delivery" },
    source: "Hyundai Canada Build & Price API (trimallpurchaseOptions, prov=AB) -- delivery 2400 on all 3 2026 IONIQ 9 trim(s)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination", amount: 2400, applies: "always", scope: "model", make: "Hyundai", model: "IONIQ 9", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.hyundaicanada.com/api/backendservice/buildandprice/trimallpurchaseOptions?trimId=51fb9737-5cbf-c2f3-0b32-9148ff3a1b75&prov=AB&lang=en", read: { key: "delivery" },
    source: "Hyundai Canada Build & Price API (trimallpurchaseOptions, prov=AB) -- delivery 2400 on all 3 2027 IONIQ 9 trim(s)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination", amount: 2300, applies: "always", scope: "model", make: "Hyundai", model: "IONIQ 5 N", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.hyundaicanada.com/api/backendservice/buildandprice/trimallpurchaseOptions?trimId=7032886d-45c9-0cae-be15-862c3d9c0e01&prov=AB&lang=en", read: { key: "delivery" },
    source: "Hyundai Canada Build & Price API (trimallpurchaseOptions, prov=AB) -- delivery 2300 on all 1 2027 IONIQ 5 N trim(s)", capturedOn: "2026-09-24" },

  // ── Mazda ── model-page fine print, and Mazda's own Alberta API ───────────
  // Where the model page prints the bundle ("which includes $2,195 freight and
  // PDI"), that sentence is the source. Mazda's Trims API (prov_code=AB)
  // itemises the same car as two lines, Freight and PDE -- 1455 + 740 on the
  // CX family, 1355 + 740 on MAZDA3 and MX-5 -- and those two lines are the
  // source for the models whose page prints no bundle. Both lines are checked,
  // each against its own label.
  //
  // The API host is Amazon's gateway; the answer is Mazda Canada's own, the one
  // mazda.ca's configurator renders (scripts/scrape-mazda.mjs). It answers 403
  // to robots.txt, which RFC 9309 reads as "no file" -- the job is allowed in.
  { component: "freight", label: "freight and PDI", amount: 2195, applies: "always", scope: "model", make: "Mazda", model: "CX-5", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.mazda.ca/en/vehicles/cx-5/",
    source: "Mazda Canada model page offer fine print -- \"which includes $2,195 freight and PDI\" (2026 CX-5)", capturedOn: "2026-09-24",
    note: "Mazda's own Alberta Trims API itemises the same car as Freight 1455 + PDE 740." },
  { component: "freight", label: "freight and PDI", amount: 2195, applies: "always", scope: "model", make: "Mazda", model: "CX-30", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.mazda.ca/en/vehicles/cx-30/",
    source: "Mazda Canada model page offer fine print -- \"which includes $2,195 freight and PDI\" (2026 CX-30)", capturedOn: "2026-09-24",
    note: "Mazda's own Alberta Trims API itemises the same car as Freight 1455 + PDE 740." },
  { component: "freight", label: "freight and PDI", amount: 2195, applies: "always", scope: "model", make: "Mazda", model: "CX-70 PHEV", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.mazda.ca/en/vehicles/cx-70-phev/",
    source: "Mazda Canada model page offer fine print -- \"which includes $2,195 freight and PDI\" (2026 CX-70 PHEV)", capturedOn: "2026-09-24",
    note: "Mazda's own Alberta Trims API itemises the same car as Freight 1455 + PDE 740." },
  { component: "freight", label: "freight and PDI", amount: 2195, applies: "always", scope: "model", make: "Mazda", model: "CX-90 PHEV", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.mazda.ca/en/vehicles/cx-90-phev/",
    source: "Mazda Canada model page offer fine print -- \"which includes $2,195 freight and PDI\" (2026 CX-90 PHEV)", capturedOn: "2026-09-24",
    note: "Mazda's own Alberta Trims API itemises the same car as Freight 1455 + PDE 740." },
  { component: "freight", label: "freight and PDI", amount: 2095, applies: "always", scope: "model", make: "Mazda", model: "MAZDA3", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.mazda.ca/en/vehicles/mazda3/",
    source: "Mazda Canada model page offer fine print -- \"which includes $2,095 freight and PDI\" (2026 MAZDA3)", capturedOn: "2026-09-24",
    note: "Mazda's own Alberta Trims API itemises the same car as Freight 1355 + PDE 740." },
  { component: "freight", label: "freight and PDI", amount: 2095, applies: "always", scope: "model", make: "Mazda", model: "MAZDA3-SPORT", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.mazda.ca/en/vehicles/mazda3-sport/",
    source: "Mazda Canada model page offer fine print -- \"which includes $2,095 freight and PDI\" (2026 MAZDA3-SPORT)", capturedOn: "2026-09-24",
    note: "Mazda's own Alberta Trims API itemises the same car as Freight 1355 + PDE 740." },
  { component: "freight", label: "freight and PDI", amount: 2095, applies: "always", scope: "model", make: "Mazda", model: "MX-5", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.mazda.ca/en/vehicles/mx-5-soft-top/",
    source: "Mazda Canada model page offer fine print -- \"which includes $2,095 freight and PDI\" (2026 MX-5)", capturedOn: "2026-09-24",
    note: "Mazda's own Alberta Trims API itemises the same car as Freight 1355 + PDE 740." },
  { component: "freight", label: "freight and PDI", amount: 2095, applies: "always", scope: "model", make: "Mazda", model: "MX-5 RF", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.mazda.ca/en/vehicles/mx-5-rf/",
    source: "Mazda Canada model page offer fine print -- \"which includes $2,095 freight and PDI\" (2026 MX-5 RF)", capturedOn: "2026-09-24",
    note: "Mazda's own Alberta Trims API itemises the same car as Freight 1355 + PDE 740." },
  { component: "freight", label: "Freight + PDE (itemised by Mazda)", amount: 2195, applies: "always", scope: "model", make: "Mazda", model: "CX-70 MHEV", modelYear: 2026, covers: "freight_pdi",
    parts: { freight: 1455, pdi: 740 }, read: { labels: { freight: "Freight", pdi: "PDE" } },
    sourceUrl: "https://n8xgyscaa3.execute-api.ca-central-1.amazonaws.com/prod/api/Trims/2026/CX-70-MHEV/?prov_code=AB&lang_code=en",
    source: "Mazda Canada Trims API (financial.fees, prov_code=AB) -- Freight 1455 and PDE 740 on every 2026 CX-70 MHEV trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight + PDE (itemised by Mazda)", amount: 2195, applies: "always", scope: "model", make: "Mazda", model: "CX-90 MHEV", modelYear: 2026, covers: "freight_pdi",
    parts: { freight: 1455, pdi: 740 }, read: { labels: { freight: "Freight", pdi: "PDE" } },
    sourceUrl: "https://n8xgyscaa3.execute-api.ca-central-1.amazonaws.com/prod/api/Trims/2026/CX-90-MHEV/?prov_code=AB&lang_code=en",
    source: "Mazda Canada Trims API (financial.fees, prov_code=AB) -- Freight 1455 and PDE 740 on every 2026 CX-90 MHEV trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight + PDE (itemised by Mazda)", amount: 2195, applies: "always", scope: "model", make: "Mazda", model: "CX-50", modelYear: 2025, covers: "freight_pdi",
    parts: { freight: 1455, pdi: 740 }, read: { labels: { freight: "Freight", pdi: "PDE" } },
    sourceUrl: "https://n8xgyscaa3.execute-api.ca-central-1.amazonaws.com/prod/api/Trims/2025/CX-50/?prov_code=AB&lang_code=en",
    source: "Mazda Canada Trims API (financial.fees, prov_code=AB) -- Freight 1455 and PDE 740 on every 2025 CX-50 trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight + PDE (itemised by Mazda)", amount: 2195, applies: "always", scope: "model", make: "Mazda", model: "CX-50 HEV", modelYear: 2025, covers: "freight_pdi",
    parts: { freight: 1455, pdi: 740 }, read: { labels: { freight: "Freight", pdi: "PDE" } },
    sourceUrl: "https://n8xgyscaa3.execute-api.ca-central-1.amazonaws.com/prod/api/Trims/2025/CX-50-HEV/?prov_code=AB&lang_code=en",
    source: "Mazda Canada Trims API (financial.fees, prov_code=AB) -- Freight 1455 and PDE 740 on every 2025 CX-50 HEV trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight + PDE (itemised by Mazda)", amount: 2195, applies: "always", scope: "model", make: "Mazda", model: "CX-5", modelYear: 2025, covers: "freight_pdi",
    parts: { freight: 1455, pdi: 740 }, read: { labels: { freight: "Freight", pdi: "PDE" } },
    sourceUrl: "https://n8xgyscaa3.execute-api.ca-central-1.amazonaws.com/prod/api/Trims/2025/CX-5/?prov_code=AB&lang_code=en",
    source: "Mazda Canada Trims API (financial.fees, prov_code=AB) -- Freight 1455 and PDE 740 on every 2025 CX-5 trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight + PDE (itemised by Mazda)", amount: 2195, applies: "always", scope: "model", make: "Mazda", model: "CX-30", modelYear: 2025, covers: "freight_pdi",
    parts: { freight: 1455, pdi: 740 }, read: { labels: { freight: "Freight", pdi: "PDE" } },
    sourceUrl: "https://n8xgyscaa3.execute-api.ca-central-1.amazonaws.com/prod/api/Trims/2025/CX-30/?prov_code=AB&lang_code=en",
    source: "Mazda Canada Trims API (financial.fees, prov_code=AB) -- Freight 1455 and PDE 740 on every 2025 CX-30 trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight + PDE (itemised by Mazda)", amount: 2195, applies: "always", scope: "model", make: "Mazda", model: "CX-70 MHEV", modelYear: 2025, covers: "freight_pdi",
    parts: { freight: 1455, pdi: 740 }, read: { labels: { freight: "Freight", pdi: "PDE" } },
    sourceUrl: "https://n8xgyscaa3.execute-api.ca-central-1.amazonaws.com/prod/api/Trims/2025/CX-70-MHEV/?prov_code=AB&lang_code=en",
    source: "Mazda Canada Trims API (financial.fees, prov_code=AB) -- Freight 1455 and PDE 740 on every 2025 CX-70 MHEV trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight + PDE (itemised by Mazda)", amount: 2195, applies: "always", scope: "model", make: "Mazda", model: "CX-70 PHEV", modelYear: 2025, covers: "freight_pdi",
    parts: { freight: 1455, pdi: 740 }, read: { labels: { freight: "Freight", pdi: "PDE" } },
    sourceUrl: "https://n8xgyscaa3.execute-api.ca-central-1.amazonaws.com/prod/api/Trims/2025/CX-70-PHEV/?prov_code=AB&lang_code=en",
    source: "Mazda Canada Trims API (financial.fees, prov_code=AB) -- Freight 1455 and PDE 740 on every 2025 CX-70 PHEV trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight + PDE (itemised by Mazda)", amount: 2195, applies: "always", scope: "model", make: "Mazda", model: "CX-90 MHEV", modelYear: 2025, covers: "freight_pdi",
    parts: { freight: 1455, pdi: 740 }, read: { labels: { freight: "Freight", pdi: "PDE" } },
    sourceUrl: "https://n8xgyscaa3.execute-api.ca-central-1.amazonaws.com/prod/api/Trims/2025/CX-90-MHEV/?prov_code=AB&lang_code=en",
    source: "Mazda Canada Trims API (financial.fees, prov_code=AB) -- Freight 1455 and PDE 740 on every 2025 CX-90 MHEV trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight + PDE (itemised by Mazda)", amount: 2195, applies: "always", scope: "model", make: "Mazda", model: "CX-90 PHEV", modelYear: 2025, covers: "freight_pdi",
    parts: { freight: 1455, pdi: 740 }, read: { labels: { freight: "Freight", pdi: "PDE" } },
    sourceUrl: "https://n8xgyscaa3.execute-api.ca-central-1.amazonaws.com/prod/api/Trims/2025/CX-90-PHEV/?prov_code=AB&lang_code=en",
    source: "Mazda Canada Trims API (financial.fees, prov_code=AB) -- Freight 1455 and PDE 740 on every 2025 CX-90 PHEV trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight + PDE (itemised by Mazda)", amount: 2095, applies: "always", scope: "model", make: "Mazda", model: "MAZDA3", modelYear: 2025, covers: "freight_pdi",
    parts: { freight: 1355, pdi: 740 }, read: { labels: { freight: "Freight", pdi: "PDE" } },
    sourceUrl: "https://n8xgyscaa3.execute-api.ca-central-1.amazonaws.com/prod/api/Trims/2025/MAZDA3/?prov_code=AB&lang_code=en",
    source: "Mazda Canada Trims API (financial.fees, prov_code=AB) -- Freight 1355 and PDE 740 on every 2025 MAZDA3 trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight + PDE (itemised by Mazda)", amount: 2095, applies: "always", scope: "model", make: "Mazda", model: "MAZDA3-SPORT", modelYear: 2025, covers: "freight_pdi",
    parts: { freight: 1355, pdi: 740 }, read: { labels: { freight: "Freight", pdi: "PDE" } },
    sourceUrl: "https://n8xgyscaa3.execute-api.ca-central-1.amazonaws.com/prod/api/Trims/2025/MAZDA3-SPORT/?prov_code=AB&lang_code=en",
    source: "Mazda Canada Trims API (financial.fees, prov_code=AB) -- Freight 1355 and PDE 740 on every 2025 MAZDA3-SPORT trim", capturedOn: "2026-09-24" },

  // ── Volkswagen ── VW Canada's own special-offers API, province=AB ─────────
  // Each offer's legal text itemises the fees: "$2,050 freight and PDI, $100
  // air conditioning levy, $25 tire recycling levy, $10 AMVIC fee" -- the AMVIC
  // line is what makes it Alberta. One response carries every model, so each
  // row reads through a JSON path to ITS model: without it, the Jetta's $2,050
  // would "confirm" a Golf R figure that had changed.
  //
  // THE MODEL YEAR IS THE FIGURE: 2026 Atlas $2,250, 2027 Atlas $2,450.
  { component: "freight", label: "freight and PDI", amount: 2050, applies: "always", scope: "model", make: "Volkswagen", model: "Jetta", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://globalapi.vwtools.ca/special-offers?province=AB&year=2026", read: { path: ["2026", "jetta"] },
    source: "Volkswagen Canada special-offers API, province=AB -- 2026 Jetta offer legal text: \"$2,050 freight and PDI\" beside the $10 AMVIC fee", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2050, applies: "always", scope: "model", make: "Volkswagen", model: "Jetta GLI", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://globalapi.vwtools.ca/special-offers?province=AB&year=2026", read: { path: ["2026", "jettagli"] },
    source: "Volkswagen Canada special-offers API, province=AB -- 2026 Jetta GLI offer legal text: \"$2,050 freight and PDI\" beside the $10 AMVIC fee", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2250, applies: "always", scope: "model", make: "Volkswagen", model: "Atlas", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://globalapi.vwtools.ca/special-offers?province=AB&year=2026", read: { path: ["2026", "atlas"] },
    source: "Volkswagen Canada special-offers API, province=AB -- 2026 Atlas offer legal text: \"$2,250 freight and PDI\" beside the $10 AMVIC fee", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2250, applies: "always", scope: "model", make: "Volkswagen", model: "Atlas Cross Sport", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://globalapi.vwtools.ca/special-offers?province=AB&year=2026", read: { path: ["2026", "atlascrosssport"] },
    source: "Volkswagen Canada special-offers API, province=AB -- 2026 Atlas Cross Sport offer legal text: \"$2,250 freight and PDI\" beside the $10 AMVIC fee", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2175, applies: "always", scope: "model", make: "Volkswagen", model: "Taos", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://globalapi.vwtools.ca/special-offers?province=AB&year=2026", read: { path: ["2026", "taos"] },
    source: "Volkswagen Canada special-offers API, province=AB -- 2026 Taos offer legal text: \"$2,175 freight and PDI\" beside the $10 AMVIC fee", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2050, applies: "always", scope: "model", make: "Volkswagen", model: "Golf GTI", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://globalapi.vwtools.ca/special-offers?province=AB&year=2026", read: { path: ["2026", "golfgti"] },
    source: "Volkswagen Canada special-offers API, province=AB -- 2026 Golf GTI offer legal text: \"$2,050 freight and PDI\" beside the $10 AMVIC fee", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2050, applies: "always", scope: "model", make: "Volkswagen", model: "Golf R", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://globalapi.vwtools.ca/special-offers?province=AB&year=2026", read: { path: ["2026", "golfr"] },
    source: "Volkswagen Canada special-offers API, province=AB -- 2026 Golf R offer legal text: \"$2,050 freight and PDI\" beside the $10 AMVIC fee", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2200, applies: "always", scope: "model", make: "Volkswagen", model: "Tiguan", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://globalapi.vwtools.ca/special-offers?province=AB&year=2026", read: { path: ["2026", "tiguan"] },
    source: "Volkswagen Canada special-offers API, province=AB -- 2026 Tiguan offer legal text: \"$2,200 freight and PDI\" beside the $10 AMVIC fee", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2050, applies: "always", scope: "model", make: "Volkswagen", model: "Jetta", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://globalapi.vwtools.ca/special-offers?province=AB&year=2027", read: { path: ["2027", "jetta"] },
    source: "Volkswagen Canada special-offers API, province=AB -- 2027 Jetta offer legal text: \"$2,050 freight and PDI\" beside the $10 AMVIC fee", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2050, applies: "always", scope: "model", make: "Volkswagen", model: "Jetta GLI", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://globalapi.vwtools.ca/special-offers?province=AB&year=2027", read: { path: ["2027", "jettagli"] },
    source: "Volkswagen Canada special-offers API, province=AB -- 2027 Jetta GLI offer legal text: \"$2,050 freight and PDI\" beside the $10 AMVIC fee", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2450, applies: "always", scope: "model", make: "Volkswagen", model: "Atlas", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://globalapi.vwtools.ca/special-offers?province=AB&year=2027", read: { path: ["2027", "atlas"] },
    source: "Volkswagen Canada special-offers API, province=AB -- 2027 Atlas offer legal text: \"$2,450 freight and PDI\" beside the $10 AMVIC fee", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2175, applies: "always", scope: "model", make: "Volkswagen", model: "Taos", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://globalapi.vwtools.ca/special-offers?province=AB&year=2027", read: { path: ["2027", "taos"] },
    source: "Volkswagen Canada special-offers API, province=AB -- 2027 Taos offer legal text: \"$2,175 freight and PDI\" beside the $10 AMVIC fee", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2200, applies: "always", scope: "model", make: "Volkswagen", model: "Tiguan", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://globalapi.vwtools.ca/special-offers?province=AB&year=2027", read: { path: ["2027", "tiguan"] },
    source: "Volkswagen Canada special-offers API, province=AB -- 2027 Tiguan offer legal text: \"$2,200 freight and PDI\" beside the $10 AMVIC fee", capturedOn: "2026-09-24" },

  // ── Toyota ── Toyota Canada's own Alberta price feed ────────────────────
  // from_prices.TOY.AB.json is the file toyota.ca's Build & Price reads; every
  // configuration carries an FPD line, "Delivery and Destination Charge", beside
  // MSRP, the A/C charge, AMVIC and the $999 dealer-fee line. Each row walks to its
  // own series and year and reads FPD's amount on every configuration of it. One
  // file answers every row, so the job fetches it once.
  // The RAV4 figure is the one Vic's Build & Price PDF proved on 2026-08-15 --
  // $1,930 then, $1,930 in the feed today.
  { component: "freight", label: "Delivery and Destination Charge", amount: 1930, applies: "always", scope: "model", make: "Toyota", model: "RAV4", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["RAH", "2026", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1930 on every 2026 RAV4 configuration (series RAH)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1930, applies: "always", scope: "model", make: "Toyota", model: "RAV4 Plug-in Hybrid", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["RAP", "2026", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1930 on every 2026 RAV4 Plug-in Hybrid configuration (series RAP)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1760, applies: "always", scope: "model", make: "Toyota", model: "Corolla", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["COR", "2027", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1760 on every 2027 Corolla configuration (series COR)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1760, applies: "always", scope: "model", make: "Toyota", model: "Corolla Hybrid", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["COH", "2027", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1760 on every 2027 Corolla Hybrid configuration (series COH)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1760, applies: "always", scope: "model", make: "Toyota", model: "Corolla Hatchback", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["CHB", "2027", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1760 on every 2027 Corolla Hatchback configuration (series CHB)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1760, applies: "always", scope: "model", make: "Toyota", model: "GR Corolla", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["GRA", "2026", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1760 on every 2026 GR Corolla configuration (series GRA)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1930, applies: "always", scope: "model", make: "Toyota", model: "Corolla Cross", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["CCR", "2026", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1930 on every 2026 Corolla Cross configuration (series CCR)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1930, applies: "always", scope: "model", make: "Toyota", model: "Corolla Cross Hybrid", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["CCH", "2026", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1930 on every 2026 Corolla Cross Hybrid configuration (series CCH)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1860, applies: "always", scope: "model", make: "Toyota", model: "Camry", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["CAH", "2026", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1860 on every 2026 Camry configuration (series CAH)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1860, applies: "always", scope: "model", make: "Toyota", model: "Crown", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["CWN", "2027", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1860 on every 2027 Crown configuration (series CWN)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1930, applies: "always", scope: "model", make: "Toyota", model: "Crown Signia", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["CWS", "2026", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1930 on every 2026 Crown Signia configuration (series CWS)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1860, applies: "always", scope: "model", make: "Toyota", model: "Prius", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["PRS", "2027", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1860 on every 2027 Prius configuration (series PRS)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1860, applies: "always", scope: "model", make: "Toyota", model: "Prius Plug-in Hybrid", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["PHV", "2027", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1860 on every 2027 Prius Plug-in Hybrid configuration (series PHV)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1860, applies: "always", scope: "model", make: "Toyota", model: "GR86", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["T86", "2027", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1860 on every 2027 GR86 configuration (series T86)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1860, applies: "always", scope: "model", make: "Toyota", model: "GR Supra", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["SUP", "2026", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1860 on every 2026 GR Supra configuration (series SUP)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1860, applies: "always", scope: "model", make: "Toyota", model: "Mirai", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["MIR", "2026", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1860 on every 2026 Mirai configuration (series MIR)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1930, applies: "always", scope: "model", make: "Toyota", model: "C-HR", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["BZ3", "2027", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1930 on every 2027 C-HR configuration (series BZ3)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1930, applies: "always", scope: "model", make: "Toyota", model: "bZ", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["BZ4", "2027", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1930 on every 2027 bZ configuration (series BZ4)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1930, applies: "always", scope: "model", make: "Toyota", model: "bZ Woodland", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["BZD", "2027", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1930 on every 2027 bZ Woodland configuration (series BZD)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1930, applies: "always", scope: "model", make: "Toyota", model: "Highlander", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["HIG", "2026", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1930 on every 2026 Highlander configuration (series HIG)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1930, applies: "always", scope: "model", make: "Toyota", model: "Highlander Hybrid", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["HIH", "2026", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1930 on every 2026 Highlander Hybrid configuration (series HIH)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1930, applies: "always", scope: "model", make: "Toyota", model: "Grand Highlander", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["GHI", "2026", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1930 on every 2026 Grand Highlander configuration (series GHI)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1930, applies: "always", scope: "model", make: "Toyota", model: "Grand Highlander Hybrid", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["GHH", "2026", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1930 on every 2026 Grand Highlander Hybrid configuration (series GHH)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1930, applies: "always", scope: "model", make: "Toyota", model: "4Runner", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["RNR", "2026", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1930 on every 2026 4Runner configuration (series RNR)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1930, applies: "always", scope: "model", make: "Toyota", model: "4Runner Hybrid", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["RNH", "2026", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1930 on every 2026 4Runner Hybrid configuration (series RNH)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1930, applies: "always", scope: "model", make: "Toyota", model: "Land Cruiser", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["PRD", "2027", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1930 on every 2027 Land Cruiser configuration (series PRD)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1930, applies: "always", scope: "model", make: "Toyota", model: "Sequoia", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["SEH", "2026", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1930 on every 2026 Sequoia configuration (series SEH)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1930, applies: "always", scope: "model", make: "Toyota", model: "Sienna", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["SIH", "2026", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1930 on every 2026 Sienna configuration (series SIH)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1930, applies: "always", scope: "model", make: "Toyota", model: "Tacoma", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["CP4", "2026", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1930 on every 2026 Tacoma configuration (series CP4)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1930, applies: "always", scope: "model", make: "Toyota", model: "Tacoma Hybrid", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["CPH", "2026", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1930 on every 2026 Tacoma Hybrid configuration (series CPH)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1930, applies: "always", scope: "model", make: "Toyota", model: "Tundra", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["TP4", "2026", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1930 on every 2026 Tundra configuration (series TP4)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 1930, applies: "always", scope: "model", make: "Toyota", model: "Tundra Hybrid", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.toyota.ca/bin/api/price_calculation/from_prices.TOY.AB.json",
    read: { path: ["TPH", "2026", "*", "name=FPD"], key: "amount" },
    source: "Toyota Canada Build & Price price feed, Alberta (from_prices.TOY.AB.json) -- FPD \"Delivery and Destination Charge\" 1930 on every 2026 Tundra Hybrid configuration (series TPH)", capturedOn: "2026-09-24" },

  // ── Lexus ── Lexus Canada's own Alberta price feed, same shape as Toyota's ─
  // Every current series reads $2,205 -- Lexus prints no single all-models
  // statement, so each series is its own row, read from its own FPD line.
  { component: "freight", label: "Delivery and Destination Charge", amount: 2205, applies: "always", scope: "model", make: "Lexus", model: "ES", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.lexus.ca/bin/api/price_calculation/from_prices.LEX.AB.json",
    read: { path: ["ESH", "2027", "*", "name=FPD"], key: "amount" },
    source: "Lexus Canada Build & Price price feed, Alberta (from_prices.LEX.AB.json) -- FPD \"Delivery and Destination Charge\" 2205 on every 2027 ES configuration (series ESH)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 2205, applies: "always", scope: "model", make: "Lexus", model: "ES All-Electric", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.lexus.ca/bin/api/price_calculation/from_prices.LEX.AB.json",
    read: { path: ["ESE", "2027", "*", "name=FPD"], key: "amount" },
    source: "Lexus Canada Build & Price price feed, Alberta (from_prices.LEX.AB.json) -- FPD \"Delivery and Destination Charge\" 2205 on every 2027 ES All-Electric configuration (series ESE)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 2205, applies: "always", scope: "model", make: "Lexus", model: "IS", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.lexus.ca/bin/api/price_calculation/from_prices.LEX.AB.json",
    read: { path: ["IS", "2026", "*", "name=FPD"], key: "amount" },
    source: "Lexus Canada Build & Price price feed, Alberta (from_prices.LEX.AB.json) -- FPD \"Delivery and Destination Charge\" 2205 on every 2026 IS configuration (series IS)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 2205, applies: "always", scope: "model", make: "Lexus", model: "UX Hybrid", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.lexus.ca/bin/api/price_calculation/from_prices.LEX.AB.json",
    read: { path: ["UXH", "2026", "*", "name=FPD"], key: "amount" },
    source: "Lexus Canada Build & Price price feed, Alberta (from_prices.LEX.AB.json) -- FPD \"Delivery and Destination Charge\" 2205 on every 2026 UX Hybrid configuration (series UXH)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 2205, applies: "always", scope: "model", make: "Lexus", model: "NX", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.lexus.ca/bin/api/price_calculation/from_prices.LEX.AB.json",
    read: { path: ["NX", "2026", "*", "name=FPD"], key: "amount" },
    source: "Lexus Canada Build & Price price feed, Alberta (from_prices.LEX.AB.json) -- FPD \"Delivery and Destination Charge\" 2205 on every 2026 NX configuration (series NX)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 2205, applies: "always", scope: "model", make: "Lexus", model: "NX Hybrid", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.lexus.ca/bin/api/price_calculation/from_prices.LEX.AB.json",
    read: { path: ["NXH", "2026", "*", "name=FPD"], key: "amount" },
    source: "Lexus Canada Build & Price price feed, Alberta (from_prices.LEX.AB.json) -- FPD \"Delivery and Destination Charge\" 2205 on every 2026 NX Hybrid configuration (series NXH)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 2205, applies: "always", scope: "model", make: "Lexus", model: "NX Plug-in Hybrid", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.lexus.ca/bin/api/price_calculation/from_prices.LEX.AB.json",
    read: { path: ["NXP", "2026", "*", "name=FPD"], key: "amount" },
    source: "Lexus Canada Build & Price price feed, Alberta (from_prices.LEX.AB.json) -- FPD \"Delivery and Destination Charge\" 2205 on every 2026 NX Plug-in Hybrid configuration (series NXP)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 2205, applies: "always", scope: "model", make: "Lexus", model: "RX", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.lexus.ca/bin/api/price_calculation/from_prices.LEX.AB.json",
    read: { path: ["RX", "2026", "*", "name=FPD"], key: "amount" },
    source: "Lexus Canada Build & Price price feed, Alberta (from_prices.LEX.AB.json) -- FPD \"Delivery and Destination Charge\" 2205 on every 2026 RX configuration (series RX)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 2205, applies: "always", scope: "model", make: "Lexus", model: "RX Hybrid", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.lexus.ca/bin/api/price_calculation/from_prices.LEX.AB.json",
    read: { path: ["RXH", "2026", "*", "name=FPD"], key: "amount" },
    source: "Lexus Canada Build & Price price feed, Alberta (from_prices.LEX.AB.json) -- FPD \"Delivery and Destination Charge\" 2205 on every 2026 RX Hybrid configuration (series RXH)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 2205, applies: "always", scope: "model", make: "Lexus", model: "RX Plug-in Hybrid", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.lexus.ca/bin/api/price_calculation/from_prices.LEX.AB.json",
    read: { path: ["RXP", "2026", "*", "name=FPD"], key: "amount" },
    source: "Lexus Canada Build & Price price feed, Alberta (from_prices.LEX.AB.json) -- FPD \"Delivery and Destination Charge\" 2205 on every 2026 RX Plug-in Hybrid configuration (series RXP)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 2205, applies: "always", scope: "model", make: "Lexus", model: "RZ", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.lexus.ca/bin/api/price_calculation/from_prices.LEX.AB.json",
    read: { path: ["RZ", "2026", "*", "name=FPD"], key: "amount" },
    source: "Lexus Canada Build & Price price feed, Alberta (from_prices.LEX.AB.json) -- FPD \"Delivery and Destination Charge\" 2205 on every 2026 RZ configuration (series RZ)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 2205, applies: "always", scope: "model", make: "Lexus", model: "TX", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.lexus.ca/bin/api/price_calculation/from_prices.LEX.AB.json",
    read: { path: ["TX", "2026", "*", "name=FPD"], key: "amount" },
    source: "Lexus Canada Build & Price price feed, Alberta (from_prices.LEX.AB.json) -- FPD \"Delivery and Destination Charge\" 2205 on every 2026 TX configuration (series TX)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 2205, applies: "always", scope: "model", make: "Lexus", model: "TX Hybrid", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.lexus.ca/bin/api/price_calculation/from_prices.LEX.AB.json",
    read: { path: ["TXH", "2026", "*", "name=FPD"], key: "amount" },
    source: "Lexus Canada Build & Price price feed, Alberta (from_prices.LEX.AB.json) -- FPD \"Delivery and Destination Charge\" 2205 on every 2026 TX Hybrid configuration (series TXH)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 2205, applies: "always", scope: "model", make: "Lexus", model: "GX", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.lexus.ca/bin/api/price_calculation/from_prices.LEX.AB.json",
    read: { path: ["GX", "2026", "*", "name=FPD"], key: "amount" },
    source: "Lexus Canada Build & Price price feed, Alberta (from_prices.LEX.AB.json) -- FPD \"Delivery and Destination Charge\" 2205 on every 2026 GX configuration (series GX)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 2205, applies: "always", scope: "model", make: "Lexus", model: "LX", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.lexus.ca/bin/api/price_calculation/from_prices.LEX.AB.json",
    read: { path: ["LX", "2026", "*", "name=FPD"], key: "amount" },
    source: "Lexus Canada Build & Price price feed, Alberta (from_prices.LEX.AB.json) -- FPD \"Delivery and Destination Charge\" 2205 on every 2026 LX configuration (series LX)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 2205, applies: "always", scope: "model", make: "Lexus", model: "LX Hybrid", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.lexus.ca/bin/api/price_calculation/from_prices.LEX.AB.json",
    read: { path: ["LXH", "2026", "*", "name=FPD"], key: "amount" },
    source: "Lexus Canada Build & Price price feed, Alberta (from_prices.LEX.AB.json) -- FPD \"Delivery and Destination Charge\" 2205 on every 2026 LX Hybrid configuration (series LXH)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 2205, applies: "always", scope: "model", make: "Lexus", model: "LC", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.lexus.ca/bin/api/price_calculation/from_prices.LEX.AB.json",
    read: { path: ["LCC", "2026", "*", "name=FPD"], key: "amount" },
    source: "Lexus Canada Build & Price price feed, Alberta (from_prices.LEX.AB.json) -- FPD \"Delivery and Destination Charge\" 2205 on every 2026 LC configuration (series LCC)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 2205, applies: "always", scope: "model", make: "Lexus", model: "LC Convertible", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.lexus.ca/bin/api/price_calculation/from_prices.LEX.AB.json",
    read: { path: ["LCV", "2026", "*", "name=FPD"], key: "amount" },
    source: "Lexus Canada Build & Price price feed, Alberta (from_prices.LEX.AB.json) -- FPD \"Delivery and Destination Charge\" 2205 on every 2026 LC Convertible configuration (series LCV)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 2205, applies: "always", scope: "model", make: "Lexus", model: "ES", modelYear: 2026, covers: "freight_pdi",
    unsourced: "Lexus Canada's price feed now carries only the 2027 ES; the 2026 ES 350h figure was read off Lexus Canada's Build & Price (Alberta) on 2026-08-25 and no Lexus page still states it. The 2027 ES reads the same $2,205.",
    source: "Lexus Canada Build & Price -- 2026 ES 350h (Alberta)", capturedOn: "2026-08-25" },

  // ── Honda ── Honda Canada's own price calculator, Province = Alberta ─────
  // The calculator honda.ca's configurator calls is a POST of [{ modelKey,
  // modelYear}] and answers FreightPdiCost on every trim. The job asks exactly that.
  // TWO HONDA SOURCES DISAGREE ON THE CR-V AND HR-V. The calculator (every trim,
  // both years) and Honda's own 2026 CR-V release say $2,000; the special-offers
  // fine print for a 26MY CR-V LX and a MY27 HR-V Sport prints "$1,830 freight and
  // PDI". We hold the calculator's $2,000 -- the per-trim, per-province answer, and
  // the higher of the two, so a listing charging either figure is never told it is
  // above what Honda publishes. The disagreement is recorded here, not resolved.
  { component: "freight", label: "freight and PDI", amount: 1830, applies: "always", scope: "model", make: "Honda", model: "Civic Sedan", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://api.honda.ca/financials-worksheets/H/Live/website/price-calculator/AB",
    request: { method: "POST", body: [{ modelKey: "civic_sedan", modelYear: 2026}] },
    read: { key: "FreightPdiCost" },
    source: "Honda Canada price calculator (api.honda.ca .../price-calculator/AB, modelKey civic_sedan) -- FreightPdiCost 1830 on every 2026 Civic Sedan trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 1830, applies: "always", scope: "model", make: "Honda", model: "Civic Hatchback", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://api.honda.ca/financials-worksheets/H/Live/website/price-calculator/AB",
    request: { method: "POST", body: [{ modelKey: "civic_hatchback", modelYear: 2026}] },
    read: { key: "FreightPdiCost" },
    source: "Honda Canada price calculator (api.honda.ca .../price-calculator/AB, modelKey civic_hatchback) -- FreightPdiCost 1830 on every 2026 Civic Hatchback trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 1830, applies: "always", scope: "model", make: "Honda", model: "Civic Si", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://api.honda.ca/financials-worksheets/H/Live/website/price-calculator/AB",
    request: { method: "POST", body: [{ modelKey: "civic_sedan_si", modelYear: 2026}] },
    read: { key: "FreightPdiCost" },
    source: "Honda Canada price calculator (api.honda.ca .../price-calculator/AB, modelKey civic_sedan_si) -- FreightPdiCost 1830 on every 2026 Civic Si trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 1830, applies: "always", scope: "model", make: "Honda", model: "Civic Type R", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://api.honda.ca/financials-worksheets/H/Live/website/price-calculator/AB",
    request: { method: "POST", body: [{ modelKey: "civic_type_r", modelYear: 2026}] },
    read: { key: "FreightPdiCost" },
    source: "Honda Canada price calculator (api.honda.ca .../price-calculator/AB, modelKey civic_type_r) -- FreightPdiCost 1830 on every 2026 Civic Type R trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 1830, applies: "always", scope: "model", make: "Honda", model: "Accord", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://api.honda.ca/financials-worksheets/H/Live/website/price-calculator/AB",
    request: { method: "POST", body: [{ modelKey: "accord_sedan", modelYear: 2026}] },
    read: { key: "FreightPdiCost" },
    source: "Honda Canada price calculator (api.honda.ca .../price-calculator/AB, modelKey accord_sedan) -- FreightPdiCost 1830 on every 2026 Accord trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 1830, applies: "always", scope: "model", make: "Honda", model: "Prelude", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://api.honda.ca/financials-worksheets/H/Live/website/price-calculator/AB",
    request: { method: "POST", body: [{ modelKey: "prelude", modelYear: 2026}] },
    read: { key: "FreightPdiCost" },
    source: "Honda Canada price calculator (api.honda.ca .../price-calculator/AB, modelKey prelude) -- FreightPdiCost 1830 on every 2026 Prelude trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 1830, applies: "always", scope: "model", make: "Honda", model: "Prelude", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://api.honda.ca/financials-worksheets/H/Live/website/price-calculator/AB",
    request: { method: "POST", body: [{ modelKey: "prelude", modelYear: 2027}] },
    read: { key: "FreightPdiCost" },
    source: "Honda Canada price calculator (api.honda.ca .../price-calculator/AB, modelKey prelude) -- FreightPdiCost 1830 on every 2027 Prelude trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2000, applies: "always", scope: "model", make: "Honda", model: "HR-V", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://api.honda.ca/financials-worksheets/H/Live/website/price-calculator/AB",
    request: { method: "POST", body: [{ modelKey: "hr_v", modelYear: 2027}] },
    read: { key: "FreightPdiCost" },
    source: "Honda Canada price calculator (api.honda.ca .../price-calculator/AB, modelKey hr_v) -- FreightPdiCost 2000 on every 2027 HR-V trim", capturedOn: "2026-09-24",
    note: "honda.ca/special-offers fine print prints \"$1,830 freight and PDI\" for this model; the calculator and Honda's own CR-V release say $2,000. Held at $2,000 -- see the section note." },
  { component: "freight", label: "freight and PDI", amount: 2000, applies: "always", scope: "model", make: "Honda", model: "CR-V", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://api.honda.ca/financials-worksheets/H/Live/website/price-calculator/AB",
    request: { method: "POST", body: [{ modelKey: "cr-v", modelYear: 2026}] },
    read: { key: "FreightPdiCost" },
    source: "Honda Canada price calculator (api.honda.ca .../price-calculator/AB, modelKey cr-v) -- FreightPdiCost 2000 on every 2026 CR-V trim", capturedOn: "2026-09-24",
    note: "honda.ca/special-offers fine print prints \"$1,830 freight and PDI\" for this model; the calculator and Honda's own CR-V release say $2,000. Held at $2,000 -- see the section note." },
  { component: "freight", label: "freight and PDI", amount: 2000, applies: "always", scope: "model", make: "Honda", model: "CR-V", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://api.honda.ca/financials-worksheets/H/Live/website/price-calculator/AB",
    request: { method: "POST", body: [{ modelKey: "cr-v", modelYear: 2027}] },
    read: { key: "FreightPdiCost" },
    source: "Honda Canada price calculator (api.honda.ca .../price-calculator/AB, modelKey cr-v) -- FreightPdiCost 2000 on every 2027 CR-V trim", capturedOn: "2026-09-24",
    note: "honda.ca/special-offers fine print prints \"$1,830 freight and PDI\" for this model; the calculator and Honda's own CR-V release say $2,000. Held at $2,000 -- see the section note." },
  { component: "freight", label: "freight and PDI", amount: 2000, applies: "always", scope: "model", make: "Honda", model: "Passport", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://api.honda.ca/financials-worksheets/H/Live/website/price-calculator/AB",
    request: { method: "POST", body: [{ modelKey: "passport", modelYear: 2026}] },
    read: { key: "FreightPdiCost" },
    source: "Honda Canada price calculator (api.honda.ca .../price-calculator/AB, modelKey passport) -- FreightPdiCost 2000 on every 2026 Passport trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2000, applies: "always", scope: "model", make: "Honda", model: "Pilot", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://api.honda.ca/financials-worksheets/H/Live/website/price-calculator/AB",
    request: { method: "POST", body: [{ modelKey: "pilot", modelYear: 2026}] },
    read: { key: "FreightPdiCost" },
    source: "Honda Canada price calculator (api.honda.ca .../price-calculator/AB, modelKey pilot) -- FreightPdiCost 2000 on every 2026 Pilot trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2000, applies: "always", scope: "model", make: "Honda", model: "Ridgeline", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://api.honda.ca/financials-worksheets/H/Live/website/price-calculator/AB",
    request: { method: "POST", body: [{ modelKey: "ridgeline", modelYear: 2026}] },
    read: { key: "FreightPdiCost" },
    source: "Honda Canada price calculator (api.honda.ca .../price-calculator/AB, modelKey ridgeline) -- FreightPdiCost 2000 on every 2026 Ridgeline trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2000, applies: "always", scope: "model", make: "Honda", model: "Odyssey", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://api.honda.ca/financials-worksheets/H/Live/website/price-calculator/AB",
    request: { method: "POST", body: [{ modelKey: "odyssey", modelYear: 2026}] },
    read: { key: "FreightPdiCost" },
    source: "Honda Canada price calculator (api.honda.ca .../price-calculator/AB, modelKey odyssey) -- FreightPdiCost 2000 on every 2026 Odyssey trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2000, applies: "always", scope: "model", make: "Honda", model: "Odyssey", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://api.honda.ca/financials-worksheets/H/Live/website/price-calculator/AB",
    request: { method: "POST", body: [{ modelKey: "odyssey", modelYear: 2027}] },
    read: { key: "FreightPdiCost" },
    source: "Honda Canada price calculator (api.honda.ca .../price-calculator/AB, modelKey odyssey) -- FreightPdiCost 2000 on every 2027 Odyssey trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2000, applies: "always", scope: "model", make: "Honda", model: "Prologue", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://api.honda.ca/financials-worksheets/H/Live/website/price-calculator/AB",
    request: { method: "POST", body: [{ modelKey: "prologue", modelYear: 2026}] },
    read: { key: "FreightPdiCost" },
    source: "Honda Canada price calculator (api.honda.ca .../price-calculator/AB, modelKey prologue) -- FreightPdiCost 2000 on every 2026 Prologue trim", capturedOn: "2026-09-24" },

  // ── Acura ── the same calculator, Acura's worksheet. "FOR ALL OFFERS: Lease
  // payments include $2,595 freight and PDI" on acura.ca agrees. TLX and ZDX
  // answer no trims today (not currently sold).
  { component: "freight", label: "freight and PDI", amount: 2595, applies: "always", scope: "model", make: "Acura", model: "ADX", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://api.honda.ca/financials-worksheets/A/Live/website/price-calculator/AB",
    request: { method: "POST", body: [{ modelKey: "adx", modelYear: 2026}] },
    read: { key: "FreightPdiCost" },
    source: "Acura Canada price calculator (api.honda.ca .../A/.../price-calculator/AB, modelKey adx) -- FreightPdiCost 2595 on every 2026 ADX trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2595, applies: "always", scope: "model", make: "Acura", model: "Integra", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://api.honda.ca/financials-worksheets/A/Live/website/price-calculator/AB",
    request: { method: "POST", body: [{ modelKey: "integra", modelYear: 2026}] },
    read: { key: "FreightPdiCost" },
    source: "Acura Canada price calculator (api.honda.ca .../A/.../price-calculator/AB, modelKey integra) -- FreightPdiCost 2595 on every 2026 Integra trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2595, applies: "always", scope: "model", make: "Acura", model: "RDX", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://api.honda.ca/financials-worksheets/A/Live/website/price-calculator/AB",
    request: { method: "POST", body: [{ modelKey: "rdx", modelYear: 2026}] },
    read: { key: "FreightPdiCost" },
    source: "Acura Canada price calculator (api.honda.ca .../A/.../price-calculator/AB, modelKey rdx) -- FreightPdiCost 2595 on every 2026 RDX trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2595, applies: "always", scope: "model", make: "Acura", model: "MDX", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://api.honda.ca/financials-worksheets/A/Live/website/price-calculator/AB",
    request: { method: "POST", body: [{ modelKey: "mdx", modelYear: 2026}] },
    read: { key: "FreightPdiCost" },
    source: "Acura Canada price calculator (api.honda.ca .../A/.../price-calculator/AB, modelKey mdx) -- FreightPdiCost 2595 on every 2026 MDX trim", capturedOn: "2026-09-24" },

  // ── Nissan ── Nissan Canada's own pricing releases, one per model year ────
  // National releases: "Selling Price includes CA$2,080 freight and PDI". A few
  // drop the dollar sign ("CA2,095"), which the reader accepts in front of a
  // comma-grouped figure. nissan.ca's own pages still carry a stale "$2,095 in
  // freight & PDI" template, so they are not the source.
  // ARIYA 2026 IS DELIBERATELY ABSENT: the release says $2,170 while nissan.ca's
  // own price data shows $2,170 AND $2,200 by grade. Holding either would tell a
  // buyer of the other grade something Nissan does not publish for their car.
  { component: "freight", label: "freight and PDI", amount: 2080, applies: "always", scope: "model", make: "Nissan", model: "Rogue", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://canada.nissannews.com/en-CA/releases/2026-nissan-rogue-pricing-announced-for-canada",
    source: "Nissan Canada 2026 Rogue pricing release (canada.nissannews.com) -- \"CA$2,080 freight and PDI\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2095, applies: "always", scope: "model", make: "Nissan", model: "Rogue Plug-in Hybrid", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://canada.nissannews.com/en-CA/releases/2026-nissan-rogue-plug-in-hybrid-pricing-announced-for-canada",
    source: "Nissan Canada 2026 Rogue Plug-in Hybrid pricing release (canada.nissannews.com) -- \"CA$2,095 freight and PDI\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2080, applies: "always", scope: "model", make: "Nissan", model: "Rogue Hybrid", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://canada.nissannews.com/en-CA/releases/2027-nissan-rogue-hybrid-press-kit",
    source: "Nissan Canada 2027 Rogue Hybrid pricing release (canada.nissannews.com) -- \"CA$2,080 freight and PDI\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2050, applies: "always", scope: "model", make: "Nissan", model: "Kicks", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://canada.nissannews.com/en-CA/releases/2026-nissan-kicks-press-kit",
    source: "Nissan Canada 2026 Kicks pricing release (canada.nissannews.com) -- \"CA$2,050 freight and PDI\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2050, applies: "always", scope: "model", make: "Nissan", model: "Kicks", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://canada.nissannews.com/en-CA/releases/2027-nissan-kicks-press-kit",
    source: "Nissan Canada 2027 Kicks pricing release (canada.nissannews.com) -- \"CA$2,050 freight and PDI\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 1850, applies: "always", scope: "model", make: "Nissan", model: "Sentra", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://canada.nissannews.com/en-CA/releases/nissan-canada-announces-pricing-for-the-all-new-2026-nissan-sentra",
    source: "Nissan Canada 2026 Sentra pricing release (canada.nissannews.com) -- \"CA$1,850 freight and PDI\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2030, applies: "always", scope: "model", make: "Nissan", model: "Pathfinder", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://canada.nissannews.com/en-CA/releases/refreshed-2026-nissan-pathfinder-pricing-confirmed-for-canada",
    source: "Nissan Canada 2026 Pathfinder pricing release (canada.nissannews.com) -- \"CA$2,030 freight and PDI\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2030, applies: "always", scope: "model", make: "Nissan", model: "Murano", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://canada.nissannews.com/en-CA/releases/2026-nissan-murano-press-kit",
    source: "Nissan Canada 2026 Murano pricing release (canada.nissannews.com) -- \"CA$2,030 freight and PDI\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2050, applies: "always", scope: "model", make: "Nissan", model: "Murano", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://canada.nissannews.com/en-CA/releases/2027-nissan-murano-pricing-announced-for-canada",
    source: "Nissan Canada 2027 Murano pricing release (canada.nissannews.com) -- \"CA$2,050 freight and PDI\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2030, applies: "always", scope: "model", make: "Nissan", model: "Frontier", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://canada.nissannews.com/en-CA/releases/2026-nissan-frontier-pricing-announced-for-canada",
    source: "Nissan Canada 2026 Frontier pricing release (canada.nissannews.com) -- \"CA$2,030 freight and PDI\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2050, applies: "always", scope: "model", make: "Nissan", model: "Frontier", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://canada.nissannews.com/en-CA/releases/2027-nissan-frontier-pricing-announced-for-canada",
    source: "Nissan Canada 2027 Frontier pricing release (canada.nissannews.com) -- \"CA$2,050 freight and PDI\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2200, applies: "always", scope: "model", make: "Nissan", model: "Armada", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://canada.nissannews.com/en-CA/releases/2026-nissan-armada-pricing-announced-for-canada",
    source: "Nissan Canada 2026 Armada pricing release (canada.nissannews.com) -- \"CA$2,200 freight and PDI\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2200, applies: "always", scope: "model", make: "Nissan", model: "Armada", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://canada.nissannews.com/en-CA/releases/2027-nissan-armada-press-kit",
    source: "Nissan Canada 2027 Armada pricing release (canada.nissannews.com) -- \"CA$2,200 freight and PDI\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2350, applies: "always", scope: "model", make: "Nissan", model: "ARIYA", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://canada.nissannews.com/en-CA/releases/nissan-canada-announces-pricing-for-2027-ariya",
    source: "Nissan Canada 2027 ARIYA pricing release (canada.nissannews.com) -- \"CA$2,350 freight and PDI\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2095, applies: "always", scope: "model", make: "Nissan", model: "LEAF", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://canada.nissannews.com/en-CA/releases/all-new-2026-nissan-leaf-pricing-announced-for-canada",
    source: "Nissan Canada 2026 LEAF pricing release (canada.nissannews.com) -- \"CA$2,095 freight and PDI\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2200, applies: "always", scope: "model", make: "Nissan", model: "LEAF", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://canada.nissannews.com/en-CA/releases/2027-nissan-leaf-press-kit",
    source: "Nissan Canada 2027 LEAF pricing release (canada.nissannews.com) -- \"CA$2,200 freight and PDI\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2200, applies: "always", scope: "model", make: "Nissan", model: "Z", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://canada.nissannews.com/en-CA/releases/2027-nissan-z-pricing-announced-for-canada",
    source: "Nissan Canada 2027 Z pricing release (canada.nissannews.com) -- \"CA$2,200 freight and PDI\"", capturedOn: "2026-09-24" },

  // ── Infiniti ── infiniti.ca model pages, the price data they carry ─────
  // Every Infiniti model page holds allVehiclesModelPriceJSON, keyed "2026-qx60",
  // "2027-qx60" ..., whose Destination.modelPrice is the freight and PDI figure
  // Infiniti's own releases print ("CA$2,495 freight and PDI"). The page's
  // single-model block flips between model years from one request to the next
  // (2026 on one read, 2027 the next), so the job reads the all-years block by
  // year. The page also carries a stale generic "$2,095 in freight & PDI"
  // disclaimer -- a page-wide read would be wrong. canada.infinitinews.com, where
  // the QX60 figure was first read, now answers 403 to an identified request.
  { component: "freight", label: "freight and PDI", amount: 2495, applies: "always", scope: "model", make: "Infiniti", model: "QX60", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.infiniti.ca/vehicles/crossovers-suvs/qx60.html",
    read: { embedded: "allVehiclesModelPriceJSON", path: ["*", "2026-qx60", "Destination"], key: "modelPrice" },
    source: "Infiniti Canada QX60 page, price data allVehiclesModelPriceJSON -- \"2026-qx60\".Destination.modelPrice 2495", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2495, applies: "always", scope: "model", make: "Infiniti", model: "QX60", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.infiniti.ca/vehicles/crossovers-suvs/qx60.html",
    read: { embedded: "allVehiclesModelPriceJSON", path: ["*", "2027-qx60", "Destination"], key: "modelPrice" },
    source: "Infiniti Canada QX60 page, price data allVehiclesModelPriceJSON -- \"2027-qx60\".Destination.modelPrice 2495", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2495, applies: "always", scope: "model", make: "Infiniti", model: "QX65", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.infiniti.ca/vehicles/crossovers-suvs/qx65.html",
    read: { embedded: "allVehiclesModelPriceJSON", path: ["*", "2027-qx65", "Destination"], key: "modelPrice" },
    source: "Infiniti Canada QX65 page, price data allVehiclesModelPriceJSON -- \"2027-qx65\".Destination.modelPrice 2495", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2495, applies: "always", scope: "model", make: "Infiniti", model: "QX80", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.infiniti.ca/vehicles/crossovers-suvs/qx80.html",
    read: { embedded: "allVehiclesModelPriceJSON", path: ["*", "2026-qx80", "Destination"], key: "modelPrice" },
    source: "Infiniti Canada QX80 page, price data allVehiclesModelPriceJSON -- \"2026-qx80\".Destination.modelPrice 2495", capturedOn: "2026-09-24" },
  { component: "freight", label: "freight and PDI", amount: 2495, applies: "always", scope: "model", make: "Infiniti", model: "QX80", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.infiniti.ca/vehicles/crossovers-suvs/qx80.html",
    read: { embedded: "allVehiclesModelPriceJSON", path: ["*", "2027-qx80", "Destination"], key: "modelPrice" },
    source: "Infiniti Canada QX80 page, price data allVehiclesModelPriceJSON -- \"2027-qx80\".Destination.modelPrice 2495", capturedOn: "2026-09-24" },

  // ── Subaru ── subaru.ca Build & Price summary, ProvinceCode=AB ────────────
  // The summary page prints "PDI & Freight: $2,295.00" server-side. ProvinceCode
  // is required: without it the province follows the visitor. The page's pricing
  // XML also carries an unlabelled freight="$1,345.00" that is NOT added into
  // Subaru's own estimate, so it is not a separate charge and is not stored.
  { component: "freight", label: "PDI & Freight", amount: 2295, applies: "always", scope: "model", make: "Subaru", model: "Forester", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.subaru.ca/WebPage.aspx?WebSiteID=282&WebPageID=26171&Range=Forester&ModelYear=2026&CarID=1562&ProvinceCode=AB",
    source: "Subaru Canada Build & Price summary, ProvinceCode=AB -- \"PDI & Freight: $2,295.00\" (2026 Forester)", capturedOn: "2026-09-24" },
  { component: "freight", label: "PDI & Freight", amount: 2095, applies: "always", scope: "model", make: "Subaru", model: "Impreza", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.subaru.ca/WebPage.aspx?WebSiteID=282&WebPageID=26284&Range=Impreza&ModelYear=2026&CarID=1579&ProvinceCode=AB",
    source: "Subaru Canada Build & Price summary, ProvinceCode=AB -- \"PDI & Freight: $2,095.00\" (2026 Impreza)", capturedOn: "2026-09-24" },
  { component: "freight", label: "PDI & Freight", amount: 2295, applies: "always", scope: "model", make: "Subaru", model: "Outback", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.subaru.ca/WebPage.aspx?WebSiteID=282&WebPageID=25924&Range=Outback&ModelYear=2026&CarID=1582&ProvinceCode=AB",
    source: "Subaru Canada Build & Price summary, ProvinceCode=AB -- \"PDI & Freight: $2,295.00\" (2026 Outback)", capturedOn: "2026-09-24" },
  { component: "freight", label: "PDI & Freight", amount: 2095, applies: "always", scope: "model", make: "Subaru", model: "WRX", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.subaru.ca/WebPage.aspx?WebSiteID=282&WebPageID=26435&Range=WRX%20%26%20WRX%20STI&ModelYear=2026&CarID=1592&ProvinceCode=AB",
    source: "Subaru Canada Build & Price summary, ProvinceCode=AB -- \"PDI & Freight: $2,095.00\" (2026 WRX)", capturedOn: "2026-09-24" },
  { component: "freight", label: "PDI & Freight", amount: 2295, applies: "always", scope: "model", make: "Subaru", model: "Crosstrek", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.subaru.ca/WebPage.aspx?WebSiteID=282&WebPageID=26232&Range=Crosstrek&ModelYear=2026&CarID=1571&ProvinceCode=AB",
    source: "Subaru Canada Build & Price summary, ProvinceCode=AB -- \"PDI & Freight: $2,295.00\" (2026 Crosstrek)", capturedOn: "2026-09-24" },
  { component: "freight", label: "PDI & Freight", amount: 2195, applies: "always", scope: "model", make: "Subaru", model: "BRZ", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.subaru.ca/WebPage.aspx?WebSiteID=282&WebPageID=26732&Range=BRZ&ModelYear=2027&CarID=1622&ProvinceCode=AB",
    source: "Subaru Canada Build & Price summary, ProvinceCode=AB -- \"PDI & Freight: $2,195.00\" (2027 BRZ)", capturedOn: "2026-09-24" },
  { component: "freight", label: "PDI & Freight", amount: 2595, applies: "always", scope: "model", make: "Subaru", model: "Solterra", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.subaru.ca/WebPage.aspx?WebSiteID=282&WebPageID=26628&Range=Solterra&ModelYear=2027&CarID=1612&ProvinceCode=AB",
    source: "Subaru Canada Build & Price summary, ProvinceCode=AB -- \"PDI & Freight: $2,595.00\" (2027 Solterra)", capturedOn: "2026-09-24" },
  { component: "freight", label: "PDI & Freight", amount: 2595, applies: "always", scope: "model", make: "Subaru", model: "Trailseeker", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.subaru.ca/WebPage.aspx?WebSiteID=282&WebPageID=26680&Range=Trailseeker&ModelYear=2027&CarID=1618&ProvinceCode=AB",
    source: "Subaru Canada Build & Price summary, ProvinceCode=AB -- \"PDI & Freight: $2,595.00\" (2027 Trailseeker)", capturedOn: "2026-09-24" },
  { component: "freight", label: "PDI & Freight", amount: 2595, applies: "always", scope: "model", make: "Subaru", model: "Uncharted", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.subaru.ca/WebPage.aspx?WebSiteID=282&WebPageID=26576&Range=Uncharted&ModelYear=2027&CarID=1606&ProvinceCode=AB",
    source: "Subaru Canada Build & Price summary, ProvinceCode=AB -- \"PDI & Freight: $2,595.00\" (2027 Uncharted)", capturedOn: "2026-09-24" },

  // ── Mitsubishi ── Mitsubishi Motor Sales of Canada's own MY26 price guides ─
  // The guides itemise the two lines -- "PDI Charge $250, freight $1,875" -- and
  // no Mitsubishi page prints a bundled total (mitsubishi-motors.ca's offers are
  // client-rendered; "$2,125 freight and PDI" appears only in third-party copy,
  // which is not a source). Both lines are stored and each is re-read against its
  // own label; the PDF text is extracted by lib/pdf-text.mjs.
  { component: "freight", label: "PDI Charge + freight (itemised by Mitsubishi)", amount: 2125, applies: "always", scope: "model", make: "Mitsubishi", model: "Outlander", modelYear: 2026, covers: "freight_pdi",
    parts: { freight: 1875, pdi: 250 },
    sourceUrl: "https://www.mitsubishi-motors-pr.ca/wp-content/uploads/2026/03/MY26-Outlander-1-Page-EN.pdf",
    read: { labels: { freight: "freight", pdi: "PDI Charge" }, text: true},
    source: "Mitsubishi Canada MY26 Outlander price guide (mitsubishi-motors-pr.ca) -- \"PDI Charge $250, freight $1,875\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "PDI Charge + freight (itemised by Mitsubishi)", amount: 2125, applies: "always", scope: "model", make: "Mitsubishi", model: "Outlander PHEV", modelYear: 2026, covers: "freight_pdi",
    parts: { freight: 1875, pdi: 250 },
    sourceUrl: "https://www.mitsubishi-motors-pr.ca/wp-content/uploads/2026/03/MY26-Outlander-PHEV-Price-Guide-EN.pdf",
    read: { labels: { freight: "freight", pdi: "PDI Charge" }, text: true},
    source: "Mitsubishi Canada MY26 Outlander PHEV price guide (mitsubishi-motors-pr.ca) -- \"PDI Charge $250, freight $1,875\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "PDI Charge + freight (itemised by Mitsubishi)", amount: 2125, applies: "always", scope: "model", make: "Mitsubishi", model: "Eclipse Cross", modelYear: 2026, covers: "freight_pdi",
    parts: { freight: 1875, pdi: 250 },
    sourceUrl: "https://www.mitsubishi-motors-pr.ca/wp-content/uploads/2026/03/MY26-Eclipse-Cross-1-Page-EN.pdf",
    read: { labels: { freight: "freight", pdi: "PDI Charge" }, text: true},
    source: "Mitsubishi Canada MY26 Eclipse Cross price guide (mitsubishi-motors-pr.ca) -- \"PDI Charge $250, freight $1,875\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "PDI Charge + freight (itemised by Mitsubishi)", amount: 2125, applies: "always", scope: "model", make: "Mitsubishi", model: "RVR", modelYear: 2026, covers: "freight_pdi",
    parts: { freight: 1875, pdi: 250 },
    sourceUrl: "https://www.mitsubishi-motors-pr.ca/wp-content/uploads/2026/03/MY26-RVR-1-Page-EN.pdf",
    read: { labels: { freight: "freight", pdi: "PDI Charge" }, text: true},
    source: "Mitsubishi Canada MY26 RVR price guide (mitsubishi-motors-pr.ca) -- \"PDI Charge $250, freight $1,875\"", capturedOn: "2026-09-24" },

  // ── Kia ── kia.ca Build & Price, the model data the page carries ─────────
  // The page holds fourteen HTML-escaped "models":[...] blocks; every trim carries
  // priceDetails per province, and AB.dnd is Kia's "Delivery & Destination
  // Charge" -- which Kia's own tooltip says "covers the cost of transportation and
  // delivery to the dealership and pre-delivery inspection". The figure has no
  // "$", so only a read by name can see it. The page is ~25 MB; the job fetches it
  // once for all these rows.
  { component: "freight", label: "Delivery & Destination Charge", amount: 2185, applies: "always", scope: "model", make: "Kia", model: "Sportage", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.kia.ca/en/shopping-tools/build-and-price",
    read: { embedded: "\"models\":[", path: ["*", "model=Sportage&year=2026", "trims", "*", "priceDetails", "AB"], key: "dnd" },
    source: "Kia Canada Build & Price model data -- priceDetails.AB.dnd 2185 on every 2026 Sportage trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery & Destination Charge", amount: 2185, applies: "always", scope: "model", make: "Kia", model: "Sportage HEV", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.kia.ca/en/shopping-tools/build-and-price",
    read: { embedded: "\"models\":[", path: ["*", "model=Sportage HEV&year=2026", "trims", "*", "priceDetails", "AB"], key: "dnd" },
    source: "Kia Canada Build & Price model data -- priceDetails.AB.dnd 2185 on every 2026 Sportage HEV trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery & Destination Charge", amount: 2185, applies: "always", scope: "model", make: "Kia", model: "Sportage HEV", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.kia.ca/en/shopping-tools/build-and-price",
    read: { embedded: "\"models\":[", path: ["*", "model=Sportage HEV&year=2027", "trims", "*", "priceDetails", "AB"], key: "dnd" },
    source: "Kia Canada Build & Price model data -- priceDetails.AB.dnd 2185 on every 2027 Sportage HEV trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery & Destination Charge", amount: 2185, applies: "always", scope: "model", make: "Kia", model: "Sportage PHEV", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.kia.ca/en/shopping-tools/build-and-price",
    read: { embedded: "\"models\":[", path: ["*", "model=Sportage PHEV&year=2026", "trims", "*", "priceDetails", "AB"], key: "dnd" },
    source: "Kia Canada Build & Price model data -- priceDetails.AB.dnd 2185 on every 2026 Sportage PHEV trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery & Destination Charge", amount: 2185, applies: "always", scope: "model", make: "Kia", model: "Sportage PHEV", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.kia.ca/en/shopping-tools/build-and-price",
    read: { embedded: "\"models\":[", path: ["*", "model=Sportage PHEV&year=2027", "trims", "*", "priceDetails", "AB"], key: "dnd" },
    source: "Kia Canada Build & Price model data -- priceDetails.AB.dnd 2185 on every 2027 Sportage PHEV trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery & Destination Charge", amount: 2185, applies: "always", scope: "model", make: "Kia", model: "Carnival", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.kia.ca/en/shopping-tools/build-and-price",
    read: { embedded: "\"models\":[", path: ["*", "model=Carnival&year=2026", "trims", "*", "priceDetails", "AB"], key: "dnd" },
    source: "Kia Canada Build & Price model data -- priceDetails.AB.dnd 2185 on every 2026 Carnival trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery & Destination Charge", amount: 2185, applies: "always", scope: "model", make: "Kia", model: "Carnival", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.kia.ca/en/shopping-tools/build-and-price",
    read: { embedded: "\"models\":[", path: ["*", "model=Carnival&year=2027", "trims", "*", "priceDetails", "AB"], key: "dnd" },
    source: "Kia Canada Build & Price model data -- priceDetails.AB.dnd 2185 on every 2027 Carnival trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery & Destination Charge", amount: 2185, applies: "always", scope: "model", make: "Kia", model: "Carnival HEV", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.kia.ca/en/shopping-tools/build-and-price",
    read: { embedded: "\"models\":[", path: ["*", "model=Carnival HEV&year=2026", "trims", "*", "priceDetails", "AB"], key: "dnd" },
    source: "Kia Canada Build & Price model data -- priceDetails.AB.dnd 2185 on every 2026 Carnival HEV trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery & Destination Charge", amount: 2185, applies: "always", scope: "model", make: "Kia", model: "Carnival HEV", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.kia.ca/en/shopping-tools/build-and-price",
    read: { embedded: "\"models\":[", path: ["*", "model=Carnival HEV&year=2027", "trims", "*", "priceDetails", "AB"], key: "dnd" },
    source: "Kia Canada Build & Price model data -- priceDetails.AB.dnd 2185 on every 2027 Carnival HEV trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery & Destination Charge", amount: 2135, applies: "always", scope: "model", make: "Kia", model: "Sorento HEV", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.kia.ca/en/shopping-tools/build-and-price",
    read: { embedded: "\"models\":[", path: ["*", "model=Sorento HEV&year=2026", "trims", "*", "priceDetails", "AB"], key: "dnd" },
    source: "Kia Canada Build & Price model data -- priceDetails.AB.dnd 2135 on every 2026 Sorento HEV trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery & Destination Charge", amount: 2135, applies: "always", scope: "model", make: "Kia", model: "Sorento PHEV", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.kia.ca/en/shopping-tools/build-and-price",
    read: { embedded: "\"models\":[", path: ["*", "model=Sorento PHEV&year=2026", "trims", "*", "priceDetails", "AB"], key: "dnd" },
    source: "Kia Canada Build & Price model data -- priceDetails.AB.dnd 2135 on every 2026 Sorento PHEV trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery & Destination Charge", amount: 2135, applies: "always", scope: "model", make: "Kia", model: "Seltos", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.kia.ca/en/shopping-tools/build-and-price",
    read: { embedded: "\"models\":[", path: ["*", "model=Seltos&year=2026", "trims", "*", "priceDetails", "AB"], key: "dnd" },
    source: "Kia Canada Build & Price model data -- priceDetails.AB.dnd 2135 on every 2026 Seltos trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery & Destination Charge", amount: 2135, applies: "always", scope: "model", make: "Kia", model: "Seltos", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.kia.ca/en/shopping-tools/build-and-price",
    read: { embedded: "\"models\":[", path: ["*", "model=Seltos&year=2027", "trims", "*", "priceDetails", "AB"], key: "dnd" },
    source: "Kia Canada Build & Price model data -- priceDetails.AB.dnd 2135 on every 2027 Seltos trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery & Destination Charge", amount: 2135, applies: "always", scope: "model", make: "Kia", model: "Telluride", modelYear: 2025, covers: "freight_pdi",
    sourceUrl: "https://www.kia.ca/en/shopping-tools/build-and-price",
    read: { embedded: "\"models\":[", path: ["*", "model=Telluride&year=2025", "trims", "*", "priceDetails", "AB"], key: "dnd" },
    source: "Kia Canada Build & Price model data -- priceDetails.AB.dnd 2135 on every 2025 Telluride trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery & Destination Charge", amount: 1935, applies: "always", scope: "model", make: "Kia", model: "K4", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.kia.ca/en/shopping-tools/build-and-price",
    read: { embedded: "\"models\":[", path: ["*", "model=K4&year=2026", "trims", "*", "priceDetails", "AB"], key: "dnd" },
    source: "Kia Canada Build & Price model data -- priceDetails.AB.dnd 1935 on every 2026 K4 trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery & Destination Charge", amount: 1935, applies: "always", scope: "model", make: "Kia", model: "K4 Hatchback", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.kia.ca/en/shopping-tools/build-and-price",
    read: { embedded: "\"models\":[", path: ["*", "model=K4 Hatchback&year=2026", "trims", "*", "priceDetails", "AB"], key: "dnd" },
    source: "Kia Canada Build & Price model data -- priceDetails.AB.dnd 1935 on every 2026 K4 Hatchback trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery & Destination Charge", amount: 2035, applies: "always", scope: "model", make: "Kia", model: "Niro", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.kia.ca/en/shopping-tools/build-and-price",
    read: { embedded: "\"models\":[", path: ["*", "model=Niro&year=2026", "trims", "*", "priceDetails", "AB"], key: "dnd" },
    source: "Kia Canada Build & Price model data -- priceDetails.AB.dnd 2035 on every 2026 Niro trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery & Destination Charge", amount: 2035, applies: "always", scope: "model", make: "Kia", model: "Niro EV", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.kia.ca/en/shopping-tools/build-and-price",
    read: { embedded: "\"models\":[", path: ["*", "model=Niro EV&year=2026", "trims", "*", "priceDetails", "AB"], key: "dnd" },
    source: "Kia Canada Build & Price model data -- priceDetails.AB.dnd 2035 on every 2026 Niro EV trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery & Destination Charge", amount: 2185, applies: "always", scope: "model", make: "Kia", model: "EV3", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.kia.ca/en/shopping-tools/build-and-price",
    read: { embedded: "\"models\":[", path: ["*", "model=EV3&year=2027", "trims", "*", "priceDetails", "AB"], key: "dnd" },
    source: "Kia Canada Build & Price model data -- priceDetails.AB.dnd 2185 on every 2027 EV3 trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery & Destination Charge", amount: 2185, applies: "always", scope: "model", make: "Kia", model: "EV4", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.kia.ca/en/shopping-tools/build-and-price",
    read: { embedded: "\"models\":[", path: ["*", "model=EV4&year=2026", "trims", "*", "priceDetails", "AB"], key: "dnd" },
    source: "Kia Canada Build & Price model data -- priceDetails.AB.dnd 2185 on every 2026 EV4 trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery & Destination Charge", amount: 2185, applies: "always", scope: "model", make: "Kia", model: "EV5", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.kia.ca/en/shopping-tools/build-and-price",
    read: { embedded: "\"models\":[", path: ["*", "model=EV5&year=2027", "trims", "*", "priceDetails", "AB"], key: "dnd" },
    source: "Kia Canada Build & Price model data -- priceDetails.AB.dnd 2185 on every 2027 EV5 trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery & Destination Charge", amount: 2150, applies: "always", scope: "model", make: "Kia", model: "EV6", modelYear: 2025, covers: "freight_pdi",
    sourceUrl: "https://www.kia.ca/en/shopping-tools/build-and-price",
    read: { embedded: "\"models\":[", path: ["*", "model=EV6&year=2025", "trims", "*", "priceDetails", "AB"], key: "dnd" },
    source: "Kia Canada Build & Price model data -- priceDetails.AB.dnd 2150 on every 2025 EV6 trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery & Destination Charge", amount: 2185, applies: "always", scope: "model", make: "Kia", model: "EV9", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.kia.ca/en/shopping-tools/build-and-price",
    read: { embedded: "\"models\":[", path: ["*", "model=EV9&year=2026", "trims", "*", "priceDetails", "AB"], key: "dnd" },
    source: "Kia Canada Build & Price model data -- priceDetails.AB.dnd 2185 on every 2026 EV9 trim", capturedOn: "2026-09-24" },
  { component: "freight", label: "Delivery & Destination Charge", amount: 2185, applies: "always", scope: "model", make: "Kia", model: "PV5", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.kia.ca/en/shopping-tools/build-and-price",
    read: { embedded: "\"models\":[", path: ["*", "model=PV5&year=2027", "trims", "*", "priceDetails", "AB"], key: "dnd" },
    source: "Kia Canada Build & Price model data -- priceDetails.AB.dnd 2185 on every 2027 PV5 trim", capturedOn: "2026-09-24" },

  // ── Genesis ── NOTHING TO HOLD, by the maker's own design. Genesis prices are
  // all-inclusive ("Vehicle price is all-inclusive") and its Alberta fee table
  // lists A/C excise, AMVIC, a $0 dealer admin fee, oil/filter and tire levies --
  // no freight line. A freight line on a Genesis quote has no maker figure to be
  // measured against, which freightFor() says by returning null.

  // ── BMW ── BMW Canada's own price list, the one its configurator renders ──
  // configure.bmw.ca reads its prices from prod.ucp.bmw.cloud, and every line
  // carries a per-province tax block. Alberta's names Freight 3470 and Motor 10
  // (AMVIC) -- the same "Freight & PDI $3,470" the configurator printed for a 2026
  // X3 30 xDrive with Province = Alberta on 2026-09-17, and the figure BMW Royal
  // Oak's $4,395 was measured against. It is $3,470 on every one of BMW's 124
  // priced Canadian lines today.
  // THE PROVINCE IS THE FIGURE: the same list prices Ontario at $2,955 and BC at
  // $3,670. The "(up to $2,955)" this catalogue once refused was the Ontario block.
  // The list names no model year -- it prices what BMW sells today -- so these rows
  // are modelYear "current". The request sends the x-api-key that BMW's own
  // configurator settings file (configure.bmw.ca/en_CA/settings.*.json) hands every
  // browser for this host; without it the list answers 401. bmw.ca itself does not
  // answer LotCheckBot at all (timeout), and prod.ucp.bmw.cloud answers robots.txt
  // with 403, which RFC 9309 reads as "no file".
  { component: "freight", label: "Freight & PDI", amount: 3470, applies: "always", scope: "model", make: "BMW", model: "2 Series Gran Coupe", modelYear: "current", covers: "freight_pdi",
    sourceUrl: "https://prod.ucp.bmw.cloud/model-matrices/vehicle-trees/connext-bmw/sources/pcaso/brands/bmwCar/countries/ca/effect-dates/{today}/order-dates/{today}?gfs-policy=none&cluster=default&future-models=true&closest-fallback=true",
    request: { headers: {"x-api-key":"OmFpaEFpV0VUaUlrWTJ2Tnp0ZGdiUTd1NDhxR3JOcHRacXg1UWQK"}},
    read: { path: ["2", "modelRanges", "F74", "lines", "*", "prices", "alberta", "taxes", "taxKey=Freight"], key: "taxValue" },
    source: "BMW Canada price list (prod.ucp.bmw.cloud, brand bmwCar, model range F74) -- Alberta tax block \"Freight\" 3470 on every 2 Series Gran Coupe line; Ontario 2955, British Columbia 3670", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight & PDI", amount: 3470, applies: "always", scope: "model", make: "BMW", model: "2 Series Coupe", modelYear: "current", covers: "freight_pdi",
    sourceUrl: "https://prod.ucp.bmw.cloud/model-matrices/vehicle-trees/connext-bmw/sources/pcaso/brands/bmwCar/countries/ca/effect-dates/{today}/order-dates/{today}?gfs-policy=none&cluster=default&future-models=true&closest-fallback=true",
    request: { headers: {"x-api-key":"OmFpaEFpV0VUaUlrWTJ2Tnp0ZGdiUTd1NDhxR3JOcHRacXg1UWQK"}},
    read: { path: ["2", "modelRanges", "G42", "lines", "*", "prices", "alberta", "taxes", "taxKey=Freight"], key: "taxValue" },
    source: "BMW Canada price list (prod.ucp.bmw.cloud, brand bmwCar, model range G42) -- Alberta tax block \"Freight\" 3470 on every 2 Series Coupe line; Ontario 2955, British Columbia 3670", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight & PDI", amount: 3470, applies: "always", scope: "model", make: "BMW", model: "M2", modelYear: "current", covers: "freight_pdi",
    sourceUrl: "https://prod.ucp.bmw.cloud/model-matrices/vehicle-trees/connext-bmw/sources/pcaso/brands/bmwCar/countries/ca/effect-dates/{today}/order-dates/{today}?gfs-policy=none&cluster=default&future-models=true&closest-fallback=true",
    request: { headers: {"x-api-key":"OmFpaEFpV0VUaUlrWTJ2Tnp0ZGdiUTd1NDhxR3JOcHRacXg1UWQK"}},
    read: { path: ["2", "modelRanges", "G87", "lines", "*", "prices", "alberta", "taxes", "taxKey=Freight"], key: "taxValue" },
    source: "BMW Canada price list (prod.ucp.bmw.cloud, brand bmwCar, model range G87) -- Alberta tax block \"Freight\" 3470 on every M2 line; Ontario 2955, British Columbia 3670", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight & PDI", amount: 3470, applies: "always", scope: "model", make: "BMW", model: "3 Series", modelYear: "current", covers: "freight_pdi",
    sourceUrl: "https://prod.ucp.bmw.cloud/model-matrices/vehicle-trees/connext-bmw/sources/pcaso/brands/bmwCar/countries/ca/effect-dates/{today}/order-dates/{today}?gfs-policy=none&cluster=default&future-models=true&closest-fallback=true",
    request: { headers: {"x-api-key":"OmFpaEFpV0VUaUlrWTJ2Tnp0ZGdiUTd1NDhxR3JOcHRacXg1UWQK"}},
    read: { path: ["3", "modelRanges", "G20", "lines", "*", "prices", "alberta", "taxes", "taxKey=Freight"], key: "taxValue" },
    source: "BMW Canada price list (prod.ucp.bmw.cloud, brand bmwCar, model range G20) -- Alberta tax block \"Freight\" 3470 on every 3 Series line; Ontario 2955, British Columbia 3670", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight & PDI", amount: 3470, applies: "always", scope: "model", make: "BMW", model: "M3", modelYear: "current", covers: "freight_pdi",
    sourceUrl: "https://prod.ucp.bmw.cloud/model-matrices/vehicle-trees/connext-bmw/sources/pcaso/brands/bmwCar/countries/ca/effect-dates/{today}/order-dates/{today}?gfs-policy=none&cluster=default&future-models=true&closest-fallback=true",
    request: { headers: {"x-api-key":"OmFpaEFpV0VUaUlrWTJ2Tnp0ZGdiUTd1NDhxR3JOcHRacXg1UWQK"}},
    read: { path: ["M", "modelRanges", "G80", "lines", "*", "prices", "alberta", "taxes", "taxKey=Freight"], key: "taxValue" },
    source: "BMW Canada price list (prod.ucp.bmw.cloud, brand bmwCar, model range G80) -- Alberta tax block \"Freight\" 3470 on every M3 line; Ontario 2955, British Columbia 3670", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight & PDI", amount: 3470, applies: "always", scope: "model", make: "BMW", model: "4 Series Coupe", modelYear: "current", covers: "freight_pdi",
    sourceUrl: "https://prod.ucp.bmw.cloud/model-matrices/vehicle-trees/connext-bmw/sources/pcaso/brands/bmwCar/countries/ca/effect-dates/{today}/order-dates/{today}?gfs-policy=none&cluster=default&future-models=true&closest-fallback=true",
    request: { headers: {"x-api-key":"OmFpaEFpV0VUaUlrWTJ2Tnp0ZGdiUTd1NDhxR3JOcHRacXg1UWQK"}},
    read: { path: ["4", "modelRanges", "G22", "lines", "*", "prices", "alberta", "taxes", "taxKey=Freight"], key: "taxValue" },
    source: "BMW Canada price list (prod.ucp.bmw.cloud, brand bmwCar, model range G22) -- Alberta tax block \"Freight\" 3470 on every 4 Series Coupe line; Ontario 2955, British Columbia 3670", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight & PDI", amount: 3470, applies: "always", scope: "model", make: "BMW", model: "4 Series Cabriolet", modelYear: "current", covers: "freight_pdi",
    sourceUrl: "https://prod.ucp.bmw.cloud/model-matrices/vehicle-trees/connext-bmw/sources/pcaso/brands/bmwCar/countries/ca/effect-dates/{today}/order-dates/{today}?gfs-policy=none&cluster=default&future-models=true&closest-fallback=true",
    request: { headers: {"x-api-key":"OmFpaEFpV0VUaUlrWTJ2Tnp0ZGdiUTd1NDhxR3JOcHRacXg1UWQK"}},
    read: { path: ["4", "modelRanges", "G23", "lines", "*", "prices", "alberta", "taxes", "taxKey=Freight"], key: "taxValue" },
    source: "BMW Canada price list (prod.ucp.bmw.cloud, brand bmwCar, model range G23) -- Alberta tax block \"Freight\" 3470 on every 4 Series Cabriolet line; Ontario 2955, British Columbia 3670", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight & PDI", amount: 3470, applies: "always", scope: "model", make: "BMW", model: "4 Series Gran Coupe", modelYear: "current", covers: "freight_pdi",
    sourceUrl: "https://prod.ucp.bmw.cloud/model-matrices/vehicle-trees/connext-bmw/sources/pcaso/brands/bmwCar/countries/ca/effect-dates/{today}/order-dates/{today}?gfs-policy=none&cluster=default&future-models=true&closest-fallback=true",
    request: { headers: {"x-api-key":"OmFpaEFpV0VUaUlrWTJ2Tnp0ZGdiUTd1NDhxR3JOcHRacXg1UWQK"}},
    read: { path: ["4", "modelRanges", "G26", "lines", "*", "prices", "alberta", "taxes", "taxKey=Freight"], key: "taxValue" },
    source: "BMW Canada price list (prod.ucp.bmw.cloud, brand bmwCar, model range G26) -- Alberta tax block \"Freight\" 3470 on every 4 Series Gran Coupe line; Ontario 2955, British Columbia 3670", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight & PDI", amount: 3470, applies: "always", scope: "model", make: "BMW", model: "i4", modelYear: "current", covers: "freight_pdi",
    sourceUrl: "https://prod.ucp.bmw.cloud/model-matrices/vehicle-trees/connext-bmw/sources/pcaso/brands/bmwCar/countries/ca/effect-dates/{today}/order-dates/{today}?gfs-policy=none&cluster=default&future-models=true&closest-fallback=true",
    request: { headers: {"x-api-key":"OmFpaEFpV0VUaUlrWTJ2Tnp0ZGdiUTd1NDhxR3JOcHRacXg1UWQK"}},
    read: { path: ["4", "modelRanges", "G26", "lines", "*", "prices", "alberta", "taxes", "taxKey=Freight"], key: "taxValue" },
    source: "BMW Canada price list (prod.ucp.bmw.cloud, brand bmwCar, model range G26) -- Alberta tax block \"Freight\" 3470 on every i4 line; Ontario 2955, British Columbia 3670", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight & PDI", amount: 3470, applies: "always", scope: "model", make: "BMW", model: "M4", modelYear: "current", covers: "freight_pdi",
    sourceUrl: "https://prod.ucp.bmw.cloud/model-matrices/vehicle-trees/connext-bmw/sources/pcaso/brands/bmwCar/countries/ca/effect-dates/{today}/order-dates/{today}?gfs-policy=none&cluster=default&future-models=true&closest-fallback=true",
    request: { headers: {"x-api-key":"OmFpaEFpV0VUaUlrWTJ2Tnp0ZGdiUTd1NDhxR3JOcHRacXg1UWQK"}},
    read: { path: ["M", "modelRanges", "G82", "lines", "*", "prices", "alberta", "taxes", "taxKey=Freight"], key: "taxValue" },
    source: "BMW Canada price list (prod.ucp.bmw.cloud, brand bmwCar, model range G82) -- Alberta tax block \"Freight\" 3470 on every M4 line; Ontario 2955, British Columbia 3670", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight & PDI", amount: 3470, applies: "always", scope: "model", make: "BMW", model: "M4 Cabriolet", modelYear: "current", covers: "freight_pdi",
    sourceUrl: "https://prod.ucp.bmw.cloud/model-matrices/vehicle-trees/connext-bmw/sources/pcaso/brands/bmwCar/countries/ca/effect-dates/{today}/order-dates/{today}?gfs-policy=none&cluster=default&future-models=true&closest-fallback=true",
    request: { headers: {"x-api-key":"OmFpaEFpV0VUaUlrWTJ2Tnp0ZGdiUTd1NDhxR3JOcHRacXg1UWQK"}},
    read: { path: ["M", "modelRanges", "G83", "lines", "*", "prices", "alberta", "taxes", "taxKey=Freight"], key: "taxValue" },
    source: "BMW Canada price list (prod.ucp.bmw.cloud, brand bmwCar, model range G83) -- Alberta tax block \"Freight\" 3470 on every M4 Cabriolet line; Ontario 2955, British Columbia 3670", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight & PDI", amount: 3470, applies: "always", scope: "model", make: "BMW", model: "5 Series", modelYear: "current", covers: "freight_pdi",
    sourceUrl: "https://prod.ucp.bmw.cloud/model-matrices/vehicle-trees/connext-bmw/sources/pcaso/brands/bmwCar/countries/ca/effect-dates/{today}/order-dates/{today}?gfs-policy=none&cluster=default&future-models=true&closest-fallback=true",
    request: { headers: {"x-api-key":"OmFpaEFpV0VUaUlrWTJ2Tnp0ZGdiUTd1NDhxR3JOcHRacXg1UWQK"}},
    read: { path: ["5", "modelRanges", "G60", "lines", "*", "prices", "alberta", "taxes", "taxKey=Freight"], key: "taxValue" },
    source: "BMW Canada price list (prod.ucp.bmw.cloud, brand bmwCar, model range G60) -- Alberta tax block \"Freight\" 3470 on every 5 Series line; Ontario 2955, British Columbia 3670", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight & PDI", amount: 3470, applies: "always", scope: "model", make: "BMW", model: "i5", modelYear: "current", covers: "freight_pdi",
    sourceUrl: "https://prod.ucp.bmw.cloud/model-matrices/vehicle-trees/connext-bmw/sources/pcaso/brands/bmwCar/countries/ca/effect-dates/{today}/order-dates/{today}?gfs-policy=none&cluster=default&future-models=true&closest-fallback=true",
    request: { headers: {"x-api-key":"OmFpaEFpV0VUaUlrWTJ2Tnp0ZGdiUTd1NDhxR3JOcHRacXg1UWQK"}},
    read: { path: ["5", "modelRanges", "G60", "lines", "*", "prices", "alberta", "taxes", "taxKey=Freight"], key: "taxValue" },
    source: "BMW Canada price list (prod.ucp.bmw.cloud, brand bmwCar, model range G60) -- Alberta tax block \"Freight\" 3470 on every i5 line; Ontario 2955, British Columbia 3670", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight & PDI", amount: 3470, applies: "always", scope: "model", make: "BMW", model: "M5", modelYear: "current", covers: "freight_pdi",
    sourceUrl: "https://prod.ucp.bmw.cloud/model-matrices/vehicle-trees/connext-bmw/sources/pcaso/brands/bmwCar/countries/ca/effect-dates/{today}/order-dates/{today}?gfs-policy=none&cluster=default&future-models=true&closest-fallback=true",
    request: { headers: {"x-api-key":"OmFpaEFpV0VUaUlrWTJ2Tnp0ZGdiUTd1NDhxR3JOcHRacXg1UWQK"}},
    read: { path: ["M", "modelRanges", "G90", "lines", "*", "prices", "alberta", "taxes", "taxKey=Freight"], key: "taxValue" },
    source: "BMW Canada price list (prod.ucp.bmw.cloud, brand bmwCar, model range G90) -- Alberta tax block \"Freight\" 3470 on every M5 line; Ontario 2955, British Columbia 3670", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight & PDI", amount: 3470, applies: "always", scope: "model", make: "BMW", model: "M5 Touring", modelYear: "current", covers: "freight_pdi",
    sourceUrl: "https://prod.ucp.bmw.cloud/model-matrices/vehicle-trees/connext-bmw/sources/pcaso/brands/bmwCar/countries/ca/effect-dates/{today}/order-dates/{today}?gfs-policy=none&cluster=default&future-models=true&closest-fallback=true",
    request: { headers: {"x-api-key":"OmFpaEFpV0VUaUlrWTJ2Tnp0ZGdiUTd1NDhxR3JOcHRacXg1UWQK"}},
    read: { path: ["M", "modelRanges", "G99", "lines", "*", "prices", "alberta", "taxes", "taxKey=Freight"], key: "taxValue" },
    source: "BMW Canada price list (prod.ucp.bmw.cloud, brand bmwCar, model range G99) -- Alberta tax block \"Freight\" 3470 on every M5 Touring line; Ontario 2955, British Columbia 3670", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight & PDI", amount: 3470, applies: "always", scope: "model", make: "BMW", model: "7 Series", modelYear: "current", covers: "freight_pdi",
    sourceUrl: "https://prod.ucp.bmw.cloud/model-matrices/vehicle-trees/connext-bmw/sources/pcaso/brands/bmwCar/countries/ca/effect-dates/{today}/order-dates/{today}?gfs-policy=none&cluster=default&future-models=true&closest-fallback=true",
    request: { headers: {"x-api-key":"OmFpaEFpV0VUaUlrWTJ2Tnp0ZGdiUTd1NDhxR3JOcHRacXg1UWQK"}},
    read: { path: ["7", "modelRanges", "G70", "lines", "*", "prices", "alberta", "taxes", "taxKey=Freight"], key: "taxValue" },
    source: "BMW Canada price list (prod.ucp.bmw.cloud, brand bmwCar, model range G70) -- Alberta tax block \"Freight\" 3470 on every 7 Series line; Ontario 2955, British Columbia 3670", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight & PDI", amount: 3470, applies: "always", scope: "model", make: "BMW", model: "i7", modelYear: "current", covers: "freight_pdi",
    sourceUrl: "https://prod.ucp.bmw.cloud/model-matrices/vehicle-trees/connext-bmw/sources/pcaso/brands/bmwCar/countries/ca/effect-dates/{today}/order-dates/{today}?gfs-policy=none&cluster=default&future-models=true&closest-fallback=true",
    request: { headers: {"x-api-key":"OmFpaEFpV0VUaUlrWTJ2Tnp0ZGdiUTd1NDhxR3JOcHRacXg1UWQK"}},
    read: { path: ["7", "modelRanges", "G70", "lines", "*", "prices", "alberta", "taxes", "taxKey=Freight"], key: "taxValue" },
    source: "BMW Canada price list (prod.ucp.bmw.cloud, brand bmwCar, model range G70) -- Alberta tax block \"Freight\" 3470 on every i7 line; Ontario 2955, British Columbia 3670", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight & PDI", amount: 3470, applies: "always", scope: "model", make: "BMW", model: "X1", modelYear: "current", covers: "freight_pdi",
    sourceUrl: "https://prod.ucp.bmw.cloud/model-matrices/vehicle-trees/connext-bmw/sources/pcaso/brands/bmwCar/countries/ca/effect-dates/{today}/order-dates/{today}?gfs-policy=none&cluster=default&future-models=true&closest-fallback=true",
    request: { headers: {"x-api-key":"OmFpaEFpV0VUaUlrWTJ2Tnp0ZGdiUTd1NDhxR3JOcHRacXg1UWQK"}},
    read: { path: ["X", "modelRanges", "U11", "lines", "*", "prices", "alberta", "taxes", "taxKey=Freight"], key: "taxValue" },
    source: "BMW Canada price list (prod.ucp.bmw.cloud, brand bmwCar, model range U11) -- Alberta tax block \"Freight\" 3470 on every X1 line; Ontario 2955, British Columbia 3670", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight & PDI", amount: 3470, applies: "always", scope: "model", make: "BMW", model: "X2", modelYear: "current", covers: "freight_pdi",
    sourceUrl: "https://prod.ucp.bmw.cloud/model-matrices/vehicle-trees/connext-bmw/sources/pcaso/brands/bmwCar/countries/ca/effect-dates/{today}/order-dates/{today}?gfs-policy=none&cluster=default&future-models=true&closest-fallback=true",
    request: { headers: {"x-api-key":"OmFpaEFpV0VUaUlrWTJ2Tnp0ZGdiUTd1NDhxR3JOcHRacXg1UWQK"}},
    read: { path: ["X", "modelRanges", "U10", "lines", "*", "prices", "alberta", "taxes", "taxKey=Freight"], key: "taxValue" },
    source: "BMW Canada price list (prod.ucp.bmw.cloud, brand bmwCar, model range U10) -- Alberta tax block \"Freight\" 3470 on every X2 line; Ontario 2955, British Columbia 3670", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight & PDI", amount: 3470, applies: "always", scope: "model", make: "BMW", model: "X3", modelYear: "current", covers: "freight_pdi",
    sourceUrl: "https://prod.ucp.bmw.cloud/model-matrices/vehicle-trees/connext-bmw/sources/pcaso/brands/bmwCar/countries/ca/effect-dates/{today}/order-dates/{today}?gfs-policy=none&cluster=default&future-models=true&closest-fallback=true",
    request: { headers: {"x-api-key":"OmFpaEFpV0VUaUlrWTJ2Tnp0ZGdiUTd1NDhxR3JOcHRacXg1UWQK"}},
    read: { path: ["X", "modelRanges", "G45", "lines", "*", "prices", "alberta", "taxes", "taxKey=Freight"], key: "taxValue" },
    source: "BMW Canada price list (prod.ucp.bmw.cloud, brand bmwCar, model range G45) -- Alberta tax block \"Freight\" 3470 on every X3 line; Ontario 2955, British Columbia 3670", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight & PDI", amount: 3470, applies: "always", scope: "model", make: "BMW", model: "iX3", modelYear: "current", covers: "freight_pdi",
    sourceUrl: "https://prod.ucp.bmw.cloud/model-matrices/vehicle-trees/connext-bmw/sources/pcaso/brands/bmwCar/countries/ca/effect-dates/{today}/order-dates/{today}?gfs-policy=none&cluster=default&future-models=true&closest-fallback=true",
    request: { headers: {"x-api-key":"OmFpaEFpV0VUaUlrWTJ2Tnp0ZGdiUTd1NDhxR3JOcHRacXg1UWQK"}},
    read: { path: ["X", "modelRanges", "NA5", "lines", "*", "prices", "alberta", "taxes", "taxKey=Freight"], key: "taxValue" },
    source: "BMW Canada price list (prod.ucp.bmw.cloud, brand bmwCar, model range NA5) -- Alberta tax block \"Freight\" 3470 on every iX3 line; Ontario 2955, British Columbia 3670", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight & PDI", amount: 3470, applies: "always", scope: "model", make: "BMW", model: "X5", modelYear: "current", covers: "freight_pdi",
    sourceUrl: "https://prod.ucp.bmw.cloud/model-matrices/vehicle-trees/connext-bmw/sources/pcaso/brands/bmwCar/countries/ca/effect-dates/{today}/order-dates/{today}?gfs-policy=none&cluster=default&future-models=true&closest-fallback=true",
    request: { headers: {"x-api-key":"OmFpaEFpV0VUaUlrWTJ2Tnp0ZGdiUTd1NDhxR3JOcHRacXg1UWQK"}},
    read: { path: ["X", "modelRanges", "G65", "lines", "*", "prices", "alberta", "taxes", "taxKey=Freight"], key: "taxValue" },
    source: "BMW Canada price list (prod.ucp.bmw.cloud, brand bmwCar, model range G65) -- Alberta tax block \"Freight\" 3470 on every X5 line; Ontario 2955, British Columbia 3670", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight & PDI", amount: 3470, applies: "always", scope: "model", make: "BMW", model: "X6", modelYear: "current", covers: "freight_pdi",
    sourceUrl: "https://prod.ucp.bmw.cloud/model-matrices/vehicle-trees/connext-bmw/sources/pcaso/brands/bmwCar/countries/ca/effect-dates/{today}/order-dates/{today}?gfs-policy=none&cluster=default&future-models=true&closest-fallback=true",
    request: { headers: {"x-api-key":"OmFpaEFpV0VUaUlrWTJ2Tnp0ZGdiUTd1NDhxR3JOcHRacXg1UWQK"}},
    read: { path: ["X", "modelRanges", "G06", "lines", "*", "prices", "alberta", "taxes", "taxKey=Freight"], key: "taxValue" },
    source: "BMW Canada price list (prod.ucp.bmw.cloud, brand bmwCar, model range G06) -- Alberta tax block \"Freight\" 3470 on every X6 line; Ontario 2955, British Columbia 3670", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight & PDI", amount: 3470, applies: "always", scope: "model", make: "BMW", model: "X6 M", modelYear: "current", covers: "freight_pdi",
    sourceUrl: "https://prod.ucp.bmw.cloud/model-matrices/vehicle-trees/connext-bmw/sources/pcaso/brands/bmwCar/countries/ca/effect-dates/{today}/order-dates/{today}?gfs-policy=none&cluster=default&future-models=true&closest-fallback=true",
    request: { headers: {"x-api-key":"OmFpaEFpV0VUaUlrWTJ2Tnp0ZGdiUTd1NDhxR3JOcHRacXg1UWQK"}},
    read: { path: ["M", "modelRanges", "F96", "lines", "*", "prices", "alberta", "taxes", "taxKey=Freight"], key: "taxValue" },
    source: "BMW Canada price list (prod.ucp.bmw.cloud, brand bmwCar, model range F96) -- Alberta tax block \"Freight\" 3470 on every X6 M line; Ontario 2955, British Columbia 3670", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight & PDI", amount: 3470, applies: "always", scope: "model", make: "BMW", model: "X7", modelYear: "current", covers: "freight_pdi",
    sourceUrl: "https://prod.ucp.bmw.cloud/model-matrices/vehicle-trees/connext-bmw/sources/pcaso/brands/bmwCar/countries/ca/effect-dates/{today}/order-dates/{today}?gfs-policy=none&cluster=default&future-models=true&closest-fallback=true",
    request: { headers: {"x-api-key":"OmFpaEFpV0VUaUlrWTJ2Tnp0ZGdiUTd1NDhxR3JOcHRacXg1UWQK"}},
    read: { path: ["X", "modelRanges", "G07", "lines", "*", "prices", "alberta", "taxes", "taxKey=Freight"], key: "taxValue" },
    source: "BMW Canada price list (prod.ucp.bmw.cloud, brand bmwCar, model range G07) -- Alberta tax block \"Freight\" 3470 on every X7 line; Ontario 2955, British Columbia 3670", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight & PDI", amount: 3470, applies: "always", scope: "model", make: "BMW", model: "XM", modelYear: "current", covers: "freight_pdi",
    sourceUrl: "https://prod.ucp.bmw.cloud/model-matrices/vehicle-trees/connext-bmw/sources/pcaso/brands/bmwCar/countries/ca/effect-dates/{today}/order-dates/{today}?gfs-policy=none&cluster=default&future-models=true&closest-fallback=true",
    request: { headers: {"x-api-key":"OmFpaEFpV0VUaUlrWTJ2Tnp0ZGdiUTd1NDhxR3JOcHRacXg1UWQK"}},
    read: { path: ["M", "modelRanges", "G09", "lines", "*", "prices", "alberta", "taxes", "taxKey=Freight"], key: "taxValue" },
    source: "BMW Canada price list (prod.ucp.bmw.cloud, brand bmwCar, model range G09) -- Alberta tax block \"Freight\" 3470 on every XM line; Ontario 2955, British Columbia 3670", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight & PDI", amount: 3470, applies: "always", scope: "model", make: "BMW", model: "iX", modelYear: "current", covers: "freight_pdi",
    sourceUrl: "https://prod.ucp.bmw.cloud/model-matrices/vehicle-trees/connext-bmw/sources/pcaso/brands/bmwi/countries/ca/effect-dates/{today}/order-dates/{today}?gfs-policy=none&cluster=default&future-models=true&closest-fallback=true",
    request: { headers: {"x-api-key":"OmFpaEFpV0VUaUlrWTJ2Tnp0ZGdiUTd1NDhxR3JOcHRacXg1UWQK"}},
    read: { path: ["i", "modelRanges", "I20", "lines", "*", "prices", "alberta", "taxes", "taxKey=Freight"], key: "taxValue" },
    source: "BMW Canada price list (prod.ucp.bmw.cloud, brand bmwi, model range I20) -- Alberta tax block \"Freight\" 3470 on every iX line; Ontario 2955, British Columbia 3670", capturedOn: "2026-09-24" },

  // ── MINI ── MINI Canada's own calculator, province = Alberta ─────────────
  // mini.ca's calculator answers a form post of CACodes and itemises
  // "Freight/PDI:" beside the A/C levy and "AMVIC". It prices the province named in
  // MINI's own preference cookie; with none it answers the ONTARIO rendering
  // ($2,995, OMVIC), which is what scripts/scrape-mini.mjs has been reading. The job
  // names Alberta in that cookie -- a true statement of the question, not a
  // session. Alberta is $3,795 on every 2026 and 2027 Cooper (3 door, 5 door,
  // Convertible, JCW) and Countryman.
  { component: "freight", label: "Freight/PDI", amount: 3795, applies: "always", scope: "model", make: "MINI", model: "Cooper", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.mini.ca/en/CalculatorAPI/GetMultipleVehicleData",
    request: { method: "POST", body: "CACodes=26HA;26HB;26HC;26HD;26HE;26VA;26VB;26VC", contentType: "application/x-www-form-urlencoded", headers: { Cookie: "__mini=ulang=en&uprov=AB; Setting=province=Alberta"}},
    read: { path: ["*", "Vehicle", "CashAllInclusivePriceBreakdown", "AdditionalItems", "FixedInternalName=FreightAndPDI"], key: "Value" },
    source: "MINI Canada calculator (mini.ca, province Alberta) -- \"Freight/PDI:\" 3795 on every 2026 Cooper (8 configurations)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight/PDI", amount: 3795, applies: "always", scope: "model", make: "MINI", model: "Cooper", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.mini.ca/en/CalculatorAPI/GetMultipleVehicleData",
    request: { method: "POST", body: "CACodes=27HA;27HB;27HC;27HD;27HE;27VA;27VB;27VC", contentType: "application/x-www-form-urlencoded", headers: { Cookie: "__mini=ulang=en&uprov=AB; Setting=province=Alberta"}},
    read: { path: ["*", "Vehicle", "CashAllInclusivePriceBreakdown", "AdditionalItems", "FixedInternalName=FreightAndPDI"], key: "Value" },
    source: "MINI Canada calculator (mini.ca, province Alberta) -- \"Freight/PDI:\" 3795 on every 2027 Cooper (8 configurations)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight/PDI", amount: 3795, applies: "always", scope: "model", make: "MINI", model: "Countryman", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.mini.ca/en/CalculatorAPI/GetMultipleVehicleData",
    request: { method: "POST", body: "CACodes=26YD;26YE;26YF", contentType: "application/x-www-form-urlencoded", headers: { Cookie: "__mini=ulang=en&uprov=AB; Setting=province=Alberta"}},
    read: { path: ["*", "Vehicle", "CashAllInclusivePriceBreakdown", "AdditionalItems", "FixedInternalName=FreightAndPDI"], key: "Value" },
    source: "MINI Canada calculator (mini.ca, province Alberta) -- \"Freight/PDI:\" 3795 on every 2026 Countryman (3 configurations)", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight/PDI", amount: 3795, applies: "always", scope: "model", make: "MINI", model: "Countryman", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.mini.ca/en/CalculatorAPI/GetMultipleVehicleData",
    request: { method: "POST", body: "CACodes=27YD;27YE;27YF", contentType: "application/x-www-form-urlencoded", headers: { Cookie: "__mini=ulang=en&uprov=AB; Setting=province=Alberta"}},
    read: { path: ["*", "Vehicle", "CashAllInclusivePriceBreakdown", "AdditionalItems", "FixedInternalName=FreightAndPDI"], key: "Value" },
    source: "MINI Canada calculator (mini.ca, province Alberta) -- \"Freight/PDI:\" 3795 on every 2027 Countryman (3 configurations)", capturedOn: "2026-09-24" },

  // ── Porsche ── Porsche Canada's configurator, model pages ────────────────
  // Porsche prints a "Destination Charge" and folds pre-delivery work into a
  // separate "Estimated Maximum Dealer Fee" ($2,750), so these rows cover freight
  // only and freightLine never measures a Freight-and-PDI line against them. $3,200
  // for every 2027 line, $2,950 for the 2026 Macan and 911 Spirit 70 and the 2025
  // 718s. The URLs the daily job fetched until 2026-09-24 (/exclusive-manufaktur
  // and /group/) are Disallowed in configurator.porsche.com/robots.txt -- it was
  // confirming Porsche every morning from a path it had been asked not to read.
  // /mode/model/{year}/{code} is allowed.
  { component: "freight", label: "Destination Charge", amount: 3200, applies: "always", scope: "model", make: "Porsche", model: "911", modelYear: 2027, covers: "freight_only",
    sourceUrl: "https://configurator.porsche.com/en-CA/mode/model/2027/9921B2",
    source: "Porsche Canada configurator, 2027 911 (9921B2) -- \"Destination Charge $3,200\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "Destination Charge", amount: 3200, applies: "always", scope: "model", make: "Porsche", model: "Cayenne", modelYear: 2027, covers: "freight_only",
    sourceUrl: "https://configurator.porsche.com/en-CA/mode/model/2027/9YAAI1",
    source: "Porsche Canada configurator, 2027 Cayenne (9YAAI1) -- \"Destination Charge $3,200\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "Destination Charge", amount: 3200, applies: "always", scope: "model", make: "Porsche", model: "Cayenne Electric", modelYear: 2027, covers: "freight_only",
    sourceUrl: "https://configurator.porsche.com/en-CA/mode/model/2027/X1AAA1",
    source: "Porsche Canada configurator, 2027 Cayenne Electric (X1AAA1) -- \"Destination Charge $3,200\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "Destination Charge", amount: 3200, applies: "always", scope: "model", make: "Porsche", model: "Macan", modelYear: 2027, covers: "freight_only",
    sourceUrl: "https://configurator.porsche.com/en-CA/mode/model/2027/XABBB1",
    source: "Porsche Canada configurator, 2027 Macan (XABBB1) -- \"Destination Charge $3,200\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "Destination Charge", amount: 3200, applies: "always", scope: "model", make: "Porsche", model: "Panamera", modelYear: 2027, covers: "freight_only",
    sourceUrl: "https://configurator.porsche.com/en-CA/mode/model/2027/YAAAA1",
    source: "Porsche Canada configurator, 2027 Panamera (YAAAA1) -- \"Destination Charge $3,200\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "Destination Charge", amount: 3200, applies: "always", scope: "model", make: "Porsche", model: "Taycan", modelYear: 2027, covers: "freight_only",
    sourceUrl: "https://configurator.porsche.com/en-CA/mode/model/2027/Y1ADJ1",
    source: "Porsche Canada configurator, 2027 Taycan (Y1ADJ1) -- \"Destination Charge $3,200\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "Destination Charge", amount: 2950, applies: "always", scope: "model", make: "Porsche", model: "Macan", modelYear: 2026, covers: "freight_only",
    sourceUrl: "https://configurator.porsche.com/en-CA/mode/model/2026/95BAU1",
    source: "Porsche Canada configurator, 2026 Macan (95BAU1) -- \"Destination Charge $2,950\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "Destination Charge", amount: 2950, applies: "always", scope: "model", make: "Porsche", model: "911 Spirit 70", modelYear: 2026, covers: "freight_only",
    sourceUrl: "https://configurator.porsche.com/en-CA/mode/model/2026/992352",
    source: "Porsche Canada configurator, 2026 911 Spirit 70 (992352) -- \"Destination Charge $2,950\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "Destination Charge", amount: 2950, applies: "always", scope: "model", make: "Porsche", model: "718 Cayman", modelYear: 2025, covers: "freight_only",
    sourceUrl: "https://configurator.porsche.com/en-CA/mode/model/2025/982120",
    source: "Porsche Canada configurator, 2025 718 Cayman (982120) -- \"Destination Charge $2,950\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "Destination Charge", amount: 2950, applies: "always", scope: "model", make: "Porsche", model: "718 Boxster", modelYear: 2025, covers: "freight_only",
    sourceUrl: "https://configurator.porsche.com/en-CA/mode/model/2025/982320",
    source: "Porsche Canada configurator, 2025 718 Boxster (982320) -- \"Destination Charge $2,950\"", capturedOn: "2026-09-24" },

  // ── Polestar ── Polestar Canada's offer fine print ──────────────────────
  // "Selling price is $72,800 which includes $69,900 MSRP, $2,800 Freight and PDI
  // and $100 air conditioning charge". National.
  { component: "freight", label: "Freight and PDI", amount: 2800, applies: "always", scope: "model", make: "Polestar", model: "Polestar 2", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.polestar.com/en-ca/offers/new/polestar-2/",
    source: "Polestar Canada Polestar 2 offer fine print -- \"$2,800 Freight and PDI\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight and PDI", amount: 2800, applies: "always", scope: "model", make: "Polestar", model: "Polestar 3", modelYear: 2027, covers: "freight_pdi",
    sourceUrl: "https://www.polestar.com/en-ca/offers/new/polestar-3/",
    source: "Polestar Canada Polestar 3 offer fine print -- \"$2,800 Freight and PDI\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "Freight and PDI", amount: 2800, applies: "always", scope: "model", make: "Polestar", model: "Polestar 4", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.polestar.com/en-ca/offers/new/polestar-4-coupe/",
    source: "Polestar Canada Polestar 4 offer fine print -- \"$2,800 Freight and PDI\"", capturedOn: "2026-09-24" },

  // ── Maserati ── one figure for every model, in Maserati's own words ──────
  // "MSRP listed may not include preparation, delivery and destination charges
  // which are CAD 2,200 for all Maserati models." maserati.com/ca answers 403;
  // the configurator's own Canada properties answer.
  { component: "freight", label: "preparation, delivery and destination charges", amount: 2200, applies: "always", scope: "model", make: "Maserati", model: "Grecale", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.configurator.maserati.com/ccbe/public/api/countryProp/41/7822620/en",
    source: "Maserati Canada configurator properties (country 41) -- \"preparation, delivery and destination charges which are CAD 2,200 for all Maserati models\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "preparation, delivery and destination charges", amount: 2200, applies: "always", scope: "model", make: "Maserati", model: "GranTurismo", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.configurator.maserati.com/ccbe/public/api/countryProp/41/7822620/en",
    source: "Maserati Canada configurator properties (country 41) -- \"preparation, delivery and destination charges which are CAD 2,200 for all Maserati models\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "preparation, delivery and destination charges", amount: 2200, applies: "always", scope: "model", make: "Maserati", model: "GranCabrio", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.configurator.maserati.com/ccbe/public/api/countryProp/41/7822620/en",
    source: "Maserati Canada configurator properties (country 41) -- \"preparation, delivery and destination charges which are CAD 2,200 for all Maserati models\"", capturedOn: "2026-09-24" },

  // ── Volvo ── volvocars.com answers 403 to an identified request ──────────
  // The XC60 figure was read from Volvo Car Canada's offer fine print on
  // 2026-08-26. The job still asks every day and records the refusal as Volvo's,
  // never as drift. Other Volvo figures seen ($2,770 XC40/XC90/V60 CC, $3,100
  // EX30/EX40) come only from a June copy of that page and are not held.
  { component: "freight", label: "freight and PDI", amount: 2770, applies: "always", scope: "model", make: "Volvo", model: "XC60", modelYear: 2026, covers: "freight_pdi",
    sourceUrl: "https://www.volvocars.com/en-ca/offers/",
    source: "Volvo Car Canada offers fine print -- \"$2,770 freight and PDI\" (read 2026-08-26)", capturedOn: "2026-08-26" },

  // ── Ford ── ford.ca, the vehicle data every page carries ─────────────────
  // ford.ca's pages ship Ford's own model list as a JavaScript string --
  // {"model":"Explorer","year":"2027","msrpPrice":52700.0,...,
  // "destinationDeliveryCharge":2395.0 } -- one entry per model and year. Ford's
  // disclosures call it "destination & delivery" and name no PDI, so these rows
  // cover freight only. THE YEAR MOVES IT: 2025 to 2026 rose $100-$400 on most
  // lines (Mach-E $2,595 to $2,995). Commercial chassis lines are in the same data
  // and not held here.
  { component: "freight", label: "destination & delivery", amount: 2595, applies: "always", scope: "model", make: "Ford", model: "F-150", modelYear: 2025, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=F-150 F-150&year=2025"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"F-150 F-150\" 2025 destinationDeliveryCharge 2595", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2695, applies: "always", scope: "model", make: "Ford", model: "F-150", modelYear: 2026, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=F-150 F-150&year=2026"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"F-150 F-150\" 2026 destinationDeliveryCharge 2695", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2795, applies: "always", scope: "model", make: "Ford", model: "F-150 Lightning", modelYear: 2025, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=F-150 Lightning&year=2025"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"F-150 Lightning\" 2025 destinationDeliveryCharge 2795", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2395, applies: "always", scope: "model", make: "Ford", model: "Super Duty", modelYear: 2025, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=SuperDuty&year=2025"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"SuperDuty\" 2025 destinationDeliveryCharge 2395", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2695, applies: "always", scope: "model", make: "Ford", model: "Super Duty", modelYear: 2026, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=SuperDuty&year=2026"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"SuperDuty\" 2026 destinationDeliveryCharge 2695", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2695, applies: "always", scope: "model", make: "Ford", model: "Super Duty", modelYear: 2027, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=SuperDuty&year=2027"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"SuperDuty\" 2027 destinationDeliveryCharge 2695", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2395, applies: "always", scope: "model", make: "Ford", model: "Ranger", modelYear: 2025, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=Ranger&year=2025"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"Ranger\" 2025 destinationDeliveryCharge 2395", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2595, applies: "always", scope: "model", make: "Ford", model: "Ranger", modelYear: 2026, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=Ranger&year=2026"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"Ranger\" 2026 destinationDeliveryCharge 2595", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2295, applies: "always", scope: "model", make: "Ford", model: "Maverick", modelYear: 2025, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=Maverick&year=2025"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"Maverick\" 2025 destinationDeliveryCharge 2295", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2495, applies: "always", scope: "model", make: "Ford", model: "Maverick", modelYear: 2026, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=Maverick&year=2026"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"Maverick\" 2026 destinationDeliveryCharge 2495", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2295, applies: "always", scope: "model", make: "Ford", model: "Bronco", modelYear: 2025, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=Bronco&year=2025"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"Bronco\" 2025 destinationDeliveryCharge 2295", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2595, applies: "always", scope: "model", make: "Ford", model: "Bronco", modelYear: 2026, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=Bronco&year=2026"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"Bronco\" 2026 destinationDeliveryCharge 2595", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2295, applies: "always", scope: "model", make: "Ford", model: "Bronco Sport", modelYear: 2025, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=Bronco Sport&year=2025"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"Bronco Sport\" 2025 destinationDeliveryCharge 2295", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2395, applies: "always", scope: "model", make: "Ford", model: "Bronco Sport", modelYear: 2026, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=Bronco Sport&year=2026"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"Bronco Sport\" 2026 destinationDeliveryCharge 2395", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2295, applies: "always", scope: "model", make: "Ford", model: "Escape", modelYear: 2025, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=Escape&year=2025"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"Escape\" 2025 destinationDeliveryCharge 2295", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2295, applies: "always", scope: "model", make: "Ford", model: "Escape", modelYear: 2026, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=Escape&year=2026"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"Escape\" 2026 destinationDeliveryCharge 2295", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2295, applies: "always", scope: "model", make: "Ford", model: "Escape Hybrid", modelYear: 2025, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=Escape Hybrid&year=2025"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"Escape Hybrid\" 2025 destinationDeliveryCharge 2295", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2295, applies: "always", scope: "model", make: "Ford", model: "Escape Hybrid", modelYear: 2026, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=Escape Hybrid&year=2026"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"Escape Hybrid\" 2026 destinationDeliveryCharge 2295", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2295, applies: "always", scope: "model", make: "Ford", model: "Escape Plug-in Hybrid", modelYear: 2025, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=Escape Plugin Hybrid&year=2025"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"Escape Plugin Hybrid\" 2025 destinationDeliveryCharge 2295", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2295, applies: "always", scope: "model", make: "Ford", model: "Escape Plug-in Hybrid", modelYear: 2026, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=Escape Plugin Hybrid&year=2026"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"Escape Plugin Hybrid\" 2026 destinationDeliveryCharge 2295", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2295, applies: "always", scope: "model", make: "Ford", model: "Explorer", modelYear: 2025, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=Explorer&year=2025"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"Explorer\" 2025 destinationDeliveryCharge 2295", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2395, applies: "always", scope: "model", make: "Ford", model: "Explorer", modelYear: 2026, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=Explorer&year=2026"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"Explorer\" 2026 destinationDeliveryCharge 2395", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2395, applies: "always", scope: "model", make: "Ford", model: "Explorer", modelYear: 2027, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=Explorer&year=2027"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"Explorer\" 2027 destinationDeliveryCharge 2395", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2595, applies: "always", scope: "model", make: "Ford", model: "Expedition", modelYear: 2025, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=Expedition&year=2025"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"Expedition\" 2025 destinationDeliveryCharge 2595", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2595, applies: "always", scope: "model", make: "Ford", model: "Expedition", modelYear: 2026, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=Expedition&year=2026"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"Expedition\" 2026 destinationDeliveryCharge 2595", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2695, applies: "always", scope: "model", make: "Ford", model: "Expedition", modelYear: 2027, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=Expedition&year=2027"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"Expedition\" 2027 destinationDeliveryCharge 2695", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2295, applies: "always", scope: "model", make: "Ford", model: "Mustang", modelYear: 2025, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=Mustang&year=2025"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"Mustang\" 2025 destinationDeliveryCharge 2295", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2395, applies: "always", scope: "model", make: "Ford", model: "Mustang", modelYear: 2026, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=Mustang&year=2026"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"Mustang\" 2026 destinationDeliveryCharge 2395", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2595, applies: "always", scope: "model", make: "Ford", model: "Mustang Mach-E", modelYear: 2025, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=Mache&year=2025"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"Mache\" 2025 destinationDeliveryCharge 2595", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2995, applies: "always", scope: "model", make: "Ford", model: "Mustang Mach-E", modelYear: 2026, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=Mache&year=2026"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"Mache\" 2026 destinationDeliveryCharge 2995", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2995, applies: "always", scope: "model", make: "Ford", model: "Transit", modelYear: 2025, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=Transit VanWagon&year=2025"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"Transit VanWagon\" 2025 destinationDeliveryCharge 2995", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2995, applies: "always", scope: "model", make: "Ford", model: "Transit", modelYear: 2026, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=Transit VanWagon&year=2026"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"Transit VanWagon\" 2026 destinationDeliveryCharge 2995", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 3095, applies: "always", scope: "model", make: "Ford", model: "Transit", modelYear: 2027, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=Transit VanWagon&year=2027"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"Transit VanWagon\" 2027 destinationDeliveryCharge 3095", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2995, applies: "always", scope: "model", make: "Ford", model: "E-Transit", modelYear: 2025, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=E-Transit&year=2025"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"E-Transit\" 2025 destinationDeliveryCharge 2995", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2995, applies: "always", scope: "model", make: "Ford", model: "E-Transit", modelYear: 2026, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=E-Transit&year=2026"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"E-Transit\" 2026 destinationDeliveryCharge 2995", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 3095, applies: "always", scope: "model", make: "Ford", model: "E-Transit", modelYear: 2027, covers: "freight_only",
    sourceUrl: "https://www.ford.ca/",
    read: { embedded: "vehicleData = \"", unescape: true, path: ["*", "model=E-Transit&year=2027"], key: "destinationDeliveryCharge" },
    source: "Ford Canada vehicle data on ford.ca -- \"E-Transit\" 2027 destinationDeliveryCharge 3095", capturedOn: "2026-09-24" },

  // ── Lincoln ── lincolncanada.com, the same data, as plain JSON ───────────
  // FMC.context.allVehicles on Lincoln Canada's home page. It replaces the source
  // this row had until 2026-09-24 -- one car's window sticker served by FordDirect,
  // a dealer-facing service whose link dies when that VIN sells. The 2026 Nautilus
  // figure it gave, $2,595, is Lincoln's own; the 2027 is $2,795.
  { component: "freight", label: "destination & delivery", amount: 2595, applies: "always", scope: "model", make: "Lincoln", model: "Aviator", modelYear: 2025, covers: "freight_only",
    sourceUrl: "https://www.lincolncanada.com/",
    read: { embedded: "FMC.context.allVehicles =", path: ["*", "model=Aviator&year=2025"], key: "destinationDeliveryCharge" },
    source: "Lincoln Canada vehicle data on lincolncanada.com -- \"Aviator\" 2025 destinationDeliveryCharge 2595", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2595, applies: "always", scope: "model", make: "Lincoln", model: "Aviator", modelYear: 2026, covers: "freight_only",
    sourceUrl: "https://www.lincolncanada.com/",
    read: { embedded: "FMC.context.allVehicles =", path: ["*", "model=Aviator&year=2026"], key: "destinationDeliveryCharge" },
    source: "Lincoln Canada vehicle data on lincolncanada.com -- \"Aviator\" 2026 destinationDeliveryCharge 2595", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2595, applies: "always", scope: "model", make: "Lincoln", model: "Aviator", modelYear: 2027, covers: "freight_only",
    sourceUrl: "https://www.lincolncanada.com/",
    read: { embedded: "FMC.context.allVehicles =", path: ["*", "model=Aviator&year=2027"], key: "destinationDeliveryCharge" },
    source: "Lincoln Canada vehicle data on lincolncanada.com -- \"Aviator\" 2027 destinationDeliveryCharge 2595", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2595, applies: "always", scope: "model", make: "Lincoln", model: "Corsair", modelYear: 2025, covers: "freight_only",
    sourceUrl: "https://www.lincolncanada.com/",
    read: { embedded: "FMC.context.allVehicles =", path: ["*", "model=Corsair&year=2025"], key: "destinationDeliveryCharge" },
    source: "Lincoln Canada vehicle data on lincolncanada.com -- \"Corsair\" 2025 destinationDeliveryCharge 2595", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2595, applies: "always", scope: "model", make: "Lincoln", model: "Corsair", modelYear: 2026, covers: "freight_only",
    sourceUrl: "https://www.lincolncanada.com/",
    read: { embedded: "FMC.context.allVehicles =", path: ["*", "model=Corsair&year=2026"], key: "destinationDeliveryCharge" },
    source: "Lincoln Canada vehicle data on lincolncanada.com -- \"Corsair\" 2026 destinationDeliveryCharge 2595", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2795, applies: "always", scope: "model", make: "Lincoln", model: "Corsair", modelYear: 2027, covers: "freight_only",
    sourceUrl: "https://www.lincolncanada.com/",
    read: { embedded: "FMC.context.allVehicles =", path: ["*", "model=Corsair&year=2027"], key: "destinationDeliveryCharge" },
    source: "Lincoln Canada vehicle data on lincolncanada.com -- \"Corsair\" 2027 destinationDeliveryCharge 2795", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2595, applies: "always", scope: "model", make: "Lincoln", model: "Nautilus", modelYear: 2025, covers: "freight_only",
    sourceUrl: "https://www.lincolncanada.com/",
    read: { embedded: "FMC.context.allVehicles =", path: ["*", "model=Nautilus&year=2025"], key: "destinationDeliveryCharge" },
    source: "Lincoln Canada vehicle data on lincolncanada.com -- \"Nautilus\" 2025 destinationDeliveryCharge 2595", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2595, applies: "always", scope: "model", make: "Lincoln", model: "Nautilus", modelYear: 2026, covers: "freight_only",
    sourceUrl: "https://www.lincolncanada.com/",
    read: { embedded: "FMC.context.allVehicles =", path: ["*", "model=Nautilus&year=2026"], key: "destinationDeliveryCharge" },
    source: "Lincoln Canada vehicle data on lincolncanada.com -- \"Nautilus\" 2026 destinationDeliveryCharge 2595", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2795, applies: "always", scope: "model", make: "Lincoln", model: "Nautilus", modelYear: 2027, covers: "freight_only",
    sourceUrl: "https://www.lincolncanada.com/",
    read: { embedded: "FMC.context.allVehicles =", path: ["*", "model=Nautilus&year=2027"], key: "destinationDeliveryCharge" },
    source: "Lincoln Canada vehicle data on lincolncanada.com -- \"Nautilus\" 2027 destinationDeliveryCharge 2795", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2595, applies: "always", scope: "model", make: "Lincoln", model: "Navigator", modelYear: 2025, covers: "freight_only",
    sourceUrl: "https://www.lincolncanada.com/",
    read: { embedded: "FMC.context.allVehicles =", path: ["*", "model=Navigator&year=2025"], key: "destinationDeliveryCharge" },
    source: "Lincoln Canada vehicle data on lincolncanada.com -- \"Navigator\" 2025 destinationDeliveryCharge 2595", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2595, applies: "always", scope: "model", make: "Lincoln", model: "Navigator", modelYear: 2026, covers: "freight_only",
    sourceUrl: "https://www.lincolncanada.com/",
    read: { embedded: "FMC.context.allVehicles =", path: ["*", "model=Navigator&year=2026"], key: "destinationDeliveryCharge" },
    source: "Lincoln Canada vehicle data on lincolncanada.com -- \"Navigator\" 2026 destinationDeliveryCharge 2595", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination & delivery", amount: 2795, applies: "always", scope: "model", make: "Lincoln", model: "Navigator", modelYear: 2027, covers: "freight_only",
    sourceUrl: "https://www.lincolncanada.com/",
    read: { embedded: "FMC.context.allVehicles =", path: ["*", "model=Navigator&year=2027"], key: "destinationDeliveryCharge" },
    source: "Lincoln Canada vehicle data on lincolncanada.com -- \"Navigator\" 2027 destinationDeliveryCharge 2795", capturedOn: "2026-09-24" },

  // ── Stellantis ── Stellantis Canada's own releases (jeep.ca, ramtruck.ca,
  // chrysler.ca and dodge.ca answer 403) ──────────────────────────────────────
  // Held only where a release states destination for the whole model line. Most
  // state it for one trim ("Grand Cherokee Overland ... including a $2,295
  // destination charge"; "2027 Ram 1500 TRX SRT ... plus $2,995 destination") and
  // Ram shows why that cannot be spread across a line: the 2026 Ram 1500 HEMI Crew
  // Cab trims carry $2,595 and the 2027 TRX and Rumble Bee $2,995.
  // RAM 1500 $2,195 IS GONE. It was held since 2026-08-25 as "Ram Canada (official
  // capture)", and Stellantis Canada's own January 2026 release prices the 2026 Ram
  // 1500 HEMI trims at "freight ($2,595)". No Stellantis source states $2,195 for
  // any current Ram; a figure $400 under the maker's would have read every
  // correctly-charged Ram 1500 as $400 above published. The robots.txt of this
  // host asks for a 20-second crawl delay, and the job keeps it.
  { component: "freight", label: "destination", amount: 2695, applies: "always", scope: "model", make: "Jeep", model: "Grand Wagoneer", modelYear: 2026, covers: "freight_only",
    sourceUrl: "https://media.stellantisnorthamerica.com/newsrelease.do?id=27112&mid=898",
    source: "Stellantis Canada 2026 Grand Wagoneer press kit pricing table -- \"Base MSRP Excludes $2,695 destination, fees and options\"", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination", amount: 2195, applies: "always", scope: "model", make: "Chrysler", model: "Pacifica", modelYear: 2027, covers: "freight_only",
    sourceUrl: "https://media.stellantisnorthamerica.com/newsrelease.do?id=27653&mid=895",
    source: "Stellantis Canada 2027 Pacifica and Grand Caravan pricing table -- \"(all prices include MSRP, $2,195 destination and additional fees)\"", capturedOn: "2026-09-24",
    note: "The table lists Pacifica Select FWD/AWD, Limited AWD and Pinnacle AWD; Pacifica Hybrid is not in it." },
  { component: "freight", label: "destination", amount: 2195, applies: "always", scope: "model", make: "Chrysler", model: "Grand Caravan", modelYear: 2027, covers: "freight_only",
    sourceUrl: "https://media.stellantisnorthamerica.com/newsrelease.do?id=27653&mid=895",
    source: "Stellantis Canada 2027 Pacifica and Grand Caravan pricing table -- \"(all prices include MSRP, $2,195 destination and additional fees)\"", capturedOn: "2026-09-24" },

  // ── Rivian ── rivian.com/en-CA builder, region Canada, currency CAD ─────
  // The builder serialises "canadaFees": destinationFee 2695, docFee 300,
  // recoveryFee 22. The $300 documentation fee is not freight. The en-CA MODEL
  // pages print a US lease disclosure ("$1,895 destination fee") and are not the
  // source.
  { component: "freight", label: "destination fee", amount: 2695, applies: "always", scope: "model", make: "Rivian", model: "R1S", modelYear: 2027, covers: "freight_only",
    sourceUrl: "https://rivian.com/en-CA/configurations/builder/r1s",
    read: { after: "destinationFee" },
    source: "Rivian Canada R1S builder -- canadaFees destinationFee 2695 (CAD)", capturedOn: "2026-09-24" },
  { component: "freight", label: "destination fee", amount: 2695, applies: "always", scope: "model", make: "Rivian", model: "R1T", modelYear: 2027, covers: "freight_only",
    sourceUrl: "https://rivian.com/en-CA/configurations/builder/r1t",
    read: { after: "destinationFee" },
    source: "Rivian Canada R1T builder -- canadaFees destinationFee 2695 (CAD)", capturedOn: "2026-09-24" },

  // ── Lucid ── lucidmotors.com/en-ca model pages ───────────────────────────
  // "Pricing includes $2,300 CAD Destination Fee, $200 CAD Documentation Fee" --
  // the documentation fee is not freight. The Air's $2,000 is printed in a footnote
  // to one trim ("Price for Pure RWD") and is not held for the line.
  { component: "freight", label: "Destination Fee", amount: 2300, applies: "always", scope: "model", make: "Lucid", model: "Gravity", modelYear: 2026, covers: "freight_only",
    sourceUrl: "https://lucidmotors.com/en-ca/gravity",
    source: "Lucid Canada Gravity page -- \"Pricing includes $2,300 CAD Destination Fee\"", capturedOn: "2026-09-24" },

  // ── GM ── every GM Canada host answers 403 to an identified request ──────
  // chevrolet.ca, gmccanada.ca, buick.ca, cadillaccanada.ca, gm.ca, media.gm.ca and
  // GM's configurator API all refuse LotCheckBot, and GM's releases say "includes
  // freight" without the amount. The one GM figure held was read from Chevrolet's
  // own Build & Price in a browser, Province = Alberta, on 2026-08-26. It is kept,
  // with that said, and nothing re-reads it; no GMC, Buick or Cadillac figure is
  // held. Tesla (403 everywhere, and a label that bundles a documentation fee),
  // Audi, Alfa Romeo and Fiat (403) are absent for the same reason. Mercedes-Benz
  // publishes only a ceiling -- "freight and PDI (up to $5,250)" -- which is not a
  // price. Jaguar and Land Rover's figures load only from rules.config.landrover.com,
  // which robots.txt disallows for every crawler, so they are not held either.
  { component: "freight", label: "Destination Freight Charge", amount: 2700, applies: "always", scope: "model", make: "Chevrolet", model: "Silverado 1500", modelYear: 2026, covers: "freight_only",
    unsourced: "Every GM Canada host and GM's configurator API answer HTTP 403 to an identified request, so no page can be re-read. The figure was read off Chevrolet Canada's Build & Price with Province = Alberta on 2026-08-26, as an itemised line that summed to the build's total.",
    source: "Chevrolet Canada Build & Price -- itemised Alberta build, \"Destination Freight Charge\"", capturedOn: "2026-08-26" },
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

/** Freight for a make+model (and model year, when known), or null if not
 *  captured (never guessed).
 *
 *  THE YEAR IS PART OF THE FIGURE. Given a year, only that year's row answers:
 *  a 2027 Atlas compared against VW's 2026 figure would read $200 "above" on
 *  a car charged exactly what VW publishes. Without a year, a figure is
 *  returned only when every year we hold for the model agrees -- otherwise
 *  there is no single published number to name, and the answer is null. */
export function freightFor(
  make: string,
  model: string,
  year?: number | string | null,
): { amount: number; source: string; sourceUrl: string | null; capturedOn: string; modelYear: number | "current" | null; covers: "freight_pdi" | "freight_only" } | null {
  const m = norm(make);
  const md = norm(model);
  const rows = FREIGHT.filter((f) => norm(f.make) === m && norm(f.model) === md);
  if (!rows.length) return null;
  const y = Number(year);
  let row: Fee | undefined;
  if (year != null && year !== "" && Number.isFinite(y)) {
    row = rows.find((f) => f.modelYear === y) ?? rows.find((f) => f.modelYear === "current");
  } else {
    const amounts = new Set(rows.map((f) => f.amount));
    const rank = (f: Fee) => (f.modelYear === "current" ? Infinity : f.modelYear ?? 0);
    row = amounts.size === 1 ? [...rows].sort((a, b) => rank(b) - rank(a))[0] : undefined;
  }
  if (!row) return null;
  return {
    amount: row.amount, source: row.source, sourceUrl: row.sourceUrl ?? null, capturedOn: row.capturedOn,
    modelYear: row.modelYear ?? null, covers: row.covers ?? "freight_pdi",
  };
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
