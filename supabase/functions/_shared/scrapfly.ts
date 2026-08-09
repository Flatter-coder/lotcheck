// ============================================================================
// Scrapfly web-unlocker RENDER → VISION rescue for protected dealer sites.
//
// When the normal Nimble path can't read a listing (JS-rendered + bot-protected
// -> blank page, no price), this renders the page with Scrapfly's anti-bot
// engine (residential IPs, real browser, JS + lazy-load) and reads the RESULT
// with Claude vision -- exactly the "render the page, then read what a human
// sees" flow. Reuses the caller's existing extraction SYSTEM_PROMPT/schema so
// the output is identical to the normal path.
//
// FAIL-SAFE + INERT: with no SCRAPFLY_API_KEY set, scrapflyRender() returns null
// and the whole rescue is a no-op -- the listing analyzer behaves exactly as it
// does today. Any error at any step returns null (never throws), so a rescue
// failure can only fall through to the existing unreadable-listing guardrail,
// never break a request. Nothing here is on the hot path until the key exists.
//
// NOTE: the exact Scrapfly query-param / response-field names below are per
// Scrapfly's documented API; they are VERIFIED against a live call in the
// Crowfoot test before this path is relied on (see the deploy/test step).
// ============================================================================

const SCRAPFLY_API_KEY = Deno.env.get("SCRAPFLY_API_KEY");
export function scrapflyEnabled(): boolean { return !!SCRAPFLY_API_KEY; }

export interface RenderResult {
  html: string | null;          // fully-rendered HTML (JS executed)
  screenshotB64: string | null; // full-page screenshot, base64
  screenshotMime: string;       // detected media type (Scrapfly returns JPEG)
}

function base64FromBytes(bytes: Uint8Array): string {
  let s = "";
  const CH = 0x8000; // chunk to avoid arg-count limits on fromCharCode
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}

// Render a URL through Scrapfly's anti-scraping-protection engine. Returns the
// rendered HTML and a full-page screenshot. null when disabled or on any error.
export async function scrapflyRender(url: string, budgetMs = 70_000): Promise<RenderResult | null> {
  if (!SCRAPFLY_API_KEY) return null;
  try {
    const u = new URL("https://api.scrapfly.io/scrape");
    u.searchParams.set("key", SCRAPFLY_API_KEY);
    u.searchParams.set("url", url);
    u.searchParams.set("asp", "true");            // Anti-Scraping-Protection (defeats bot walls)
    u.searchParams.set("render_js", "true");      // execute JS so dynamic price loads
    u.searchParams.set("country", "ca");          // Canadian residential IP
    u.searchParams.set("rendering_wait", "8000"); // give the price XHR time to land
    u.searchParams.set("auto_scroll", "true");    // trigger lazy-loaded sections
    u.searchParams.set("screenshots[main]", "fullpage");
    u.searchParams.set("format", "json");

    const res = await fetch(u.toString(), { signal: AbortSignal.timeout(budgetMs) });
    if (!res.ok) { console.warn("scrapflyRender HTTP", res.status); return null; }
    const j: any = await res.json();
    const html: string | null = j?.result?.content ?? null;

    // Screenshots come back as authenticated URLs; fetch the main one to bytes.
    let screenshotB64: string | null = null;
    let screenshotMime = "image/jpeg"; // Scrapfly default
    const shotUrl: string | undefined = j?.result?.screenshots?.main?.url;
    if (shotUrl) {
      try {
        const sep = shotUrl.includes("?") ? "&" : "?";
        const sr = await fetch(`${shotUrl}${sep}key=${SCRAPFLY_API_KEY}`, { signal: AbortSignal.timeout(20_000) });
        if (sr.ok) {
          const bytes = new Uint8Array(await sr.arrayBuffer());
          screenshotB64 = base64FromBytes(bytes);
          // Detect from magic bytes so the vision call always sends the right media type.
          screenshotMime = (bytes[0] === 0x89 && bytes[1] === 0x50) ? "image/png" : (bytes[0] === 0xFF && bytes[1] === 0xD8) ? "image/jpeg" : (sr.headers.get("content-type") || "image/jpeg");
        }
      } catch (e) { console.warn("scrapfly screenshot fetch failed:", (e as Error)?.message); }
    }
    if (!html && !screenshotB64) return null;
    return { html, screenshotB64, screenshotMime };
  } catch (e) {
    console.warn("scrapflyRender error:", (e as Error)?.message);
    return null;
  }
}

// Very small HTML -> text reducer (fallback input when there's no screenshot).
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 60_000);
}

// Pull the first JSON object out of a Claude response's text.
function firstJsonObject(text: string): any | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

export interface RescueOpts {
  systemPrompt: string;   // the caller's existing extraction SYSTEM_PROMPT (same schema)
  anthropicKey: string;
  model: string;
  budgetMs?: number;
}

// Full rescue: render with Scrapfly, then read the result with Claude vision
// (screenshot preferred; rendered-HTML text as fallback) using the SAME
// extraction prompt/schema as the normal path. Returns the parsed analysis
// object, or null if disabled / render failed / nothing extracted.
export async function rescueListingViaScrapfly(url: string, opts: RescueOpts): Promise<any | null> {
  if (!SCRAPFLY_API_KEY || !opts.anthropicKey) return null;
  try {
    const rendered = await scrapflyRender(url, opts.budgetMs ?? 70_000);
    if (!rendered) return null;

    const userContent: any[] = [];
    if (rendered.screenshotB64) {
      userContent.push({ type: "image", source: { type: "base64", media_type: rendered.screenshotMime || "image/jpeg", data: rendered.screenshotB64 } });
      userContent.push({ type: "text", text: `Above is a full-page screenshot of a dealer listing page (URL: ${url}). Read every visible figure — asking price, MSRP, fees/add-ons, VIN, odometer, financing/lease terms — and return the JSON object described in your instructions. If a field isn't visible, use null; never invent a number.` });
    } else if (rendered.html) {
      userContent.push({ type: "text", text: `Here is the rendered content of a dealer listing page (URL: ${url}):\n\n${htmlToText(rendered.html)}\n\nAnalyze this listing and return the JSON object described in your instructions.` });
    } else {
      return null;
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": opts.anthropicKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model: opts.model, max_tokens: 8000, system: opts.systemPrompt, messages: [{ role: "user", content: userContent }] }),
      signal: AbortSignal.timeout(opts.budgetMs ?? 60_000),
    });
    if (!res.ok) { console.warn("scrapfly-rescue Claude HTTP", res.status); return null; }
    const data: any = await res.json();
    const text: string = data?.content?.[0]?.text ?? "";
    const parsed = firstJsonObject(text);
    if (!parsed) return null;
    parsed.extractionMethod = "scrapfly_render_vision";
    // #14 listing-photo proof lock: keep the rendered screenshot ON the report
    // and seal its SHA-256 into the signed canonical (report-sign.ts reads
    // listingShotSha256). Proves what the page looked like at that moment --
    // the direct counter to "that screenshot could be fake". Size-capped so a
    // giant full-page render never bloats the response/cache; the HASH is
    // computed over exactly the bytes we attach.
    try {
      if (rendered.screenshotB64 && rendered.screenshotB64.length < 1_500_000) {
        const bin = atob(rendered.screenshotB64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const dig = await crypto.subtle.digest("SHA-256", bytes);
        parsed.listingShot = `data:${rendered.screenshotMime || "image/jpeg"};base64,${rendered.screenshotB64}`;
        parsed.listingShotSha256 = Array.from(new Uint8Array(dig)).map((b) => b.toString(16).padStart(2, "0")).join("");
        parsed.listingShotAt = new Date().toISOString();
      }
    } catch { /* photo lock is best-effort -- never sink the rescue */ }
    return parsed;
  } catch (e) {
    console.warn("rescueListingViaScrapfly error:", (e as Error)?.message);
    return null;
  }
}

// Merge rescued fields into the existing analysis WITHOUT clobbering good data:
// only fill blanks, but always prefer a real rescued price/MSRP over null.
export function mergeRescued(analysis: any, rescued: any): void {
  if (!analysis || !rescued) return;
  const preferKeys = ["quotedPrice", "msrp"];
  for (const k of preferKeys) {
    if ((analysis[k] == null || Number(analysis[k]) <= 0) && Number(rescued[k]) > 0) analysis[k] = rescued[k];
  }
  const fillKeys = ["trim", "vin", "odometerKm", "vehicleCondition", "fuelType", "dealerName", "dealerCity", "vehicle", "year", "make", "model", "financing", "summary", "listingShot", "listingShotSha256", "listingShotAt"];
  for (const k of fillKeys) {
    if ((analysis[k] == null || analysis[k] === "") && rescued[k] != null && rescued[k] !== "") analysis[k] = rescued[k];
  }
  // Add-ons: take the rescued list only if we had none.
  if ((!Array.isArray(analysis.addOns) || analysis.addOns.length === 0) && Array.isArray(rescued.addOns) && rescued.addOns.length) {
    analysis.addOns = rescued.addOns;
  }
  analysis.extractionMethod = rescued.extractionMethod || "scrapfly_render_vision";
}
