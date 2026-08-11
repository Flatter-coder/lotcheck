// Capture a manufacturer's OWN PUBLISHED price from its OWN page.
//
// WHY THIS EXISTS. Manufacturer build-&-price APIs return figures that are not
// the advertised MSRP: Toyota's `vehicleStartPrice` sits a constant $653.08
// below the published price and always ends in .92; GM's `msrp.amount.value`
// comes back on half-dollars (43442.5). Both shipped into the catalog as if
// they were sticker prices (2026-08-11). The only figure we can defend in a
// buyer's report is the one the manufacturer prints on its own page, next to
// the words "Starting at" -- so we read that, and store the page URL with it.
//
// Rendering: these pages are client-side, so a plain fetch sees no prices. The
// same Scrapfly render already used for walled dealer pages does the job; one
// render per model line, weekly, is a few cents.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Render a page (JS executed, lazy content scrolled into view) and return HTML. */
export async function renderPage(url, { key = process.env.SCRAPFLY_API_KEY, budgetMs = 60_000 } = {}) {
  if (!key) throw new Error("SCRAPFLY_API_KEY is not set — cannot render published-price pages");
  const u = new URL("https://api.scrapfly.io/scrape");
  u.searchParams.set("key", key);
  u.searchParams.set("url", url);
  u.searchParams.set("render_js", "true");
  u.searchParams.set("auto_scroll", "true");
  u.searchParams.set("rendering_wait", "4000");
  u.searchParams.set("country", "ca");
  const res = await fetch(u.toString(), { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(budgetMs) });
  if (!res.ok) throw new Error(`Scrapfly HTTP ${res.status} for ${url}`);
  const j = await res.json();
  const html = j?.result?.content;
  if (!html || html.length < 2000) throw new Error(`Scrapfly returned no usable content for ${url}`);
  return html;
}

const strip = (s) => String(s || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/**
 * Pull (trim, price) pairs out of a rendered manufacturer page.
 *
 * Only "starting at"-style labels are accepted. "As configured" is a
 * configurator total for whatever options happen to be selected — reading it
 * as an MSRP is the same mistake that started all this.
 */
export function extractStartingPrices(html) {
  if (!html) return [];
  const text = strip(html);
  const out = [];
  // "Starting at: $40,042" / "Starting at $40,042*" / "From $40,042"
  const re = /(starting\s+at|starting\s+from|from)\s*:?\s*\$\s?([0-9]{2,3},[0-9]{3})(?:\.\d{2})?/gi;
  let m, prevEnd = 0;
  while ((m = re.exec(text)) !== null) {
    const price = Number(m[2].replace(/,/g, ""));
    if (!Number.isInteger(price) || price < 10_000 || price > 500_000) continue;
    // The trim name is the nearest preceding capitalised fragment; keep it
    // short and reject sentence-like text so we never store prose as a trim.
    // Bound the search to text since the PREVIOUS price, so one card's name can
    // never be concatenated onto the next ("LS RS Activ").
    let before = text.slice(Math.max(prevEnd, m.index - 110), m.index);
    // Strip the PREVIOUS card's price labels, or they mask this card's name
    // ("... As configured: $46,188* RS" must yield "RS", not nothing).
    before = before.replace(/(starting\s+at|starting\s+from|from|as\s+configured)\s*:?\s*\$\s?[0-9,]+(?:\.\d{2})?\*?/gi, " ")
                   .replace(/[|•·—–*]/g, " ").replace(/\s+/g, " ").trim();
    const tail = before.match(/([A-Z][A-Za-z0-9.\-+]*(?: [A-Z0-9][A-Za-z0-9.\-+]*){0,3})\s*$/);
    const cand = tail ? tail[1].trim() : "";
    const trim = cand && cand.length <= 28 && cand.split(" ").length <= 4 ? cand : null;
    out.push({ trim, msrp: price });
    prevEnd = re.lastIndex;
  }
  // Same trim twice (repeated cards) -> keep the lowest, matching how the rest
  // of the catalog dedupes to the advertised "starting" figure.
  const byTrim = new Map();
  for (const r of out) {
    const k = r.trim || `__untrimmed_${r.msrp}`;
    const prev = byTrim.get(k);
    if (!prev || r.msrp < prev.msrp) byTrim.set(k, r);
  }
  return [...byTrim.values()];
}

/** Turn extracted pairs into msrp_catalog rows. */
export function toCatalogRows({ year, make, model, url, fuelType = null }, pairs) {
  return pairs.map((p) => ({
    year, make, model,
    trim: p.trim,
    msrp: p.msrp,
    fuel_type: fuelType,
    source_url: url,          // provenance: the page the buyer can open
    price_basis: null,        // established per-make when confirmed; see migration
    fetched_at: new Date().toISOString(),
  }));
}
