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
import { visionImageVerdict, imageDimensions } from "./vision-limits.ts";
import { CAPTURE_MAX_B64, CAPTURE_BASE_WIDTH, CAPTURE_MIN_WIDTH, captureFitWidth, captureCoverage } from "./capture.ts";

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

/** A challenge page or an empty shell, not a dealer listing. Exported for the test. */
export function isWalledShell(html: string): boolean {
  if (html.length < 2_000) return true;
  return /just a moment|cf-chl|challenge-platform|attention required|access denied|enable javascript and cookies/i.test(html.slice(0, 6_000));
}
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
    // Scrapfly keeps rendering -- and billing -- after our AbortSignal fires
    // unless told otherwise. Their `timeout` (ms) is the server-side cap; keep
    // it just inside ours so the two fail together instead of us paying for a
    // render we have already walked away from. (lexusofroyaloak.com, 2026-09-02:
    // two 70s renders abandoned client-side, both still running on their side.)
    u.searchParams.set("timeout", String(Math.max(5_000, Math.min(150_000, budgetMs - 2_000))));
    if (autoScroll) u.searchParams.set("auto_scroll", "true"); // trigger lazy-loaded sections
    u.searchParams.set("js", DISMISS_OVERLAYS_JS_B64); // strip consent overlays before render settles
    if (shot !== "none") u.searchParams.set("screenshots[main]", shot);
    // RAW, AND THIS ONE LINE WAS THE BUG.
    //
    // On Scrapfly's SCRAPE api, `format` is the format of the PAGE CONTENT --
    // not of the response envelope, which is always JSON. Their own list:
    //
    //     raw         Original HTML as-is        (the default)
    //     clean_html  Cleaned and sanitized HTML
    //     json        Attempt to parse as JSON
    //     markdown / text
    //
    // We were sending `json`, believing it described the envelope. It told
    // Scrapfly to try to parse a dealer's HTML page AS JSON, so result.content
    // came back as something that is not HTML -- 737,194 characters of it on
    // the Advantage Ford page.
    //
    // AND EVERY STRUCTURED READER WE HAVE LOOKS INSIDE <script> TAGS:
    // extractJsonLdVehicle wants application/ld+json, extractConvertusVmsVehicle
    // wants `vmsData =`, extractD2cVdpVehicle wants `__vdpJSON`. All three found
    // nothing, every time, on every page that reached this path -- which is
    // every page whose direct fetch is walled. That is ~28% of Alberta's dealer
    // hosts, and it is why "Scrapfly render fallback produced no usable data"
    // kept being the last line before a 502.
    //
    // The trace that finally showed it, after four wrong theories on one URL:
    //     pageSrc=737194 jsonLdVeh=null convertus=null d2c=null
    // Three independent readers returning null on the same 737 KB is not three
    // bugs. It is one input that is not what they were promised.
    //
    // Deliberately explicit rather than omitted: `raw` IS the default, but a
    // default that silently produced this is worth naming at the call site.
    u.searchParams.set("format", "raw");

    const res = await fetch(u.toString(), { signal: AbortSignal.timeout(budgetMs) });
    if (!res.ok) {
      noteScrapflyError(`render HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
      console.warn("scrapflyRender", lastScrapflyError);
      return null;
    }
    const j: any = await res.json();
    let html: string | null = j?.result?.content ?? null;
    // A Cloudflare interstitial is a 200 with content, and it is NOT the page.
    // Nimble already refuses a 74-char shell as "content too short"; this path
    // must too, or an HTML-only first attempt "succeeds" on the wall and the
    // screenshot retry that could have beaten it never runs.
    if (html && isWalledShell(html)) {
      noteScrapflyError(`render 200 but the content is a bot-wall shell (${html.length} chars)`);
      html = null;
    }
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
    // The same derived ceiling the capture path uses -- this was a second copy
    // of the same 1_500_000 guess. Deliberately the BYTE cap and not
    // visionImageVerdict: this screenshot is also the sealed evidence photo
    // (see the photo-lock re-attach below), so discarding it for a vision-only
    // reason such as pixel height would lose the picture as well as the vision
    // input. Vision suitability is judged separately, where the image is sent.
    if (screenshotB64 && screenshotB64.length > CAPTURE_MAX_B64) {
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

  // Attempt 1: HTML ONLY, on a short slice of the budget. No screenshot, no
  // auto_scroll, a short JS wait. The rendered HTML is the valuable part -- it
  // carries the JSON-LD, the Convertus vmsData blob and the D2C __vdpJSON that
  // every fallback reads -- and it is the cheapest thing Scrapfly can return.
  //
  // This used to run SECOND, after a viewport-shot attempt with auto_scroll and
  // an 8s wait. On lexusofroyaloak.com (Cloudflare, 972 KB, 2026-09-02) that
  // first attempt burned the entire 70s budget, the HTML-only retry never got
  // to run, the rescue rendered fresh and burned 70s more, and the scan died --
  // over a page whose static HTML held the whole vehicle. Cheapest first.
  const htmlSlice = Math.min(25_000, budgetMs);
  const first = await scrapflyRenderOnce(url, htmlSlice, "none", false, 2_500);
  if (first?.html) return first;

  // Attempt 2: the viewport shot, with whatever budget remains. Still never
  // fullpage -- a 17,729px capture is past the vision ceiling by construction
  // (stampedetoyotacalgary.com, 2026-08-16). It only runs after HTML-only came
  // back empty or walled, so the common path stays one cheap call.
  const left = deadline - Date.now();
  if (left < 6_000) {
    console.warn("scrapflyRender: no budget left for the screenshot retry.");
    return first;
  }
  console.log(`scrapflyRender: HTML-only yielded nothing; retrying with a viewport shot and ${Math.round(left / 1000)}s left.`);
  const second = await scrapflyRenderOnce(url, left, opts.shot ?? "viewport", true, 8_000);
  return second ?? first;
}

// Per-scan sealed screenshot via Scrapfly's dedicated Screenshot API
// ($0.009 / 60 credits per shot on the Discovery plan) -- far cheaper than a
// full ASP scrape, used to put a hash-sealed "what the page looked like"
// photo on EVERY report (#14 on every scan, Vic-approved 2026-08-09).
// Returns { b64, mime } or null. Fail-safe: any error -> null, never throws.
// THE CAPTURE IS THE WHOLE PAGE. Vic, 2026-08-27, on a Sundance Mazda CX-90:
// "scrapfly only took screnshoot half the page". Two separate wrongs sat
// behind that, fixed in two passes:
//
//   PR #342 made the degrade HONEST. The function returned only { b64, mime },
//   so no consumer could tell a whole-page capture from a top-of-page one and
//   every surface labelled both "Full-page capture of the listing". It now
//   reports `kind`, and the copy follows the evidence.
//
//   This pass makes the degrade RARE, which is the actual fix. A full-page
//   shot that came back over the size cap used to be discarded outright and
//   replaced by a viewport shot -- so the answer to "this photo of the whole
//   page is too big" was to photograph LESS of the page. It is now re-shot
//   whole at a narrower width (see the ladder below), and the top-of-page
//   shot is what is left when even that cannot be had.
//
// WHAT IS DELIBERATELY NOT BUILT, and how we will know if it should be.
// TILING -- capturing the page as several stitched segments -- was designed and
// rejected on arithmetic, not taste. Splitting a page does not shrink it: the
// segments sum to at least the monolith once overlap and per-file JPEG headers
// are counted, and the ceiling that actually binds is a TOTAL (report-auth.ts
// MAX_BODY_BYTES, enforced on the whole email POST body). So tiling cannot
// carry one extra byte of page to a buyer's inbox. What it would buy is only
// the pixel-height class, and it would buy that by turning one sealed hash into
// many -- a signed-canonical change, which is the one edit in this repo with a
// recorded history of making every listing-URL report unemailable.
//
// The residue that would genuinely need it is measurable rather than
// guessable: the over-cap warning below prints the byte length and the page
// dimensions on every capture that misses, and the "no width would bring this
// page under the cap" warning prints when the ladder gives up entirely. Count
// those two over a fortnight of real scans. If the second one is ~never, this
// is finished; if it is not, that count -- not an estimate -- is what justifies
// the canonical change.
//
// [[capture-always-whole-page]] [[claims-must-stay-backed]]
// What one /screenshot call can come back as. `tooLarge` is not a failure: it
// is a MEASUREMENT -- the page was photographed whole and the file is too big
// to carry, and the width and height it reports are what the refit is computed
// from.
type Shot = { b64: string; mime: string; kind: "fullpage" | "viewport"; widthPx: number; heightPx: number | null };
type TooLarge = { tooLarge: { b64Len: number; width: number; pageHeightPx: number | null } };
const isTooLarge = (r: unknown): r is TooLarge => !!r && typeof r === "object" && "tooLarge" in (r as any);
const isShot = (r: unknown): r is Shot => !!r && typeof r === "object" && "b64" in (r as any);

export type ListingCapture = Shot & { pageHeightPx?: number | null };

// NO RUNG IS ENTERED THAT CANNOT FINISH. `rendering_wait` is a hard 8s on
// every /screenshot call below -- fullpage, refit, viewport degrade and the
// ASP retry alike -- so a rung entered with 3s or 5s left cannot possibly
// return before its own AbortSignal fires. It would issue the call, hold one
// of the account's five concurrency slots for the whole timeout, return null,
// and may still be BILLED because Scrapfly can finish the shot server-side
// after we abort. Every guard on this ladder used to be a bare 3_000 or
// 5_000 literal, all of them under that 8s floor.
const CAPTURE_RUNG_MIN_MS = 12_000;        // 8s render wait + render + transfer
const CAPTURE_FIRST_ATTEMPT_MS = 45_000;   // half the caller's 90s
const CAPTURE_REFIT_MS = 30_000;           // the refit is a retry, not the main event
// RESERVED, NOT SPENT. The refit used to be handed every remaining
// millisecond, so a refit that hung to the deadline left nothing for the
// top-of-page degrade: two billed shots and NO photo at all, which is worse
// than the cropped photo this whole change exists to replace.
const CAPTURE_VIEWPORT_RESERVE_MS = 20_000;
// Two, because the SECOND one is computed from a real measurement rather than
// an extrapolation, and a third would be extrapolating from an extrapolation.
const CAPTURE_MAX_REFITS = 2;

// onBilledShot fires once per shot Scrapfly actually charges for. It is a
// CALLBACK and not a module-level counter on purpose: an edge isolate serves
// several requests at once, so a shared counter would attribute one scan's
// shots to another scan's ledger row.
export async function captureListingScreenshot(url: string, budgetMs = 25_000, opts: { viewportOnly?: boolean; onBilledShot?: () => void } = {}): Promise<ListingCapture | null> {
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
  const shoot = async (fullpage: boolean, ms: number, asp = false, width: number | null = null): Promise<Shot | TooLarge | "shield" | null> => {
    try {
      const u = new URL("https://api.scrapfly.io/screenshot");
      u.searchParams.set("key", SCRAPFLY_API_KEY);
      u.searchParams.set("url", url);
      u.searchParams.set("format", "jpg");
      if (fullpage) u.searchParams.set("capture", "fullpage");
      // WIDTH IS SET ONLY ON THE REFIT. The first shot sends no `resolution`
      // and inherits Scrapfly's default, exactly as every capture to date has.
      // Adding a parameter to the rung that takes EVERY capture would risk a
      // 422 on every listing to buy nothing -- and the arithmetic does not need
      // it, because the width is READ BACK off the returned image below. On the
      // refit the parameter is the whole point, and if Scrapfly ever rejected
      // it there, the fall-through is the top-of-page shot we would have taken
      // anyway.
      if (width) u.searchParams.set("resolution", `${width}x1080`);
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
      // BILLED. A 403/shield exit costs 0 credits (Vic's dashboard, quoted
      // above); a 200 that returns an image is charged whether we keep the
      // bytes or reject them as too large. Count it here, at the only place
      // that knows a shot succeeded.
      opts.onBilledShot?.();
      const ct = res.headers.get("content-type") || "";
      if (!/image\//i.test(ct)) { console.warn("captureListingScreenshot non-image response:", ct); return null; }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length < 5_000) return null; // too small to be a real page shot
      const b64 = base64FromBytes(bytes);
      // Dimensions come out of the file's own frame header, so a too-large
      // capture still TELLS US how tall the page is -- which is what lets the
      // refit below be arithmetic instead of a guess, and what lets a degraded
      // capture state its shortfall as a measured fact.
      const dim = imageDimensions(b64);
      // MEASURED, not assumed. The refit is computed from the width the image
      // actually came back at, so it stays correct even if Scrapfly's default
      // resolution ever moves. CAPTURE_BASE_WIDTH is only the fallback for an
      // unreadable header.
      const shotWidth = dim?.width ?? width ?? CAPTURE_BASE_WIDTH;
      if (b64.length > CAPTURE_MAX_B64) {
        console.warn(`captureListingScreenshot ${fullpage ? "fullpage" : "viewport"} over the cap at ${shotWidth}px wide (${b64.length} b64 chars > ${CAPTURE_MAX_B64}${dim ? `, page is ${dim.width}x${dim.height}px` : ""})`);
        return { tooLarge: { b64Len: b64.length, width: shotWidth, pageHeightPx: dim?.height ?? null } };
      }
      const mime = /png/i.test(ct) ? "image/png" : "image/jpeg";
      return { b64, mime, kind: (fullpage ? "fullpage" : "viewport") as "fullpage" | "viewport", widthPx: shotWidth, heightPx: dim?.height ?? null };
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
  const attempt = async (fullpage: boolean, ms: number, asp = false, width: number | null = null) => {
    let r = await shoot(fullpage, ms, asp, width);
    let tries = 1;
    while (r === "shield" && tries < 3) {
      const left = budgetMs - (Date.now() - started);
      if (left < CAPTURE_RUNG_MIN_MS) { console.warn("captureListingScreenshot: shield failure, no budget left to re-roll."); break; }
      await new Promise((res) => setTimeout(res, 1_500 * tries)); // "retry in few seconds"
      console.log(`captureListingScreenshot: shield failure — re-rolling the exit (attempt ${tries + 1}, ${Math.round(left / 1000)}s left).`);
      r = await shoot(fullpage, Math.min(ms, left), asp, width);
      tries++;
    }
    return r;
  };

  // ONE FETCH MUST NOT EAT THE WHOLE BUDGET. The caller hands this 90s and
  // `attempt` passed all of it straight to a single AbortSignal.timeout -- so a
  // slow first shot could leave nothing for the refit (needs > 5s), the
  // viewport fall-through (> 3s), or the shield re-roll (> 8s). Half the budget
  // is plenty for a shot that normally lands well under 20s, and it guarantees
  // the rest of the ladder still gets to run.
  // viewportOnly: the vision rescue needs an image Anthropic will ACCEPT, and
  // a whole-page capture of a very tall listing is refused on the 8,000px long
  // edge however small its file is. The sealed evidence and the vision input do
  // not have to be the same bytes.
  if (opts.viewportOnly) {
    const vpOnly = await attempt(false, Math.min(budgetMs, CAPTURE_FIRST_ATTEMPT_MS));
    return isShot(vpOnly) ? vpOnly : null;
  }

  const first = await attempt(true, Math.min(budgetMs, CAPTURE_FIRST_ATTEMPT_MS));
  if (isShot(first)) return first;

  // The measured page height survives every branch below, so even a degraded
  // capture can say how much of the page it is showing rather than leaving the
  // report to imply it got everything.
  let pageHeightPx = isTooLarge(first) ? first.tooLarge.pageHeightPx : null;

  // TOO LARGE IS NOT A REASON TO STOP PHOTOGRAPHING THE PAGE.
  //
  // This used to fall straight to a viewport shot -- the top of the listing --
  // and that is what Vic saw: "scrapfly only took screnshoot half the page".
  // The rule is that the capture is ALWAYS the whole page, so a file that is
  // too big is a sizing problem to solve, not a reason to photograph less.
  //
  // The page does not reflow shorter when narrowed (measured on the failing
  // Mazda VDP: 5,873px tall at 1280 AND at 1024), so bytes fall very nearly
  // linearly with width -- and the baseline is 1920, not the 1280 the earlier
  // measurement compared against. captureFitWidth turns "how far over the cap
  // are we" into the width that fits. Still the WHOLE page, still one image,
  // one extra call, and nothing downstream changes shape.
  if (isTooLarge(first)) {
    // The first refit width is an EXTRAPOLATION from one data point. If it
    // comes back over the cap too, that miss is itself a second real
    // measurement -- a width we actually shot and the bytes it actually
    // produced -- so the next width is derived from it rather than from the
    // same 1920px guess again. Bounded at two: a third would be extrapolating
    // from an extrapolation, and each rung costs a real shot.
    let over: { b64Len: number; width: number; pageHeightPx: number | null } | null = first.tooLarge;
    for (let n = 0; n < CAPTURE_MAX_REFITS && over; n++) {
      const refitW = captureFitWidth(over.b64Len, over.width);
      if (!refitW) {
        console.warn(`captureListingScreenshot: no width at or above ${CAPTURE_MIN_WIDTH}px would bring this page under ${CAPTURE_MAX_B64} b64 chars (last: ${over.b64Len} at ${over.width}px); below that it stops being the desktop page a buyer sees.`);
        break;
      }
      const left = budgetMs - (Date.now() - started);
      // The degrade's budget is set aside BEFORE the refit is allowed to run.
      if (left < CAPTURE_RUNG_MIN_MS + CAPTURE_VIEWPORT_RESERVE_MS) {
        console.warn(`captureListingScreenshot: ${Math.round(left / 1000)}s left — not enough to re-shoot the whole page at ${refitW}px AND still keep the top-of-page shot in reserve.`);
        break;
      }
      console.log(`captureListingScreenshot: full page was ${over.b64Len} b64 chars at ${over.width}px — re-shooting the WHOLE page at ${refitW}px (refit ${n + 1}/${CAPTURE_MAX_REFITS}, ${Math.round(left / 1000)}s left).`);
      const refit = await attempt(true, Math.min(CAPTURE_REFIT_MS, left - CAPTURE_VIEWPORT_RESERVE_MS), false, refitW);
      // No pageHeightPx on this return, on purpose: a full-page shot's OWN
      // height IS the page height, measured at the width actually shot.
      if (isShot(refit)) return refit;
      over = isTooLarge(refit) ? refit.tooLarge : null;
      if (over?.pageHeightPx) pageHeightPx = over.pageHeightPx;
    }
    // Last resort, and it is NOT a full-page capture: kind stays "viewport" so
    // every surface says what it actually is (PR #342), and pageHeightPx rides
    // along so the shortfall is a measured number rather than a silence.
    const leftVp = budgetMs - (Date.now() - started);
    if (leftVp >= CAPTURE_RUNG_MIN_MS) {
      const vp = await attempt(false, leftVp);
      if (isShot(vp)) return { ...vp, pageHeightPx };
    } else {
      console.warn(`captureListingScreenshot: ${Math.round(leftVp / 1000)}s left — below the ${CAPTURE_RUNG_MIN_MS / 1000}s a shot needs, so no top-of-page fallback either.`);
    }
    return null;
  }
  // DEGRADE ON ANY FAILURE, not only on "too_large". A fullpage 422 used to
  // return null here and never try the viewport, so the report shipped with no
  // evidence photo at all -- which is what Vic kept seeing. A viewport shot of
  // the top of the listing (price + vehicle visible) is worth far more than
  // nothing, and it is the same ladder the render path now uses.
  {
    const left = budgetMs - (Date.now() - started);
    if (left >= CAPTURE_RUNG_MIN_MS) {
      console.log(`captureListingScreenshot: fullpage failed — trying a viewport shot with ${Math.round(left / 1000)}s left.`);
      const vp = await attempt(false, left);
      if (isShot(vp)) return vp;
      // Both unprotected attempts failed. NOW pay for ASP -- the alternative at
      // this point is shipping the report with no evidence photo.
      const leftAsp = budgetMs - (Date.now() - started);
      if (leftAsp >= CAPTURE_RUNG_MIN_MS) {
        console.log(`captureListingScreenshot: retrying viewport WITH asp (${Math.round(leftAsp / 1000)}s left) — a 403 from a non-CA proxy is the usual cause.`);
        const withAsp = await attempt(false, leftAsp, true);
        if (isShot(withAsp)) return withAsp;
      }
    } else {
      console.warn("captureListingScreenshot: fullpage failed and no budget left for a viewport shot.");
    }
    return null;
  }
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
export async function attachSealedScreenshot(url: string, analysis: any, budgetMs = 25_000, pre?: Promise<Partial<ListingCapture> & { b64: string; mime: string } | null>): Promise<void> {
  if (analysis) {
    analysis.sourceUrl = analysis.sourceUrl || url;
    if (!analysis.capturedAt) analysis.capturedAt = new Date().toISOString();
  }
  try {
    // A WHOLE-PAGE CAPTURE OUTRANKS A TOP-OF-PAGE ONE. This used to skip
    // whenever ANY listingShot was already set -- and on every rescue path one
    // already is: the photo-lock above seals scrapflyRender's screenshot, which
    // is a VIEWPORT shot. So the dedicated 60-credit full-page capture, already
    // paid for and running in parallel, was thrown away in favour of a picture
    // of the top of the page. Raising the size cap would never have reached
    // those reports at all.
    //
    // Skip only when what we hold is already the strong one.
    if (!analysis || !SCRAPFLY_API_KEY) return;
    if (analysis.listingShot && analysis.listingShotKind === "fullpage") return;
    const replacing = !!analysis.listingShot;
    // A pre-started capture (kicked off at the top of the scan, running in
    // parallel with extraction) beats a fresh one started after the scan has
    // burned the request budget -- the late start was why shots kept missing.
    // BOUNDED WAIT. With a pre-started capture this used to `await` the
    // promise outright, however long the ladder still had to run -- and the
    // ladder's own budget is 90s while this call site may have seconds left
    // before the request deadline. Supabase kills the function at ~150s with a
    // raw 504 that skips the credit-release path and STRANDS THE HOLD, so a
    // late photo must never be able to cause one. A report without the
    // evidence photo is recoverable; a stranded paid credit is not.
    // [[never-charge-to-ask-a-question]]
    const shot = pre
      ? await Promise.race([
          pre,
          new Promise<null>((res) => setTimeout(() => res(null), Math.max(1_000, budgetMs))),
        ]).catch(() => null)
      : await captureListingScreenshot(url, budgetMs);
    if (!shot) return;
    // Only swap for something genuinely better. Replacing one top-of-page shot
    // with another is churn, and it would re-stamp listingShotAt for nothing.
    if (replacing && shot.kind !== "fullpage") return;
    const bin = atob(shot.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dig = await crypto.subtle.digest("SHA-256", bytes);
    analysis.listingShot = `data:${shot.mime};base64,${shot.b64}`;
    analysis.listingShotSha256 = Array.from(new Uint8Array(dig)).map((b) => b.toString(16).padStart(2, "0")).join("");
    analysis.listingShotAt = new Date().toISOString();
    // CLEARED, NOT LEFT BEHIND. listingShot is written unconditionally and the
    // measurements below are conditional -- so when this replaces an earlier
    // shot (or when the new image's frame header is unreadable), the OLD
    // height and page height would survive next to the NEW bytes and the card
    // would print "covers the top N% of the page" about an image those numbers
    // do not describe. The four fields move together or not at all.
    delete analysis.listingShotWidthPx;
    delete analysis.listingShotHeightPx;
    delete analysis.listingShotPageHeightPx;
    // WHOLE PAGE, or the top of it? The ladder degrades to a viewport shot
    // when a fullpage capture is too large or fails, and that is worth far
    // more than no photo -- but the report must SAY so. Labelling a
    // top-of-page shot "Full-page capture of the listing" is an unbacked
    // claim about our own evidence, on the one artifact a buyer puts in
    // front of a dealer. [[capture-always-whole-page]]
    // NOT `shot.kind || "fullpage"`. Defaulting an honesty label to the
    // STRONGEST claim is how a top-of-page photo gets announced as the whole
    // page in the first place. Absent means unknown, and every surface already
    // renders unknown as "Photo of the listing" and nothing more.
    if (shot.kind) analysis.listingShotKind = shot.kind;
    // HOW MUCH OF THE PAGE, as a measured number. A viewport shot used not to
    // know what it had missed, so every surface could only speak in
    // generalities about a capture that fell short. The full-page attempt
    // reports the page's real height even when its file is too big to carry,
    // so the shortfall is arithmetic: captured height over page height.
    // Absent when we genuinely do not know -- never estimated.
    // [[present-without-creating-questions]]
    if (shot.heightPx) analysis.listingShotHeightPx = shot.heightPx;
    if (shot.widthPx) analysis.listingShotWidthPx = shot.widthPx;
    const pagePx = shot.pageHeightPx ?? (shot.kind === "fullpage" ? shot.heightPx : null);
    if (pagePx) analysis.listingShotPageHeightPx = pagePx;
    const cov = captureCoverage(shot.heightPx ?? 0, pagePx ?? 0);
    console.log(`Sealed screenshot ${replacing ? "REPLACED a top-of-page shot" : "attached"} (${bytes.length} bytes, ${shot.kind || "fullpage"}${shot.widthPx ? ` ${shot.widthPx}x${shot.heightPx ?? "?"}px` : ""}${cov !== null && cov < 1 ? `, ${Math.round(cov * 100)}% of a ${pagePx}px page` : ""}, sha ${analysis.listingShotSha256.slice(0, 12)}).`);
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
        // A WHOLE-PAGE CAPTURE CAN BE TOO TALL TO READ, and on this rung there
        // is no HTML behind it -- so an image Anthropic refuses used to mean
        // the entire rescue returned null and the buyer got no analysis at all.
        //
        // That became reachable the moment the size cap was raised. Before it,
        // a 17,729px page always came back over the old cap and degraded to a
        // 1,080px viewport shot, which passes the long-edge check by accident.
        // Now the whole page IS carried -- correctly, for evidence -- and
        // handed to a vision call that rejects it on pixel height.
        //
        // The sealed evidence and the vision input do not have to be the same
        // bytes. Take a viewport shot for the READ and leave the photo alone.
        // Same one call the old ladder spent on its degrade, so no new cost.
        if (!visionImageVerdict(shot.b64, shot.mime).ok) {
          const left = deadline - Date.now() - 20_000;
          console.warn(`scrapfly-rescue: the sealed capture is unreadable by vision (${visionImageVerdict(shot.b64, shot.mime).reason}) and there is no HTML — taking a viewport shot for the READ only; the evidence photo is untouched.`);
          const forVision = left > 0 ? await captureListingScreenshot(url, left, { viewportOnly: true }) : null;
          rendered = forVision
            ? { html: null, screenshotB64: forVision.b64, screenshotMime: forVision.mime }
            : null;
        }
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
      userContent.push({ type: "text", text: `Above is a screenshot of a dealer listing page (URL: ${url}) -- it may show only the top of the page. Read every visible figure — asking price, MSRP, fees/add-ons, VIN, odometer, financing/lease terms — and return the JSON object described in your instructions. If a field isn't visible, use null; never invent a number.` });
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
      // <= CAPTURE_MAX_B64, not < 1_500_000. Note this comparison runs the
      // OPPOSITE way to the two above (this one gates KEEPING, they gate
      // dropping), so a careless swap of the constant flips the guard.
      if (rendered.screenshotB64 && rendered.screenshotB64.length <= CAPTURE_MAX_B64) {
        const bin = atob(rendered.screenshotB64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const dig = await crypto.subtle.digest("SHA-256", bytes);
        parsed.listingShot = `data:${rendered.screenshotMime || "image/jpeg"};base64,${rendered.screenshotB64}`;
        parsed.listingShotSha256 = Array.from(new Uint8Array(dig)).map((b) => b.toString(16).padStart(2, "0")).join("");
        parsed.listingShotAt = new Date().toISOString();
        // SAY WHICH SHOT. scrapflyRender asks for a VIEWPORT screenshot by
        // default (see its attempt-1 comment), so this photo is the top of the
        // page -- and it was sealed with no kind at all, which every surface
        // reads as "we do not know". We do know. [[claims-must-stay-backed]]
        parsed.listingShotKind = "viewport";
        // Measure it here as well, or the fields mergeRescued now carries would
        // never have anything to carry and the coverage sentence would stay
        // unreachable on every rescue path -- wired, but with nothing on the wire.
        const rdim = imageDimensions(rendered.screenshotB64);
        if (rdim) { parsed.listingShotWidthPx = rdim.width; parsed.listingShotHeightPx = rdim.height; }
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
    analysis.priceGateGoogleAdsBacked = !!rescued.priceGateGoogleAdsBacked;
  }
  const fillKeys = ["trim", "vin", "odometerKm", "vehicleCondition", "fuelType", "dealerName", "dealerCity", "vehicle", "year", "make", "model", "financing", "summary", "listingShot", "listingShotSha256", "listingShotAt",
    // BUILT BUT UNWIRED. The capture describes itself now -- which shot it is,
    // how tall it came back, how tall the page actually is -- and every one of
    // those fields was dropped here, so on any rescue path the report fell back
    // to the neutral "Photo of the listing" and the coverage sentence never
    // rendered. listingShotKind has been stripped here since PR #342 shipped it.
    "listingShotKind", "listingShotWidthPx", "listingShotHeightPx", "listingShotPageHeightPx"];
  for (const k of fillKeys) {
    if ((analysis[k] == null || analysis[k] === "") && rescued[k] != null && rescued[k] !== "") analysis[k] = rescued[k];
  }
  // Add-ons: take the rescued list only if we had none.
  if ((!Array.isArray(analysis.addOns) || analysis.addOns.length === 0) && Array.isArray(rescued.addOns) && rescued.addOns.length) {
    analysis.addOns = rescued.addOns;
  }
  analysis.extractionMethod = rescued.extractionMethod || "scrapfly_render_vision";
}
