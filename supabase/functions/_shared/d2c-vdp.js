// D2C Media embedded vehicle data — present on D2C-platform VDPs as a single
// inline `window.__vdpJSON = {...};` blob (D2C's analogue of Convertus's
// `var vmsData`; see convertus-vms.js). Confirmed on Okotoks Toyota,
// 2026-08-15 AND again 2026-08-22 (same VIN, JTM7ERAV1TD018440, still
// unbuilt in between — see [[gated-price-recovery]] memory).
//
// THE MECHANISM: D2C's template blanks every field it actually RENDERS
// ("price":"", "fullPrice":"") and swaps in a lead-capture message
// ("messages":{"message":"Call for pricing"}) — but priceWithoutCustomFees /
// originalPriceWithoutCustomFees keep the real, current asking price. The
// same number also sits in plain hidden <input> fields on the page (used for
// CarProof/CarGurus/GA4 integrations, not for a third party's benefit, but
// readable all the same) and is independently published to Google Vehicle
// Ads for new-vehicle listings (Google requires an all-in price for those).
// Three independent corroborating sources for one number the page itself
// declines to show a visitor.
//
// D2C publishes NO manufacturer MSRP anywhere in this blob — confirmed
// against a non-gated unit on the same site (proved the pair is
// current-ask/was-price, not MSRP). Never populate msrp from this source;
// the catalog lookup already owns that.

function extractBalancedJson(text, startIdx) {
  let depth = 0, inStr = false, esc = false;
  for (let i = startIdx; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === "\"") inStr = false;
      continue;
    }
    if (c === "\"") { inStr = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return text.slice(startIdx, i + 1); }
  }
  return null;
}

// Phrases D2C (and lookalikes) use in prices.messages.message when the
// template has blanked the real price fields. Deliberately narrow and
// literal -- this only ever fires alongside a real recovered number, so a
// missed phrase costs a missing note, not a wrong claim either way.
const GATING_PHRASES = /call for pricing|contact us for price|request a price|ask for price/i;

export function extractD2cVdpVehicle(html) {
  if (typeof html !== "string" || html.length === 0) return null;
  const declMatch = /window\.__vdpJSON\s*=\s*\{/.exec(html);
  if (!declMatch) return null;
  const braceStart = declMatch.index + declMatch[0].length - 1;

  let v;
  try {
    const jsonStr = extractBalancedJson(html, braceStart);
    if (!jsonStr) return null;
    v = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;

  const num = (x) => { const n = Number(x); return Number.isFinite(n) && n > 0 ? n : null; };
  const str = (x) => (typeof x === "string" && x.trim()) ? x.trim() : null;
  // D2C prices are strings like "$85,995" -- strip everything but digits/dot.
  const money = (x) => {
    if (typeof x !== "string" || !x.trim()) return null;
    const n = Number(x.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const vinRaw = String(v.niv || "").trim().toUpperCase();
  const vin = (/^[A-HJ-NPR-Z0-9]{17}$/.test(vinRaw) && !/^(.)\1{16}$/.test(vinRaw)) ? vinRaw : null;

  const condition = v.isNew ? "new" : (v.isDemo ? "used" : (v.isCertified ? "used" : null));
  // Finer condition, kept alongside the binary `condition` (which stays used for
  // demo/certified so nothing downstream keying off "new"/"used" changes).
  const saleConditionHint = v.isNew ? "new" : (v.isDemo ? "demo" : (v.isCertified ? "certified" : (condition === "used" ? "used" : null)));

  const yearNum = Number(v.year);
  // "km" comes through as "" (not absent) on a fresh-delivery new unit --
  // Number("") is 0, which would wrongly assert a KNOWN zero-km reading
  // rather than "not stated here." str() first so an empty string stays null.
  const odoNum = str(v.km) ? Number(v.km) : NaN;

  const p = (v.prices && typeof v.prices === "object") ? v.prices : {};
  // Same "current ask, never a sticker figure" logic as Convertus's
  // asking_price/internet_price pair: the LOWER of the two is what a buyer
  // is actually being asked to pay today (a dealer only discounts DOWN from
  // an original figure, never up).
  const priceCandidates = [money(p.priceWithoutCustomFees), money(p.originalPriceWithoutCustomFees)].filter((n) => n != null);
  const quotedPrice = priceCandidates.length ? Math.min(...priceCandidates) : null;

  // ── THE DEALER'S OWN ITEMISATION ────────────────────────────────────────
  //
  // D2C publishes the line items behind its advertised price, and we were
  // reading none of them. On the 2025 Mazda CX-90 at sundancemazda.com the
  // page showed, in the dealer's own words:
  //
  //     2025 Mazda CX-90 MHEV MSRP starting at   $66,010
  //     Admin. Fee                                  $795
  //     Dealer bonus:                            - $8,000
  //     Your Price:                              $58,805
  //
  // and the blob carries every one of those numbers: customFeesList
  // [{amount: 795, descEn: "Admin. Fee"}] and allIncentivesList
  // [{amount: 8000, descEn: "Dealer bonus:"}], base64 in descEn. The report
  // said "Add-ons & fee audit: NONE LISTED" and Vic caught it: "at least they
  // transparent $795 fees but we miss them incredible".
  //
  // THE FEE IS INSIDE THE ADVERTISED PRICE, NOT ON TOP OF IT. The page's own
  // arithmetic proves it three ways, to the dollar:
  //     58,805 - 795            = 58,010 = priceWithoutCustomFees
  //     66,010 + 795            = 66,805 = fullPriceInteger
  //     66,010 + 795 - 8,000    = 58,805 = the advertised price
  // That distinction is the whole safety of this read. Treating an included
  // fee as an add-on would inflate the buyer's "real pre-tax" by $795 and
  // describe a dealer who itemised openly as though they had padded the
  // quote -- the class fixed in 38274c2. So the items are returned SEPARATELY
  // from addOns, with `insideAdvertisedPrice` PROVEN rather than assumed.
  const b64Text = (x) => {
    if (typeof x !== "string" || !x.trim()) return null;
    let t = x.trim();
    // descEn is base64 in every sample seen; a platform that stops encoding it
    // must still work, so decoding is attempted and never required.
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(t) && t.length % 4 === 0) {
      try { t = new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(atob(t), (c) => c.charCodeAt(0))); }
      catch { /* not base64 after all -- keep the raw string */ }
    }
    t = t.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().replace(/[\s:;,.\u2013\u2014-]+$/, "");
    return t && t.length <= 80 ? t : null;
  };
  // `amount` arrives as a NUMBER here (795), not the formatted string money()
  // expects, so money() rejected every row and both lists came back empty.
  const amountOf = (x) => {
    const n = typeof x === "number" ? x : (typeof x === "string" ? Number(x.replace(/[^0-9.]/g, "")) : NaN);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const lineItems = (arr) => (Array.isArray(arr) ? arr : []).map((it) => {
    const amount = amountOf(it && it.amount), name = b64Text(it && it.descEn);
    // A row we cannot both name AND price is dropped, never guessed at.
    return amount != null && amount > 0 && name ? { name, amount } : null;
  }).filter(Boolean);

  const dealerFees = lineItems(p.customFeesList);
  const dealerFeesTotal = dealerFees.reduce((t, f) => t + f.amount, 0);
  const dealerIncentives = lineItems(p.allIncentivesList);

  // PROVEN, not assumed: the advertised price must exceed the ex-fee figure by
  // the fee total, within a dollar of rounding. If the page does not reconcile
  // we say nothing about where the fees sit. [[missing-beats-wrong]]
  const advertised = money(p.priceInteger) ?? money(p.price);
  const exFees = money(p.priceWithoutCustomFees);
  const feesInsideAdvertised = (dealerFeesTotal > 0 && advertised != null && exFees != null)
    ? Math.abs((advertised - exFees) - dealerFeesTotal) <= 1
    : null;

  // The dealer's own stated MSRP leg, promoted ONLY when the page's arithmetic
  // identifies it as one: MSRP + fees = fullPrice. Without that test this field
  // is just a was-price, which is why the header note used to say D2C carries
  // no MSRP at all -- true of the one unit that note was written against.
  const fullPrice = money(p.fullPriceInteger) ?? money(p.fullPrice);
  const origExFees = money(p.originalPriceWithoutCustomFees);
  const dealerStatedMsrp = (origExFees != null && fullPrice != null && dealerFeesTotal > 0
    && Math.abs((origExFees + dealerFeesTotal) - fullPrice) <= 1) ? origExFees : null;

  // The tell: the template swapped the real price fields for a lead-capture
  // message. Only meaningful alongside a recovered quotedPrice -- a gate with
  // no recoverable number at all (the Red Deer Toyota case in the same
  // memory) has nothing for this extractor to add.
  const gateMessage = str(p.messages && p.messages.message);
  const priceGated = !!(quotedPrice && gateMessage && GATING_PHRASES.test(gateMessage));
  // Whether the Google Vehicle Ads corroboration may be CITED for this unit.
  // Google requires a real price (and, in Canada, an all-in price type) on
  // NEW-vehicle listings -- that requirement is what makes "it's public
  // anyway" a backed statement rather than an assumption. It does NOT extend
  // to used/CPO inventory, which a dealer can advertise without a price feed
  // at all. The report copy asserted it unconditionally, so on a gated USED
  // D2C unit it stated a corroboration nothing had checked
  // (claims-must-stay-backed). Surfaces render the narrower sentence when
  // this is false.
  const googleAdsCorroborated = priceGated && !!v.isNew;

  const dealerName = str(v.addresses && v.addresses.dealer);
  const dealerPhone = str(v.addresses && v.addresses.phone);

  if (!yearNum && !str(v.make && v.make.basic) && !str(v.model && v.model.basic) && quotedPrice == null) return null;

  return {
    year: Number.isFinite(yearNum) && yearNum > 1900 ? Math.round(yearNum) : null,
    make: str(v.make && v.make.basic),
    model: str(v.model && v.model.basic),
    trim: str(v.version && v.version.basic),
    vin,
    stockNumber: str(v.sn),
    odometerKm: Number.isFinite(odoNum) && odoNum >= 0 ? Math.round(odoNum) : null,
    condition,
    saleConditionHint,
    quotedPrice,
    priceGated,
    priceGateMessage: priceGated ? gateMessage : null,
    googleAdsCorroborated,
    drivetrain: str(v.drivetrain),
    dealerName,
    dealerCity: null, // not carried in this blob; the page's own address block/city is read elsewhere
    dealerPhone,
    // Kept OUT of addOns on purpose -- see the block above. These are the
    // dealer's own itemisation of a price they already advertise.
    dealerFees,
    dealerIncentives,
    feesInsideAdvertised,
    dealerStatedMsrp,
  };
}

// Fill blanks in a Claude-extracted analysis object (`parsed`) using a D2C
// vdpJSON read of the SAME rendered page (`dv`, from extractD2cVdpVehicle
// above). Same fill-only contract as convertus-vms.js's fillFromConvertusVms
// -- structured data outranks a vision/prose guess, never clobbers a real
// parsed value, mutates and returns `parsed`.
export function fillFromD2cVdp(parsed, dv) {
  if (!parsed || !dv) return parsed;
  if ((parsed.quotedPrice == null || Number(parsed.quotedPrice) <= 0) && Number(dv.quotedPrice) > 0) {
    parsed.quotedPrice = dv.quotedPrice;
    parsed.quotedPriceSource = "d2c_vdp";
    if (dv.priceGated) {
      parsed.priceGatedButRecovered = true;
      parsed.priceGateMessage = dv.priceGateMessage;
      parsed.priceGateGoogleAdsBacked = !!dv.googleAdsCorroborated;
    }
  }
  if (!parsed.vin && dv.vin) parsed.vin = dv.vin;
  if (!parsed.year && dv.year) parsed.year = dv.year;
  if (!parsed.make && dv.make) parsed.make = dv.make;
  if (!parsed.model && dv.model) parsed.model = dv.model;
  if (!parsed.trim && dv.trim) parsed.trim = dv.trim;
  if (!parsed.vehicleCondition && dv.condition) parsed.vehicleCondition = dv.condition;
  if (!parsed.saleConditionHint && dv.saleConditionHint) parsed.saleConditionHint = dv.saleConditionHint;
  if (!parsed.dealerName && dv.dealerName) parsed.dealerName = dv.dealerName;
  if (parsed.odometerKm == null && dv.odometerKm != null) parsed.odometerKm = dv.odometerKm;
  if (!parsed.drivetrain && dv.drivetrain) parsed.drivetrain = dv.drivetrain;
  if (!parsed.vehicle) {
    const vehicleStr = [dv.year, dv.make, dv.model, dv.trim].filter(Boolean).join(" ");
    if (vehicleStr) parsed.vehicle = vehicleStr;
  }
  return parsed;
}
