// ============================================================================
// Regression suite for the Alberta dealer-website catalogue's decisions.
//
// The catalogue exists so a scan stops rediscovering every host from scratch.
// Its ONE job at request time is choosing which way to fetch first, so these
// are the cases that matter: a known-walled host must not spend the request
// budget re-proving the wall, and a stale or wrong verdict must never cost more
// than one attempt.
//
// Run (Node 24+, from repo root):
//   node --experimental-strip-types supabase/functions/_shared/dealer-catalog.test.ts
// ============================================================================

import {
  toOrigin, catalogKey, chooseFetchPlan, buildObservation,
  WALL_VERDICT_TTL_MS, THROTTLE_WINDOW_MS, CATALOG_PLATFORMS, CRAWLABLE_PLATFORMS,
  directVerdict, REFUSAL_CODES, originVariants,
} from "./dealer-catalog.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  -- ${detail}` : ""}`); }
};

const NOW = Date.parse("2026-08-30T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000, DAY = 24 * HOUR;

console.log("\nThe catalogue key");

check("a bare domain becomes an https origin",
  toOrigin("advantageford.ca") === "https://advantageford.ca");

check("a full listing URL is reduced to its origin",
  toOrigin("https://www.advantageford.ca/inventory/2025-gmc-acadia/") === "https://www.advantageford.ca");

check("http is normalised to https",
  toOrigin("http://www.example-dealer.ca/x") === "https://www.example-dealer.ca");

check("a dealer's Facebook page is not a dealer website",
  toOrigin("https://www.facebook.com/somedealer") === null &&
  toOrigin("https://instagram.com/somedealer") === null);

check("mail and phone links are not websites",
  toOrigin("mailto:sales@dealer.ca") === null && toOrigin("tel:4035551234") === null);

check("junk is null, never a throw",
  toOrigin(null) === null && toOrigin("") === null && toOrigin("   ") === null &&
  toOrigin(42 as unknown as string) === null && toOrigin("not a url at all") === null);

{
  // AMVIC records the bare domain; the live site redirects to www; the buyer
  // pastes whichever their browser shows. Keyed on the raw hostname the same
  // dealer files twice and neither lookup finds the other.
  const a = catalogKey("https://www.advantageford.ca/inventory/x/");
  const b = catalogKey("advantageford.ca");
  check("www and non-www are the same dealer", a === b && a === "https://advantageford.ca", `${a} vs ${b}`);
}

check("the lookup key survives a path, a query and a fragment",
  catalogKey("https://www.d.ca/inventory/2025-gmc?x=1#top") === catalogKey("https://d.ca"));

console.log("\nWhich way to fetch first");

{
  const p = chooseFetchPlan(null, NOW);
  check("an unknown host falls back to today's ladder, never a refusal",
    p.aspFirst === false && p.why.length > 10, JSON.stringify(p));
}

{
  const p = chooseFetchPlan({ host: "https://d.ca", lastDirectOkAt: ago(2 * HOUR) }, NOW);
  check("a host that answered a plain fetch keeps getting one", p.aspFirst === false, JSON.stringify(p));
}

{
  // The measured case: 28% of Alberta hosts refuse a datacenter IP outright.
  const p = chooseFetchPlan({ host: "https://d.ca", lastDirectStatus: "challenged", lastDirectFailAt: ago(2 * HOUR) }, NOW);
  check("a host that served a challenge shell 2h ago goes straight to ASP",
    p.aspFirst === true && /refused a plain fetch/.test(p.why), JSON.stringify(p));
}

{
  // THIS CASE USED TO ASSERT THE BUG. It read `lastDirectStatus: "http_error"`
  // and called it "a 403 counts as a wall" -- but http_error was every non-OK
  // status except 429/503, so the very same value a SOLD vehicle's 404
  // produces. The gate encoded the conflation instead of catching it. A
  // refusal is now its own verdict, resolved from the status code.
  const p = chooseFetchPlan({ host: "https://d.ca", lastDirectStatus: "refused", lastDirectFailAt: ago(30 * 60_000) }, NOW);
  check("a 403 counts as a wall", p.aspFirst === true, JSON.stringify(p));
}

{
  // A blip is not a wall. Recording one as a wall would spend a paid credit on
  // every future scan of a host that answers a plain GET perfectly well.
  const p = chooseFetchPlan({ host: "https://d.ca", lastDirectStatus: "network", lastDirectFailAt: ago(1 * HOUR) }, NOW);
  check("a network blip is not a wall", p.aspFirst === false, JSON.stringify(p));
  const q = chooseFetchPlan({ host: "https://d.ca", lastDirectStatus: "empty", lastDirectFailAt: ago(1 * HOUR) }, NOW);
  check("an empty body is not a wall either", q.aspFirst === false, JSON.stringify(q));
}

{
  // Sites change CDN configuration. A verdict that never expires turns a
  // temporary block into a permanent paid detour.
  const stale = chooseFetchPlan({ host: "https://d.ca", lastDirectStatus: "challenged", lastDirectFailAt: ago(WALL_VERDICT_TTL_MS + DAY) }, NOW);
  check("a wall verdict older than the TTL is re-tested with a free fetch",
    stale.aspFirst === false && /re-testing/.test(stale.why), JSON.stringify(stale));
  const fresh = chooseFetchPlan({ host: "https://d.ca", lastDirectStatus: "challenged", lastDirectFailAt: ago(WALL_VERDICT_TTL_MS - DAY) }, NOW);
  check("and one inside the TTL is still trusted", fresh.aspFirst === true, JSON.stringify(fresh));
}

{
  // Success after failure settles it, whatever the old verdict said.
  const p = chooseFetchPlan({
    host: "https://d.ca", lastDirectStatus: "challenged",
    lastDirectFailAt: ago(3 * DAY), lastDirectOkAt: ago(1 * DAY),
  }, NOW);
  check("a plain fetch that worked SINCE the failure clears the wall",
    p.aspFirst === false && /since its last failure/.test(p.why), JSON.stringify(p));
}

{
  const p = chooseFetchPlan({
    host: "https://d.ca", lastDirectStatus: "challenged",
    lastDirectFailAt: ago(1 * DAY), lastDirectOkAt: ago(3 * DAY),
  }, NOW);
  check("but an OLDER success does not clear a NEWER failure", p.aspFirst === true, JSON.stringify(p));
}

{
  const p = chooseFetchPlan({ host: "https://d.ca", fetchStrategy: "asp" }, NOW);
  check("an explicit asp strategy with no timestamps is honoured", p.aspFirst === true, JSON.stringify(p));
}

check("every plan explains itself",
  [null, { host: "h" }, { host: "h", lastDirectStatus: "challenged", lastDirectFailAt: ago(HOUR) }]
    .every((r) => chooseFetchPlan(r as never, NOW).why.length > 10));

console.log("\nA bad page is not a walled host");

{
  // THE ONE THAT WOULD HAVE HURT MOST. `http_error` covered every non-OK
  // status except 429/503, so a 404 on a vehicle that had just sold arrived
  // indistinguishable from a Cloudflare 403 -- and ONE buyer pasting a
  // delisted listing would have pinned that dealer's whole site to the paid
  // render path for a week.
  check("a 404 on a sold listing says nothing about the host",
    directVerdict("http_error", 404) === "http_error");
  check("a 500 says nothing about the host either",
    directVerdict("http_error", 500) === "http_error");
  check("a 403 IS a refusal to serve us",
    directVerdict("http_error", 403) === "refused");
  check("so are 401, 407 and 451",
    directVerdict("http_error", 401) === "refused" &&
    directVerdict("http_error", 407) === "refused" &&
    directVerdict("http_error", 451) === "refused");
  check("a verdict with no code stays what it was",
    directVerdict("http_error", null) === "http_error" && directVerdict("challenged") === "challenged");
  check("other statuses pass through untouched",
    directVerdict("ok", 200) === "ok" && directVerdict("network") === "network" &&
    directVerdict("rate_limited", 429) === "rate_limited");
}

{
  const p = chooseFetchPlan({ host: "https://d.ca", lastDirectStatus: "http_error", lastDirectFailAt: ago(2 * HOUR) }, NOW);
  check("a plain http_error host is NOT sent down the paid path",
    p.aspFirst === false, JSON.stringify(p));
  const q = chooseFetchPlan({ host: "https://d.ca", lastDirectStatus: "refused", lastDirectFailAt: ago(2 * HOUR) }, NOW);
  check("a refused host is", q.aspFirst === true, JSON.stringify(q));
}

{
  // Answering a throttle with MORE free requests is the wrong move; the
  // render is a different address entirely. Its own SHORT window, because a
  // 429 lifts in minutes where a bot wall does not.
  const fresh = chooseFetchPlan({ host: "https://d.ca", lastDirectStatus: "rate_limited", lastDirectFailAt: ago(10 * 60_000) }, NOW);
  check("a host that rate-limited us minutes ago is not asked again for free",
    fresh.aspFirst === true && /rate-limited/.test(fresh.why), JSON.stringify(fresh));
  const old = chooseFetchPlan({ host: "https://d.ca", lastDirectStatus: "rate_limited", lastDirectFailAt: ago(3 * HOUR) }, NOW);
  check("and the throttle window is much shorter than the wall TTL",
    old.aspFirst === false && THROTTLE_WINDOW_MS < WALL_VERDICT_TTL_MS, JSON.stringify(old));
}

console.log("\nWhat a scan teaches the catalogue");

{
  const o = buildObservation("https://d.ca", "ok", false, "d2c", new Date(NOW).toISOString());
  check("a successful direct read is recorded with its platform",
    !!o && o.directStatus === "ok" && o.usedAsp === false && o.platform === "d2c", JSON.stringify(o));
}

{
  const o = buildObservation("https://d.ca", "challenged", true, null, new Date(NOW).toISOString());
  check("a wall plus a successful ASP read is one observation",
    !!o && o.directStatus === "challenged" && o.usedAsp === true, JSON.stringify(o));
}

{
  // A scan that went straight to ASP never tried the direct path, so it learned
  // nothing about the wall. Recording "failed" there would write the very
  // verdict that sent it to ASP -- self-confirming, forever.
  const o = buildObservation("https://d.ca", null, true, "convertus", new Date(NOW).toISOString());
  check("skipping the direct path records no direct verdict",
    !!o && o.directStatus === null, JSON.stringify(o));
}

check("a scan that learned nothing writes nothing",
  buildObservation("https://d.ca", null, false, null, new Date(NOW).toISOString()) === null);

check("no host means no observation",
  buildObservation(null, "ok", false, "d2c", new Date(NOW).toISOString()) === null);

console.log("\nThe platform vocabulary");

check("the catalogue can hold a host whose platform we do not know yet",
  CATALOG_PLATFORMS.includes("unknown" as never));

check("d2c is a first-class platform (we have had the reader all along)",
  CATALOG_PLATFORMS.includes("d2c" as never));

check("every crawlable platform is a catalogue platform",
  CRAWLABLE_PLATFORMS.every((p) => CATALOG_PLATFORMS.includes(p as never)));

check("the crawler's set excludes the catalogue-only values",
  !CRAWLABLE_PLATFORMS.includes("unknown" as never) && !CRAWLABLE_PLATFORMS.includes("other" as never) &&
  !CRAWLABLE_PLATFORMS.includes("d2c" as never));

// ---------------------------------------------------------------------------
// The other forms of the same URL.
//
// 53 of 78 TLS "failures" in the 2026-08-31 re-probe were live sites we had
// asked for on the wrong scheme. These pin that the fallback exists, that it
// never re-spends the request that already failed, and that it cannot invent a
// hostname that was never in the roster.
console.log("\nOrigin variants (the same site, asked for differently)");

check("plain http is tried first -- 47 of the 53 recoveries were exactly that",
  originVariants("https://www.berniesauto.ca")[0] === "http://www.berniesauto.ca");

check("the www-flipped name is offered too",
  originVariants("https://www.parkmazda.ca").includes("https://parkmazda.ca"));

check("a bare name gets its www form, not a stripped one",
  originVariants("https://parkmazda.ca").includes("https://www.parkmazda.ca"));

check("the origin we already tried is NOT returned -- it would re-spend the failed request",
  !originVariants("https://www.autohub.ca").includes("https://www.autohub.ca"));

check("every variant is a well-formed origin",
  originVariants("https://www.autohub.ca").every((v) => /^https?:\/\/[a-z0-9.-]+$/i.test(v)));

check("no duplicates -- a duplicate is a wasted request against a walled host",
  new Set(originVariants("https://www.autohub.ca")).size === originVariants("https://www.autohub.ca").length);

check("an IP address is not given an invented www form",
  !originVariants("https://192.168.1.10").some((v) => v.includes("www.")));

check("a hostname with no dot cannot be flipped into a fake domain",
  originVariants("https://localhost").every((v) => !v.includes("www.")));

check("junk in, empty out -- never a variant list built on nothing",
  originVariants(null).length === 0 && originVariants("").length === 0 && originVariants("n/a").length === 0);

check("variants preserve the hostname exactly; only scheme and www move",
  originVariants("https://www.sherwoodparktoyota.com")
    .every((v) => v.replace(/^https?:\/\//, "").replace(/^www\./, "") === "sherwoodparktoyota.com"));

console.log(`\n${pass}/${pass + fail} passed${fail ? "  -- FAILING" : "  all green"}`);
if (fail) (globalThis as never as { process?: { exit?: (n: number) => void } }).process?.exit?.(1);
