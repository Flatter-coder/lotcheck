// Hosts the standing crawl must never touch, enforced in code.
//
// WHY THIS IS A FILE AND NOT A CONVENTION. The clearance to run a standing
// crawl across Alberta came with a condition, stated by Vic on 2026-09-22:
// dealer websites only — no Facebook, AutoTrader, Kijiji or CarGurus.
//
// Until now that condition held only because those hosts happen not to be in
// dealer_source. A condition of a legal clearance resting on the contents of a
// table is a guard that cannot fail: one discovery run that seeds a
// marketplace, or one row added by hand, and the crawl breaches the terms it
// was granted under with nothing to stop it and nothing to notice.
//
// So it is enforced where the crawl actually reads its list, on every run,
// and the run says out loud when it drops something. A silent exclusion and a
// missing adapter look identical from the outside.
//
// THIS IS NOT A ROBOTS RULE AND NOT A POLITENESS RULE. Those already exist
// separately (scripts/lib/robots.mjs, and the crawl's honest User-Agent). This
// is the scope of a permission, and it is checked first.

// Marketplaces and aggregators: their inventory is not a dealer's own
// publication, and their terms are the open question counsel has never
// answered. [[aggregator-scraping-tos]]
const BLOCKED = [
  // named explicitly in the clearance
  "facebook.com", "fb.com", "marketplace.facebook.com",
  "autotrader.ca", "autotrader.com",
  "kijiji.ca", "kijijiautos.ca",
  "cargurus.ca", "cargurus.com",
  // same category, same reasoning — an aggregator is an aggregator whether or
  // not it was named in the sentence
  "carpages.ca", "autohebdo.net", "clutch.ca", "canadadrives.ca",
  "carfax.ca", "vinaudit.com", "craigslist.org", "ebay.ca", "ebay.com",
  "trader.ca", "autotrader.co.uk", "cars.com", "carmax.com", "carvana.com",
];

/**
 * Normalise a host the way the catalogue does, so "https://WWW.Kijiji.ca/x"
 * and "kijiji.ca" are the same thing to this check.
 */
function normHost(value) {
  let h = String(value || "").trim().toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");   // any scheme, not just http(s)
  h = h.split("/")[0].split("?")[0].split("#")[0];
  h = h.split("@").pop();                          // user:pass@host
  h = h.split(":")[0];                             // port
  return h.replace(/^www\./, "").replace(/\.$/, "");
}

/**
 * Is this host inside the crawl's permitted scope?
 *
 * A subdomain of a blocked host is blocked too — dealers.autotrader.ca is
 * still AutoTrader. An unparseable or empty host is BLOCKED, not allowed: we
 * do not crawl something we cannot name.
 */
export function isCrawlAllowed(host) {
  const h = normHost(host);
  if (!h || !h.includes(".")) return false;
  return !BLOCKED.some((bad) => h === bad || h.endsWith(`.${bad}`));
}

/** The blocked hosts, for the run to report and for the gate to check. */
export function blockedHosts() {
  return [...BLOCKED];
}

/**
 * Split a dealer list into what may be crawled and what may not.
 * The caller MUST report `blocked` — a silent exclusion is indistinguishable
 * from a missing adapter.
 */
export function partitionByScope(dealers) {
  const allowed = [], blocked = [];
  for (const d of (dealers || [])) {
    (isCrawlAllowed(d && d.host) ? allowed : blocked).push(d);
  }
  return { allowed, blocked };
}
