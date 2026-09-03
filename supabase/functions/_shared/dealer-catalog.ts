// ============================================================================
// THE ALBERTA DEALER-WEBSITE CATALOGUE — pure helpers.
//
// WHY IT EXISTS. Vic, 2026-08-30, after a third consecutive single-site
// failure: "i want catalog of all car websites in alberta ... we should have
// them all listed on place track them daily and read them on as soones
// lotcheck user makes request".
//
// Every broken listing had been its own investigation — the Convertus price
// miss, the D2C gated price, the SM360 feed, the Cloudflare wall — and each fix
// was real and none of them reduced the NEXT one's cost, because a scan
// rediscovers everything about a host from scratch every single time.
//
// THE NUMBERS THAT FORCED IT, measured, not estimated:
//
//     21,866   AMVIC licensees (the regulator's whole list)
//      1,639   distinct hosts among the Issued ones WITH a website
//         30   hosts in our catalogue before this   <-- 1.8%
//    452/1639  (28%) never answered our probe from a datacenter IP at all
//
// That last line is the one that matters at request time. West Wind Honda
// answered 403 to all SEVEN probes from CI and 200 from a normal connection,
// where our own parser reads 15 VINs off it — so "EDealer: 0 across Alberta"
// was a fact about our egress address, not about Alberta. A scan that does not
// know which side of that line a host sits on spends its budget finding out,
// and on a walled host it finds out by running out of time.
//
// WHAT THIS MODULE DECIDES. Given what the catalogue already knows about a
// host, which way to fetch it FIRST. Nothing here refuses anything: an unknown
// host falls back to exactly today's ladder, so the catalogue's absence can
// never become a failure. [[no-single-point-of-failure]]
//
// Pure and offline so dealer-catalog.test.ts can pin every branch, and shared
// with scripts/ so the host normalisation has ONE definition rather than a copy
// in the crawler that can drift away from the one the scanner uses.
// ============================================================================

/** What the catalogue stores about one host. Mirrors dealer_source's columns. */
export interface CatalogRow {
  host: string;
  platform?: string | null;
  fetchStrategy?: string | null;      // 'direct' | 'asp' | 'unknown'
  lastDirectStatus?: string | null;   // 'ok' | 'challenged' | 'http_error' | 'empty' | 'network'
  lastDirectOkAt?: string | null;
  lastDirectFailAt?: string | null;
  lastAspOkAt?: string | null;
  observedCount?: number | null;
}

/**
 * A dealer website reduced to its origin — the catalogue's key.
 *
 * Origin only, never a path: a path in this column would silently point the
 * crawler at the wrong thing, which is why dealer_source constrains it in the
 * database too. Social pages are dropped because a dealer's Facebook page is
 * not a dealer website and will never carry a listing.
 */
export function toOrigin(raw: unknown): string | null {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s || /^(mailto:|tel:)/i.test(s)) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)) return null;
    if (/facebook|instagram|twitter|x\.com|linkedin|youtube|google\./i.test(u.hostname)) return null;
    return `https://${u.hostname}`;
  } catch { return null; }
}

/**
 * The same origin, for LOOKUP, tolerating the www./non-www. split.
 *
 * AMVIC records "advantageford.ca" where the live site redirects to
 * "www.advantageford.ca", and a buyer pastes whichever one their browser shows.
 * Keying the catalogue on the raw hostname would file the same dealer twice and
 * find neither. The lookup key drops a leading "www." — the stored `host` keeps
 * whatever form we confirmed answers, because that is what we must fetch.
 */
export function catalogKey(raw: unknown): string | null {
  const origin = toOrigin(raw);
  if (!origin) return null;
  return origin.replace(/^https:\/\/www\./i, "https://");
}

// WHAT IS EVIDENCE ABOUT THE HOST, AND WHAT IS EVIDENCE ABOUT THE PAGE.
//
// This distinction is the whole safety of the catalogue. `http_error` used to
// mean every non-OK status except 429/503 — so a 404 on a vehicle that had
// just sold arrived here byte-identical to a Cloudflare 403, and ONE buyer
// pasting a delisted listing would pin that dealer's entire site to the paid
// render path for a week.
//
// A wall is a refusal to serve US: 401, 403, 407, 451. A 404 or a 500 is the
// page or the server having a bad day and says nothing about whether the host
// takes datacenter traffic. The status code was captured all along and thrown
// away before it reached this decision.
const WALLED = new Set(["challenged", "refused"]);

// HTTP statuses that mean "not you". 451 is legal blocking, 407 a proxy
// demanding auth; both are about the requester, like 401 and 403.
/**
 * The other URLs that are the SAME SITE.
 *
 * A host string out of AMVIC's roster is a guess about two things nobody
 * verified: the scheme, and whether the site lives on `www`. Both guesses fail
 * silently at the transport layer, and a transport failure is indistinguishable
 * from "this business is gone" unless something tries the alternatives.
 *
 * MEASURED, 2026-08-31. Re-probing the 336 hosts that never answered the
 * province-wide probe: 78 failed on TLS, and **53 of those 78 answer perfectly
 * well** — 47 of them over plain `http://`, 6 on the www-flipped name. They
 * were never unreachable. We asked for the wrong URL and recorded the answer as
 * a fact about the dealer.
 *
 * That is the same shape as the 403s that produced "EDealer: 0 across Alberta":
 * our own request recorded as the world's answer. [[repeat-fix-pattern]]
 *
 * Ordered by how much of the original they keep, so the first hit is the
 * closest match: same name over http, then the flipped name over https, then
 * flipped over http. The input origin itself is NOT included — the caller has
 * already tried it, and returning it would re-spend the request that failed.
 */
export function originVariants(raw: unknown): string[] {
  const origin = toOrigin(raw);
  if (!origin) return [];
  let hostname: string;
  try { hostname = new URL(origin).hostname; } catch { return []; }
  const flipped = hostname.startsWith("www.") ? hostname.slice(4) : `www.${hostname}`;
  // A bare TLD-less name or an IP has no meaningful www form; flipping it
  // would invent a hostname that was never in the roster.
  const flippable = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(hostname) && !/^\d+(\.\d+){3}$/.test(hostname);
  const out = [`http://${hostname}`];
  if (flippable) out.push(`https://${flipped}`, `http://${flipped}`);
  return out;
}

/**
 * Did the anti-bot pass actually COME BACK WITH A PAGE?
 *
 * The distinction this draws is the one a province-wide readability number
 * rests on, and getting it wrong made the number move the wrong way. Three
 * different outcomes all used to set `rescued: true`:
 *
 *   1. Scrapfly fetched the dealer's page          -> a real success
 *   2. Scrapfly reached the host and it refused    -> a fact about the DEALER
 *   3. Scrapfly refused US (401 on our key)        -> a fact about OUR KEY,
 *                                                     nothing reached the host
 *
 * Counting all three as "answered only via anti-bot" means a completely dead
 * key makes READABLE BY LOTCHECK go UP -- the more thoroughly broken our
 * credential, the healthier Alberta looks. It also suppressed the "no anti-bot
 * pass in this run" caveat, because something had been flagged as rescued.
 *
 * Only (1) is an answer. [[absence-read-as-knowledge]]
 */
export function aspAnswered(r: { rescued?: boolean; platform?: string | null; miss?: string | null } | null | undefined): boolean {
  if (!r || !r.rescued) return false;
  return !!r.platform || r.miss === "responded-no-feed";
}

export const REFUSAL_CODES = new Set([401, 403, 407, 451]);

/** The catalogue's verdict for one direct read, from its status and code. */
export function directVerdict(status: string, code?: number | null): string {
  if (status === "http_error") return code != null && REFUSAL_CODES.has(code) ? "refused" : "http_error";
  return status;
}

// A 429 is the origin saying we are asking too often. Answering it with MORE
// free requests is the wrong move, and going through the render (a different
// address entirely) is the right one — but only briefly, because a throttle
// lifts in minutes where a bot wall does not.
export const THROTTLE_WINDOW_MS = 60 * 60 * 1000;

// How long a wall verdict is trusted before we spend one cheap request finding
// out whether it is still true. Dealer sites change CDN configuration; a host
// walled in March is not walled forever, and a catalogue that never re-checks
// turns a temporary block into a permanent one.
export const WALL_VERDICT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface FetchPlan {
  aspFirst: boolean;
  why: string;
}

/**
 * Which way to fetch this host FIRST.
 *
 * The only thing this changes is ORDER. Both paths remain available in every
 * case, so a wrong or stale verdict costs one attempt, never the scan.
 *
 * `aspFirst` is not free — it spends a Scrapfly credit on a host that might
 * have answered a plain GET — so it is claimed only from a RECENT, recorded
 * failure of the kind that means a wall, never from a guess and never from a
 * single network blip.
 */
export function chooseFetchPlan(row: CatalogRow | null, nowMs: number): FetchPlan {
  if (!row) return { aspFirst: false, why: "host not in the catalogue — the usual ladder" };

  const failAt = row.lastDirectFailAt ? Date.parse(row.lastDirectFailAt) : NaN;
  const okAt = row.lastDirectOkAt ? Date.parse(row.lastDirectOkAt) : NaN;

  // A direct read that has worked SINCE the last failure settles it.
  if (Number.isFinite(okAt) && (!Number.isFinite(failAt) || okAt >= failAt)) {
    return { aspFirst: false, why: "a plain fetch of this host has worked since its last failure" };
  }

  // A recent throttle is answered by NOT spending more free requests on it.
  // Its own short window, because a 429 lifts in minutes and a bot wall does not.
  if (String(row.lastDirectStatus ?? "") === "rate_limited" && Number.isFinite(failAt) && nowMs - failAt < THROTTLE_WINDOW_MS) {
    return { aspFirst: true, why: `this host rate-limited us ${Math.round((nowMs - failAt) / 60_000)}m ago — not spending more free requests on it` };
  }

  const walled = WALLED.has(String(row.lastDirectStatus ?? "")) || row.fetchStrategy === "asp";
  if (!walled) return { aspFirst: false, why: "nothing recorded says a plain fetch is refused here" };

  if (!Number.isFinite(failAt)) {
    return { aspFirst: true, why: `catalogue says this host refuses a plain fetch (${row.lastDirectStatus ?? row.fetchStrategy})` };
  }
  if (nowMs - failAt > WALL_VERDICT_TTL_MS) {
    // Deliberately re-test rather than trust an old verdict forever.
    return { aspFirst: false, why: `the wall verdict is ${Math.round((nowMs - failAt) / 86_400_000)} days old — re-testing a plain fetch` };
  }
  return { aspFirst: true, why: `this host refused a plain fetch ${Math.round((nowMs - failAt) / 3_600_000)}h ago (${row.lastDirectStatus})` };
}

/**
 * What one scan learned about a host, in the shape the catalogue stores.
 *
 * EVERY SCAN TEACHES THE CATALOGUE. This is the whole reason the catalogue can
 * be built without crawling anyone: the buyer asked us to read that page, we
 * read it, and what happened is a fact about the host we already hold. Nothing
 * here is a separate request to a dealer's server.
 *
 * `directStatus` null means the direct path was never attempted on this scan,
 * which must not be recorded as a failure — a scan that went straight to ASP
 * would otherwise write the very verdict that sent it there, forever.
 */
export interface Observation {
  host: string;
  directStatus: string | null;
  usedAsp: boolean;
  platform: string | null;
  at: string;
}

export function buildObservation(
  host: string | null,
  directStatus: string | null,
  usedAsp: boolean,
  platform: string | null,
  atIso: string,
): Observation | null {
  if (!host) return null;
  if (directStatus === null && !usedAsp) return null;   // nothing was learned
  return { host, directStatus, usedAsp, platform: platform || null, at: atIso };
}

/** The platform values dealer_source accepts. Kept beside the migration's check. */
export const CATALOG_PLATFORMS = [
  "sm360", "convertus", "jsonld_itemlist", "edealer", "d2c", "unknown", "other",
] as const;

/** The platforms the inventory crawler knows how to walk. */
export const CRAWLABLE_PLATFORMS = ["sm360", "convertus", "jsonld_itemlist", "edealer"] as const;

/**
 * Which dealer platform this page is served by, from markers in its own HTML.
 *
 * Only the three unambiguous page-blob platforms are claimed. Each marker is a
 * variable name the platform emits inline and nothing else does:
 *
 *     convertus   var vmsData = {...}          _shared/convertus-vms.js
 *     d2c         window.__vdpJSON = {...}     _shared/d2c-vdp.js
 *     edealer     vehicleArray = {...}         scripts/lib/structured-inventory.mjs
 *
 * SM360 is deliberately absent: it is identified by answering a JSON listing
 * endpoint, not by anything in the page, so it cannot be claimed from HTML.
 *
 * JSON-LD is deliberately absent too. `jsonld_itemlist` means "a category page
 * carrying an ItemList of Car nodes", which the crawler walks — a detail page
 * with one Car node is not that, and labelling it so would tell the crawler
 * something false about a host. A platform we cannot name stays 'unknown',
 * which is the honest answer and the one the catalogue is built to hold.
 */
export function detectPlatform(html: unknown): string | null {
  if (typeof html !== "string" || !html) return null;
  if (html.includes("__vdpJSON")) return "d2c";
  if (/\bvmsData\s*=/.test(html)) return "convertus";
  if (html.includes("vehicleArray = {")) return "edealer";
  return null;
}
