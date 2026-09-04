// When the dealer quotes no financing, do the arithmetic ourselves.
//
// VIC'S RULE, 2026-08-16: "the rule is: use Toyota Canada APR and MSRP price,
// do the math." A Stampede Toyota Land Cruiser listing showed no payment terms,
// so the Financing-math point printed "NO TERMS QUOTED" and stopped — even
// though both halves of the calculation were sitting in our own tables:
// finance_rate_catalog holds Toyota's published 5.69% / 72, and msrp_catalog
// holds the Land Cruiser's all-in price.
//
// A buyer does not feel $2,000 of markup. They feel $31 a month for six years.
// Converting the gap into the unit the dealership actually negotiates in is the
// whole point of the reference-point model ([[reference-point-model]]).
//
// WHY resolveFinanceRates COULD NOT DO THIS. It selects a catalog row that
// carries term_months and then returns { apr, promo, effectiveDate } — dropping
// the term. An APR with no term cannot produce a payment, so the data was
// present and thrown away one line before it was needed.
//
// WHAT THIS IS NOT. Not a quote. No tax, no down payment, no trade-in, no
// dealer-arranged buy-rate markup. It is what the manufacturer's own published
// rate does to the manufacturer's own published price, and to the dealer's
// asking price, on identical terms — so the two are comparable to each other
// and to nothing else. Every field says so.

export type ReferencePayment = {
  principal: number; apr: number; termMonths: number;
  monthly: number; totalPaid: number; totalInterest: number;
};

export type ReferenceFinancing = {
  source: "manufacturer";
  apr: number; termMonths: number; effectiveDate: string | null; promo: boolean;
  atAsking: ReferencePayment | null;
  atManufacturerPrice: ReferencePayment | null;
  monthlyDelta: number | null;      // asking - manufacturer, per month
  lifetimeDelta: number | null;     // the same gap over the full term
  basis: "all_in" | "ex_freight" | null;
  note: string;
};

/** Standard amortization. A 0% promo is a real rate, so handle it exactly. */
export function amortizedPayment(principal: number, aprPct: number, months: number): ReferencePayment | null {
  const P = Number(principal), n = Math.round(Number(months));
  const apr = Number(aprPct);
  if (!(P > 0) || !(n > 0) || !Number.isFinite(apr) || apr < 0 || apr >= 100) return null;
  const i = apr / 100 / 12;
  const monthly = i === 0 ? P / n : (P * i) / (1 - Math.pow(1 + i, -n));
  if (!Number.isFinite(monthly) || monthly <= 0) return null;
  const totalPaid = monthly * n;
  return {
    principal: P, apr, termMonths: n,
    monthly: Math.round(monthly * 100) / 100,
    totalPaid: Math.round(totalPaid * 100) / 100,
    totalInterest: Math.round((totalPaid - P) * 100) / 100,
  };
}

const n = (v: unknown): number | null => {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : null;
};

/**
 * Returns null when there is genuinely nothing to say — no manufacturer rate,
 * no term, or no price. Never invents a rate, and never fills a term the
 * catalog did not publish.
 */
export function computeReferenceFinancing(analysis: any): ReferenceFinancing | null {
  const mf = analysis?.financeRates?.manufacturer;
  // `Number.isFinite(Number(mf.apr))` passes for apr null, because Number(null)
  // is 0 -- and the sentence below then tells the buyer to demand a "published
  // 0% over 60 months" the manufacturer never published. [[read-num]]
  const apr = mf?.apr == null || !Number.isFinite(Number(mf.apr)) ? null : Number(mf.apr);
  const termMonths = n(mf?.termMonths);
  if (apr === null || !termMonths) return null;

  const asking = n(analysis?.quotedPrice);
  // Compare like with like: an all-in advertised price against the
  // manufacturer's all-in figure, never against the ex-freight MSRP. Mixing
  // them invents roughly $3,000 of principal ([[reference-point-model]]).
  const useAllIn = !!analysis?.allInPricing && !!n(analysis?.msrpAllIn);
  const mfPrice = useAllIn ? n(analysis?.msrpAllIn) : n(analysis?.msrp);
  const basis: "all_in" | "ex_freight" | null = mfPrice ? (useAllIn ? "all_in" : "ex_freight") : null;

  // Only compare the two payments when the underlying price comparison is
  // itself sound. If the bases disagree, show the dealer's payment alone —
  // that figure is arithmetic on the dealer's own number and is always safe.
  const comparable = !!asking && !!mfPrice && basis === "all_in" && analysis?.msrpBasis === "exact";

  const atAsking = asking ? amortizedPayment(asking, apr, termMonths) : null;
  const atManufacturerPrice = comparable && mfPrice ? amortizedPayment(mfPrice, apr, termMonths) : null;

  if (!atAsking && !atManufacturerPrice) return null;

  const monthlyDelta = atAsking && atManufacturerPrice
    ? Math.round((atAsking.monthly - atManufacturerPrice.monthly) * 100) / 100 : null;
  const lifetimeDelta = atAsking && atManufacturerPrice
    ? Math.round((atAsking.totalPaid - atManufacturerPrice.totalPaid) * 100) / 100 : null;

  const make = analysis?.make || "the manufacturer";
  const rateLabel = `${make}'s published ${apr}% over ${termMonths} months`;
  // A SHORT PROMO TERM MAKES A BIG MONTHLY NUMBER, and the report printed
  // "about ,881.86/month ... use it as the number to beat" off a genuine
  // 4.9%-over-24-months Genesis promotion. The term was real; nobody
  // benchmarks a ,882 payment, so the line created a question instead of
  // answering one. The comparable thing is the RATE. Say that where the term
  // is short. [[present-without-creating-questions]]
  const shortTerm = termMonths <= 36
    ? ` That is a ${termMonths}-month term${mf?.promo ? " promotion" : ""}, which is short, so the monthly figure is large -- the number to take to the dealer is the RATE, not this payment.`
    : "";
  let note: string;
  if (monthlyDelta !== null && atAsking && atManufacturerPrice) {
    note = monthlyDelta > 0
      ? `This dealer quotes no financing, so here is the arithmetic on ${rateLabel}: their asking price works out to about $${atAsking.monthly.toLocaleString()}/month, against $${atManufacturerPrice.monthly.toLocaleString()}/month at ${make}'s own all-in price — about $${Math.abs(monthlyDelta).toLocaleString()} more every month, roughly $${Math.abs(lifetimeDelta ?? 0).toLocaleString()} over the full term. Before tax, down payment or trade-in.${shortTerm}`
      : `This dealer quotes no financing. On ${rateLabel}, their asking price works out to about $${atAsking.monthly.toLocaleString()}/month — at or below the $${atManufacturerPrice.monthly.toLocaleString()}/month that ${make}'s own all-in price would cost on the same terms. Before tax, down payment or trade-in.${shortTerm}`;
  } else if (atAsking) {
    note = `This dealer quotes no financing. On ${rateLabel}, their asking price works out to about $${atAsking.monthly.toLocaleString()}/month before tax, down payment or trade-in.${shortTerm} Use the rate as the number to beat, and ask what rate they will actually write.`;
  } else {
    note = `${make} publishes ${apr}% over ${termMonths} months for this model. This dealer quotes no financing, so ask them to quote against that rate.`;
  }

  return {
    source: "manufacturer", apr, termMonths,
    effectiveDate: mf?.effectiveDate ?? null, promo: !!mf?.promo,
    atAsking, atManufacturerPrice, monthlyDelta, lifetimeDelta, basis, note,
  };
}
