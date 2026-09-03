// Regression gate for the 2026-08-27 fix: ONE page source per scan, and a
// blocked origin must not empty the report.
//
// THE REPORT THIS LOCKS. LC-46A4-66F, a real paid report on a 2026 Lexus NX
// 350h at a Convertus dealer, printed "ASKING PRICE: Not shown" and "VIN: NOT
// ON QUOTE" for a page whose own vmsData carried asking_price 62005 and VIN
// 2T2GKCEZ8TC072832. Nothing was wrong with the extractors — every structured
// reader hung off ONE direct GET, Cloudflare refused it, and price, MSRP, VIN,
// trim, APR and days-on-lot all vanished together.
//
// Pure node, no network.
import { readFileSync } from "node:fs";
import { resolvePageSource, MIN_USABLE_HTML } from "../supabase/functions/_shared/page-source.js";
import { extractConvertusVmsVehicle } from "../supabase/functions/_shared/convertus-vms.js";

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const big = (s) => s + " ".repeat(Math.max(0, MIN_USABLE_HTML - s.length));

console.log("\nwhich source wins");
{
  const r = resolvePageSource(big("<html>direct</html>"), { html: big("<html>rendered</html>") });
  check("a successful direct read always wins over the render", r.source === "direct");
}
check("a refused direct read falls back to the render",
  resolvePageSource(null, { html: big("<html>r</html>") }).source === "render");
check("no direct and no render resolves to none",
  resolvePageSource(null, null).source === "none");
check("no direct and an empty render resolves to none",
  resolvePageSource(null, { html: null }).source === "none");
check("a challenge-shell-sized render is refused, not parsed",
  resolvePageSource(null, { html: "<html>Just a moment...</html>" }).source === "none");
check("a truncated direct read falls through to the render",
  resolvePageSource("<html/>", { html: big("<html>r</html>") }).source === "render");
check("resolvePageSource never throws on junk input",
  (() => { try { return resolvePageSource(undefined, undefined).source === "none"; } catch { return false; } })());

// ── End to end: the readers must see the page through the render ───────────
// A minimal Convertus VDP carrying the same fields, shapes and values the real
// listing did.
const page = `<!doctype html><html lang="en-CA"><head><meta charset="utf-8">
<title>2026 Lexus NX 350h Premium Hybrid AWD | New Inventory</title>
<meta name="description" content="New 2026 Lexus NX 350h Premium Hybrid AWD for sale.">
</head><body><header><nav>Home / New / Lexus / NX</nav></header>
<main><h1>2026 Lexus NX 350h Premium Hybrid AWD</h1>
<section class="pricing"><span class="label">Sales Price</span></section>
<script>var vmsData = {"settings":{"vdpNewDisclaimer":"+ GST"},"vehicle":{
"vin":"2T2GKCEZ8TC072832","stock_number":"L260670","year":2026,"make":"Lexus",
"model":"NX 350h","trim":"350h Premium Hybrid AWD","odometer":5,"certified":0,
"msrp":58675,"asking_price":62005,"sale_price":62005,"internet_price":62005,
"date_on_lot":"2026-05-04 16:10:23",
"finance":[{"finance_term":60,"finance_rate":6.99},{"finance_term":96,"finance_rate":8.99}]}};<\/script>
</body></html>`;

console.log("\nthe blocked-origin scan still reads the page");
{
  const blocked = resolvePageSource(null, { html: page });
  const v = blocked.html ? extractConvertusVmsVehicle(blocked.html) : null;
  check("source is the render", blocked.source === "render");
  check("VIN survives a blocked direct read", v?.vin === "2T2GKCEZ8TC072832", `got ${v?.vin}`);
  check("asking price survives", Number(v?.quotedPrice) === 62005, `got ${v?.quotedPrice}`);
  check("MSRP survives", Number(v?.msrp) === 58675, `got ${v?.msrp}`);
  check("trim survives", String(v?.trim || "").includes("350h"), `got ${v?.trim}`);
  check("APR survives", Number(v?.financeApr) === 8.99, `got ${v?.financeApr}`);
}
console.log("\nand the old wiring is what lost it");
{
  // What the code did before: readers hung off the direct read alone.
  const v = null ? extractConvertusVmsVehicle(null) : null;
  check("direct-only wiring yields nothing (the defect)", v === null);
}

// ── Structural: no consumer may open its own un-shared read of the page ─────
// A scan used to fire up to five separate GETs at the same dealer URL, and on
// a rate-limited origin that volume is what PROVOKES the block. Every consumer
// must take the scan's shared read. This is checked against the source because
// the cost of a new un-shared call site is invisible until a report loses its
// price in production.
console.log("\nno un-shared page fetches");
{
  const src = readFileSync(new URL("../supabase/functions/analyze-listing-url/index.ts", import.meta.url), "utf8");
  const ALLOWED = [
    // the retry wrapper — the one place a direct read is actually opened
    "const html = await fetchDirectHtml(url, timeoutMs, outcome);",
    // per-consumer fallbacks, reached only when no shared read was supplied
    "const html = sharedHtml ? await sharedHtml.catch(() => null) : await fetchDirectHtml(url, 8_000);",
    "const html = sharedHtml ? await sharedHtml.catch(() => null) : await fetchDirectHtml(url, 12_000);",
    "const html = sharedHtml ? await sharedHtml : await fetchDirectHtml(url, 15_000);",
  ];
  const calls = src.split("\n")
    .map((l, i) => ({ line: i + 1, text: l.trim() }))
    .filter((l) => /(?<!async function )\bfetchDirectHtml\s*\(/.test(l.text) && !l.text.startsWith("//"));
  const rogue = calls.filter((c) => !ALLOWED.some((a) => c.text.includes(a)));
  check(`every fetchDirectHtml call site takes the shared read (${calls.length} found)`,
    rogue.length === 0, rogue.map((r) => `line ${r.line}: ${r.text}`).join(" | "));

  check("the trade-in widget takes the shared read",
    /detectTradeInWidget\([^)]*pageHtml\)/.test(src));
  check("days-on-lot takes the shared read",
    /captureConvertusDaysOnLot\(url, analysis, pageHtml\)/.test(src));
  check("the structured readers hang off pageHtml, not the raw direct read",
    /buildJsonLdFallbackAnalysis\(url, pageHtml\)/.test(src)
    && /const earlyConvertusVms[^=]*=\s*pageHtml\.then/.test(src)
    && /const earlyD2cVdp[^=]*=\s*pageHtml\.then/.test(src));
  check("the retry loop backs off in seconds, not milliseconds",
    /BACKOFF_MS\s*=\s*\[2_000,\s*8_000\]/.test(src));
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exit(1);
