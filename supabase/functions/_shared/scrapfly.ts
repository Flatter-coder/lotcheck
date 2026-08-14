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

import { extractJsonLdVehicle, fillFromJsonLd } from "./jsonld-vehicle.js";
import { extractConvertusVmsVehicle, fillFromConvertusVms } from "./convertus-vms.js";

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

// WHY renders failed, readable by callers so the failure reason can ride
// into api_usage_log (edge console logs are only visible in the dashboard;
// a paid report shipping hollow deserves a queryable trace). APPENDED, not
// reset -- the first trace of this design reset it per-call, so a later
// render call that happened to return 200 wiped the earlier failure and the
// log said "sfErr=none" about a scan whose renders demonstrably died
// (albertahonda.com, 2026-08-14 05:19). Callers read the accumulated trail.
export let lastScrapflyError: string | null = null;
function noteScrapflyError(msg: string): void {
  lastScrapflyError = lastScrapflyError ? `${lastScrapflyError} ;; ${msg}` : msg;
}

// Render a URL through Scrapfly's anti-scraping-protection engine. Returns the
// rendered HTML and a full-page screenshot. null when disabled or on any error.
export async function scrapflyRender(url: string, budgetMs = 70_000): Promise<RenderResult | null> {
  if (!SCRAPFLY_API_KEY) return null;
  const renderDeadline = Date.now() + budgetMs;
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
    if (!res.ok) {
      noteScrapflyError(`render HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
      console.warn("scrapflyRender", lastScrapflyError);
      return null;
    }
    const j: any = await res.json();
    const html: string | null = j?.result?.content ?? null;
    if (!html) noteScrapflyError(`render 200 but no content (success=${j?.result?.success}, status=${j?.result?.status_code}, reason=${String(j?.result?.reason ?? "").slice(0, 80)})`);

    // Screenshots come back as authenticated URLs; fetch the main one to bytes.
    let screenshotB64: string | null = null;
    let screenshotMime = "image/jpeg"; // Scrapfly default
    const shotUrl: string | undefined = j?.result?.screenshots?.main?.url;
    if (shotUrl) {
      try {
        const sep = shotUrl.includes("?") ? "&" : "?";
        // Bounded by what's left of the caller's budgetMs, not a flat 20s on
        // top of it -- a hardcoded extra timeout here is the same class of
        // bug as the render/Claude-call doubling above: the caller computed
        // budgetMs from their own deadline expecting THIS to be the total
        // time this function takes, not total-plus-20s. Same minimum-1s
        // floor so a render that used the whole budget still gets a real
        // (if short) attempt instead of an instant abort.
        const shotBudget = Math.max(1_000, Math.min(20_000, renderDeadline - Date.now()));
        const sr = await fetch(`${shotUrl}${sep}key=${SCRAPFLY_API_KEY}`, { signal: AbortSignal.timeout(shotBudget) });
        if (sr.ok) {
          const bytes = new Uint8Array(await sr.arrayBuffer());
          screenshotB64 = base64FromBytes(bytes);
          // Detect from magic bytes so the vision call always sends the right media type.
          screenshotMime = (bytes[0] === 0x89 && bytes[1] === 0x50) ? "image/png" : (bytes[0] === 0xFF && bytes[1] === 0xD8) ? "image/jpeg" : (sr.headers.get("content-type") || "image/jpeg");
        }
      } catch (e) { console.warn("scrapfly screenshot fetch failed:", (e as Error)?.message); }
    }
    // Claude's vision API rejects images past its own size/dimension ceiling.
    // A "fullpage" capture of a long dealer page can run well past that --
    // confirmed live on capitalchev.ca, whose listing page is 17,729px tall.
    // That silently fails the vision call below (res.ok false -> null) and
    // loses the WHOLE rescue even though Scrapfly's render itself succeeded.
    // Same cutoff already proven safe for the sealed-evidence screenshot in
    // captureListingScreenshot() below. Drop the oversized shot here so the
    // caller falls back to the rendered HTML (text) path instead of a
    // guaranteed-failing vision call.
    if (screenshotB64 && screenshotB64.length > 1_500_000) {
      console.warn(`scrapflyRender: full-page screenshot too large (${screenshotB64.length} b64 chars) -- dropping, falling back to rendered HTML.`);
      screenshotB64 = null;
    }
    if (!html && !screenshotB64) return null;
    return { html, screenshotB64, screenshotMime };
  } catch (e) {
    noteScrapflyError(`render threw: ${String((e as Error)?.name)} ${String((e as Error)?.message).slice(0, 120)}`);
    console.warn("scrapflyRender error:", (e as Error)?.message);
    return null;
  }
}

// Per-scan sealed screenshot via Scrapfly's dedicated Screenshot API
// ($0.009 / 60 credits per shot on the Discovery plan) -- far cheaper than a
// full ASP scrape, used to put a hash-sealed "what the page looked like"
// photo on EVERY report (#14 on every scan, Vic-approved 2026-08-09).
// Returns { b64, mime } or null. Fail-safe: any error -> null, never throws.
export async function captureListingScreenshot(url: string, budgetMs = 25_000): Promise<{ b64: string; mime: string } | null> {
  if (!SCRAPFLY_API_KEY) return null;
  const started = Date.now();
  const shoot = async (fullpage: boolean, ms: number): Promise<{ b64: string; mime: string } | "too_large" | null> => {
    try {
      const u = new URL("https://api.scrapfly.io/screenshot");
      u.searchParams.set("key", SCRAPFLY_API_KEY);
      u.searchParams.set("url", url);
      u.searchParams.set("format", "jpg");
      if (fullpage) u.searchParams.set("capture", "fullpage");
      // 8s, not 3s: the page's own content paints well inside 3s, but dealer
      // vehicle PHOTOS come off a separate image CDN (autoscout24's picture
      // service on Convertus sites) that hadn't delivered yet -- Vic's
      // 2027 HR-V report (2026-08-14) sealed a perfect capture of every
      // figure with grey boxes where the car should be. Matches the 8s the
      // ASP render already uses for the same reason.
      u.searchParams.set("rendering_wait", "8000");
      u.searchParams.set("auto_scroll", "true");
      u.searchParams.set("country", "ca");
      const res = await fetch(u.toString(), { signal: AbortSignal.timeout(ms) });
      if (!res.ok) { console.warn("captureListingScreenshot HTTP", res.status); return null; }
      const ct = res.headers.get("content-type") || "";
      if (!/image\//i.test(ct)) { console.warn("captureListingScreenshot non-image response:", ct); return null; }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length < 5_000) return null; // too small to be a real page shot
      const b64 = base64FromBytes(bytes);
      if (b64.length > 1_500_000) { console.warn(`captureListingScreenshot ${fullpage ? "fullpage" : "viewport"} too large (${b64.length})`); return "too_large"; }
      const mime = /png/i.test(ct) ? "image/png" : "image/jpeg";
      return { b64, mime };
    } catch (e) {
      console.warn("captureListingScreenshot error:", (e as Error)?.message);
      return null;
    }
  };
  // Full page first (best evidence). Long dealer pages can blow the size cap
  // (Okotoks: 2.5MB) -- degrade to a viewport shot of the top of the listing
  // (price + vehicle visible, always small) instead of losing the photo
  // entirely. The pricing fine print is separately captured verbatim as text,
  // so the bottom-of-page evidence survives the degrade.
  const first = await shoot(true, budgetMs);
  if (first && first !== "too_large") return first;
  if (first === "too_large") {
    const left = budgetMs - (Date.now() - started);
    if (left > 4_000) {
      const second = await shoot(false, left);
      return second && second !== "too_large" ? second : null;
    }
  }
  return null;
}

// Attach a sealed screenshot to the analysis when it doesn't already carry one
// (the vision rescue may have provided it). Hash computed over exactly the
// attached bytes; MUST run before finalizeServerSide so the hash gets signed.
export async function attachSealedScreenshot(url: string, analysis: any, budgetMs = 25_000, pre?: Promise<{ b64: string; mime: string } | null>): Promise<void> {
  try {
    if (!analysis || analysis.listingShot || !SCRAPFLY_API_KEY) return;
    // A pre-started capture (kicked off at the top of the scan, running in
    // parallel with extraction) beats a fresh one started after the scan has
    // burned the request budget -- the late start was why shots kept missing.
    const shot = await (pre ?? captureListingScreenshot(url, budgetMs));
    if (!shot) return;
    const bin = atob(shot.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dig = await crypto.subtle.digest("SHA-256", bytes);
    analysis.listingShot = `data:${shot.mime};base64,${shot.b64}`;
    analysis.listingShotSha256 = Array.from(new Uint8Array(dig)).map((b) => b.toString(16).padStart(2, "0")).join("");
    analysis.listingShotAt = new Date().toISOString();
    console.log(`Sealed screenshot attached (${bytes.length} bytes, sha ${analysis.listingShotSha256.slice(0, 12)}).`);
  } catch { /* best-effort -- never sink the scan */ }
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
  // A render the caller started EARLY, in parallel with the main scan (the
  // moment its direct page fetch conclusively failed -- the strongest signal
  // this rescue will be needed). By the time the main path gets here it has
  // burned 60-110s of the request on Nimble+Claude, and the honest remaining
  // budget is often too short for a cold ASP render of a bot-protected page
  // (confirmed live 2026-08-14, albertahonda.com: rescue fired with the
  // correct bounded budget and the render just couldn't finish inside it, so
  // a paid report shipped with no price/VIN at all). A pre-warmed render is
  // already done or nearly done by then. Resolving null falls back to a
  // fresh render with whatever budget remains, same as before.
  preRendered?: Promise<RenderResult | null>;
  // The sealed-evidence screenshot ALREADY being captured at t=0 on every
  // scan (Scrapfly Screenshot API). Vic's screenshot-first directive
  // (2026-08-14): on albertahonda.com the /scrape ASP render kept failing
  // while THIS endpoint attached a clean full-page shot on every single one
  // of the same scans -- so when both renders fail, the rescue reads the
  // page the way a human does: vision on the screenshot we already hold.
  // The rescue must never again return empty while a good photo of the page
  // sits in the same request.
  fallbackShot?: Promise<{ b64: string; mime: string } | null>;
}

// Full rescue: render with Scrapfly, then read the result with Claude vision
// (screenshot preferred; rendered-HTML text as fallback) using the SAME
// extraction prompt/schema as the normal path. Returns the parsed analysis
// object, or null if disabled / render failed / nothing extracted.
export async function rescueListingViaScrapfly(url: string, opts: RescueOpts): Promise<any | null> {
  if (!SCRAPFLY_API_KEY || !opts.anthropicKey) return null;
  // opts.budgetMs is the caller's TOTAL time budget for this whole function,
  // computed from their own remaining REQUEST_DEADLINE -- but this function
  // used to hand that SAME full value to BOTH internal steps independently
  // (scrapflyRender, then the Claude call), so a "70s-budgeted" call could
  // actually take up to ~140s worst case. Confirmed live, 2026-08-14
  // (albertahonda.com Civic Sedan): that doubling, stacked on Nimble's own
  // 30s+, pushed the whole request past Supabase's 150s platform ceiling --
  // the function gets killed outright with no error response and no log
  // line, which is why the report showed a generic "something went wrong"
  // with nothing in api_usage_log to explain it. Now the render step gets
  // the caller's budget up front (it's the step most likely to need it --
  // ASP challenge-solving, JS execution, lazy-load waits) and the Claude
  // call gets only whatever's left, so the total is bounded by opts.budgetMs
  // the way every caller already assumes.
  const totalBudget = opts.budgetMs ?? 70_000;
  const deadline = Date.now() + totalBudget;
  try {
    // Prefer the caller's pre-warmed render; a fresh one only when there is
    // none or it failed (see RescueOpts.preRendered). The fresh-render
    // fallback uses the REMAINING budget, since awaiting a pending
    // pre-render may itself have consumed some.
    let rendered = opts.preRendered ? await opts.preRendered.catch(() => null) : null;
    // The fresh render RESERVES ~20s for the Claude read that follows it. It
    // used to get everything left, so on a slow ASP fight (albertahonda.com,
    // 2026-08-14 05:19 breadcrumbs) the render consumed the entire remaining
    // budget and the vision call aborted at its 1s floor -- a render we PAID
    // for, thrown away unread. A render capped 20s shorter still usually
    // finishes, and the vision step is the whole point of rendering.
    if (!rendered) rendered = await scrapflyRender(url, Math.max(5_000, deadline - Date.now() - 20_000));
    // Both renders dead -> screenshot-first (see RescueOpts.fallbackShot):
    // the sealed shot captured at t=0 becomes the vision input.
    if (!rendered && opts.fallbackShot) {
      const shot = await opts.fallbackShot.catch(() => null);
      if (shot) {
        console.log("Rescue renders failed -- falling back to the sealed screenshot as the vision input (screenshot-first).");
        rendered = { html: null, screenshotB64: shot.b64, screenshotMime: shot.mime };
      }
    }
    if (!rendered) return null;

    // Deterministic structured-data read of the SAME rendered HTML, alongside
    // (not instead of) the vision/text pass below. Matters here specifically:
    // htmlToText() below strips every <script> tag before Claude ever sees the
    // text fallback, which deletes schema.org JSON-LD outright -- the text
    // path can only ever read prose, never this. Confirmed live on
    // capitalchev.ca: the page's Car/Offer JSON-LD (price, VIN, year/make/
    // model, dealer) parses cleanly with extractJsonLdVehicle even though the
    // vision call fails outright on that page's 17,729px-tall screenshot.
    // Structured data already outranks a vision/prose guess everywhere else
    // in this codebase (buildJsonLdFallbackAnalysis) -- same rule here.
    const jsonLd = rendered.html ? extractJsonLdVehicle(rendered.html) : null;
    // Same deal, for the platform JSON-LD can't cover: a Convertus page
    // (e.g. Convertus/DealerFire family sites) with NO schema.org markup at
    // all. Confirmed live, 2026-08-14 (albertahonda.com Civic Sedan): zero
    // JSON-LD blocks on the page, and price/VIN/financing/fine-print ALL
    // live in vmsData instead -- when this rescue's own vision/text pass
    // also misses them (long page, oversized screenshot, whatever), this was
    // the one remaining source with nothing reading it. See convertus-vms.js.
    const cv = rendered.html ? extractConvertusVmsVehicle(rendered.html) : null;

    const userContent: any[] = [];
    if (rendered.screenshotB64) {
      userContent.push({ type: "image", source: { type: "base64", media_type: rendered.screenshotMime || "image/jpeg", data: rendered.screenshotB64 } });
      userContent.push({ type: "text", text: `Above is a full-page screenshot of a dealer listing page (URL: ${url}). Read every visible figure — asking price, MSRP, fees/add-ons, VIN, odometer, financing/lease terms — and return the JSON object described in your instructions. If a field isn't visible, use null; never invent a number.` });
    } else if (rendered.html) {
      userContent.push({ type: "text", text: `Here is the rendered content of a dealer listing page (URL: ${url}):\n\n${htmlToText(rendered.html)}\n\nAnalyze this listing and return the JSON object described in your instructions.` });
    } else {
      return null;
    }

    let parsed: any = null;
    // Whatever's left of totalBudget after the render step -- NOT the full
    // budget again (see the doubling bug explained above). A minimum of 1s
    // so a render that consumed the entire budget still gets a real attempt
    // instead of an instant abort.
    const claudeBudget = Math.max(1_000, deadline - Date.now());
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": opts.anthropicKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model: opts.model, max_tokens: 8000, system: opts.systemPrompt, messages: [{ role: "user", content: userContent }] }),
      signal: AbortSignal.timeout(claudeBudget),
    });
    if (!res.ok) console.warn("scrapfly-rescue Claude HTTP", res.status);
    else {
      const data: any = await res.json();
      const text: string = data?.content?.[0]?.text ?? "";
      parsed = firstJsonObject(text);
    }

    // Claude's pass (vision or text) failed outright -- still worth returning
    // a JSON-LD-only result rather than losing the whole rescue, exactly the
    // capitalchev.ca case (oversized screenshot -> vision 400 -> parsed stays
    // null, but the page's own structured data was sitting right there).
    if (!parsed && !jsonLd && !cv) return null;
    if (!parsed) parsed = {};
    parsed.extractionMethod = parsed.extractionMethod
      || (Object.keys(parsed).length === 0 && (jsonLd || cv) ? "scrapfly_render_structured_data" : "scrapfly_render_vision");

    if (jsonLd) fillFromJsonLd(parsed, jsonLd);
    // Runs AFTER JSON-LD on purpose: Convertus's own msrp/financing/fine-print
    // fields have no schema.org equivalent, so this only ever fills gaps
    // JSON-LD genuinely couldn't -- never overwrites what fillFromJsonLd set.
    if (cv) fillFromConvertusVms(parsed, cv);
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
