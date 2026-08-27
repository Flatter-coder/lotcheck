// ============================================================================
// robots.txt handling for the standing Alberta inventory crawl.
//
// A per-buyer single-page read (production) is one thing; a STANDING nightly bulk
// crawl is held to a higher bar, and honouring robots.txt is the first line of
// that bar (it's named in the legal brief's Q17 as a defensibility guardrail).
// This module: parses a host's robots.txt, selects the group for OUR agent
// (else '*'), and answers isPathAllowed with the Google longest-match rule
// (the most specific pattern wins; a tie goes to Allow). It also surfaces
// Crawl-delay. Pure + fully tested (scripts/test-robots.mjs).
//
// Fetch policy lives in the crawler: a 404 means "no robots.txt -> allowed"
// (the standard convention); any OTHER failure means "couldn't confirm
// permission -> skip this dealer today" (fail-safe, matching the crawler's
// existing skip-on-failure philosophy).
// ============================================================================

// Parse robots.txt into the rule set + crawl-delay that apply to `uaProduct`
// (e.g. "lotcheckbot"). Groups are formed the standard way: consecutive
// User-agent lines share the rules that follow, until a User-agent line that
// comes AFTER at least one rule starts a new group.
export function parseRobots(text, uaProduct) {
  const groups = [];
  let cur = null;
  let sawRuleSinceAgent = false;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!cur || sawRuleSinceAgent) { cur = { agents: [], rules: [], crawlDelay: null }; groups.push(cur); sawRuleSinceAgent = false; }
      cur.agents.push(value.toLowerCase());
    } else if (cur && (field === "disallow" || field === "allow")) {
      sawRuleSinceAgent = true;
      cur.rules.push({ allow: field === "allow", path: value });
    } else if (cur && field === "crawl-delay") {
      sawRuleSinceAgent = true;
      const d = Number(value);
      if (Number.isFinite(d) && d >= 0) cur.crawlDelay = d;
    }
  }

  // Pick the most specific matching group: an exact/substring match on our
  // product token beats '*'; a longer matching token is more specific.
  const prod = String(uaProduct || "").toLowerCase();
  let chosen = null, chosenScore = -1;
  for (const g of groups) {
    for (const a of g.agents) {
      let score = -1;
      if (a === "*") score = 0;
      else if (prod && a && (prod.includes(a) || a.includes(prod))) score = a.length;
      if (score > chosenScore) { chosenScore = score; chosen = g; }
    }
  }
  return chosen ? { rules: chosen.rules, crawlDelay: chosen.crawlDelay } : { rules: [], crawlDelay: null };
}

// A robots path pattern -> RegExp anchored at the path start. '*' = any run of
// chars, '$' = end-of-path anchor; every other regex metachar is escaped.
function patternToRegExp(pattern) {
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "$") re += "$";
    else re += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re);
}

// Is `path` (e.g. "/used-inventory/") crawlable under these rules? Longest
// matching pattern wins; a tie goes to Allow. No matching rule => allowed.
// An empty Disallow ("Disallow:") means "allow all" and constrains nothing.
export function isPathAllowed(robots, path) {
  const rules = (robots && robots.rules) || [];
  let best = null; // { allow, len }
  for (const r of rules) {
    if (!r.path) continue; // empty Disallow = allow all; empty Allow = no-op
    if (patternToRegExp(r.path).test(path)) {
      const len = r.path.length;
      if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) {
        best = { allow: r.allow, len };
      }
    }
  }
  return best ? best.allow : true;
}
