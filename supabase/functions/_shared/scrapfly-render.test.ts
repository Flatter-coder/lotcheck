// The render budget, pinned.
//
// stampedetoyotacalgary.com failed for Vic on 2026-08-16 with
// "scrapflyRender error: Signal timed out." The render asked for render_js +
// auto_scroll + a FULLPAGE screenshot in one call, and on a long dealer page
// that combination overran the budget.
//
// The screenshot was never the valuable part. The rendered HTML is: it carries
// the schema.org JSON-LD and the Convertus vmsData blob that every fallback
// reads. So the run spent its whole budget building an artifact the size guard
// would have discarded anyway, and lost the HTML with it.
//
// Run: node --experimental-strip-types supabase/functions/_shared/scrapfly-render.test.ts

(globalThis as any).Deno = { env: { get: (k: string) => (k === "SCRAPFLY_API_KEY" ? "test-key" : undefined) } };
import { readFileSync } from "node:fs";
const { scrapflyRender } = await import("./scrapfly.ts");

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, detail?: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "\n        " + (detail ?? "")}`);
  cond ? pass++ : fail++;
};

type Call = { shot: string; autoScroll: string; wait: string | null; format: string; timeout: string | null };

/** Stub Scrapfly. `behave(n)` decides what the n-th attempt does. */
function stub(behave: (n: number) => "timeout" | { html?: string | null; shotBytes?: number }) {
  const calls: (Call & { format?: string })[] = [];
  (globalThis as any).fetch = async (u: unknown) => {
    const url = String(u);
    if (url.includes("api.scrapfly.io")) {
      const q = new URL(url).searchParams;
      calls.push({ shot: q.get("screenshots[main]") ?? "none", autoScroll: q.get("auto_scroll") ?? "off", wait: q.get("rendering_wait"), format: q.get("format") ?? "(unset)", timeout: q.get("timeout") });
      const r = behave(calls.length);
      if (r === "timeout") throw new Error("Signal timed out.");
      return { ok: true, status: 200, json: async () => ({ result: { content: r.html ?? null, screenshots: r.shotBytes ? { main: { url: "https://shot.invalid/x" } } : undefined } }) };
    }
    // screenshot byte fetch
    const r = behave(calls.length) as any;
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(r.shotBytes || 10).buffer, headers: { get: () => "image/jpeg" } };
  };
  return calls;
}

// ---------------------------------------------------------------------------
// 1. The common path is still ONE call — and never asks for fullpage.
// ---------------------------------------------------------------------------
{
  // A real dealer page is 700 KB-1 MB. The wall guard treats anything under
  // 2,000 chars as a bot-wall shell (Nimble refuses a 74-char one the same
  // way), so the stub has to look like a page, not a token.
  const calls = stub(() => ({ html: '<html><body><script type="application/ld+json">{"@type":"Car"}</script>ok</body></html>'.padEnd(2_500, " ") }));
  const out = await scrapflyRender("https://example.com/vdp", 30_000);
  check("a successful render is a single call", calls.length === 1, JSON.stringify(calls));
  // 2026-09-02 (lexusofroyaloak.com): the first attempt is now HTML-ONLY. The
  // rendered HTML is the valuable part -- JSON-LD, vmsData, __vdpJSON -- and it
  // is the cheapest thing Scrapfly returns. The viewport shot is the retry.
  check("THE FIX: the first call is HTML-only -- no screenshot at all",
    calls[0].shot === "none",
    `asked for "${calls[0].shot}" — a screenshot-first attempt burned a whole 70s budget on a Cloudflare-walled EDealer page whose static HTML held the vehicle`);
  check("...and no auto_scroll, which is what makes a long page slow",
    calls[0].autoScroll === "off", JSON.stringify(calls[0]));
  check("never fullpage, on any attempt",
    calls.every((c) => c.shot !== "fullpage"),
    "a fullpage capture of a 17,729px page is past the vision ceiling by construction (2026-08-16)");
  check("Scrapfly's own timeout rides with the request, inside our budget",
    Number(calls[0].timeout) > 0 && Number(calls[0].timeout) < 30_000,
    `timeout=${calls[0].timeout} on a 30s budget — without it Scrapfly keeps rendering, and billing, after our AbortSignal fires`);
  check("the HTML comes back", !!out?.html, JSON.stringify(out));
}

// ---------------------------------------------------------------------------
// 2. THE STAMPEDE CASE: attempt 1 times out, and we still get the HTML.
// ---------------------------------------------------------------------------
{
  const calls = stub((n) => (n === 1 ? "timeout" : { html: '<script type="application/ld+json">{"@type":"Car"}</script>'.padEnd(2_500, " "), shotBytes: 4_000 }));
  const out = await scrapflyRender("https://example.com/vdp", 30_000);
  check("THE BUG: a timeout no longer loses the whole render",
    !!out?.html, "attempt 1 timed out and the viewport retry recovered it");
  check("the retry is the viewport shot",
    calls[1]?.shot === "viewport", JSON.stringify(calls[1]));
  check("...with auto_scroll, since the cheap path already failed",
    calls[1]?.autoScroll === "true", JSON.stringify(calls[1]));
  check("...and a longer JS wait than the cheap attempt",
    Number(calls[1]?.wait) > Number(calls[0]?.wait), `${calls[0]?.wait} -> ${calls[1]?.wait}`);
  check("the HTML-only slice is bounded, so a hang there cannot eat the whole budget",
    Number(calls[0]?.timeout) <= 25_000, `first-attempt timeout=${calls[0]?.timeout}`);
}

// ---------------------------------------------------------------------------
// 2b. THE LEXUS CASE: a bot-wall answers the HTML-only attempt with a shell.
//     That is a 200 with content, and it is NOT the page. It must fall through
//     to the screenshot attempt, not be returned as a "render".
// ---------------------------------------------------------------------------
{
  const calls = stub((n) => (n === 1
    ? { html: "<html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>" }
    : { html: '<script type="application/ld+json">{"@type":"Car","offers":{"price":69898}}</script>'.padEnd(2_500, " "), shotBytes: 4_000 }));
  const out = await scrapflyRender("https://example.com/vdp", 30_000);
  check("a Cloudflare shell is not accepted as the render",
    calls.length === 2, `${calls.length} call(s) — the wall was returned as if it were the listing`);
  check("...and the real page comes back from the screenshot attempt",
    !!out?.html && /69898/.test(out.html), JSON.stringify(out?.html?.slice(0, 80)));
}

// ---------------------------------------------------------------------------
// 3. The retry is bounded: it must not run when there is no budget for it.
// ---------------------------------------------------------------------------
{
  const calls = stub(() => "timeout");
  await scrapflyRender("https://example.com/vdp", 3_000);
  check("no budget left means no retry, rather than overrunning the caller",
    calls.length === 1, `${calls.length} attempts on a 3s budget`);
}

// ---------------------------------------------------------------------------
// 4. Both attempts failing still returns null, never throws.
// ---------------------------------------------------------------------------
{
  stub(() => "timeout");
  let threw = false;
  let out: unknown = "unset";
  try { out = await scrapflyRender("https://example.com/vdp", 30_000); } catch { threw = true; }
  check("a total failure is null, not an exception", !threw && out === null,
    "this runs inside a paid scan; it must degrade, never crash the request");
}

// ---------------------------------------------------------------------------
// 5. attachSealedScreenshot stamps sourceUrl/capturedAt BEFORE either early
//    return -- these ride inside the signed canonical (report-sign.ts
//    canonicalReport()'s `source` field), so a report must carry the real
//    fetched URL and a real timestamp for its signature to mean anything,
//    even when the screenshot itself is skipped or fails.
//
//    Regression for the 2026-08-20 incident: the server never stamped these
//    on the listing-URL scan path, so canonicalReport() signed `source: null`
//    for every report. The client then unconditionally overwrote
//    analysis.sourceUrl/capturedAt with its own url + Date.now() before
//    emailing (harmless before source was part of the signed canonical,
//    silently fatal after). email-quote-report recomputed a non-null
//    `source` against a signature made over `null` and rejected every
//    single listing-URL report with "This report can't be verified as one
//    of ours." Vic hit it live on the easytermauto.ca Bronco Sport listing.
// ---------------------------------------------------------------------------
{
  const { attachSealedScreenshot } = await import("./scrapfly.ts");
  const analysis: any = { listingShot: "data:image/jpeg;base64,alreadyset" };
  await attachSealedScreenshot("https://dealer.example/vdp/123", analysis);
  check("sourceUrl is stamped even when the screenshot step short-circuits (already has one)",
    analysis.sourceUrl === "https://dealer.example/vdp/123", JSON.stringify(analysis));
  check("capturedAt is stamped even when the screenshot step short-circuits",
    typeof analysis.capturedAt === "string" && analysis.capturedAt.length > 0, JSON.stringify(analysis));
}
{
  const { attachSealedScreenshot } = await import("./scrapfly.ts");
  const analysis: any = {
    listingShot: "data:image/jpeg;base64,x",
    sourceUrl: "https://already-set.example/x",
    capturedAt: "2020-01-01T00:00:00.000Z",
  };
  await attachSealedScreenshot("https://different-url.example/vdp", analysis);
  check("an existing sourceUrl is never clobbered (idempotent across the six finalize call sites)",
    analysis.sourceUrl === "https://already-set.example/x", analysis.sourceUrl);
  check("an existing capturedAt is never clobbered",
    analysis.capturedAt === "2020-01-01T00:00:00.000Z", analysis.capturedAt);
}
{
  const { attachSealedScreenshot } = await import("./scrapfly.ts");
  let threw = false;
  try { await attachSealedScreenshot("https://x.example", null); } catch { threw = true; }
  check("a null analysis does not throw", !threw);
}

// ---------------------------------------------------------------------------
// THE RENDER MUST ASK FOR HTML.
//
// `format` on Scrapfly's scrape api is the format of the PAGE CONTENT, not of
// the response envelope: raw | clean_html | json | markdown | text. We sent
// `json`, which asks Scrapfly to parse a dealer's HTML page AS JSON -- so
// result.content was never HTML on this path. Every structured reader we have
// looks inside <script> tags: extractJsonLdVehicle wants application/ld+json,
// the Convertus reader wants `vmsData =`, the D2C reader wants `__vdpJSON`.
// All three returned null on every page whose direct fetch was walled, which
// is ~28% of Alberta's dealer hosts.
//
// The trace that showed it: pageSrc=737194 jsonLdVeh=null convertus=null
// d2c=null. Three independent readers returning null on the same 737 KB is
// not three bugs; it is one input that is not what they were promised.
// ---------------------------------------------------------------------------
{
  const src = readFileSync(new URL("./scrapfly.ts", import.meta.url), "utf8");
  const scrape = src.slice(src.indexOf("https://api.scrapfly.io/scrape"), src.indexOf("https://api.scrapfly.io/screenshot"));
  check("the render asks Scrapfly for raw HTML, never a reformatted body",
    /searchParams\.set\("format", "raw"\)/.test(scrape) &&
    !/searchParams\.set\("format", "(json|markdown|text|clean_html)"\)/.test(scrape));
  check("the screenshot call still asks for an image format",
    /searchParams\.set\("format", "jpg"\)/.test(src));
}
console.log(`\n${pass}/${pass + fail} passed${fail ? `  — ${fail} FAILING` : "  ✓ all green"}`);
if (fail) (globalThis as any).process?.exit?.(1);
