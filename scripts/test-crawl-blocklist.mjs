// GATE: the standing crawl's permission has a scope, and code enforces it.
//
// The clearance to crawl Alberta daily came with a condition, stated by Vic on
// 2026-09-22: dealer websites only — no Facebook, AutoTrader, Kijiji, CarGurus.
//
// Until crawl-blocklist.mjs that condition held ONLY because those hosts happen
// not to be in dealer_source. A term of a legal clearance resting on the
// contents of a table is a guard that cannot fail: one discovery run that seeds
// a marketplace, or one row added by hand, and the crawl breaches the terms it
// was granted under with nothing to stop it and nobody told.
//
// This gate exists because that failure would be silent, permanent, and
// discovered by somebody other than us.
import { isCrawlAllowed, partitionByScope, blockedHosts } from "./lib/crawl-blocklist.mjs";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`ok    ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
};

// ---- the four named in the clearance, in every shape a row might hold -----
const NAMED = ["facebook.com", "autotrader.ca", "kijiji.ca", "cargurus.ca"];
for (const host of NAMED) {
  for (const shape of [
    host, `www.${host}`, `https://${host}`, `https://www.${host}/`,
    `HTTPS://WWW.${host.toUpperCase()}`, `http://${host}:8080/inventory`,
    `https://dealers.${host}/listings`,            // a subdomain is still them
  ]) {
    check(`refuses ${shape}`, isCrawlAllowed(shape) === false, shape);
  }
}

// ---- other aggregators, same category ------------------------------------
for (const host of ["carpages.ca", "autohebdo.net", "clutch.ca", "craigslist.org", "carvana.com", "cars.com"]) {
  check(`refuses aggregator ${host}`, isCrawlAllowed(host) === false);
}

// ---- real Alberta dealers must still be crawlable ------------------------
// A blocklist that also blocks the job is worse than none: it would read as
// "the crawl found nothing" rather than "the crawl was switched off".
for (const host of [
  "https://www.citygm.com", "tazaparkvw.com", "www.wheatonhonda.com",
  "https://www.stadiumnissan.com/", "silverzincmotors.com", "uniquemv.com",
  "https://www.mcdonaldnissan.com",
  // a dealer whose name merely CONTAINS a blocked brand's word
  "autotraderscalgary.example.ca", "myfacebookmotors.ca",
]) check(`allows dealer ${host}`, isCrawlAllowed(host) === true, host);

// ---- an unnameable host is blocked, not allowed --------------------------
// We do not crawl something we cannot name.
for (const bad of ["", "   ", null, undefined, "localhost", "not a host", "/inventory"]) {
  check(`refuses unnameable host ${JSON.stringify(bad)}`, isCrawlAllowed(bad) === false);
}

// ---- partitioning reports, never silently drops --------------------------
const { allowed, blocked } = partitionByScope([
  { host: "https://www.citygm.com" },
  { host: "https://www.autotrader.ca" },
  { host: "tazaparkvw.com" },
  { host: "https://marketplace.facebook.com/vehicles" },
  { host: null },
]);
check("permitted dealers pass through", allowed.length === 2, JSON.stringify(allowed.map((d) => d.host)));
check("out-of-scope hosts are separated, not dropped", blocked.length === 3, JSON.stringify(blocked.map((d) => d.host)));
check("the caller can name what was excluded", blocked.every((d) => "host" in d));
check("an empty list partitions cleanly",
  partitionByScope([]).allowed.length === 0 && partitionByScope(null).blocked.length === 0);

// ---- the crawler actually calls it ---------------------------------------
// A blocklist nothing consults is the built-but-unwired shape, and here it
// would look exactly like a crawl that respects its clearance.
const crawler = readFileSync(new URL("./crawl-alberta-inventory.mjs", import.meta.url), "utf8");
check("the crawler imports the blocklist", /from\s+["']\.\/lib\/crawl-blocklist\.mjs["']/.test(crawler));
check("the crawler partitions its dealer list", /partitionByScope\s*\(/.test(crawler));
check("the crawler reports what it excluded",
  /OUT OF SCOPE/.test(crawler), "the run must say which hosts it dropped");
// It must filter BEFORE the per-run bound, or a blocked host could consume a
// slot and silently push a real dealer to tomorrow.
check("scope is applied before the max-dealers bound",
  crawler.indexOf("partitionByScope") < crawler.indexOf("dealers.length > MAX_DEALERS"));

// ---- the gate must be able to fail ---------------------------------------
check("the blocklist is not empty", blockedHosts().length >= 8, String(blockedHosts().length));
check("every host named in the clearance is on it",
  NAMED.every((h) => blockedHosts().includes(h)), blockedHosts().join(","));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
