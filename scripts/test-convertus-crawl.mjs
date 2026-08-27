// Regression suite for the convertus branch of the standing crawl.
// Run: node --experimental-strip-types scripts/test-convertus-crawl.mjs
//
// The convertus adapter was rewritten (2026-08-27) to read each dealer's OWN
// sitemap + per-VDP vmsData blob instead of the /wp-content ajax endpoint that
// robots.txt Disallows. This locks the two pure pieces of that path:
//   - vdpUrlsFromSitemap: pull real VDP URLs out of a sitemap, drop the listing
//   - normalizeConvertus: one VDP vehicle object -> one row, incl. the real
//     date_on_lot the VDP carries (and the old days_on_lot as a fallback)
// The VDP shape/values below are trimmed straight from a live page
// (denhamford.ca, a 2024 Ford Bronco Sport, captured 2026-08-27).

import { normalizeConvertus, vdpUrlsFromSitemap, discoverConvertusVdps, crawlConvertus, sameHost, sectionCondition, planSectionDelisting } from "./crawl-alberta-inventory.mjs";
import { parseRobots } from "./lib/robots.mjs";

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : detail}`); cond ? pass++ : fail++; };

// ---- vdpUrlsFromSitemap ----
const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://www.denhamford.ca/vehicles/used/</loc></url>
  <url><loc>https://www.denhamford.ca/vehicles/2024/ford/bronco-sport/wetaskiwin/ab/68178702/?sale_class=used</loc></url>
  <url><loc> https://www.denhamford.ca/vehicles/2022/ford/f-150/wetaskiwin/ab/990011/ </loc></url>
  <url><loc>https://www.denhamford.ca/about-us/</loc></url>
</urlset>`;
{
  const vdps = vdpUrlsFromSitemap(SITEMAP);
  check("keeps only real /vehicles/YYYY/ VDP URLs (drops listing + non-vehicle)", vdps.length === 2, ` got ${JSON.stringify(vdps)}`);
  check("excludes the /vehicles/used/ listing page", !vdps.some((u) => /\/vehicles\/used\/$/.test(u)));
  check("tolerates whitespace inside <loc>", vdps.some((u) => u === "https://www.denhamford.ca/vehicles/2022/ford/f-150/wetaskiwin/ab/990011/"));
  check("empty/garbage sitemap -> []", vdpUrlsFromSitemap("").length === 0 && vdpUrlsFromSitemap(null).length === 0);
}

// ---- normalizeConvertus: real VDP vehicle object (carries date_on_lot) ----
const VDP_VEHICLE = {
  vin: "3FMCR9B67RRE53467", stock_number: "5T168X", year: 2024, make: "Ford",
  model: "Bronco Sport", search_trim: "Big Bend", trim: "Big Bend 4x4, AWD, copilot 360 assist+",
  odometer: 26460, msrp: 0, asking_price: 32886, final_price: 32886, internet_price: 32886,
  sale_price: 32886, certified: 0, in_transit: 0, on_order: 0, date_on_lot: "2025-10-08 06:47:47",
};
{
  const r = normalizeConvertus(VDP_VEHICLE, "used");
  check("valid VDP -> a row (not null)", !!r, ` got ${JSON.stringify(r)}`);
  check("vin/stock/year/make/model carried through", r && r.vin === "3FMCR9B67RRE53467" && r.stock_no === "5T168X" && r.year === 2024 && r.make === "Ford" && r.model === "Bronco Sport");
  check("trim prefers the clean search_trim over the long marketing trim", r && r.trim === "Big Bend");
  check("odometer read", r && r.odometer_km === 26460);
  check("msrp 0 -> null (never a fabricated $0 sticker)", r && r.msrp === null);
  check("list/sale price from the consumer-facing fields", r && r.list_price === 32886 && r.sale_price === 32886);
  check("date_entry comes from the REAL date_on_lot", r && r.date_entry === "2025-10-08", ` got ${r && r.date_entry}`);
  check("days_in_inventory is a real positive day count", r && typeof r.days_in_inventory === "number" && r.days_in_inventory > 0);
  check("condition/status/flags", r && r.condition === "used" && r.status === "FOR_SALE" && r.certified === false && r.damaged === null);
}

// ---- a discounted unit: list_price is the sticker, sale_price the lower ask ----
{
  const r = normalizeConvertus({ ...VDP_VEHICLE, asking_price: 40000, final_price: 0, internet_price: 38000, sale_price: 0 }, "used");
  check("discount: list_price=asking (40000), sale_price=internet (38000)", r && r.list_price === 40000 && r.sale_price === 38000, ` got list ${r && r.list_price} sale ${r && r.sale_price}`);
}

// ---- price mirrors the byte-verified buyer path (Math.min of consumer fields) ----
{
  // sale_price carries the ONLY/lowest active promo; asking_price repeats the
  // MSRP sticker. The ask must be 47000 (not the 51422 sticker), the buyer
  // path's answer — the exact "stores the sticker as the ask" bug it was fixed for.
  const r = normalizeConvertus({ ...VDP_VEHICLE, asking_price: 51422, internet_price: 0, final_price: 0, sale_price: 47000 }, "used");
  check("sale_price promo wins: list=51422 sticker, sale=47000 ask (not the sticker)", r && r.list_price === 51422 && r.sale_price === 47000, ` got list ${r && r.list_price} sale ${r && r.sale_price}`);
  // internet_price lower than a stale final_price: min still wins, final ignored.
  const r2 = normalizeConvertus({ ...VDP_VEHICLE, asking_price: 51422, internet_price: 48922, final_price: 55000, sale_price: 0 }, "used");
  check("final_price is excluded; internet (48922) is the ask", r2 && r2.sale_price === 48922, ` got ${r2 && r2.sale_price}`);
}

// ---- backward compatibility: the OLD ajax shape (days_on_lot, no date_on_lot) ----
{
  const r = normalizeConvertus({ ...VDP_VEHICLE, date_on_lot: undefined, days_on_lot: 30 }, "used");
  check("no date_on_lot -> days_in_inventory falls back to days_on_lot (30)", r && r.days_in_inventory === 30, ` got ${r && r.days_in_inventory}`);
  check("no date_on_lot -> date_entry is derived (a valid date)", r && /^\d{4}-\d{2}-\d{2}$/.test(r.date_entry || ""));
}

// ---- date_on_lot WINS over days_on_lot when both are present ----
{
  const r = normalizeConvertus({ ...VDP_VEHICLE, days_on_lot: 5 }, "used");
  check("date_on_lot beats days_on_lot for date_entry", r && r.date_entry === "2025-10-08");
}

// ---- certified truthy variants + invalid VIN ----
{
  check("certified: 1 -> true", normalizeConvertus({ ...VDP_VEHICLE, certified: 1 }, "used").certified === true);
  check("invalid VIN -> null row (a row we can't key on is worse than none)", normalizeConvertus({ ...VDP_VEHICLE, vin: "NOTAVIN" }, "used") === null);
  check("garbage future/system date_on_lot -> ignored, not a claim", normalizeConvertus({ ...VDP_VEHICLE, date_on_lot: "3999-01-01 00:00:00", days_on_lot: null }, "used").date_entry === null);
}

// ---- flags decode strict values, not raw truthiness (string "0" is FALSE) ----
{
  check("in_transit \"0\" is NOT in-transit (string 0 must not flip a for-sale car)", normalizeConvertus({ ...VDP_VEHICLE, in_transit: "0", on_order: "0" }, "used").status === "FOR_SALE");
  check("in_transit \"1\" -> IN_TRANSIT", normalizeConvertus({ ...VDP_VEHICLE, in_transit: "1" }, "used").status === "IN_TRANSIT");
}

// ---- days_in_inventory is a clean calendar count, immune to entry time-of-day ----
{
  const a = normalizeConvertus({ ...VDP_VEHICLE, date_on_lot: "2025-10-08 00:00:01" }, "used").days_in_inventory;
  const b = normalizeConvertus({ ...VDP_VEHICLE, date_on_lot: "2025-10-08 23:59:59" }, "used").days_in_inventory;
  check("entry time-of-day does not change the day count (no intra-day over-count)", a === b && typeof a === "number" && a > 0, ` got ${a} vs ${b}`);
}

// ---- sameHost: only the dealer's own host is ever fetched ----
{
  check("sameHost: same host -> true", sameHost("https://d.ca/vehicles/2024/x/", "https://d.ca") === true);
  check("sameHost: different host -> false", sameHost("https://cdn.other.com/vehicles/2024/x/", "https://d.ca") === false);
  check("sameHost: relative/garbage -> false", sameHost("/vehicles/2024/x/", "https://d.ca") === false && sameHost("junk", "https://d.ca") === false);
}

// ---- DELISTING SAFETY: any gap in enumeration must make the crawl partial, so
// still-listed cars are never read as sold. Driven offline via an injected
// fetcher (delayMs:0). These lock the fixes for the adversarial review's
// confirmed high-severity findings. ----
const HOST = "https://d.ca";
const VINS = ["3FMCR9B67RRE53467", "3FMCR9D91RRE99075", "3FMCR9C6XRRE02852"]; // real, valid
const idxXml = (subs) => `<urlset>${subs.map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`;
const smXml = (urls) => `<urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`;
const vdpHtml = (vin, over = {}) => `<html><script>var vmsData = ${JSON.stringify({ vehicle: { ...VDP_VEHICLE, vin, ...over } })};</script></html>`;
// a mock fetcher over a { url: body } map; urls in `boom` throw (fetch failure)
const mkFetcher = (map, boom = new Set()) => async (url) => {
  if (boom.has(url)) throw new Error("timeout");
  if (Object.prototype.hasOwnProperty.call(map, url)) return map[url];
  throw new Error(`404 ${url}`);
};
const ALLOW = parseRobots("", "lotcheckbot");           // allow-all
const NO_QUERY = parseRobots("User-agent: *\nDisallow: /*?", "lotcheckbot"); // blocks any ?query
const SM1 = `${HOST}/used-vehicle-1-sitemap.xml`, SM2 = `${HOST}/used-vehicle-2-sitemap.xml`;
const vdp = (i, q = "") => `${HOST}/vehicles/2024/ford/bronco-sport/wetaskiwin/ab/${1000 + i}/${q}`;
const opts = (map, boom) => ({ fetcher: mkFetcher(map, boom), delayMs: 0 });

// 1. Clean crawl: everything fetches -> all rows, NOT partial.
{
  const map = { [`${HOST}/sitemap.xml`]: idxXml([SM1]), [SM1]: smXml([vdp(0), vdp(1), vdp(2)]),
    [vdp(0)]: vdpHtml(VINS[0]), [vdp(1)]: vdpHtml(VINS[1]), [vdp(2)]: vdpHtml(VINS[2]) };
  const r = await crawlConvertus(HOST, "used", ALLOW, opts(map));
  check("clean crawl: 3 rows, partial=false (delisting allowed)", r.rows.length === 3 && r.partial === false, ` got ${r.rows.length} rows partial=${r.partial}`);
}

// 2. A sub-sitemap fetch fails -> partial (never delist the missing submap's cars).
{
  const map = { [`${HOST}/sitemap.xml`]: idxXml([SM1, SM2]), [SM1]: smXml([vdp(0), vdp(1)]),
    [vdp(0)]: vdpHtml(VINS[0]), [vdp(1)]: vdpHtml(VINS[1]) };
  const r = await crawlConvertus(HOST, "used", ALLOW, opts(map, new Set([SM2])));
  check("sub-sitemap fetch failure -> partial=true (no false delisting)", r.partial === true, ` got partial=${r.partial}`);
}

// 3. A robots-disallowed VDP is dropped -> partial (the confirmed query-VDP case).
{
  const map = { [`${HOST}/sitemap.xml`]: idxXml([SM1]), [SM1]: smXml([vdp(0), vdp(1, "?sale_class=used")]),
    [vdp(0)]: vdpHtml(VINS[0]) };
  const r = await crawlConvertus(HOST, "used", NO_QUERY, opts(map));
  check("robots-skipped VDP -> partial=true, and the skipped car is not crawled", r.partial === true && r.rows.length === 1, ` got partial=${r.partial} rows=${r.rows.length}`);
}

// 4. A VDP fetches 200 but won't parse (no vmsData) -> partial, row dropped.
{
  const map = { [`${HOST}/sitemap.xml`]: idxXml([SM1]), [SM1]: smXml([vdp(0), vdp(1)]),
    [vdp(0)]: vdpHtml(VINS[0]), [vdp(1)]: "<html>no vmsData here</html>" };
  const r = await crawlConvertus(HOST, "used", ALLOW, opts(map));
  check("unparseable VDP -> partial=true, 1 row (missing beats wrong)", r.partial === true && r.rows.length === 1, ` got partial=${r.partial} rows=${r.rows.length}`);
}

// 4b. A sub-sitemap fetches 200 but yields ZERO VDP URLs (gzip/WAF/truncation)
//     -> incomplete -> partial (its cars are never read as sold).
{
  const map = { [`${HOST}/sitemap.xml`]: idxXml([SM1, SM2]), [SM1]: smXml([vdp(0)]),
    [SM2]: "<html>WAF interstitial, no <loc> here</html>", [vdp(0)]: vdpHtml(VINS[0]) };
  const r = await crawlConvertus(HOST, "used", ALLOW, opts(map));
  check("sub-sitemap 200-but-empty -> partial=true (not read as complete)", r.partial === true && r.rows.length === 1, ` got partial=${r.partial} rows=${r.rows.length}`);
}

// 5. A cross-host VDP loc is never fetched -> dropped, partial.
{
  const CROSS = "https://cdn.evil.com/vehicles/2024/ford/x/ab/9/";
  const map = { [`${HOST}/sitemap.xml`]: idxXml([SM1]), [SM1]: smXml([vdp(0), CROSS]),
    [vdp(0)]: vdpHtml(VINS[0]), [CROSS]: vdpHtml(VINS[1]) };
  const r = await crawlConvertus(HOST, "used", ALLOW, opts(map));
  check("cross-host VDP dropped -> partial=true, only same-host row kept", r.partial === true && r.rows.length === 1 && r.rows[0].vin === VINS[0], ` got partial=${r.partial} rows=${r.rows.length}`);
}

// 6. No reachable sitemap index at all -> THROWS (section failure, no delisting).
{
  let threw = false;
  try { await discoverConvertusVdps(HOST, "used", ALLOW, opts({})); } catch { threw = true; }
  check("unreachable sitemap index -> throws (treated as section failure)", threw === true);
}

// 7. Index read but lists no vehicle sitemaps -> complete:true, empty (not a false failure).
{
  const map = { [`${HOST}/sitemap.xml`]: idxXml([`${HOST}/page-sitemap.xml`]) };
  const d = await discoverConvertusVdps(HOST, "used", ALLOW, opts(map));
  check("index with no vehicle sitemaps -> {vdps:[], complete:true}", d.vdps.length === 0 && d.complete === true);
  const r = await crawlConvertus(HOST, "used", ALLOW, opts(map));
  check("...and crawlConvertus reports partial (no cars seen, none delisted)", r.partial === true && r.rows.length === 0);
}

// ---- SECTION-SCOPED DELISTING (planSectionDelisting): a stale/partial one
// section must never delist another (cross-section masking, Finding B). ----
{
  check("sectionCondition maps section -> condition", sectionCondition("new-inventory") === "new" && sectionCondition("used-inventory") === "used" && sectionCondition("new") === "new" && sectionCondition("used") === "used");

  const both = planSectionDelisting(
    { new: { crawled: true, ok: true }, used: { crawled: true, ok: true } },
    { new: ["A"], used: ["B", "C"] }, true);
  check("clean dealer -> delist both, each scoped to its condition", both.length === 2 && both.find((p) => p.condition === "new").count === 1 && both.find((p) => p.condition === "used").count === 2);

  // THE section != condition safety: if ANY section is unhealthy the dealer is
  // not clean, so we delist NOTHING — a used-sourced 'new'-tagged car can't be
  // wrongly delisted just because the used section failed while new succeeded.
  check("any unhealthy section (dealerClean=false) -> delist NOTHING",
    planSectionDelisting({ new: { crawled: true, ok: true }, used: { crawled: true, ok: false } }, { new: ["A"], used: ["B"] }, false).length === 0);

  // Finding B on a CLEAN dealer: both conditions are still delisted per-condition;
  // the silent one-condition collapse is caught by the SQL >50% guard, not here.
  check("clean dealer with both conditions -> both planned, scoped per condition",
    planSectionDelisting({ new: { crawled: true, ok: true }, used: { crawled: true, ok: true } }, { new: ["A"], used: ["B", "C", "D"] }, true).length === 2);

  check("a condition crawled but with 0 VINs seen is not delisted (0-result is suspect)",
    planSectionDelisting({ new: { crawled: true, ok: true } }, { new: [], used: [] }, true).length === 0);
  check("a condition never crawled is left untouched",
    planSectionDelisting({ new: { crawled: false, ok: true }, used: { crawled: true, ok: true } }, { new: ["X"], used: ["B"] }, true).every((p) => p.condition !== "new"));

  // Two sections mapping to the same condition (used + certified) must not
  // double-count a VIN — an inflated saw-count would defeat the SQL >50% guard.
  const dup = planSectionDelisting({ used: { crawled: true, ok: true } }, { used: ["V1", "V2", "V1", "V2"], new: [] }, true);
  check("same-condition duplicate VINs are deduped in the saw-count", dup.length === 1 && dup[0].count === 2 && dup[0].vins.length === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
