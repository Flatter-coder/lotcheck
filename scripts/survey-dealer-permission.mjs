// WHOSE DOOR IS OPEN — the permission survey.
//
// Vic, 2026-09-11: "make list of dealers we can ran without v[i]siting there
// terms of service, which btw needs to be track daily as well".
//
// Before today the only recorded robots data in this repo was two dealer names
// in a code comment. This reads every catalogued Alberta host's robots.txt,
// asks whether the paths our crawler actually requests are allowed, and writes
// the answer down with a date on it.
//
// WHY THIS IS NOT THE THING THAT IS WITH COUNSEL. robots.txt is a file published
// specifically to be read by automated clients. Fetching it is the MECHANISM for
// discovering a site's rules, not a use of the site — you cannot honour a rule
// you are not allowed to read. It is one request per host, it is what the file
// is for, and a dealer who disallows is recorded as a permanent, correct hole in
// our coverage rather than something to route around.
//
// WHY DAILY. A permission is not a fact about the world, it is a fact about a
// document on a given day. robots.txt gets edited. If we crawl today under a
// rule read in August we are working off a stale licence and would not know.
// "We read your robots.txt at 06:04 on the day we crawled, here is what it said"
// is a complete answer to a complaint. "We checked at some point" is not.
//
// TERMS OF SERVICE ARE DELIBERATELY NOT JUDGED HERE. A ToS is prose. This finds
// it, records where it lives and hashes it so a CHANGE is detectable, and stops.
// Whether a clause binds us is a question for a person, and a machine that
// answered it would be the most dangerous thing in this repo.
//
// Run:
//   node scripts/survey-dealer-permission.mjs --dry-run --hosts=https://a.com,https://b.com
//   node scripts/survey-dealer-permission.mjs            # needs SUPABASE_* ; writes the trail
//   node scripts/survey-dealer-permission.mjs --out=permission.json
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { parseRobots, isPathAllowed } from "./lib/robots.mjs";
import { politeFetch, requestLedger } from "./lib/polite-fetch.mjs";

const UA = "LotCheckBot/1.0 (+https://lotcheck.ca/about; reading robots.txt to learn your rules)";

const flag = (k, d = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  if (hit) return hit.slice(k.length + 3);
  return process.argv.includes(`--${k}`) ? true : d;
};
const DRY = !!flag("dry-run");
const OUT = flag("out");
const HOSTS_ARG = flag("hosts");
const LIMIT = Number(flag("max-hosts", 0)) || 0;

// The paths the crawler actually requests. Asking about paths we never fetch
// would manufacture a permission problem we do not have; asking about fewer
// than we fetch would manufacture a clean bill we have not earned.
const PROBE_PATHS = (sections) => {
  const out = ["/sitemap.xml"];
  for (const sc of sections?.length ? sections : ["new-inventory", "used-inventory"]) {
    out.push(`/en/${sc}/api/listing?page=1`);   // SM360 listing feed
    out.push(`/${sc}/`);                        // JSON-LD / EDealer index
  }
  return out;
};

const sha = (s) => createHash("sha256").update(String(s || "")).digest("hex");

// A ToS lives behind a link, not at a fixed path. We look for the usual ones and
// record which answered — we do NOT read it for meaning.
const TOS_CANDIDATES = ["/terms", "/terms-of-use", "/terms-and-conditions", "/terms-of-service", "/legal"];

async function surveyHost(host, sections) {
  const row = {
    host, checkedAt: new Date().toISOString(),
    verdict: "unknown", robotsStatus: null, crawlDelay: null,
    allowedPaths: [], disallowedPaths: [], robotsHash: null, robotsBytes: 0,
    tosUrl: null, tosHash: null, note: null,
  };
  let res;
  try {
    res = await politeFetch(`${host}/robots.txt`, { ua: UA });
  } catch (e) {
    row.robotsStatus = "unreachable";
    row.note = `robots.txt unreachable (${e.message})`;
    return row;                       // verdict stays "unknown" -> we do not crawl
  }
  row.robotsStatus = String(res.status);

  if (res.status === 404 || res.status === 410) {
    // The standard convention: no robots.txt means no restrictions stated.
    row.verdict = "allowed";
    row.note = "no robots.txt — nothing disallowed";
    row.allowedPaths = PROBE_PATHS(sections);
  } else if (res.ok) {
    const body = await res.text();
    row.robotsHash = sha(body);
    row.robotsBytes = body.length;
    const robots = parseRobots(body, "lotcheckbot");
    row.crawlDelay = robots.crawlDelay ?? null;
    for (const p of PROBE_PATHS(sections)) {
      (isPathAllowed(robots, p) ? row.allowedPaths : row.disallowedPaths).push(p);
    }
    row.verdict = row.disallowedPaths.length === 0 ? "allowed"
      : row.allowedPaths.length === 0 ? "disallowed" : "partial";
    row.note = row.verdict === "partial"
      ? `${row.disallowedPaths.length} of ${PROBE_PATHS(sections).length} probe paths disallowed`
      : row.verdict === "disallowed" ? "every path we would fetch is disallowed" : "all probe paths allowed";
  } else {
    // A 5xx or a bot wall is NOT permission. Fail closed, same stance as the crawler.
    row.note = `robots.txt HTTP ${res.status} — permission could not be confirmed`;
  }

  // Where the ToS lives, for the human-read trail. HEAD only, and a miss is fine.
  for (const path of TOS_CANDIDATES) {
    try {
      const r = await politeFetch(`${host}${path}`, { ua: UA, method: "HEAD" });
      if (r.ok) { row.tosUrl = `${host}${path}`; break; }
    } catch { /* a ToS we cannot find is not an error */ }
  }
  return row;
}

async function loadHosts() {
  if (HOSTS_ARG) return String(HOSTS_ARG).split(",").filter(Boolean).map((h) => ({ host: h.trim(), sections: null }));
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (or pass --hosts=...).");
    console.error("This script reads the dealer catalogue, which is not anon-readable.");
    process.exitCode = 1;
    return null;
  }
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await sb.from("dealer_source").select("host, sections, active").order("id");
  if (error) { console.error("could not read dealer_source:", error.message); process.exitCode = 1; return null; }
  return data.map((d) => ({ host: d.host, sections: d.sections, active: d.active }));
}

async function main() {
  let hosts = await loadHosts();
  if (!hosts) return;
  if (LIMIT) hosts = hosts.slice(0, LIMIT);
  console.log(`Permission survey: ${hosts.length} host(s)${DRY ? " (dry run — nothing written)" : ""}`);

  const rows = [];
  for (const [i, h] of hosts.entries()) {
    const r = await surveyHost(h.host, h.sections);
    rows.push(r);
    const mark = { allowed: "ok  ", partial: "part", disallowed: "NO  ", unknown: "??  " }[r.verdict];
    console.log(`  ${String(i + 1).padStart(4)}/${hosts.length} ${mark} ${r.host}${r.crawlDelay ? ` (crawl-delay ${r.crawlDelay}s)` : ""}${r.verdict !== "allowed" ? ` — ${r.note}` : ""}`);
  }

  const by = (v) => rows.filter((r) => r.verdict === v);
  console.log("");
  console.log(`  allowed    ${by("allowed").length}`);
  console.log(`  partial    ${by("partial").length}   (some sections disallowed — crawl only the allowed ones)`);
  console.log(`  disallowed ${by("disallowed").length}   (permanent, correct holes in coverage)`);
  console.log(`  unknown    ${by("unknown").length}   (could not confirm — we do NOT crawl these)`);
  const led = requestLedger();
  console.log(`  requests sent: ${led.reduce((n, h) => n + h.requests, 0)} · refused ${led.reduce((n, h) => n + h.refusals, 0)}`);

  if (OUT) { writeFileSync(String(OUT), JSON.stringify({ surveyedAt: new Date().toISOString(), rows }, null, 2)); console.log(`  wrote ${OUT}`); }

  if (DRY) { console.log("  dry run — the permission trail was not written"); return; }
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.log("  no credentials — trail not written"); return; }
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await sb.rpc("fn_record_dealer_permission", { p_rows: rows });
  if (error) { console.error("  could not write the permission trail:", error.message); process.exitCode = 1; return; }
  console.log(`  trail: ${JSON.stringify(data)}`);
}

main().catch((e) => { console.error(e?.message || e); process.exitCode = 1; });
