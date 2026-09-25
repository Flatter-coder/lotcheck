// Porsche Canada's configurator, read as the maker publishes it.
//
// 2026-09-25: models.porsche.com/en-CA/model-start/{series} began 308-redirecting
// to www.porsche.com/canada/en/models/{series}/configure/, a page that carries
// no price at all, so scrape-porsche.mjs found 0 model groups and Porsche MSRP
// went stale from 09-22 (catalog-refresh red four days running).
//
// The prices now live on one configurator page per model code, server-rendered,
// itemised by Porsche itself (911 Carrera, MY2027, read 2026-09-25):
//   Base price $144,900 · Destination Charge $3,200 · Estimated Maximum Dealer Fee
//   $2,750 · Estimated Luxury Tax $10,197 · tire fee $35 · A/C excise $100
//   -> Estimated Total Price $161,182 (the schema.org Offer price).
// Base price is listed APART from destination, so the MSRP basis is excl_freight
// on the maker's own wording -- not a guess. [[build-and-price-msrp-source]]

// Model codes linked from a series' configure page, in page order, once each.
export function configuratorCodes(html) {
  const out = [];
  for (const m of String(html || "").matchAll(/configurator\.porsche\.com\/en-CA\/mode\/model\/([A-Z0-9]{5,8})/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

const money = (s) => { const n = Number(String(s || "").replace(/[^0-9.]/g, "")); return Number.isFinite(n) && n > 0 ? n : null; };

// One configurator page -> the figures Porsche itemises, or null when the page
// does not carry a base price (a code Porsche has withdrawn).
export function parseConfigurator(html, code) {
  const h = String(html || "");
  const name = (h.match(/<title>([^<|]+?)\s*\|\s*Porsche Car Configurator/) || [])[1]?.trim() || null;
  // The model-year tag Porsche shows on the page; the asset path as a fallback,
  // which on a 718 carries a five-character code (/model/2025/98212/).
  const year = Number((h.match(/<\/template>(20\d\d)<\/icc-p-tag>/) || [])[1])
    || Number((h.match(new RegExp(`/model/(20\\d\\d)/${code.slice(0, 5)}`)) || [])[1]) || null;
  const items = {};
  for (const m of h.matchAll(/<p class="text-contrast-high">([^<]+)<\/p><p>([^<]+)<\/p>/g)) {
    if (!(m[1] in items)) items[m[1].trim()] = money(m[2]);
  }
  const base = items["Base price"] ?? null;
  if (!name || !year || !base) return null;
  return {
    code, name, year, base,
    destination: items["Destination Charge"] ?? null,
    dealerFeeMax: items["Estimated Maximum Dealer Fee"] ?? null,
    luxuryTax: items["Estimated Luxury Tax"] ?? null,
    total: money((h.match(/"price":"(\d+)","priceCurrency":"CAD"/) || [])[1]),
  };
}

// Nameplate + variant, the way dealers list them ("Porsche Cayenne S").
// Longest prefix first so "718 Cayman GT4 RS" is a 718 Cayman, not a 718.
const NAMEPLATES = ["718 Boxster", "718 Cayman", "718 Spyder", "911", "Taycan", "Panamera", "Macan", "Cayenne"];
export function splitName(name) {
  const n = String(name || "").trim();
  const plate = NAMEPLATES.find((p) => n === p || n.startsWith(p + " "));
  if (!plate) return { model: n, trim: null };
  const rest = n.slice(plate.length).trim();
  return { model: plate, trim: rest || null };
}
