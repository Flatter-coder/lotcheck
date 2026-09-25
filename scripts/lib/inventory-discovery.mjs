// Find a dealer's inventory page by reading the dealer's own links.
//
// WHY. The feed probe guessed five fixed paths — /new/, /inventory/,
// /new-inventory/, /inventory/new/, /vehicles/ — and asked each detector to
// try them. On 2026-09-22 a 400-host probe of the AMVIC roster returned FIVE
// usable feeds. 273 hosts answered 200 with a real page and no feed found, and
// the traces show why: every one of those paths 404s while the homepage serves
// 284KB of working site.
//
// We were not failing to recognise platforms. We were failing to find the
// inventory page at all, then reporting that as "no feed".
//
// silverzincmotors.com is the shape of the miss: its homepage links
// /inventory-list/ and /listings/<vehicle>. Neither matches
// discoverCategoryPages(), whose regex accepts only /inventory/new-<something>/
// — one platform's URL shape, applied to every dealer in Alberta.
//
// SO THIS READS THEIR LINKS INSTEAD OF GUESSING OURS. It changes no detector:
// the same sm360, convertus, JSON-LD and eDealer detectors run afterwards,
// against pages that exist. One discovery fix lifts every platform at once,
// which is why it comes before writing a sixth adapter.
//
// PRECISION OVER RECALL. A link is a candidate only if its PATH says inventory.
// Matching on link text, or on any URL containing "car", would hand the
// detectors a careers page and a blog, and a detector that runs on the wrong
// page is how a dealer gets catalogued against someone else's stock.

const INDEX_HINTS = [
  "inventory", "vehicles", "showroom", "listings", "our-cars",
  "new-vehicles", "used-vehicles", "new-inventory", "used-inventory",
  "pre-owned", "preowned", "usedcars", "newcars", "vehicle-search",
  "browse-inventory", "car-inventory", "stock-list", "all-inventory",
];

// Paths that contain an inventory word but are not an inventory index.
const NOT_AN_INDEX = [
  "inventory-management", "inventory-financing", "sell-your", "trade-in",
  "value-your", "careers", "about", "contact", "blog", "news", "service",
  "parts", "finance-application", "credit-application", "privacy", "terms",
];

const isHttp = (u) => /^https?:$/i.test(u.protocol);

/**
 * Inventory-index candidates from one page's own links, best first.
 *
 * `html` is the fetched page, `origin` the site it came from. Returns absolute
 * URLs on the SAME host — a link to a marketplace is somebody else's listing
 * page and must never be crawled as this dealer's stock.
 */
export function discoverInventoryPages(html, origin) {
  let base;
  try { base = new URL(origin); } catch { return []; }
  const scored = new Map();

  for (const m of String(html || "").matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    let u;
    try { u = new URL(m[1].replace(/&amp;/g, "&"), base); } catch { continue; }
    if (!isHttp(u)) continue;
    // Same host only. originVariants handles www/non-www upstream; here a
    // different host is a different business.
    if (u.hostname.replace(/^www\./, "") !== base.hostname.replace(/^www\./, "")) continue;

    const path = u.pathname.toLowerCase();
    if (path === "/" || path.length > 120) continue;
    if (NOT_AN_INDEX.some((bad) => path.includes(bad))) continue;

    const hit = INDEX_HINTS.find((h) => path.includes(h));
    if (!hit) continue;

    // A page carrying a query string is usually a FILTERED view of the index
    // (?type=ATV). The unfiltered index is the better crawl target, so it wins,
    // but a filtered one is kept as a fallback when nothing else is found.
    let score = 100 - hit.length;                 // longer, more specific hint first
    if (u.search) score += 50;
    // /inventory/2019-honda-civic-abc123 is a VEHICLE, not an index. Deep paths
    // with digits are detail pages.
    if (/\/\d{4}-/.test(path) || /[a-z]\d{5,}/.test(path)) score += 200;
    const depth = path.split("/").filter(Boolean).length;
    score += depth * 5;

    const href = u.origin + u.pathname + u.search;
    if (!scored.has(href) || scored.get(href) > score) scored.set(href, score);
  }

  return [...scored.entries()].sort((a, b) => a[1] - b[1]).map(([href]) => href);
}

/**
 * Inventory-index candidates from a sitemap.
 *
 * Some dealers link inventory only from a menu their homepage renders in JS,
 * and harvesthillsauto.ca is one: no inventory link in the HTML, sitemap.xml
 * answers 200. The sitemap is the site's own statement of what it contains.
 */
export function discoverFromSitemap(xml, origin) {
  let base;
  try { base = new URL(origin); } catch { return []; }
  const out = new Map();
  for (const m of String(xml || "").matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    let u;
    try { u = new URL(m[1]); } catch { continue; }
    if (!isHttp(u)) continue;
    if (u.hostname.replace(/^www\./, "") !== base.hostname.replace(/^www\./, "")) continue;
    const path = u.pathname.toLowerCase();
    if (NOT_AN_INDEX.some((bad) => path.includes(bad))) continue;
    const hit = INDEX_HINTS.find((h) => path.includes(h));
    if (!hit) continue;
    let score = 100 - hit.length;
    if (/\/\d{4}-/.test(path) || /[a-z]\d{5,}/.test(path)) score += 200;
    score += path.split("/").filter(Boolean).length * 5;
    const href = u.origin + u.pathname;
    if (!out.has(href) || out.get(href) > score) out.set(href, score);
  }
  return [...out.entries()].sort((a, b) => a[1] - b[1]).map(([href]) => href);
}

/** Is this a sitemap INDEX (a sitemap of sitemaps) rather than a page list? */
export function sitemapIndexEntries(xml, origin) {
  if (!/<sitemapindex/i.test(String(xml || ""))) return [];
  let base;
  try { base = new URL(origin); } catch { return []; }
  const out = [];
  for (const m of String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    let u;
    try { u = new URL(m[1]); } catch { continue; }
    if (isHttp(u) && u.hostname.replace(/^www\./, "") === base.hostname.replace(/^www\./, "")) out.push(u.href);
  }
  return out;
}

// WHICH PLATFORM IS THIS SITE ON, from markers its own homepage carries.
// Recorded on a miss, never acted on: on 2026-09-11, 1,154 of 1,639 Alberta
// dealer sites answered on a platform no detector recognised, so which adapter
// to build next was a guess. This turns it into a count. First match wins, so
// the specific vendors sit above the generic CMS markers.
const PLATFORM_MARKERS = [
  ["d2c_media", /d2cmedia/i],
  ["dealer_com", /static\.dealer\.com|pictures\.dealer\.com|ddc-[a-z]+\.js/i],
  ["dealer_inspire", /dealerinspire/i],
  ["dealeron", /dealeron\.com|dealeron-/i],
  ["edealer", /edealer/i],
  ["sm360", /sm360/i],
  ["strathcom", /strathcom/i],
  ["leadbox", /leadbox/i],
  ["motoinsight", /motoinsight/i],
  ["autoverify", /autoverify/i],
  ["foxdealer", /foxdealer/i],
  ["dealer_eprocess", /dealereprocess/i],
  ["dealersocket", /dealersocket|dealerfire/i],
  ["cdk", /cdkglobal|cobalt\.com|cdkdealer/i],
  ["sincro", /sincro/i],
  ["carsforsale", /carsforsale/i],
  ["wordpress", /wp-content\//i],
];
export function platformHint(html) {
  const s = String(html || "");
  if (!s) return null;
  for (const [name, re] of PLATFORM_MARKERS) if (re.test(s)) return name;
  return "unknown";
}
