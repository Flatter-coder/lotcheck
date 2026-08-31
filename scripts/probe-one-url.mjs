// ============================================================================
// WHY CAN'T WE READ THIS PAGE? — fetch it exactly as a scan does, then ask
// every structured reader what it makes of the result.
//
// WHY THIS EXISTS. The Advantage Ford link failed four times and collected four
// theories, because the only evidence available was a screenshot of the error
// card. The breadcrumb reader closed half of that: it says WHICH layer died.
// This closes the other half — it says what the layers actually returned, on a
// page anyone can name, without spending a buyer's credit or a paid report.
//
// The failure it was written for read:
//
//     direct read : fail                  (Cloudflare walled the plain GET)
//     ASP render  : html:738421,shot:0    (Scrapfly returned 738 KB of page)
//     nimble      : 200 but content too short (markdown.length=74)
//
// We were HOLDING the page and still told the buyer we could not read it. That
// is a reader problem, and a reader problem is reproducible — but only against
// the bytes Scrapfly actually returns, which are neither the raw HTML (962 KB
// on this page) nor a browser's DOM (1.83 MB). Both of those parse fine. This
// fetches the third thing.
//
// COST: one Scrapfly ASP scrape per run (~80 credits, a few cents). It is the
// cheapest possible answer to a question that has cost four round-trips.
//
// Run (Node 24+, from repo root; needs SCRAPFLY_API_KEY):
//   node scripts/probe-one-url.mjs "https://www.advantageford.ca/inventory/..."
//   node scripts/probe-one-url.mjs "<url>" --dump /tmp/page.html
// ============================================================================

import { extractJsonLdVehicle, jsonLdVehicles } from "../supabase/functions/_shared/jsonld-vehicle.js";
import { extractConvertusVmsVehicle } from "../supabase/functions/_shared/convertus-vms.js";
import { extractD2cVdpVehicle } from "../supabase/functions/_shared/d2c-vdp.js";
import { detectPlatform, catalogKey } from "../supabase/functions/_shared/dealer-catalog.ts";
import { distinctValidVins } from "../supabase/functions/_shared/multi-vehicle.ts";

const url = process.argv[2];
if (!url || !/^https?:\/\//.test(url)) {
  console.error('Usage: node scripts/probe-one-url.mjs "<listing url>" [--dump <file>]');
  process.exit(1);
}
const DUMP = (() => { const i = process.argv.indexOf("--dump"); return i > -1 ? process.argv[i + 1] : null; })();
const KEY = (process.env.SCRAPFLY_API_KEY || "").trim();
if (!KEY) { console.error("Needs SCRAPFLY_API_KEY."); process.exit(1); }

// The SAME parameters scrapflyRender sends. A probe that asks differently
// answers a different question than the one the scan asked.
const u = new URL("https://api.scrapfly.io/scrape");
u.searchParams.set("key", KEY);
u.searchParams.set("url", url);
u.searchParams.set("render_js", "true");
u.searchParams.set("asp", "true");
u.searchParams.set("country", "ca");
u.searchParams.set("rendering_wait", "8000");

console.log(`\nFetching through Scrapfly (render_js + asp + country=ca), exactly as a scan does...`);
const t0 = Date.now();
// Identifies itself, like every other job here. The gate that insists on this
// exists because anonymous Overpass requests drew 406/429 and silently lost 4
// of 5 weekly runs -- a request that is refused produces no red signal, it
// just quietly stops being true.
const UA = "LotCheckBot/1.0 (+https://lotcheck.ca/about; buyer-side vehicle price verification)";
const res = await fetch(u.toString(), { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(90_000) });
const body = await res.json().catch(() => null);
console.log(`  HTTP ${res.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s   cost ${res.headers.get("x-scrapfly-api-cost") ?? "?"} credits`);

const html = body?.result?.content ?? null;
if (typeof html !== "string" || !html) {
  console.error("\nScrapfly returned no content. Body:", JSON.stringify(body?.result?.status ?? body).slice(0, 400));
  process.exit(1);
}
console.log(`  content: ${html.length.toLocaleString()} chars`);
if (DUMP) { const { writeFileSync } = await import("node:fs"); writeFileSync(DUMP, html); console.log(`  dumped -> ${DUMP}`); }

// Everything below is pure and offline: the same readers the scan runs, on the
// same bytes. Each caught separately, because a reader that THROWS and a reader
// that declines are different facts and the scan currently records neither.
const ask = (name, fn) => {
  try {
    const v = fn();
    console.log(`  ${name.padEnd(22)} ${v ? "OK   " + JSON.stringify(v).slice(0, 150) : "null"}`);
  } catch (e) {
    console.log(`  ${name.padEnd(22)} THREW  ${String(e?.message).slice(0, 160)}`);
  }
};

console.log(`\nWhat the structured readers make of it:`);
ask("extractJsonLdVehicle", () => extractJsonLdVehicle(html));
ask("jsonLdVehicles", () => jsonLdVehicles(html, url));
ask("extractConvertusVms", () => extractConvertusVmsVehicle(html));
ask("extractD2cVdp", () => extractD2cVdpVehicle(html));
ask("detectPlatform", () => detectPlatform(html));

const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
let ok = 0, bad = 0;
for (const b of blocks) { try { JSON.parse(b[1].trim()); ok++; } catch { bad++; } }
console.log(`\nRaw signals in what Scrapfly returned:`);
console.log(`  ld+json blocks         ${blocks.length}  (parse ok ${ok}, malformed ${bad})`);
console.log(`  valid VINs             ${distinctValidVins(html).length}`);
console.log(`  __vdpJSON present      ${html.includes("__vdpJSON")}`);
console.log(`  vmsData present        ${/\bvmsData\s*=/.test(html)}`);
console.log(`  catalogue key          ${catalogKey(url)}`);

// The verdict, stated rather than left to be inferred from the lines above.
const v = (() => { try { return extractJsonLdVehicle(html); } catch { return null; } })();
console.log(`\nVerdict: ${v
  ? `this page IS readable — the JSON-LD fallback should have served ${v.year} ${v.make} ${v.model} at $${v.price}.`
  : "this page is NOT readable by the structured readers from what Scrapfly returns, which is the defect to fix."}`);
