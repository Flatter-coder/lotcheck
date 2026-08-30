// ============================================================================
// Build the Alberta dealer-website CATALOGUE from the regulator's own roster.
//
// WHY. dealer_source held 30 hosts — the ones a feed probe had already
// confirmed crawlable. Alberta has 1,639 distinct dealer websites (AMVIC
// licensees with a website), so we knew 1.8% of the province and rediscovered
// the rest from scratch on every scan. Vic, 2026-08-30: "we should have them
// all listed on place".
//
// WHAT IT DOES NOT DO. It touches no dealer's server. Every host here comes out
// of amvic_licensees, a table we already hold, and rows land with
// platform 'unknown' and active FALSE — invisible to crawl-alberta-inventory,
// which selects only active rows on a crawlable platform. Cataloguing a host is
// not crawling it, and the standing-crawl question stays exactly where it is.
//
// WHAT FILLS IN THE REST. Two things, neither of them a crawl:
//   * every live scan writes back what it learned (fn_dealer_catalog_observe)
//   * discover-dealer-feeds.mjs, when it is run, promotes hosts it confirms
//
// NEVER DOWNGRADES. A row the feed probe already owns keeps its platform, its
// active flag and its name; this only ever fills gaps and adds hosts.
//
// Run (Node 24+, from repo root):
//   node scripts/build-dealer-catalog.mjs                 # dry run, prints the plan
//   node scripts/build-dealer-catalog.mjs --write         # commit
//   node scripts/build-dealer-catalog.mjs --write --limit 50
// ============================================================================

import { toOrigin } from "../supabase/functions/_shared/dealer-catalog.ts";

const ARG = (n, d = null) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const WRITE = process.argv.includes("--write");
const LIMIT = Number(ARG("--limit", "0")) || 0;

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) {
  console.error("Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const { createClient } = await import("@supabase/supabase-js");
const supabase = createClient(URL_, KEY);

// MUST paginate, and MUST order. PostgREST caps a response at 1000 rows and
// there are 21,866 licensees, so an unpaginated read silently truncates to the
// first page and reads like a real, small result. And a paginated read with no
// ORDER BY has no guaranteed row order, so successive windows can overlap and
// leave gaps — which is exactly how "1,639 distinct hosts" stopped being
// reproducible once before (aa77a97).
async function allLicenseesWithWebsite() {
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("amvic_licensees")
      .select("id,name,trade_name,city,website,facility_status,facility_type")
      .not("website", "is", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error("could not read amvic_licensees:", error.message); process.exit(1); }
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

async function existingCatalog() {
  const byKey = new Map();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("dealer_source").select("id,host,platform,active,name,city,source")
      .order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) { console.error("could not read dealer_source:", error.message); process.exit(1); }
    for (const r of data || []) byKey.set(r.host.toLowerCase().replace(/^https:\/\/www\./, "https://"), r);
    if (!data || data.length < PAGE) break;
  }
  return byKey;
}

const all = await allLicenseesWithWebsite();

// facility_status carries AMVIC's OWN string, verbatim — "Issued" is the valid
// one, not "Active". Filtering on /active/i matches nothing and returns an
// empty list that looks exactly like "no licensed dealer has a website".
const issued = all.filter((r) => /issued/i.test(r.facility_status || ""));
const byStatus = new Map();
for (const r of all) byStatus.set(r.facility_status || "(none)", (byStatus.get(r.facility_status || "(none)") || 0) + 1);

console.log(`${all.length} AMVIC licensees with a website. Status breakdown:`);
for (const [k, n] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(5)}  ${k}`);
console.log(`${issued.length} of them hold an Issued licence.\n`);

// One row per HOST, not per licensee: several licensees legitimately share a
// site (a group's rooftops), and the catalogue is keyed on the website.
const byKey = new Map();
let unusable = 0;
for (const r of issued) {
  const origin = toOrigin(r.website);
  if (!origin) { unusable++; continue; }
  const key = origin.toLowerCase().replace(/^https:\/\/www\./, "https://");
  const prior = byKey.get(key);
  if (prior) { prior.licensees++; continue; }
  byKey.set(key, {
    key, host: origin,
    name: (r.trade_name && r.trade_name !== "N/A" ? r.trade_name : null) || r.name || null,
    city: r.city || null,
    amvic_id: r.id, facility_type: r.facility_type || null, licence_status: r.facility_status || null,
    licensees: 1,
  });
}

console.log(`${byKey.size} distinct usable hosts (${unusable} website values were not a usable origin).`);

const existing = await existingCatalog();
const fresh = [...byKey.values()].filter((c) => !existing.has(c.key));
const known = byKey.size - fresh.length;
console.log(`${known} already catalogued, ${fresh.length} new.\n`);

const byType = new Map();
for (const c of byKey.values()) byType.set(c.facility_type || "(none)", (byType.get(c.facility_type || "(none)") || 0) + 1);
console.log("Facility types among the hosts:");
for (const [k, n] of [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`   ${String(n).padStart(5)}  ${k}`);

const toInsert = (LIMIT ? fresh.slice(0, LIMIT) : fresh).map((c) => ({
  host: c.host,
  // 'unknown' until something positively identifies it. An honest default beats
  // a guess that the crawler would then act on.
  platform: "unknown",
  // Catalogued, not crawled. crawl-alberta-inventory selects active rows on a
  // crawlable platform, so these are invisible to it.
  active: false,
  source: "amvic",
  name: c.name, city: c.city, province: "AB",
  amvic_id: c.amvic_id, facility_type: c.facility_type, licence_status: c.licence_status,
}));

if (!WRITE) {
  console.log(`\nDRY RUN — would insert ${toInsert.length} rows. Sample:`);
  for (const r of toInsert.slice(0, 8)) console.log(`   ${r.host}  ${r.name ?? ""} ${r.city ? "(" + r.city + ")" : ""}`);
  console.log("\nRe-run with --write to commit.");
  process.exit(0);
}

// Chunked, and ignoreDuplicates so a concurrent run or a re-run is a no-op
// rather than an error — and so a host the feed probe owns is never rewritten.
let written = 0;
const CHUNK = 500;
for (let i = 0; i < toInsert.length; i += CHUNK) {
  const slice = toInsert.slice(i, i + CHUNK);
  const { error } = await supabase.from("dealer_source").upsert(slice, { onConflict: "host", ignoreDuplicates: true });
  if (error) { console.error(`insert failed at ${i}:`, error.message); process.exit(1); }
  written += slice.length;
  console.log(`   wrote ${written}/${toInsert.length}`);
}

const { data: cov } = await supabase.rpc("fn_catalog_coverage");
console.log("\nCatalogue now:", JSON.stringify(cov, null, 1));
