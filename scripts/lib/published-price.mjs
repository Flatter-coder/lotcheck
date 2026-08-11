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

/**
 * Render a page (JS executed, lazy content scrolled into view) and return HTML.
 *
 * Two routes, in order:
 *   1. the `render-page` edge function, which holds the Scrapfly key in
 *      Supabase -- so the key lives in ONE place instead of being copied into
 *      GitHub Actions as a second secret to rotate and leak;
 *   2. a direct Scrapfly call, when SCRAPFLY_API_KEY happens to be in the
 *      environment (local debugging).
 */
// The service-role key stored in CI can go stale when the project rotates its
// keys (ours did: CI's copy dated 2026-07-01 no longer matched what the edge
// function read, and every call came back forbidden). Ask the Management API
// for the CURRENT key instead, using the access token CI already holds -- so a
// rotation fixes itself instead of failing a week later.
let cachedKey = null;
async function currentServiceKey() {
  if (cachedKey) return cachedKey;
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const ref = (process.env.SUPABASE_URL || "").match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
  if (token && ref) {
    try {
      // reveal=true: without it the Management API returns MASKED key values,
      // which then silently fail the function's comparison.
      const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const keys = await res.json();
        const list = Array.isArray(keys) ? keys : [];
        const hit = list.find((k) => /service_role|secret/i.test(`${k?.name || ""} ${k?.type || ""}`)) || null;
        const val = hit?.api_key || hit?.secret || null;
        if (val && !/\*/.test(val)) {
          console.log(`  (auth: using ${hit.name || hit.type} from the Management API, ...${String(val).slice(-6)})`);
          cachedKey = val; return cachedKey;
        }
        console.warn(`  (auth: Management API returned ${list.length} keys, none usable: ${list.map(k => k?.name || k?.type).join(", ")})`);
      }
    } catch { /* fall back below */ }
  }
  cachedKey = process.env.SUPABASE_SERVICE_ROLE_KEY || null;
  return cachedKey;
}

export async function renderPage(url, { key = process.env.SCRAPFLY_API_KEY, budgetMs = 60_000 } = {}) {
  const sbUrl = process.env.SUPABASE_URL, sbKey = await currentServiceKey();
  if (!key && sbUrl && sbKey) {
    const res = await fetch(`${sbUrl.replace(/\/$/, "")}/functions/v1/render-page`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: sbKey, Authorization: `Bearer ${sbKey}` },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(budgetMs + 40_000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.html) throw new Error(`render-page: ${j.error || "HTTP " + res.status}`);
    return j.html;
  }
  if (!key) throw new Error("no render route: set SCRAPFLY_API_KEY, or SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to use the render-page function");
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
// Words that appear around a price on these pages but are never part of a trim
// name: nav chrome, section headings, body-style labels, model years.
const NOISE = /^(price|prices|view|inventory|learn|more|models?|model|vehicle|details|detail|drive|driven|choose|your|also|like|explore|build|compare|starting|from|new|the|all|small|compact|mid-?size|full-?size|suv|suvs|truck|trucks|car|cars|electric|remarkably|20\d{2})$/i;

function cleanTrim(raw) {
  let words = String(raw || "").split(/\s+/).filter(Boolean);
  // Strip noise from the FRONT (headings precede the card) and the back.
  while (words.length && NOISE.test(words[0])) words.shift();
  while (words.length && NOISE.test(words[words.length - 1])) words.pop();
  // A real trim is short. Anything longer is a sentence we misread.
  if (!words.length || words.length > 3) return null;
  const out = words.join(" ");
  return /^[A-Za-z0-9][A-Za-z0-9 .\-+]{0,26}$/.test(out) ? out : null;
}

export function extractStartingPrices(html, { model = null, otherModels = [] } = {}) {
  if (!html) return [];
  const text = strip(html);
  const out = [];
  // "Starting at: $40,042" / "Starting at $40,042*" / "From $40,042"
  const re = /(starting\s+at|starting\s+from|from)\s*:?\s*\$\s?([0-9]{2,3},[0-9]{3})(?:\.\d{2})?/gi;
  let m, prevEnd = 0;
  while ((m = re.exec(text)) !== null) {
    const windowStart = prevEnd;
    prevEnd = re.lastIndex;   // advance FIRST: a dropped row must still move the
                              // window, or the next card inherits this text
    const price = Number(m[2].replace(/,/g, ""));
    if (!Number.isInteger(price) || price < 10_000 || price > 500_000) continue;
    // The trim name is the nearest preceding capitalised fragment; keep it
    // short and reject sentence-like text so we never store prose as a trim.
    // Bound the search to text since the PREVIOUS price, so one card's name can
    // never be concatenated onto the next ("LS RS Activ").
    let before = text.slice(Math.max(windowStart, m.index - 110), m.index);
    // Strip the PREVIOUS card's price labels, or they mask this card's name
    // ("... As configured: $46,188* RS" must yield "RS", not nothing).
    before = before.replace(/(starting\s+at|starting\s+from|from|as\s+configured)\s*:?\s*\$\s?[0-9,]+(?:\.\d{2})?\*?/gi, " ")
                   .replace(/[|•·—–*]/g, " ").replace(/\s+/g, " ").trim();
    const tail = before.match(/([A-Za-z0-9][A-Za-z0-9.\-+]*(?: [A-Za-z0-9][A-Za-z0-9.\-+]*){0,4})\s*$/);
    const trim = cleanTrim(tail ? tail[1] : "");
    // Cross-model contamination: these pages cross-link the rest of the lineup
    // ("Small SUV Encore GX $34,192" on the Envista page), and storing those
    // under the target model would be simply wrong. Drop them.
    const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const isOther = trim && otherModels.some((m) => norm(m) && norm(m) !== norm(model) && norm(trim).includes(norm(m)));
    if (isOther) continue;
    // "Equinox $40,042" on the Equinox page is the model's starting price, not
    // a trim called Equinox.
    const finalTrim = trim && model && norm(trim) === norm(model) ? null : trim;
    out.push({ trim: finalTrim, msrp: price });
  }
  // Same trim twice (repeated cards) -> keep the lowest, matching how the rest
  // of the catalog dedupes to the advertised "starting" figure.
  const byTrim = new Map();
  for (const r of out) {
    const k = r.trim ? r.trim.toLowerCase() : `__untrimmed_${r.msrp}`;
    const prev = byTrim.get(k);
    if (!prev || r.msrp < prev.msrp) byTrim.set(k, r);
  }
  // A nameless row at the same price as a named one is the same car seen twice
  // (the hero block above the trim cards) -- keep the named one.
  const named = [...byTrim.values()].filter((r) => r.trim);
  const namedPrices = new Set(named.map((r) => r.msrp));
  return [...byTrim.values()].filter((r) => r.trim || !namedPrices.has(r.msrp));
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
