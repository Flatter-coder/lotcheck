// GATE: find the dealer's inventory page by reading the dealer's links.
//
// THE MEASUREMENT THIS EXISTS TO PROTECT (2026-09-22). A 400-host probe of the
// AMVIC roster found FIVE usable feeds. 273 hosts answered 200 with a real page
// and reported "no feed", and the traces showed every guessed path 404ing while
// the homepage served hundreds of KB of working site. We were not failing to
// recognise platforms; we were failing to find the inventory page at all.
//
// On 24 real hosts from that miss list, discoverCategoryPages() found an index
// on ZERO and link discovery found one on NINE — Wheaton Honda, McDonald
// Nissan, Stadium Nissan, CarZone Calgary, Silver Zinc Motors, Unique MV, Just
// Auto Sales, Adrenalin Motors, Wrenches Automotive.
//
// The fixtures below are the real URL shapes from that run.
import { discoverInventoryPages, discoverFromSitemap, sitemapIndexEntries, platformHint } from "./lib/inventory-discovery.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`ok    ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
};
const page = (...hrefs) => hrefs.map((h) => `<a href="${h}">link</a>`).join("\n");

// ---- the shapes the old regex could not see ------------------------------
const REAL = [
  ["/inventory-list/", "https://www.silverzincmotors.com"],
  ["/vehicles/", "https://www.carzonecalgary.com"],
  ["/new/inventory/search.html", "https://www.wheatonhonda.com"],
  ["/inventory/a8.html", "https://www.stadiumnissan.com"],
  ["/en/liquidation-inventory", "https://www.mcdonaldnissan.com"],
  ["/inventory", "https://justautosales.ca"],
  ["/inventory/", "https://uniquemv.com"],
];
for (const [path, origin] of REAL) {
  const found = discoverInventoryPages(page("/", "/about", path, "/contact"), origin);
  check(`finds ${path}`, found.some((u) => u.endsWith(path) || u.endsWith(path.replace(/\/$/, ""))), found.join(" "));
}

// ---- precision: what it must NOT hand a detector -------------------------
// A detector pointed at the wrong page catalogues a dealer against somebody
// else's stock, so recall is worth nothing without this half.
const noise = page(
  "/inventory-management-careers", "/sell-your-vehicle", "/trade-in-value",
  "/about-our-inventory-team", "/blog/how-we-price-inventory", "/service",
  "/parts", "/finance-application", "/privacy", "/contact",
);
check("ignores careers, trade-in and blog pages that mention inventory",
  discoverInventoryPages(noise, "https://example.ca").length === 0,
  discoverInventoryPages(noise, "https://example.ca").join(" "));

check("never leaves the host",
  discoverInventoryPages(page("https://www.autotrader.ca/inventory/", "https://example.ca/inventory/"), "https://example.ca")
    .every((u) => u.startsWith("https://example.ca")));
check("ignores tel: and javascript: links",
  discoverInventoryPages(page("tel:4035551212", "javascript:void(0)"), "https://example.ca").length === 0);
check("a page with no links yields nothing", discoverInventoryPages("", "https://example.ca").length === 0);
check("a broken origin yields nothing rather than throwing",
  discoverInventoryPages(page("/inventory/"), "not a url").length === 0);

// A path that is neither an inventory word NOR on the exclusion list must
// still be ignored. Without this the hint list is never load-bearing: every
// fixture above is already blocked by NOT_AN_INDEX, so replacing the lookup
// with a constant passed the whole suite.
const ordinary = page("/our-team", "/hours", "/directions", "/financing-options", "/warranty", "/reviews");
check("an ordinary page with no inventory word is ignored",
  discoverInventoryPages(ordinary, "https://example.ca").length === 0,
  discoverInventoryPages(ordinary, "https://example.ca").join(" "));

// ---- ranking: an index beats a vehicle, and unfiltered beats filtered -----
const mixed = discoverInventoryPages(
  page("/inventory/2019-honda-civic-ex-abc12345", "/inventory/?type=ATV", "/inventory/"),
  "https://example.ca");
check("the plain index ranks first", mixed[0] === "https://example.ca/inventory/", mixed.join(" "));
check("a vehicle detail page ranks below the index",
  mixed.indexOf("https://example.ca/inventory/") < mixed.findIndex((u) => u.includes("2019-honda-civic")),
  mixed.join(" "));
// AT EQUAL DEPTH the year/stock-number rule is the only thing separating an
// index from a vehicle. Without this case, path depth alone ordered the
// fixture above and the rule could be deleted unnoticed.
const sameDepth = discoverInventoryPages(
  page("/inventory/2019-honda-civic-ex-abc12345", "/inventory/new/"), "https://example.ca");
check("at equal depth a vehicle still ranks below an index",
  sameDepth[0] === "https://example.ca/inventory/new/", sameDepth.join(" "));
check("a filtered view ranks below the unfiltered index",
  mixed.indexOf("https://example.ca/inventory/") < mixed.findIndex((u) => u.includes("type=ATV")),
  mixed.join(" "));
check("&amp; in an href is decoded", discoverInventoryPages(page("/inventory/?type=ATV&amp;cat=Quad"), "https://example.ca")
  .some((u) => u.includes("type=ATV&cat=Quad")));

// ---- sitemap fallback ----------------------------------------------------
// harvesthillsauto.ca links no inventory from its homepage and answers 200 on
// /sitemap.xml. The site's own statement of what it contains.
const sm = `<?xml version="1.0"?><urlset>
  <url><loc>https://example.ca/</loc></url>
  <url><loc>https://example.ca/inventory/</loc></url>
  <url><loc>https://example.ca/about</loc></url>
  <url><loc>https://other.ca/inventory/</loc></url>
</urlset>`;
const smFound = discoverFromSitemap(sm, "https://example.ca");
check("sitemap yields the inventory page", smFound.includes("https://example.ca/inventory/"), smFound.join(" "));
check("sitemap stays on the host", smFound.every((u) => u.startsWith("https://example.ca")));
check("an empty sitemap yields nothing", discoverFromSitemap("", "https://example.ca").length === 0);

const smIndex = `<?xml version="1.0"?><sitemapindex>
  <sitemap><loc>https://example.ca/sitemap-inventory.xml</loc></sitemap>
  <sitemap><loc>https://example.ca/sitemap-pages.xml</loc></sitemap>
</sitemapindex>`;
check("a sitemap index is recognised", sitemapIndexEntries(smIndex, "https://example.ca").length === 2);
check("a plain urlset is not mistaken for an index", sitemapIndexEntries(sm, "https://example.ca").length === 0);

// ---- the gate must be able to fail --------------------------------------
// If the hint list were ever emptied this would find nothing forever and report
// clean. Assert it still recognises the single most common shape.
check("the hint list still recognises a bare /inventory/",
  discoverInventoryPages(page("/inventory/"), "https://example.ca").length === 1);

// Platform fingerprint (2026-09-25): a count of which platform the unreadable
// sites run, so the next adapter goes where most dealers are.
check("a D2C Media site is named, even beside WordPress markers",
  platformHint('<script src="https://cdn.d2cmedia.ca/x.js"></script><link href="/wp-content/a.css">') === "d2c_media");
check("a Dealer.com site is named", platformHint('<img src="https://pictures.dealer.com/a.jpg">') === "dealer_com");
check("a page with no known marker is 'unknown', never a guess", platformHint("<html><body>Welcome</body></html>") === "unknown");
check("no page, no hint", platformHint("") === null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
