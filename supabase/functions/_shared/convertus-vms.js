// Convertus VMS embedded vehicle data — present on every Convertus
// "/vehicles/YYYY/make/model/city/prov/adId/" VDP as a single inline
// `var vmsData = {...};` blob, REGARDLESS of whether the page also carries
// schema.org JSON-LD (many Convertus dealer themes -- e.g. the "Platinum
// Kia" theme southtrailkia.com runs -- carry no JSON-LD at all). This is the
// SAME source captureConvertusDaysOnLot (analyze-listing-url/index.ts)
// already reads ONE field from (date_on_lot); this reads the rest: identity,
// odometer, condition, dealer, and -- critically -- msrp/asking_price/
// internet_price, none of which appear in the page's visible text or its
// Nimble markdown (both drop <script> content), so nothing upstream of this
// ever saw them.
//
// Confirmed live, 2026-08-13 (southtrailkia.com, a 2027 Kia Seltos X-Line
// Limited AWD): the report showed "Price vs MSRP: Not shown" / asking price
// "—" and fell back to Kia's generic $28,495 base-trim starting MSRP, while
// this exact page's vmsData.vehicle carried msrp:43780, asking_price:47509
// (a real $3,729-over-MSRP listing -- exactly the kind of gap LotCheck
// exists to catch) plus the VIN and full identity, all correctly trim-
// matched to this unit already.

// Scans forward from a JSON `{` for its matching `}`, string-aware so a
// brace inside a quoted value never miscounts depth. `vmsData` is a single
// ~50-100KB flat-ish object with no code, just JSON, so this is safe and
// far cheaper than a real JS parser.
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

export function extractConvertusVmsVehicle(html) {
  if (typeof html !== "string" || html.length === 0) return null;
  // The page also references vmsData.vehicle.* dozens of times in unrelated
  // template strings BEFORE the actual declaration -- confirmed live,
  // southtrailkia.com: the first several `vmsData` hits are inside JS
  // template literals like `${vmsData.vehicle.model}`. Anchor on the
  // declaration itself (var/let/const/window.vmsData = { ... or bare
  // vmsData = {), not just the bare word.
  const declMatch = /(?:var|let|const)\s+vmsData\s*=\s*\{|window\.vmsData\s*=\s*\{|\bvmsData\s*=\s*\{/.exec(html);
  if (!declMatch) return null;
  const braceStart = declMatch.index + declMatch[0].length - 1; // position of the '{'

  let root;
  try {
    const jsonStr = extractBalancedJson(html, braceStart);
    if (!jsonStr) return null;
    root = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  const v = root && typeof root === "object" ? root.vehicle : null;
  if (!v || typeof v !== "object") return null;

  const num = (x) => { const n = Number(x); return Number.isFinite(n) && n > 0 ? n : null; };
  const str = (x) => (typeof x === "string" && x.trim()) ? x.trim() : null;

  const vinRaw = String(v.vin || "").trim().toUpperCase();
  const vin = (/^[A-HJ-NPR-Z0-9]{17}$/.test(vinRaw) && !/^(.)\1{16}$/.test(vinRaw)) ? vinRaw : null;

  const saleClass = String(v.sale_class || "").toLowerCase();
  const condition = /new/.test(saleClass) ? "new" : (/used|pre-?owned|certified/.test(saleClass) ? "used" : null);

  const yearNum = Number(v.year);
  const odoNum = Number(v.odometer);

  const c = (v.company_data && typeof v.company_data === "object") ? v.company_data : {};
  const dealerCity = str(c.company_city)
    ? (str(c.company_province) ? `${str(c.company_city)}, ${str(c.company_province)}` : str(c.company_city))
    : null;

  // asking_price is NOT reliably "what's being asked" -- confirmed live,
  // 2026-08-13 (albertahonda.com): asking_price (51422) duplicated msrp
  // exactly (the pre-discount sticker), while internet_price (48922) carried
  // the real, currently-advertised price after the dealer's own stated
  // "$2500 Manager Discount" -- matching the page's own displayed final
  // price exactly. Preferring asking_price (the original assumption, based
  // only on southtrailkia.com where the two fields happened to be equal)
  // silently reported the buyer's own MSRP back to them as the "asking
  // price," hiding the $2,500 they were actually being charged less.
  // sale_price is an even-more-specific active promo price when populated.
  // retail_price/wholesale_price/invoice_price are deliberately excluded --
  // reference/internal figures, not what the dealer is asking a buyer to
  // pay. The lowest of the genuinely consumer-facing fields is the real
  // advertised price: a dealer only ever discounts down from a sticker, so
  // the smallest positive value among these IS the current ask.
  const askingCandidates = [num(v.internet_price), num(v.sale_price), num(v.asking_price)].filter((n) => n != null);
  const asking = askingCandidates.length ? Math.min(...askingCandidates) : null;

  // The dealer's own advertised finance rate -- confirmed live, 2026-08-14
  // (albertahonda.com, 2026 Civic Sedan): the page headlined "6.69% for 96
  // Months" as its payment estimate, and vmsData.vehicle.finance carried 10
  // term options (12mo@2.99% up to 96mo@6.69%) with NO field marking one as
  // "default" -- but 96 was the LONGEST term offered, and the longest term
  // (lowest biweekly payment) is what these payment-calculator widgets
  // consistently feature as their headline rate. Entirely invisible upstream
  // for the same reason price/VIN are: it's <script>-embedded JSON, never in
  // visible text or Nimble's markdown.
  const financeArr = Array.isArray(v.finance) ? v.finance : [];
  let financeApr = null, financeTermMonths = null;
  if (financeArr.length) {
    const longest = financeArr.reduce((best, f) => (num(f.finance_term) ?? 0) > (num(best.finance_term) ?? 0) ? f : best, financeArr[0]);
    financeApr = num(longest.finance_rate);
    financeTermMonths = num(longest.finance_term) != null ? Math.round(num(longest.finance_term)) : null;
  }

  // The page's own pricing fine print -- confirmed live on the same listing:
  // "New Vehicles come with Alberta Winter Package which may contain any/all
  // of the following: Lifetime Oil Change, Rust + Undercoat, Block Heater,
  // Mud Flaps, Locking Nuts, and Paint Protection. Finance + Lease Payment
  // details are for informational purposes..." -- names a bundle of possible
  // add-on fees and hedges the advertised payment, exactly the kind of text
  // _shared/disclaimer.ts exists to catch, but it was never reaching Claude
  // because it also lives inside this same script-embedded object (as HTML,
  // in vehicle.description), invisible to the scrape same as everything else
  // here. Stripped to plain text and capped, matching the schema's own
  // "VERBATIM excerpt, max 600 characters" contract.
  const finePrint = (() => {
    const raw = str(v.description);
    if (!raw) return null;
    const text = raw.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 600) : null;
  })();

  if (!yearNum && !str(v.make) && !str(v.model) && asking == null && num(v.msrp) == null) return null;

  return {
    year: Number.isFinite(yearNum) && yearNum > 1900 ? Math.round(yearNum) : null,
    make: str(v.make),
    model: str(v.model),
    trim: str(v.trim) || str(v.search_trim),
    vin,
    stockNumber: str(v.stock_number),
    odometerKm: Number.isFinite(odoNum) && odoNum >= 0 ? Math.round(odoNum) : null,
    condition,
    msrp: num(v.msrp),
    quotedPrice: asking,
    financeApr,
    financeTermMonths,
    finePrint,
    dealerName: str(c.company_name),
    dealerCity,
    dealerPhone: str(c.company_sales_phone),
  };
}

// Fill blanks in a Claude-extracted analysis object (`parsed`) using a
// Convertus vmsData read of the SAME rendered page (`cv`, from
// extractConvertusVmsVehicle above). Same contract as jsonld-vehicle.js's
// fillFromJsonLd -- structured data outranks a vision/prose guess, fill-only,
// never clobbers a real parsed value, mutates and returns `parsed`.
//
// Exists for the case JSON-LD can't cover: a Convertus page with NO
// schema.org markup at all (confirmed live, 2026-08-14, albertahonda.com --
// zero <script type="application/ld+json"> blocks anywhere on the VDP) where
// the Scrapfly rescue's own vision/text pass ALSO missed price, VIN,
// financing and the pricing fine print -- all of it script-embedded, none of
// it visible to a text read, and (that day) too tall/complex a page for
// vision to catch reliably either. Without this, a Convertus site with no
// JSON-LD had no deterministic fallback left at all once the rescue's own
// read came back empty.
export function fillFromConvertusVms(parsed, cv) {
  if (!parsed || !cv) return parsed;
  if ((parsed.quotedPrice == null || Number(parsed.quotedPrice) <= 0) && Number(cv.quotedPrice) > 0) {
    parsed.quotedPrice = cv.quotedPrice;
    parsed.quotedPriceSource = "convertus_vms";
  }
  if ((parsed.msrp == null || Number(parsed.msrp) <= 0) && Number(cv.msrp) > 0) parsed.msrp = cv.msrp;
  if (!parsed.vin && cv.vin) parsed.vin = cv.vin;
  if (!parsed.year && cv.year) parsed.year = cv.year;
  if (!parsed.make && cv.make) parsed.make = cv.make;
  if (!parsed.model && cv.model) parsed.model = cv.model;
  if (!parsed.trim && cv.trim) parsed.trim = cv.trim;
  if (!parsed.vehicleCondition && cv.condition) parsed.vehicleCondition = cv.condition;
  if (!parsed.dealerName && cv.dealerName) parsed.dealerName = cv.dealerName;
  if (!parsed.dealerCity && cv.dealerCity) parsed.dealerCity = cv.dealerCity;
  if (parsed.odometerKm == null && cv.odometerKm != null) parsed.odometerKm = cv.odometerKm;
  if (!(Number(parsed.financing?.rate) > 0) && cv.financeApr != null) {
    parsed.financing = { ...(parsed.financing || {}), rate: cv.financeApr, termMonths: cv.financeTermMonths ?? parsed.financing?.termMonths ?? null, source: "convertus_vms" };
  }
  if (!parsed.pricingDisclaimer && cv.finePrint) parsed.pricingDisclaimer = cv.finePrint;
  if (!parsed.vehicle) {
    const vehicleStr = [cv.year, cv.make, cv.model, cv.trim].filter(Boolean).join(" ");
    if (vehicleStr) parsed.vehicle = vehicleStr;
  }
  return parsed;
}
