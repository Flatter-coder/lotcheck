// schema.org Vehicle/Offer extraction, shared so it can be regression-tested in
// Node (same pattern as trim-match.js / amvic-match.js / tradein-detect.js).
//
// This is no longer just a fallback: it runs in parallel with the scrape on
// every URL scan, so a slow or blocked scrape can't cost the buyer their
// report. Dealer platforms nest this data in different shapes -- a top-level
// @type, an array of nodes, or an @graph with @type arrays like
// ["Product","Car"] (EDealer) -- and every shape here came off a real page.

export function extractJsonLdVehicle(html) {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1].trim());
  if (blocks.length === 0) return null;

  const nodes = [];
  for (const b of blocks) {
    try {
      const parsed = JSON.parse(b);
      const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.["@graph"]) ? parsed["@graph"] : [parsed]);
      for (const n of arr) if (n && typeof n === "object") nodes.push(n);
    } catch { /* one malformed block never sinks the rest */ }
  }

  const typeOf = (n) => {
    const t = n?.["@type"];
    return Array.isArray(t) ? t.map(String) : (t ? [String(t)] : []);
  };
  const isVehicle = (n) => typeOf(n).some((t) => /^(Car|Vehicle|MotorizedVehicle|Product)$/i.test(t));
  const firstOffer = (n) => {
    const o = n?.offers;
    if (!o) return null;
    return Array.isArray(o) ? (o[0] ?? null) : o;
  };
  const priceFrom = (offer) => {
    if (!offer) return null;
    const cand = offer.price ?? offer.lowPrice ?? offer?.priceSpecification?.price;
    const num = Number(String(cand ?? "").replace(/[^0-9.]/g, ""));
    return Number.isFinite(num) && num > 0 ? num : null;
  };

  let node = null; let offer = null; let price = null;
  for (const n of nodes) {
    if (!isVehicle(n)) continue;
    const o = firstOffer(n);
    const p = priceFrom(o);
    if (p != null) { node = n; offer = o; price = p; break; } // best: a priced vehicle node
    if (!node) { node = n; offer = o; } // weak fallback: a vehicle node with no price
  }
  if (!node) return null;
  if (price == null) price = priceFrom(offer);

  const str = (v) =>
    (typeof v === "string" && v.trim()) ? v.trim()
      : (v && typeof v.name === "string" && v.name.trim()) ? v.name.trim() : null;
  const titleCase = (s) => s ? s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()) : s;

  const yearRaw = node.vehicleModelDate ?? node.modelDate ?? node.productionDate ?? node.releaseDate;
  const ym = String(yearRaw ?? "").match(/\b(19|20)\d{2}\b/);
  const year = ym ? Number(ym[0]) : null;

  const make = titleCase(str(node.brand) || str(node.manufacturer));
  const model = str(node.model) || str(node.name);
  const trim = titleCase(str(node.vehicleConfiguration) || str(node.trim) || str(node.vehicleModelConfiguration));

  const vinRaw = typeof node.vehicleIdentificationNumber === "string" ? node.vehicleIdentificationNumber.trim().toUpperCase() : "";
  const vin = (/^[A-HJ-NPR-Z0-9]{17}$/.test(vinRaw) && !/^(.)\1{16}$/.test(vinRaw)) ? vinRaw : null;

  let odometerKm = null;
  const odo = node.mileageFromOdometer;
  if (odo != null) {
    const v = Number(typeof odo === "object" ? odo.value : odo);
    if (Number.isFinite(v) && v >= 0) {
      const unit = String(typeof odo === "object" ? (odo.unitCode || odo.unitText || "") : "").toUpperCase();
      odometerKm = /SMI|MILE/.test(unit) ? Math.round(v * 1.60934) : Math.round(v);
    }
  }

  const cond = String(node.itemCondition || offer?.itemCondition || "").toLowerCase();
  let condition = /new/.test(cond) ? "new" : (/used|refurb/.test(cond) ? "used" : null);
  if (condition == null && odometerKm != null) condition = odometerKm <= 100 ? "new" : "used";

  const currency = str(offer?.priceCurrency);
  const seller = offer?.seller || node?.seller;
  const addr = seller?.address;
  const locality = str(addr?.addressLocality);
  const region = str(addr?.addressRegion);
  const dealerCity = locality ? (region ? `${locality}, ${region}` : locality) : null;

  if (!year && !make && !model && price == null) return null;
  return { year, make, model, trim, vin, odometerKm, price, currency, condition, dealerName: str(seller?.name), dealerCity };
}

// Fill blanks in a Claude-extracted analysis object (`parsed`) using a
// schema.org read of the SAME page (`jsonLd`, from extractJsonLdVehicle
// above). Structured data outranks a vision/prose guess everywhere else in
// this codebase (buildJsonLdFallbackAnalysis) -- same rule here. Never
// clobbers a real parsed value, only fills what's missing or a non-positive
// price. Mutates and returns `parsed`; a null jsonLd is a no-op.
export function fillFromJsonLd(parsed, jsonLd) {
  if (!parsed || !jsonLd) return parsed;
  if ((parsed.quotedPrice == null || Number(parsed.quotedPrice) <= 0) && Number(jsonLd.price) > 0) parsed.quotedPrice = jsonLd.price;
  if (!parsed.vin && jsonLd.vin) parsed.vin = jsonLd.vin;
  if (!parsed.year && jsonLd.year) parsed.year = jsonLd.year;
  if (!parsed.make && jsonLd.make) parsed.make = jsonLd.make;
  if (!parsed.model && jsonLd.model) parsed.model = jsonLd.model;
  if (!parsed.trim && jsonLd.trim) parsed.trim = jsonLd.trim;
  if (!parsed.vehicleCondition && jsonLd.condition) parsed.vehicleCondition = jsonLd.condition;
  if (!parsed.dealerName && jsonLd.dealerName) parsed.dealerName = jsonLd.dealerName;
  if (!parsed.dealerCity && jsonLd.dealerCity) parsed.dealerCity = jsonLd.dealerCity;
  if (parsed.odometerKm == null && jsonLd.odometerKm != null) parsed.odometerKm = jsonLd.odometerKm;
  if (!parsed.vehicle) {
    const vehicleStr = [jsonLd.year, jsonLd.make, jsonLd.model, jsonLd.trim].filter(Boolean).join(" ");
    if (vehicleStr) parsed.vehicle = vehicleStr;
  }
  return parsed;
}
