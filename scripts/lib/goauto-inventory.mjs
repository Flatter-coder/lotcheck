// Go Auto group inventory reader.
//
// WHY THIS EXISTS. Go Auto is 70+ dealerships and 30+ brands across Alberta and
// BC, and every one of them was invisible to us. The feed probe guesses /new/,
// /new-inventory/ and /vehicles/new/; Go Auto serves inventory from /vehicles
// behind an Algolia search, so every store answered 404 or a bot wall and fell
// into the 1,608 hosts recorded as "no feed detected". St. Albert Honda — the
// single largest gap in the province — is one of them.
//
// ONE ENDPOINT, EVERY STORE. https://www.goauto.ca/vehicles carries the whole
// group's stock, and each card names the dealership AND its city. That matters
// more than the volume: city attribution is what the price index has been
// starving for, and here it arrives with the listing instead of needing the
// dealer->city join that produced the spelling-collision bug (5cf6fdd).
//
// PARSED IN-HOUSE, DELIBERATELY. Scrapfly can return this page pre-extracted,
// and we do not use that. A vendor may fetch a page for us; it may never be the
// thing that produces the substance of a report. The fetch is swappable
// plumbing, the reading is ours — the same rule that keeps VinAudit out.
//
// NO VIN ON THE INDEX. Cards carry year/make/model/trim/price/dealer only; the
// VIN lives on each vehicle's detail page. Callers that need one must follow
// `url`. Saying so plainly because a listing without a VIN cannot support a
// recall or history claim, and a silent null there reads as "no recalls".

const stripTags = (s) => s
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
  .replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/\s+/g, " ").trim();

// "Call for price" is not a missing price — it is a dealer choosing to withhold
// one, which is a finding rather than a gap. Kept separately so a caller can
// tell "we could not read it" from "they would not show it".
const GATED = /call for price|contact (us )?for price|please call|price on request/i;

// A card's chrome runs straight into the dealer name with nothing between them
// — "…Cash Price Call for price Southtown Hyundai, Edmonton". On a priced card
// the number itself separates them; on a GATED one there is no number, so the
// label leaks into the dealer. Cut everything up to the last chrome token.
const CHROME = /^.*?(?:call for price|cash price|your price|all-in price|finance|lease|price on request|please call)\s*/i;
function cleanDealer(raw) {
  if (!raw) return null;
  const s = String(raw).replace(CHROME, "").trim();
  return s || null;
}

export function extractGoAutoVehicles(html, { condition = null } = {}) {
  if (typeof html !== "string" || !html) return [];
  const anchors = [...html.matchAll(/<a class="contents" aria-label="([^"]+)" href="([^"?]+)/g)];
  const out = [];

  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    // The next card is the natural end of this one. For the LAST card there is
    // no next anchor, and a fixed byte window is the wrong tool: each card
    // carries an image carousel worth tens of KB of markup, so a 12,000-char
    // cap fell short of the price and dropped the final vehicle on every page.
    // "Check Availability" is the card's own closing CTA, so it ends the card
    // wherever the markup happens to be heavy.
    const cta = html.indexOf("Check Availability", a.index);
    const end = anchors[i + 1]
      ? anchors[i + 1].index
      : (cta > a.index ? cta + 400 : a.index + 60000);
    const chunk = html.slice(a.index, end);
    const text = stripTags(chunk);

    const label = a[1].trim();
    const m = label.match(/^(\d{4})\s+(\S+)\s+(.*)$/);
    if (!m) continue;

    const cond = /\|\s*New\b/i.test(text) ? "new" : /\|\s*Used\b/i.test(text) ? "used" : null;
    if (condition && cond && cond !== condition) continue;

    // "Go Infiniti South, Edmonton" sits immediately before the CTA. Anchoring
    // on that trailing marker rather than on the first comma keeps badge text
    // ("HIGH DEMAND", "Cash Price Finance Lease") out of the dealer name — the
    // first version of this swallowed exactly that.
    const loc = text.match(/([A-Za-z][A-Za-z0-9'&.-]*(?:\s+[A-Za-z][A-Za-z0-9'&.-]*){0,5}),\s*([A-Za-z][A-Za-z.-]*(?:\s+[A-Za-z.-]+){0,2})\s+Check Availability/);

    const priceGated = GATED.test(text);
    let list_price = null;
    if (!priceGated) {
      // The card prints tab labels between the heading and the number
      // ("Cash Price Finance Lease $26,645"), so the amount is the first dollar
      // figure AFTER the heading, not adjacent to it.
      const p = text.match(/(?:Cash Price|Your Price|All-In Price)[^$]{0,60}\$\s*([\d,]{4,})/i);
      if (p) list_price = Number(p[1].replace(/,/g, "")) || null;
    }

    // "was $74,561" beside the price is the dealer's own before-figure. Kept,
    // because a discount claim is only checkable against what it was.
    const wasM = text.match(/was\s*\$\s*([\d,]{4,})/i);

    out.push({
      year: Number(m[1]),
      make: m[2],
      model_trim: m[3].trim(),
      condition: cond,
      list_price,
      was_price: wasM ? Number(wasM[1].replace(/,/g, "")) || null : null,
      priceGated,
      dealer: cleanDealer(loc && loc[1]),
      city: loc ? loc[2].trim() : null,
      url: a[2],
      source: "goauto",
    });
  }
  return out;
}

export const GOAUTO_INVENTORY_URL =
  'https://www.goauto.ca/vehicles?refinementList=%7B%22stock_type%22%3A%5B%22NEW%22%5D%7D';
