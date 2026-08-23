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
import { extractD2cVdpVehicle, fillFromD2cVdp } from "./d2c-vdp.js";
import { visionImageVerdict } from "./vision-limits.ts";

const SCRAPFLY_API_KEY = Deno.env.get("SCRAPFLY_API_KEY");
export function scrapflyEnabled(): boolean { return !!SCRAPFLY_API_KEY; }

// Ground-truth price-gate CTA text, matched against the RAW rendered DOM --
// independent of whether the screenshot capture was complete or the vision
// pass actually saw the sidebar it lives in. Confirmed live 2026-08-13, Fish
// Creek Nissan's Rock Creek listing: the page plainly shows "Contact Us For
// Price" (screenshot-verified), but the sealed capture's own render came back
// missing the sidebar it lives in, vision never saw it, and the accusation-
// gate correctly refused to accuse on an incomplete read -- producing a false
// CLEAN "not_shown" instead of an honest "couldn't verify". A plain regex
// against the actual rendered HTML can't be fooled by an incomplete capture
// the way a vision read of it can.
export const PRICE_GATE_CTA_RE = /contact\s+us\s+for\s+price|call\s+for\s+price|get\s+e-?price|unlock\s+(the|this|your)\s+price|get\s+today'?s\s+price/i;

// Cookie/privacy-consent overlays (OneTrust, TrustArc, Quantcast, and any
// other IAB-TCF-based CMP) sit on top of the page until a human clicks
// through -- a bot render never does, so both screenshot calls below can end
// up capturing a blank consent backdrop instead of the listing. Confirmed
// live 2026-08-13 on tazaparkvw.com: a full-page "Consent Management" dialog,
// page behind it never visible in the capture. Rather than chase each CMP
// vendor's own button selector (brittle, breaks silently when a vendor
// changes markup), strip any fixed/sticky high-z-index element before the
// shot -- covers consent banners, paywalls and sticky promo bars generically.
// Best-effort: wrapped in try/catch so a page that rejects injected JS just
// renders as before, never breaks the request.
const DISMISS_OVERLAYS_JS = `(function(){try{document.querySelectorAll('*').forEach(function(el){var cs=getComputedStyle(el);if((cs.position==='fixed'||cs.position==='sticky')&&parseInt(cs.zIndex||'0',10)>999){el.remove();}});document.documentElement.style.overflow='auto';document.body.style.overflow='auto';}catch(e){}})();`;
const DISMISS_OVERLAYS_JS_B64 = btoa(DISMISS_OVERLAYS_JS);

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
// TWO ATTEMPTS, CHEAPEST-USEFUL FIRST. This used to make one maximally
// expensive request -- render_js + auto_scroll + a FULLPAGE screenshot -- and
// on a long dealer page that combination is what blew the budget:
//
//   scrapflyRender error: Signal timed out.        (stampedetoyotacalgary.com)
//
// The cost was not just the screenshot. A timeout loses the RENDERED HTML too,
// and the HTML is the part that actually rescues a page: it carries the
// schema.org JSON-LD and the Convertus vmsData blob that every fallback below
// reads. So the run spent its entire budget producing an artifact that the size
// guard would have discarded anyway, and threw away the one thing it needed.
//
// Asking for a FULLPAGE shot was always self-defeating here. A 17,729px capture
// is past the vision API's ceiling by construction, so the best case was "spend
// 70s, then drop it". A VIEWPORT shot is bounded, fast, and always within
// limits -- and the dispute-proof full-page evidence photo is a SEPARATE,
// cheaper call (captureListingScreenshot) that already has its own
// fullpage->viewport ladder. This path never needed to duplicate it.
//
// Attempt 2 exists because a render can still overrun on a heavy page: drop the
// screenshot entirely, drop auto_scroll, shorten the JS wait, and go for the
// HTML alone. It only fires after a failure, so the common path stays one call.
type RenderShot = "viewport" | "fullpage" | "none";

async function scrapflyRenderOnce(
  url: string, budgetMs: number, shot: RenderShot, autoScroll: boolean, waitMs: number,
): Promise<RenderResult | null> {
  if (!SCRAPFLY_API_KEY) return null;
  const renderDeadline = Date.now() + budgetMs;
  try {
    const u = new URL("https://api.scrapfly.io/scrape");
    u.searchParams.set("key", SCRAPFLY_API_KEY);
    u.searchParams.set("url", url);
    u.searchParams.set("asp", "true");            // Anti-Scraping-Protection (defeats bot walls)
    u.searchParams.set("render_js", "true");      // execute JS so dynamic price loads
    u.searchParams.set("country", "ca");          // Canadian residential IP
    u.searchParams.set("rendering_wait", String(waitMs));
    if (autoScroll) u.searchParams.set("auto_scroll", "true"); // trigger lazy-loaded sections
    u.searchParams.set("js", DISMISS_OVERLAYS_JS_B64); // strip consent overlays before render settles
    if (shot !== "none") u.searchParams.set("screenshots[main]", shot);
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
        // Bounded by what's LEFT of budgetMs, never a flat extra timeout on top:
        // the caller computed budgetMs expecting it to be this function's total.
        const shotBudget = Math.max(1_000, Math.min(20_000, renderDeadline - Date.now()));
        const sr = await fetch(`${shotUrl}${sep}key=${SCRAPFLY_API_KEY}`, { signal: AbortSignal.timeout(shotBudget) });
        if (sr.ok) {
          const bytes = new Uint8Array(await sr.arrayBuffer());
          screenshotB64 = base64FromBytes(bytes);
          screenshotMime = (bytes[0] === 0x89 && bytes[1] === 0x50) ? "image/png" : (bytes[0] === 0xFF && bytes[1] === 0xD8) ? "image/jpeg" : (sr.headers.get("content-type") || "image/jpeg");
        }
      } catch (e) {
        // A screenshot is optional. Losing it must never lose the HTML.
        console.warn("scrapflyRender: screenshot fetch failed (keeping the HTML):", (e as Error)?.message);
      }
    }
    // Belt and braces behind the viewport request: if a shot still comes back
    // past the vision ceiling, drop it so the caller takes the text path rather
    // than a guaranteed-failing vision call. See vision-limits.ts.
    if (screenshotB64 && screenshotB64.length > 1_500_000) {
      console.warn(`scrapflyRender: screenshot too large (${screenshotB64.length} b64 chars) -- dropping, falling back to rendered HTML.`);
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

// Is this a Scrapfly SHIELD failure — the transient kind it explicitly tells us
// to retry?
//
//     ERR::ASP::SHIELD_PROTECTION_FAILED
//     "Unable to bypass cloudflare, please retry in few seconds"
//
// Vic's dashboards for stampedetoyotacalgary.com and lethbridgetoyota.com show
// the same shape on both: the exit geography VARIES PER ATTEMPT, and it decides
// the outcome.
//
//     JP  403  cost 0        CA  200  cost 80
//     AR  403  cost 0        US  200  cost 80
//
// Same URL, seconds apart. The request that failed went out as a Vietnamese-
// locale Linux browser through a Mumbai Cloudflare edge, at a Calgary dealer;
// Cloudflare scored it non-human. `country=ca` is set on our side and plainly
// is not taking effect — even the successes came out of Canada and the US
// rather than only Canada.
//
// THE COST COLUMN DECIDES THE FIX. A blocked attempt costs 0 credits; only a
// success costs 80. So retrying a shield failure is FREE, the vendor asks us to
// do it, and each retry is a fresh roll of the exit geography. We were treating
// it as terminal and giving up after one attempt — which is why a page that
// answers a plain curl in 1.4s produced no report at all.
export function isShieldFailure(status: number, body: string): boolean {
  if (/ERR::ASP::SHIELD_PROTECTION_FAILED/i.test(body)) return true;
  if (/unable to bypass/i.test(body)) return true;
  // A bare 403/429 from the target reaches us the same way and is the same
  // dice-roll; 422 is Scrapfly refusing the request itself, which a retry
  // cannot fix, so it is deliberately NOT here.
  return status === 403 || status === 429;
}

export async function scrapflyRender(url: string, budgetMs = 70_000, opts: { shot?: RenderShot } = {}): Promise<RenderResult | null> {
  if (!SCRAPFLY_API_KEY) return null;
  const deadline = Date.now() + budgetMs;

  // Attempt 1: viewport shot. Bounded by construction, so it cannot produce the
  // oversized capture the vision call refuses, and it renders far faster than a
  // fullpage stitch of a 17,000px page.
  const first = await scrapflyRenderOnce(url, budgetMs, opts.shot ?? "viewport", true, 8_000);
  if (first?.html || first?.screenshotB64) return first;

  // Attempt 2: HTML only. No screenshot, no auto_scroll, a short JS wait. This
  // is the cheapest thing that still yields JSON-LD and vmsData, and it only
  // runs after a failure -- the common path remains a single call.
  const left = deadline - Date.now();
  if (left < 6_000) {
    console.warn("scrapflyRender: no budget left for the HTML-only retry.");
    return first;
  }
  console.log(`scrapflyRender: first attempt yielded nothing; retrying HTML-only with ${Math.round(left / 1000)}s left.`);
  return await scrapflyRenderOnce(url, left, "none", false, 2_500);
}

// Per-scan sealed screenshot via Scrapfly's dedicated Screenshot API
// ($0.009 / 60 credits per shot on the Discovery plan) -- far cheaper than a
// full ASP scrape, used to put a hash-sealed "what the page looked like"
// photo on EVERY report (#14 on every scan, Vic-approved 2026-08-09).
// Returns { b64, mime } or null. Fail-safe: any error -> null, never throws.
export async function captureListingScreenshot(url: string, budgetMs = 25_000): Promise<{ b64: string; mime: string } | null> {
  if (!SCRAPFLY_API_KEY) return null;
  const started = Date.now();
  // `asp` is the difference between the call that works and the one that does
  // not. The /scrape render has always sent asp=true; this /screenshot call
  // never did, so it took whatever proxy it was given. Vic's Scrapfly dashboard
  // for 2026-08-16 shows exactly that:
  //
  //     JP  403  cost 0      CA  200  cost 80
  //     AR  403  cost 0      US  200  cost 80
  //
  // Every 403 exits via Japan or Argentina, every 200 via Canada or the US, on
  // the SAME url seconds apart. Block rate 50%. The dealer geo-blocks; ASP is
  // what retries through a proxy that is not blocked.
  //
  // COST: ASP costs more per call, so it is NOT the default. The cheap
  // unprotected shot is tried first and ASP is only paid for when that fails --
  // i.e. only when the alternative is no evidence photo at all. On the happy
  // path this change costs nothing.
  const shoot = async (fullpage: boolean, ms: number, asp = false): Promise<{ b64: string; mime: string } | "too_large" | "shield" | null> => {
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
      // auto_scroll only for the fullpage capture, which stitches the WHOLE
      // page and needs it to trigger below-the-fold lazy images (the HR-V
      // grey-box case above). On the viewport degrade path -- which exists
      // specifically to show "the top of the listing (price + vehicle
      // visible)" per the comment below -- auto_scroll actively defeats that:
      // it leaves the page scrolled to wherever it stopped, and the viewport
      // shot then captures THAT position, not the top. Confirmed live
      // 2026-08-21 (Okotoks Toyota, the exact dealer already named above as
      // the known too_large/degrade case): the sealed capture showed the
      // Specifications/Key features section, not the price/VIN/vehicle photo
      // at the top -- the report's most important evidence, missing.
      if (fullpage) u.searchParams.set("auto_scroll", "true");
      u.searchParams.set("js", DISMISS_OVERLAYS_JS_B64); // strip consent overlays before the sealed shot
      u.searchParams.set("country", "ca");
      if (asp) u.searchParams.set("asp", "true");
      const res = await fetch(u.toString(), { signal: AbortSignal.timeout(ms) });
      if (!res.ok) {
        // READ THE BODY. A 422 from Scrapfly names the reason -- bad params, ASP
        // failure, target error -- and logging only the number is why
        // "captureListingScreenshot HTTP 422" cost Vic a round-trip to
        // diagnose. Same lesson as the Claude 400 in the rescue path: the one
        // thing that explains the failure was fetched and thrown away.
        const body = await res.text().catch(() => "");
        // Name the params too: a 422 is "unprocessable", and which parameter it
        // objected to is the whole diagnosis.
        const sent = [...u.searchParams.keys()].filter((k) => k !== "key").join(",");
        console.warn(`captureListingScreenshot ${fullpage ? "fullpage" : "viewport"}${asp ? "+asp" : ""} HTTP ${res.status} [params: ${sent}]: ${body.slice(0, 300)}`);
        if (isShieldFailure(res.status, body)) return "shield";
        return null;
      }
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
  // A shield failure is a FREE re-roll of the exit geography (blocked = 0
  // credits), and Scrapfly asks us to retry. Loop while the budget allows
  // rather than giving up on the first Japanese exit.
  const attempt = async (fullpage: boolean, ms: number, asp = false) => {
    let r = await shoot(fullpage, ms, asp);
    let tries = 1;
    while (r === "shield" && tries < 3) {
      const left = budgetMs - (Date.now() - started);
      if (left < 8_000) { console.warn("captureListingScreenshot: shield failure, no budget left to re-roll."); break; }
      await new Promise((res) => setTimeout(res, 1_500 * tries)); // "retry in few seconds"
      console.log(`captureListingScreenshot: shield failure — re-rolling the exit (attempt ${tries + 1}, ${Math.round(left / 1000)}s left).`);
      r = await shoot(fullpage, Math.min(ms, left), asp);
      tries++;
    }
    return r;
  };

  const first = await attempt(true, budgetMs);
  if (first && first !== "too_large" && first !== "shield") return first;
  // DEGRADE ON ANY FAILURE, not only on "too_large". A fullpage 422 used to
  // return null here and never try the viewport, so the report shipped with no
  // evidence photo at all -- which is what Vic kept seeing. A viewport shot of
  // the top of the listing (price + vehicle visible) is worth far more than
  // nothing, and it is the same ladder the render path now uses.
  if (first === null || first === "shield") {
    const left = budgetMs - (Date.now() - started);
    if (left > 3_000) {
      console.log(`captureListingScreenshot: fullpage failed — trying a viewport shot with ${Math.round(left / 1000)}s left.`);
      const vp = await attempt(false, left);
      if (vp && vp !== "too_large" && vp !== "shield") return vp;
      // Both unprotected attempts failed. NOW pay for ASP -- the alternative at
      // this point is shipping the report with no evidence photo.
      const leftAsp = budgetMs - (Date.now() - started);
      if (leftAsp > 5_000) {
        console.log(`captureListingScreenshot: retrying viewport WITH asp (${Math.round(leftAsp / 1000)}s left) — a 403 from a non-CA proxy is the usual cause.`);
        const withAsp = await attempt(false, leftAsp, true);
        if (withAsp && withAsp !== "too_large" && withAsp !== "shield") return withAsp;
      }
    } else {
      console.warn("captureListingScreenshot: fullpage failed and no budget left for a viewport shot.");
    }
    return null;
  }
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
//
// Also stamps sourceUrl/capturedAt here, unconditionally and before the
// early-returns below -- this is the one place every finalizeServerSide()
// call site on the listing-URL path already calls with the real fetched
// `url` in scope, so it is the single point that can make source/capturedAt
// true (and therefore signable) for every branch at once. Before this, only
// the CLIENT stamped these two fields (App.jsx, after receiving the response)
// with its own url + Date.now() -- harmless while canonicalReport() ignored
// them, but report-sign.ts's v3 bump started projecting them into the signed
// canonical (see "source" there) without this side stamping the SAME values
// server-side first. The result: every listing-URL report signed a `source`
// of null, the client then unconditionally overwrote sourceUrl/capturedAt
// with its own values before ever emailing, and email-quote-report's
// recomputed canonical -- now non-null -- never matched the signature. Every
// single listing-URL report was unemailable. Setting real values here BEFORE
// signing, and only ever filling a gap the client left (`analysis.sourceUrl
// || url`) client-side, closes the gap instead of racing it.
export async function attachSealedScreenshot(url: string, analysis: any, budgetMs = 25_000, pre?: Promise<{ b64: string; mime: string } | null>): Promise<void> {
  if (analysis) {
    analysis.sourceUrl = analysis.sourceUrl || url;
    if (!analysis.capturedAt) analysis.capturedAt = new Date().toISOString();
  }
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
    // D2C Media's window.__vdpJSON -- same reasoning as Convertus above, a
    // second platform whose real price/identity fields never reach JSON-LD
    // or vision when the page templates a "Call for pricing" gate over them.
    // See d2c-vdp.js.
    const dv = rendered.html ? extractD2cVdpVehicle(rendered.html) : null;

    // Ground-truth price-gate check against the RAW rendered DOM text -- runs
    // regardless of whether the screenshot capture was complete or the vision
    // call below actually saw the CTA. See PRICE_GATE_CTA_RE.
    const renderGateCtaDetected = !!(rendered.html && PRICE_GATE_CTA_RE.test(rendered.html));

    const userContent: any[] = [];
    // PRE-FLIGHT THE IMAGE. Anthropic rejects an oversized image with HTTP 400,
    // and this call used to send whatever the render produced -- a 17,729px-tall
    // capitalchev.ca screenshot, a 903 KB stampedetoyotacalgary.com page -- and
    // take the 400. The text path below already works and is right there, so an
    // image we KNOW will be refused should never be sent in its place.
    const shotVerdict = visionImageVerdict(rendered.screenshotB64, rendered.screenshotMime);
    if (rendered.screenshotB64 && !shotVerdict.ok) {
      console.warn(`scrapfly-rescue: skipping the screenshot (${shotVerdict.reason}) and using the rendered text instead.`);
    }
    if (rendered.screenshotB64 && shotVerdict.ok) {
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
    // READ THE BODY. A 400 from Anthropic is OUR malformed request and the body
    // names the reason -- image too large, bad base64, token overflow. Logging
    // only the status number is why "scrapfly-rescue Claude HTTP 400" cost a
    // round-trip through Vic to diagnose: the one thing that explains it was
    // fetched and discarded. Same rule as the usage-log breadcrumbs elsewhere
    // in this codebase -- a failed PAID scan must be diagnosable from logs alone.
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`scrapfly-rescue Claude HTTP ${res.status}: ${body.slice(0, 400)}`);
    }
    else {
      const data: any = await res.json();
      const text: string = data?.content?.[0]?.text ?? "";
      parsed = firstJsonObject(text);
    }

    // Claude's pass (vision or text) failed outright -- still worth returning
    // a JSON-LD-only result rather than losing the whole rescue, exactly the
    // capitalchev.ca case (oversized screenshot -> vision 400 -> parsed stays
    // null, but the page's own structured data was sitting right there).
    // A confirmed price-gate CTA is the same kind of signal worth keeping
    // even when vision, JSON-LD and vmsData all came back empty.
    if (!parsed && !jsonLd && !cv && !dv && !renderGateCtaDetected) return null;
    if (!parsed) parsed = {};
    parsed.extractionMethod = parsed.extractionMethod
      || (Object.keys(parsed).length === 0 && (jsonLd || cv) ? "scrapfly_render_structured_data" : "scrapfly_render_vision");
    parsed.renderGateCtaDetected = renderGateCtaDetected;

    if (jsonLd) fillFromJsonLd(parsed, jsonLd);
    // Runs AFTER JSON-LD on purpose: Convertus's own msrp/financing/fine-print
    // fields have no schema.org equivalent, so this only ever fills gaps
    // JSON-LD genuinely couldn't -- never overwrites what fillFromJsonLd set.
    if (cv) fillFromConvertusVms(parsed, cv);
    if (dv) fillFromD2cVdp(parsed, dv);
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
  const hadNoQuotedPrice = !(Number(analysis.quotedPrice) > 0);
  const preferKeys = ["quotedPrice", "msrp"];
  for (const k of preferKeys) {
    if ((analysis[k] == null || Number(analysis[k]) <= 0) && Number(rescued[k]) > 0) analysis[k] = rescued[k];
  }
  // quotedPriceSource rides along with quotedPrice above -- without it, a
  // rescue-path Convertus price (fillFromConvertusVms now tags it
  // "convertus_vms") gets the right number but silently drops the provenance
  // tag priceVerified checks for, same bug as the main-path gap-fill it
  // mirrors. Gated on hadNoQuotedPrice (captured before the loop above), not
  // just "analysis.quotedPrice is now positive" -- otherwise an already-present
  // LLM-guessed price that happens to match rescued's number would wrongly
  // inherit rescued's "verified" source tag instead of staying unverified.
  if (hadNoQuotedPrice && Number(analysis.quotedPrice) > 0 && rescued.quotedPriceSource) {
    analysis.quotedPriceSource = rescued.quotedPriceSource;
  }
  // Same reasoning, same gate: the D2C "page says Call for pricing, blob
  // says $X" tell (fillFromD2cVdp) only means something if THIS merge is
  // what actually supplied the price.
  if (hadNoQuotedPrice && Number(analysis.quotedPrice) > 0 && rescued.priceGatedButRecovered) {
    analysis.priceGatedButRecovered = true;
    analysis.priceGateMessage = rescued.priceGateMessage;
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
