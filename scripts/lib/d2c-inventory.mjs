// D2C Media inventory listings (Wheaton Honda, Sun Valley Honda and many
// other Canadian franchise stores). Read 2026-09-26 from wheatonhonda.com.
//
// WHERE THE LIST IS. /new/inventory/search.html and /used/inventory/search.html
// render the first page; the site's own pager then writes a filter code into
// /inventory.html?filterid=... and that address is server-rendered too. The
// code is the filter object the pager POSTs, written compactly:
//   a{sort} b{categories} [d{make id, base 36}] q{page} -10x0-0-0
// Categories: 1 = used, 3 = new stock, 2 = new incoming (the site's own new
// page asks for [3,2]). So every page of a section is one plain GET, the same
// request a buyer's browser makes when they press "2".
//
// WHAT A CAR IS. One <li class="carBoxWrapper"> per vehicle, carrying the
// dealer's schema.org Vehicle (VIN, price, link), a hidden "vehicledata" input
// (make, model, year, stock number, condition), the trim, the odometer and the
// fuel. Structured records OUTSIDE a card (side panels, "new arrivals") are
// never read -- a used page carries new-car records in its sidebar.
import { validateVin } from "../../supabase/functions/_shared/invariants.ts";

export const D2C_SECTIONS = { new: "a1b32", used: "a1b1" };
export const d2cPageUrl = (host, condition, page) => `${host}/inventory.html?filterid=${D2C_SECTIONS[condition]}q${page}-10x0-0-0`;

const attr = (tag, name) => { const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`)); return m ? m[1].trim() : null; };
const num = (s) => { const n = Number(String(s ?? "").replace(/[^0-9.]/g, "")); return Number.isFinite(n) && n > 0 ? n : null; };
const text = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

export function isD2cListing(html) {
  return /imagescdn\.d2cmedia\.ca/.test(html) && /class="carBoxWrapper"/.test(html);
}

// Every car card on one listing page, as crawler rows. condition is the
// section's (the card's own data-condition wins when it says NEW/USED/DEMO).
export function parseD2cListing(html, condition) {
  const rows = [];
  const cards = String(html || "").split(/<li class="carBoxWrapper"/).slice(1);
  for (const raw of cards) {
    const card = raw.split(/<\/li>\s*<li class="carBoxWrapper"/)[0];
    const input = (card.match(/<input name="vehicledata"[^>]*>/) || [])[0];
    if (!input) continue;
    const check = validateVin(attr(input, "data-vin"));
    if (!check.present || !check.valid) continue;
    let ld = null;
    for (const m of card.matchAll(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/g)) {
      try { const j = JSON.parse(m[1]); if (j?.["@type"] === "Vehicle" && String(j.vehicleIdentificationNumber || "").toUpperCase() === check.vin) ld = j; } catch { /* not ours */ }
    }
    const cardCond = String(attr(input, "data-condition") || "").toUpperCase();
    const trim = text((card.match(/<span class='divTrim'>([\s\S]*?)<\/span>/) || [])[1]) || attr(input, "data-trim") || null;
    const km = num((card.match(/<span class='s-km'>([\d,]+)\s*KM<\/span>/i) || [])[1]);
    const price = num(ld?.offers?.price) ?? num((card.match(/class='dollarsigned p-base[^']*'>([\d,]+)</) || [])[1]);
    const fuel = text((card.match(/Fuel:\s*<\/span>\s*<span[^>]*>([^<]*)</) || [])[1]) || null;
    rows.push({
      vin: check.vin,
      stock_no: attr(input, "data-stock-number"),
      year: num(attr(input, "data-year")),
      make: attr(input, "data-make"),
      model: attr(input, "data-model"),
      trim,
      // The card's data-condition is NOT the car's condition: on 2026-09-26 six
      // cards in Wheaton Honda's USED section said NEW -- a 2025 Escape at
      // 57,487 km, a 2025 Corolla Hybrid at 61,751 km -- all at /used/ URLs.
      // It tracks model year, not ownership. The car's own address, then the
      // section the dealer filed it under, decide.
      condition: /\/used\//i.test(ld?.offers?.url || "") ? "used" : /\/new\//i.test(ld?.offers?.url || "") ? "new" : condition,
      odometer_km: km,
      msrp: null,
      list_price: price,
      sale_price: price,
      date_entry: null,
      days_in_inventory: null,
      certified: /certified/i.test(card.match(/carBanner[\s\S]{0,400}/)?.[0] || "") ? true : null,
      demo: cardCond === "DEMO" ? true : null,
      damaged: null,
      status: null,
      fuel_type: fuel,
      vdp_url: ld?.offers?.url || null,
    });
  }
  return rows;
}
