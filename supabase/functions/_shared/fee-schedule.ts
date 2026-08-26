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
  capturedOn: string;  // ISO date it was read
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
// The cap is a NATIONAL manufacturer policy ("dealer fees of up to $X"), so rows
// carry no region and apply wherever docfee.ts fires (the all-in provinces). Each
// figure is the published MAXIMUM ("up to $X") read verbatim from an official
// source on the date shown; the flag fires only ABOVE it, so a dealer charging
// within "up to $X" is never flagged.
const DEALER_FEE_CEILING: Fee[] = [
  { component: "dealer_fee_ceiling", label: "Dealer Fees (maximum)", amount: 999, applies: "always", scope: "brand", make: "Toyota",
    source: "Toyota Canada Build & Price — 2026 RAV4 (Alberta)", capturedOn: "2026-08-15",
    note: "Published maximum dealer fee. In an all-in province it must already be inside the advertised price." },
  { component: "dealer_fee_ceiling", label: "Dealer Fees", amount: 995, applies: "always", scope: "brand", make: "Lexus",
    source: "Lexus Canada Build & Price — 2026 ES 350h (Alberta)", capturedOn: "2026-08-25",
    note: "Published maximum dealer fee." },
  { component: "dealer_fee_ceiling", label: "dealer admin fee (up to $799)", amount: 799, applies: "always", scope: "brand", make: "Hyundai",
    source: "Hyundai Canada (hyundaicanada.com/en/special-offers/vehicles) — \"dealer admin. fees of up to $799\"", capturedOn: "2026-08-25",
    note: "\"Fees may vary by dealer.\" Some models publish $599; $799 is the highest published figure, used as the max." },
  { component: "dealer_fee_ceiling", label: "retailer administration fee (up to $795)", amount: 795, applies: "always", scope: "brand", make: "Mazda",
    source: "Mazda Canada (mazda.ca/en/vehicles/cx-5) — \"retailer administration fee (up to $795)\"", capturedOn: "2026-08-25" },
  { component: "dealer_fee_ceiling", label: "dealer admin fee (up to $750)", amount: 750, applies: "always", scope: "brand", make: "Volkswagen",
    source: "Volkswagen Canada (vw.ca/offers) — \"representative dealer admin fee (actual fee is set by dealers and varies, up to $750)\"", capturedOn: "2026-08-25",
    note: "Framed as a \"representative\" fee, but explicitly capped at \"up to $750\"." },
  { component: "dealer_fee_ceiling", label: "dealer fee (up to $699)", amount: 699, applies: "always", scope: "brand", make: "Chevrolet",
    source: "Chevrolet Canada Build & Price disclaimer (chevrolet.ca) — \"up to $699 dealer fee\"", capturedOn: "2026-08-25",
    note: "GM's B&P applies a $350 default in-build, but the published maximum is $699; we flag only ABOVE $699 to stay conservative." },
  { component: "dealer_fee_ceiling", label: "dealer fees (up to $621)", amount: 621, applies: "always", scope: "brand", make: "Nissan",
    source: "Nissan Canada (canada.nissannews.com, 2026 Rogue pricing) — \"dealer fees (up to $621)\"", capturedOn: "2026-08-25",
    note: "\"May vary by region and dealer.\"" },
  // Batch 2 (2026-08-26). MINI read verbatim in-session; BMW is the same BMW Group
  // policy (identical wording, verified via MINI); Buick/Cadillac carry GM's one
  // national B&P disclaimer, the same "up to $699 dealer fee" string as Chevrolet.
  { component: "dealer_fee_ceiling", label: "retailer administration fees (up to $595)", amount: 595, applies: "always", scope: "brand", make: "MINI",
    source: "MINI Canada (mini.ca/en/special-offers) — \"retailer administration fees (up to $595)\"", capturedOn: "2026-08-26" },
  { component: "dealer_fee_ceiling", label: "retailer administration fees (up to $595)", amount: 595, applies: "always", scope: "brand", make: "BMW",
    source: "BMW Canada (bmw.ca) — \"retailer administration fees (up to $595)\"; same BMW Group policy verified verbatim on MINI", capturedOn: "2026-08-26" },
  { component: "dealer_fee_ceiling", label: "dealer fee (up to $699)", amount: 699, applies: "always", scope: "brand", make: "Buick",
    source: "GM Canada Build & Price disclaimer (buick.ca) — \"up to $699 dealer fee\" (GM's national string, same as Chevrolet)", capturedOn: "2026-08-26",
    note: "Flag only ABOVE $699 (GM applies a lower default in-build)." },
  { component: "dealer_fee_ceiling", label: "dealer fee (up to $699)", amount: 699, applies: "always", scope: "brand", make: "Cadillac",
    source: "GM Canada Build & Price disclaimer (cadillaccanada.ca) — \"up to $699 dealer fee\" (GM's national string, same as Chevrolet)", capturedOn: "2026-08-26",
    note: "Flag only ABOVE $699 (GM applies a lower default in-build)." },
];

// ── Model — freight / Delivery & Destination, per make AND model ────────────
const FREIGHT: Fee[] = [
  { component: "freight", label: "Delivery and Destination Charge", amount: 1930, applies: "always", scope: "model", make: "Toyota", model: "RAV4",
    source: "Toyota Canada Build & Price — 2026 RAV4", capturedOn: "2026-08-15" },
  { component: "freight", label: "Delivery and Destination Charge", amount: 2205, applies: "always", scope: "model", make: "Lexus", model: "ES",
    source: "Lexus Canada Build & Price — 2026 ES 350h", capturedOn: "2026-08-25" },
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
 *  captured one for this make (never guessed). */
export function dealerFeeCeiling(
  make: string,
  region = "AB",
): { amount: number; source: string; capturedOn: string; note?: string } | null {
  const m = norm(make);
  const r = String(region ?? "").toUpperCase();
  const row = DEALER_FEE_CEILING.find((f) => norm(f.make) === m && (!f.region || f.region === r));
  return row ? { amount: row.amount, source: row.source, capturedOn: row.capturedOn, note: row.note } : null;
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
): { ceiling: number; observed: number; over: boolean; overBy: number; source: string; capturedOn: string } | null {
  const c = dealerFeeCeiling(make, region);
  const fee = Number(observedFee);
  if (!c || !Number.isFinite(fee) || fee <= 0) return null;
  const over = fee > c.amount;
  return { ceiling: c.amount, observed: round2(fee), over, overBy: over ? round2(fee - c.amount) : 0, source: c.source, capturedOn: c.capturedOn };
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
