// Regression suite for the crawler's robots.txt guardrail (lib/robots.mjs).
// Run: node scripts/test-robots.mjs
//
// A standing nightly crawl must honour robots.txt (named in the legal brief's
// Q17 as a defensibility guardrail). This locks the parsing + longest-match
// Allow/Disallow rules so a future edit can't silently start ignoring a dealer
// that asked not to be crawled.

import { parseRobots, isPathAllowed } from "./lib/robots.mjs";

let pass = 0, fail = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); cond ? pass++ : fail++; };

const UA = "lotcheckbot";

// ---- 1. A blanket block on our agent ----
{
  const r = parseRobots("User-agent: LotCheckBot\nDisallow: /", UA);
  check("blanket Disallow: / blocks the section root", isPathAllowed(r, "/used-inventory/") === false);
  check("blanket Disallow: / blocks the site root", isPathAllowed(r, "/") === false);
}

// ---- 2. A block that names only OUR agent, with a '*' allow-all group ----
{
  const txt = "User-agent: *\nDisallow:\n\nUser-agent: lotcheckbot\nDisallow: /";
  const r = parseRobots(txt, UA);
  check("our-agent-specific block beats the permissive * group", isPathAllowed(r, "/inventory/") === false);
  const other = parseRobots(txt, "googlebot");
  check("a different agent falls to the permissive * group (empty Disallow = allow all)", isPathAllowed(other, "/inventory/") === true);
}

// ---- 3. Section-level Disallow, everything else allowed ----
{
  const r = parseRobots("User-agent: *\nDisallow: /admin/\nDisallow: /cart", UA);
  check("a Disallowed directory is blocked", isPathAllowed(r, "/admin/users") === false);
  check("an unrelated section stays allowed", isPathAllowed(r, "/used-inventory/") === true);
  check("Disallow: /cart matches by prefix", isPathAllowed(r, "/cart/checkout") === false);
}

// ---- 4. Longest-match wins; a tie goes to Allow (the Google convention) ----
{
  const r = parseRobots("User-agent: *\nDisallow: /inventory\nAllow: /inventory/used", UA);
  check("broad Disallow blocks the general path", isPathAllowed(r, "/inventory/new") === false);
  check("a more specific Allow re-opens its subtree", isPathAllowed(r, "/inventory/used/civic") === true);
}

// ---- 5. Wildcards and the end-anchor ----
{
  const r = parseRobots("User-agent: *\nDisallow: /*/api/\nDisallow: /*.json$", UA);
  check("'*' wildcard matches a variable segment", isPathAllowed(r, "/en/api/listing") === false);
  check("'$' anchors the match to the path end", isPathAllowed(r, "/data/feed.json") === false);
  check("'$' does NOT match when more path follows", isPathAllowed(r, "/data/feed.json/raw") === true);
}

// ---- 6. No matching rule => allowed; empty robots => allowed ----
{
  check("empty robots.txt => everything allowed", isPathAllowed(parseRobots("", UA), "/anything") === true);
  const r = parseRobots("User-agent: *\nDisallow: /nope", UA);
  check("a path no rule matches is allowed", isPathAllowed(r, "/yes") === true);
}

// ---- 7. Crawl-delay is surfaced for the matching group ----
{
  const r = parseRobots("User-agent: lotcheckbot\nCrawl-delay: 10\nDisallow: /admin", UA);
  check("crawl-delay is read as a number", r.crawlDelay === 10);
  const none = parseRobots("User-agent: *\nDisallow: /admin", UA);
  check("absent crawl-delay is null", none.crawlDelay === null);
}

// ---- 8. Comments and casing are tolerated ----
{
  const r = parseRobots("# hello\nUSER-AGENT: *\nDISALLOW: /private  # secret", UA);
  check("directive casing is normalized", isPathAllowed(r, "/private/x") === false);
  check("trailing comments are stripped from the value", isPathAllowed(r, "/public") === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
