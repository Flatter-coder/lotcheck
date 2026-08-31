// schema.org Vehicle/Offer extraction, shared so it can be regression-tested in
// Node (same pattern as trim-match.js / amvic-match.js / tradein-detect.js).
//
// This is no longer just a fallback: it runs in parallel with the scrape on
// every URL scan, so a slow or blocked scrape can't cost the buyer their
// report. Dealer platforms nest this data in different shapes -- a top-level
// @type, an array of nodes, or an @graph with @type arrays like
// ["Product","Car"] (EDealer) -- and every shape here came off a real page.

// What the page DECLARES it is about -- a different question from what it
// mentions, and the one that tells a detail page from an inventory grid.
// See _shared/multi-vehicle.ts.
//
// Returns the NODE COUNT as well as the VINs, because those are not the same
// question either. A detail page that declares one vehicle whose VIN string we
// cannot use (a placeholder, a typo, an omitted field) is still a detail page;
// counting VINs alone would score it "declares nothing" and refuse it.
//
// `pageUrl` resolves the shape that would otherwise cost a real VDP its scan:
// platforms that mark up their similar-vehicles rail give every card its own
// Car node, so the page declares several. The one whose url/@id/
// mainEntityOfPage is THIS page is the subject; the rest are the rail.
//
// Deliberately NOT built on extractJsonLdVehicle: that returns the FIRST
// priced vehicle node and stops, so it can never answer "how many".
export function jsonLdVehicles(html, pageUrl) {
  const empty = { count: 0, vins: [], anchoredVin: null };
  if (typeof html !== "string" || !html) return empty;
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1].trim());
  const out = new Set();
  const seenNodes = new Set();
  let anchoredVin = null;
  const norm = (u) => String(u ?? "").trim().toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
  const here = norm(pageUrl);
  const typeOf = (n) => {
    const t = n?.["@type"];
    return Array.isArray(t) ? t.map(String) : (t ? [String(t)] : []);
  };
  const isVehicle = (n) => typeOf(n).some((t) => /^(Car|Vehicle|MotorizedVehicle|Product)$/i.test(t));
  const vinOf = (n) => {
    // Four fields real dealer schemas use for it, in decreasing directness.
    const vin = n.vehicleIdentificationNumber ?? n.vin ?? n.sku ?? n.mpn;
    return (typeof vin === "string" && /^[A-HJ-NPR-Z0-9]{17}$/i.test(vin.trim())) ? vin.trim().toUpperCase() : null;
  };
  const anchorOf = (n) => norm(
    typeof n.url === "string" ? n.url
      : typeof n["@id"] === "string" ? n["@id"]
      : typeof n.mainEntityOfPage === "string" ? n.mainEntityOfPage
      : n?.mainEntityOfPage?.["@id"],
  );
  const walk = (n, depth) => {
    if (!n || typeof n !== "object" || depth > 6) return;
    if (Array.isArray(n)) { for (const x of n) walk(x, depth + 1); return; }
    if (isVehicle(n)) {
      const vin = vinOf(n);
      // Identity for counting: the VIN when there is one, otherwise the node's
      // own anchor or its name -- so one vehicle described twice across two
      // blocks (common: a Product node and a Car node for the same unit) is
      // counted once, and a VIN-less node is still counted.
      const key = vin || anchorOf(n) || String(n.name ?? "").trim().toLowerCase() || `node:${seenNodes.size}`;
      seenNodes.add(key);
      if (vin) out.add(vin);
      if (vin && here && anchorOf(n) === here) anchoredVin = vin;
    }
    for (const v of Object.values(n)) walk(v, depth + 1);
  };
  for (const b of blocks) {
    try { walk(JSON.parse(b), 0); } catch { /* one malformed block never sinks the rest */ }
  }
  return { count: seenNodes.size, vins: [...out], anchoredVin };
}

/** Back-compat shim: the VINs alone. */
export function jsonLdVehicleVins(html) {
  return jsonLdVehicles(html, null).vins;
}

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

  // WHEN THE DEALER GOT IT. schema.org purchaseDate is "the date the item was
  // purchased by the current owner" -- and on a dealer's own listing the current
  // owner is the dealer, so this is the date it landed in their inventory.
  //
  // We were reporting "Days on lot: not published - ask the dealer" on pages
  // that publish it, in a blob the scan had already parsed. Advantage Ford's
  // Acadia carried "purchaseDate":"2026-07-30T11:27:42.000" the whole time.
  // [[days-on-lot-own-engine]] is our own leverage feature; handing it back
  // because nobody read one field is the cheapest possible miss.
  //
  // Guarded, because a date is easy to publish wrong: a future date or one more
  // than ten years old is a data error, not a very patient dealer.
  let listedSince = null;
  {
    const raw = node.purchaseDate ?? offer?.availabilityStarts ?? null;
    const t = raw ? Date.parse(String(raw)) : NaN;
    if (Number.isFinite(t)) {
      const days = Math.floor((Date.now() - t) / 86400000);
      if (days >= 0 && days <= 3650) listedSince = new Date(t).toISOString().slice(0, 10);
    }
  }

  const currency = str(offer?.priceCurrency);
  const seller = offer?.seller || node?.seller;
  const addr = seller?.address;
  const locality = str(addr?.addressLocality);
  const region = str(addr?.addressRegion);
  const dealerCity = locality ? (region ? `${locality}, ${region}` : locality) : null;

  if (!year && !make && !model && price == null) return null;
  return { year, make, model, trim, vin, odometerKm, price, currency, condition, listedSince, dealerName: str(seller?.name), dealerCity };
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
  // DAYS ON LOT, from the listing's own inventory date.
  //
  // Only when nothing better already found one: the platform feeds (SM360's
  // date_on_lot, Convertus's date_added) are the dealer's operational record
  // and outrank a schema.org field, exactly as the existing capture order says.
  // This fills the case where there was no answer at all -- which is what the
  // buyer saw as "Not published, ask the dealer" on a page that published it.
  if (!parsed.daysOnLot && jsonLd.listedSince) {
    const t = Date.parse(jsonLd.listedSince + "T00:00:00Z");
    const days = Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : NaN;
    // A car listed today is 0 days on the lot, which is TRUE and worth saying --
    // but it is also what a mis-stamped date looks like, and "brand new to the
    // lot" is the one reading that gives a buyer no leverage and costs nothing
    // to omit. Report it from one full day.
    if (Number.isFinite(days) && days >= 1 && days <= 3650) {
      parsed.daysOnLot = {
        days,
        since: jsonLd.listedSince,
        source: "listing_structured_data",
        sourceLabel: "the listing's own inventory date",
      };
    }
  }
  if (parsed.odometerKm == null && jsonLd.odometerKm != null) parsed.odometerKm = jsonLd.odometerKm;
  if (!parsed.vehicle) {
    const vehicleStr = [jsonLd.year, jsonLd.make, jsonLd.model, jsonLd.trim].filter(Boolean).join(" ");
    if (vehicleStr) parsed.vehicle = vehicleStr;
  }
  return parsed;
}
