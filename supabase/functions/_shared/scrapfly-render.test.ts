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
const { scrapflyRender } = await import("./scrapfly.ts");

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, detail?: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "\n        " + (detail ?? "")}`);
  cond ? pass++ : fail++;
};

type Call = { shot: string; autoScroll: string; wait: string | null };

/** Stub Scrapfly. `behave(n)` decides what the n-th attempt does. */
function stub(behave: (n: number) => "timeout" | { html?: string | null; shotBytes?: number }) {
  const calls: Call[] = [];
  (globalThis as any).fetch = async (u: unknown) => {
    const url = String(u);
    if (url.includes("api.scrapfly.io")) {
      const q = new URL(url).searchParams;
      calls.push({ shot: q.get("screenshots[main]") ?? "none", autoScroll: q.get("auto_scroll") ?? "off", wait: q.get("rendering_wait") });
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
  const calls = stub(() => ({ html: "<html><body>ok</body></html>" }));
  const out = await scrapflyRender("https://example.com/vdp", 30_000);
  check("a successful render is a single call", calls.length === 1, JSON.stringify(calls));
  check("THE FIX: it asks for a VIEWPORT shot, never fullpage",
    calls[0].shot === "viewport",
    `asked for "${calls[0].shot}" — a fullpage capture of a 17,729px page is past the vision ceiling by construction`);
  check("the HTML comes back", !!out?.html, JSON.stringify(out));
}

// ---------------------------------------------------------------------------
// 2. THE STAMPEDE CASE: attempt 1 times out, and we still get the HTML.
// ---------------------------------------------------------------------------
{
  const calls = stub((n) => (n === 1 ? "timeout" : { html: '<script type="application/ld+json">{"@type":"Car"}</script>' }));
  const out = await scrapflyRender("https://example.com/vdp", 30_000);
  check("THE BUG: a timeout no longer loses the whole render",
    !!out?.html, "attempt 1 timed out and the HTML-only retry recovered it");
  check("the retry drops the screenshot entirely",
    calls[1]?.shot === "none", JSON.stringify(calls[1]));
  check("...and drops auto_scroll, which is what makes a long page slow",
    calls[1]?.autoScroll === "off", JSON.stringify(calls[1]));
  check("...and shortens the JS wait",
    Number(calls[1]?.wait) < Number(calls[0]?.wait), `${calls[0]?.wait} -> ${calls[1]?.wait}`);
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

console.log(`\n${pass}/${pass + fail} passed${fail ? `  — ${fail} FAILING` : "  ✓ all green"}`);
if (fail) (globalThis as any).process?.exit?.(1);
