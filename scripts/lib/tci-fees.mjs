// The manufacturer's OWN published fee stack, and what each line actually is.
//
// WHY THIS EXISTS. A real paid report (LC-46A4-66F, a 2026 Lexus NX 350h) faced
// a dealer pricing block reading "MSRP 58,675 + Fees & Accessories 3,330 =
// Sales Price 62,005". "Fees & Accessories" is the PLATFORM's generic caption
// for its addon slot -- it is not a description of the contents. Read literally
// it invites the conclusion that a named AMVIC-licensed dealer added $3,330 of
// its own. Decomposed against Lexus Canada's own published Alberta stack it is:
//
//     Dealer Fees (DRF)                     995     <- the only dealer line,
//                                                       and it is LEXUS's own
//                                                       published figure
//     Delivery and Destination (FPD)      2,205     <- manufacturer freight
//     Air Conditioning Charge (AC)          100     <- federal excise
//     AMVIC                                  10     <- provincial regulator
//     Tire Levy (TIR)                        20     <- provincial levy
//                                       -------
//                                        3,330.00   <- to the cent
//
// So $2,335 of it is freight and government charges. Calling that dealer
// padding is a false statement about a named business. [[no-accusation-language]]
// This repo has already made that exact mistake once, at a cost of $11,173 in
// phantom markup -- see the S25 comment in analyze-listing-url/index.ts:
// "printing Toyota's own $3,078 of freight as dealer markup".
//
// A PLATFORM'S CAPTION MUST NEVER CLASSIFY MONEY. Only the manufacturer's own
// published line items may, and this module is how we read them.
//
// ─────────────────────────────────────────────────────────────────────────────
// MEASURED, NOT ASSUMED. Every rule below was derived from the live payloads on
// 2026-08-27: Toyota (TOY) and Lexus (LEX) x AB/ON/QC/BC = 204 series-year
// entries, 2,892 line items.
//
//   * Exactly ONE model code per (series, year). from_prices publishes the base
//     configuration only, so a stack is per NAMEPLATE, never per trim.
//   * FPD (freight) is per SERIES and identical across provinces. Lexus is flat
//     at $2,205 for all 18 series; Toyota varies by series ($1,930 / $1,860 /
//     $1,760) and does NOT vary by province.
//   * DRF (dealer fee) is per make x PROVINCE, constant across the lineup:
//     Lexus AB 995 / ON 999 / QC 795 / BC 995; Toyota AB 999 / ON 999 / QC 899
//     / BC 990.
//   * TIR (tire levy) varies WITHIN a province by vehicle -- AB $25 or $20 --
//     which is precisely why a single hardcoded constant cannot be right.
//     fee-schedule.ts hardcodes $25 and is wrong for 7 of 18 Lexus series.
//   * ACCESSORIES is a NESTED node whose amount lives in items[], not on the
//     node. It carries MANUFACTURER-fitted accessories -- 24 of them across the
//     sampled lineup, every one a block heater, $398-$797. Toyota publishes and
//     prices them itself. Missing this line would have made $16,759 of factory
//     accessories look like dealer padding.
//   * INCENTIVES is also nested, carries NEGATIVE amounts, is EXCLUDED from
//     SUBTOTAL and applied after tax at TOTAL. Counting it makes every stack
//     short by exactly the incentive.
//   * PPSA / PPSASF are FINANCE-ONLY: absent from the cash column entirely.
//
// With those rules, parts == SUBTOTAL to the cent on 204/204 entries, on all
// three payment bases. That reconciliation is this module's proof of a correct
// read, and a stack that does not reconcile is REFUSED rather than stored --
// the same discipline tci-msrp.mjs applies to cross-province agreement.
//
// WHICH BASIS. "cash". An advertised all-in price under AMVIC (and ON/BC/QC)
// is what a buyer pays without financing, so comparing a dealer's sticker
// against the finance column would silently add PPSA the buyer may never owe.
// [[amvic-all-in-pricing]]

/** Payment column to read. Cash is the honest basis for an advertised price. */
export const FEE_BASIS = "cash";

// What each published line IS. This classification is the whole safety
// contract: it is the only thing standing between "the manufacturer charges
// this" and "the dealer added this".
//
//   vehicle       the car itself -- not a fee at all
//   manufacturer  the maker's own charge (freight, A/C excise, factory
//                 accessories, luxury surcharge)
//   government    a regulator or levy the dealer must collect and remit
//   dealer        the dealer's administration fee -- THE ONLY negotiable line,
//                 and the only one that may ever be measured against a ceiling
//   financing     applies only if the buyer finances; never part of a cash
//                 advertised price
//   excluded      totals, taxes and incentives -- never stored as a fee
export const LINE_KIND = {
  MSRP: "vehicle",
  PACKAGE: "vehicle",
  ACCESSORIES: "manufacturer",
  FPD: "manufacturer",
  AC: "manufacturer",
  LUXURY_SURCHARGE_AMOUNT: "manufacturer",
  DRF: "dealer",
  AMVIC: "government",
  OMVIC: "government",
  VSA: "government",
  TIR: "government",
  EOF: "government",
  EOL: "government",
  EOC: "government",
  PPSA: "financing",
  PPSASF: "financing",
  SUBTOTAL: "excluded",
  GST: "excluded",
  PST: "excluded",
  QST: "excluded",
  HST: "excluded",
  TOTAL: "excluded",
  DOWN_PAYMENT: "excluded",
  INCENTIVES: "excluded",
};

/** Lines that never count toward the pre-tax subtotal. */
const EXCLUDED = new Set(
  Object.entries(LINE_KIND).filter(([, k]) => k === "excluded").map(([n]) => n),
);

/**
 * A node's value on one payment basis: its own amount, or the sum of its nested
 * items when the amount lives there instead (ACCESSORIES, INCENTIVES).
 */
function nodeAmount(node, basis) {
  const own = node?.[basis]?.amount;
  if (Number.isFinite(own)) return own;
  if (Array.isArray(node?.items)) {
    let sum = 0, any = false;
    for (const it of node.items) {
      const v = it?.[basis]?.amount;
      if (Number.isFinite(v)) { sum += v; any = true; }
    }
    if (any) return sum;
  }
  return null;
}

/** The nested detail of a node that carries items (so we can name each one). */
function nodeItems(node, basis) {
  if (!Array.isArray(node?.items)) return [];
  return node.items
    .map((it) => ({
      label: String(it?.label?.en || it?.name || "").trim(),
      amount: Number.isFinite(it?.[basis]?.amount) ? it[basis].amount : null,
    }))
    .filter((x) => x.label && x.amount != null);
}

/**
 * Read one published fee stack.
 *
 * @param {object} fromPrices  the from_prices.<BRAND>.<PROV>.json payload
 * @param {string} series      series code, e.g. "NXH"
 * @param {number|string} year
 * @param {string} modelCode   the single published model code for that series/year
 * @param {string} [basis]     payment column; defaults to cash
 * @returns {{
 *   ok: boolean,
 *   refusal: string|null,
 *   modelCode: string|null,
 *   lines: Array<{code:string,label:string,amount:number,kind:string,items?:Array<{label:string,amount:number}>}>,
 *   subtotal: number|null,
 *   partsTotal: number|null,
 * }}
 *
 * Never throws. `ok` is false whenever the stack cannot be PROVEN correct, and
 * a refused stack must not be stored: an unproven fee decomposition is exactly
 * the input that turns into a false accusation. [[missing-beats-wrong]]
 */
export function parseFeeStack(fromPrices, series, year, modelCode, basis = FEE_BASIS) {
  const empty = { ok: false, refusal: null, modelCode: modelCode || null, lines: [], subtotal: null, partsTotal: null };
  const entry = fromPrices?.[series]?.[String(year)]?.[modelCode];
  if (!Array.isArray(entry) || !entry.length) {
    return { ...empty, refusal: `no from_prices entry for ${series}/${year}/${modelCode}` };
  }

  const lines = [];
  let parts = 0;
  let subtotal = null;
  const unknown = [];

  for (const node of entry) {
    const code = String(node?.name || "").trim();
    if (!code) continue;
    const kind = LINE_KIND[code];
    const value = nodeAmount(node, basis);

    if (code === "SUBTOTAL") { subtotal = value; continue; }
    if (!kind) {
      // An UNRECOGNISED line is not ignorable. If the manufacturer adds a line
      // we have never seen, silently dropping it makes the stack understate the
      // real charges -- and understating them is what turns legitimate money
      // into an "unexplained" residual pointed at the dealer.
      if (value != null && value !== 0) unknown.push(`${code}=${value}`);
      continue;
    }
    if (kind === "excluded") continue;
    if (value == null) continue;

    const items = nodeItems(node, basis);
    lines.push({
      code,
      label: String(node?.label?.en || code).trim(),
      amount: value,
      kind,
      ...(items.length ? { items } : {}),
    });
    parts += value;
  }

  if (unknown.length) {
    return { ...empty, lines, subtotal, partsTotal: round2(parts),
      refusal: `unrecognised published line item(s): ${unknown.join(", ")} -- classify them before this stack may be used` };
  }
  if (subtotal == null) {
    return { ...empty, lines, partsTotal: round2(parts), refusal: "no SUBTOTAL line to reconcile against" };
  }
  if (!lines.some((l) => l.code === "MSRP")) {
    return { ...empty, lines, subtotal, partsTotal: round2(parts), refusal: "no MSRP line -- this is not a priced configuration" };
  }
  if (Math.abs(parts - subtotal) >= 0.02) {
    return { ...empty, lines, subtotal, partsTotal: round2(parts),
      refusal: `does not reconcile: parts ${round2(parts)} vs published SUBTOTAL ${subtotal}` };
  }

  return { ok: true, refusal: null, modelCode, lines, subtotal, partsTotal: round2(parts) };
}

/**
 * The fee lines only — the vehicle itself removed. This is what gets stored and
 * what a dealer's addon block is decomposed against.
 *
 * `financing` lines are excluded by default because an advertised all-in price
 * is a CASH price; pass { financed: true } only when comparing against a
 * financed quote.
 */
export function feeLinesOnly(stack, { financed = false } = {}) {
  if (!stack?.ok) return [];
  return stack.lines.filter((l) =>
    l.kind === "manufacturer" || l.kind === "government" || l.kind === "dealer" ||
    (financed && l.kind === "financing"));
}

/** Sum of the fee lines — the figure a dealer's addon block is measured against. */
export function feeStackTotal(stack, opts) {
  return round2(feeLinesOnly(stack, opts).reduce((s, l) => s + l.amount, 0));
}

/** The vehicle price the stack sits on top of (MSRP + base package). */
export function vehiclePrice(stack) {
  if (!stack?.ok) return null;
  const v = stack.lines.filter((l) => l.kind === "vehicle").reduce((s, l) => s + l.amount, 0);
  return v > 0 ? round2(v) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The stored shape.
//
// 38 rows in msrp_catalog already carry a hand-seeded `attrs.all_in_breakdown`,
// captured from Build & Price screenshots. This mapping writes the SAME key
// names from the published payload so the automatic capture is a drop-in
// replacement for the hand-seeding rather than a second, competing convention:
//
//   {"amvic":10,"tire_levy":25,"block_heater":682,"dealer_fees_max":999,
//    "air_conditioning":100,"delivery_destination":1930}
//
// Note that the hand-seeded rows already carry `block_heater` -- somebody
// reading a B&P summary by hand noticed the factory accessory that the naive
// arithmetic misses. This module reads it from ACCESSORIES automatically.
const BREAKDOWN_KEY = {
  FPD: "delivery_destination",
  DRF: "dealer_fees_max",
  AC: "air_conditioning",
  AMVIC: "amvic",
  OMVIC: "omvic",
  VSA: "vsa",
  TIR: "tire_levy",
  EOF: "env_filters",
  EOL: "env_lube",
  EOC: "env_coolant",
  LUXURY_SURCHARGE_AMOUNT: "luxury_surcharge",
  PPSA: "ppsa",
  PPSASF: "ppsa_service",
  ACCESSORIES: "accessories",
};

/** Is this accessory the factory block heater the seeded rows already name? */
const isBlockHeater = (label) => /block\s*heater/i.test(String(label || ""));

/**
 * The `attrs.all_in_breakdown` object for a parsed stack, in the shape the
 * hand-seeded rows already use. Returns null for a stack that was refused --
 * a breakdown we cannot prove must not be written. [[missing-beats-wrong]]
 *
 * @param {object} stack   result of parseFeeStack
 * @param {object} [opts]  { financed } to include PPSA lines
 */
export function allInBreakdown(stack, opts) {
  if (!stack?.ok) return null;
  const out = {};
  let blockHeater = false;
  for (const l of feeLinesOnly(stack, opts)) {
    const key = BREAKDOWN_KEY[l.code];
    if (!key) continue;
    if (l.code === "ACCESSORIES") {
      // Name the factory accessory rather than burying it in a total: it is the
      // line most likely to be mistaken for a dealer add-on, and on Toyota it is
      // a $398-$797 block heater the manufacturer itself prices.
      for (const it of l.items || []) {
        if (isBlockHeater(it.label)) { out.block_heater = round2((out.block_heater || 0) + it.amount); blockHeater = true; }
        else out.accessories = round2((out.accessories || 0) + it.amount);
      }
      if (!l.items?.length) out.accessories = round2((out.accessories || 0) + l.amount);
      continue;
    }
    out[key] = round2((out[key] || 0) + l.amount);
  }
  if (blockHeater) out.block_heater_included = true;
  return Object.keys(out).length ? out : null;
}

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}
