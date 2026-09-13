// GATE: the place_id cache holds an identifier, and never licensed data.
//
// Google Maps Platform caps caching of Places data at 30 CONSECUTIVE DAYS.
// place_id is the ONLY indefinite exemption:
//   https://developers.google.com/maps/documentation/places/web-service/policies
//
// So dealer_place -- which we keep forever -- may hold place_id and our own
// keys, and nothing else. Rating, review count, review text, display name and
// formatted address are 30-day data and belong in dealer_sentiment_cache, which
// expires them.
//
// The pressure to break this is obvious and will arrive: caching the rating
// beside the id makes a report faster and cheaper, and the column would look
// harmless in a diff. It is the difference between a cache and an unlicensed
// copy of someone else's database. This gate is here to make that diff go red.
// [[always-check-legally-clear]] [[vendor-capture-risk]]
//
// Offline. No network, no database.
//
// Run: npm run test:dealer-place

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hostKey, nameCityKey, basisCode }
  from "../supabase/functions/_shared/place-match.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let failed = 0;
const fail = (m, d) => { failed++; console.error(`FAIL  ${m}`); if (d) console.error(`      ${d}`); };
const ok = (m) => console.log(`ok    ${m}`);
const check = (m, c, d) => c ? ok(m) : fail(m, d);

// Every Places field that carries a 30-day expiry. Names as they appear in the
// API and as anyone would spell them in SQL.
const LICENSED = [
  "rating", "user_rating_count", "userratingcount", "review_count", "reviewcount",
  "reviews", "review_text", "themes", "highlights",
  "display_name", "displayname", "formatted_address", "formattedaddress",
  "editorial_summary", "photos", "opening_hours", "phone", "price_level",
];

/* ── 0. the checker bites ────────────────────────────────────────────────── */
console.log("\npart 0 -- the licensed-column check itself");
{
  const planted = "create table public.dealer_place (\n  place_id text primary key,\n  rating numeric\n);";
  const hits = LICENSED.filter((c) => new RegExp(`^\\s*${c}\\s+`, "im").test(planted));
  if (hits.length) ok(`a planted rating column is caught (${hits.join(", ")})`);
  else { console.error("FATAL the licensed-column check cannot fail."); process.exit(1); }

  const clean = "create table public.dealer_place (\n  place_id text primary key,\n  host_key text\n);";
  if (!LICENSED.some((c) => new RegExp(`^\\s*${c}\\s+`, "im").test(clean))) ok("a clean table is left alone");
  else { console.error("FATAL the check flags a clean table."); process.exit(1); }
}

/* ── 1. the migration ────────────────────────────────────────────────────── */
console.log("\npart 1 -- the table we keep forever");
{
  const migDir = path.join(ROOT, "supabase", "migrations");
  const file = fs.readdirSync(migDir).find((f) => /dealer_place/.test(f));
  check("the dealer_place migration exists", !!file, "no migration matching /dealer_place/");
  if (!file) { console.error(`${failed} failure(s)`); process.exit(1); }

  const sql = read(path.join("supabase", "migrations", file));
  const body = (sql.match(/create table[^;]*dealer_place\s*\(([\s\S]*?)\n\);/i) || [])[1] || "";
  check("the CREATE TABLE body was found", body.length > 40, "regex did not match -- fix it, do not delete the check");

  const cols = body.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("--") && !l.startsWith("constraint"))
    .map((l) => l.split(/\s+/)[0].toLowerCase());
  check("columns parsed", cols.length >= 5, cols.join(", "));

  const bad = cols.filter((c) => LICENSED.includes(c));
  check("dealer_place holds NO 30-day licensed Places field", bad.length === 0,
    bad.length ? `${bad.join(", ")} — these expire after 30 days and cannot live in a table we keep indefinitely` : "");

  check("place_id is the primary key", /place_id\s+text\s+primary key/i.test(body), body.slice(0, 120));
  check("row-level security is on", /alter table public\.dealer_place enable row level security/i.test(sql));
  check("a row must be reachable by at least one key",
    /check \(host_key is not null or namecity_key is not null\)/i.test(sql));
  check("match_basis is constrained to OUR codes, not free text",
    /match_basis\s+text not null check \(match_basis in \('domain', 'domain\+city', 'name\+city'\)\)/i.test(body), body);
}

/* ── 2. what the edge function actually writes ───────────────────────────── */
console.log("\npart 2 -- the write path");
{
  const src = read("supabase/functions/get-dealer-sentiment/index.ts");
  const up = (src.match(/from\("dealer_place"\)\s*\.upsert\(\{([\s\S]*?)\}\s*,/) || [])[1];
  check("the dealer_place upsert was found", !!up,
    "if the write moved, point this check at it -- do not delete it");
  if (up) {
    const keys = [...up.matchAll(/^\s*([a-z_]+)\s*:/gim)].map((m) => m[1].toLowerCase());
    check("the upsert writes only identity and our own keys",
      !keys.some((k) => LICENSED.includes(k)),
      keys.filter((k) => LICENSED.includes(k)).join(", "));
    check("...and it does write place_id", keys.includes("place_id"), keys.join(", "));
    check("...and match_basis", keys.includes("match_basis"), keys.join(", "));
  }
  check("the 30-day rating cache is still a separate table",
    /from\("dealer_sentiment_cache"\)/.test(src),
    "rating data must not migrate into dealer_place");
}

/* ── 3. the keys ─────────────────────────────────────────────────────────── */
console.log("\npart 3 -- key derivation");
{
  check("hostKey strips scheme, www and path",
    hostKey("https://www.xpertsautos.com/inventory") === "xpertsautos.com",
    hostKey("https://www.xpertsautos.com/inventory"));
  check("hostKey is null, not empty string, when there is no host",
    hostKey("") === null && hostKey(null) === null, String(hostKey("")));
  check("nameCityKey needs both halves",
    nameCityKey("Auto House", "") === null && nameCityKey("", "Calgary") === null);
  check("nameCityKey normalises corporate noise and case",
    nameCityKey("XPERTS AUTO SALES LTD.", "Calgary") === nameCityKey("Xperts Auto Sales", "calgary"),
    `${nameCityKey("XPERTS AUTO SALES LTD.", "Calgary")} vs ${nameCityKey("Xperts Auto Sales", "calgary")}`);
  check("two different dealers do not collide",
    nameCityKey("Auto House", "Calgary") !== nameCityKey("Auto House", "Red Deer"));
}

/* ── 4. basisCode never leaks Google's copy ──────────────────────────────── */
console.log("\npart 4 -- the basis is our word, not theirs");
{
  check("a website match is 'domain'",
    basisCode({ basis: "website matches the listing's own domain (xpertsautos.com)" }) === "domain");
  check("a website match with a city is 'domain+city'",
    basisCode({ basis: "website matches, and the address is in Calgary" }) === "domain+city");
  check("a name match is 'name+city'",
    basisCode({ basis: 'name matches "Summit Auto House" and the address is in Calgary' }) === "name+city");
  // The prose basis quotes Google's displayName. Storing it would put licensed
  // 30-day copy into a table we keep forever.
  const code = basisCode({ basis: 'name matches "Summit Auto House" and the address is in Calgary' });
  check("the stored code contains no business name", !/summit|auto house/i.test(code), code);
}

console.log("");
if (failed) { console.error(`${failed} failure(s)`); process.exit(1); }
console.log("all checks passed");
