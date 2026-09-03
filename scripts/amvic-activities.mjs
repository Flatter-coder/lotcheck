#!/usr/bin/env node
// WHAT IS ACTUALLY A CAR-SALES WEBSITE?
//
// "1,639 Alberta car websites" is the count of distinct hosts among AMVIC
// licensees that list one. AMVIC licenses far more than dealerships, though --
// the roster carries repair shops, tire shops, parts suppliers, rental and
// salvage operators. A live re-probe of the silent hosts surfaced
// centraldieselinjection.com, millertruckparts.ca and a TRENCHING company, all
// answering perfectly well and none of them a place you can buy a car.
//
// That matters for the only question worth asking -- "can LotCheck read the
// sites a buyer will paste at it" -- because a business with no inventory
// pages can neither be read nor fail to be read. Counting it in the
// denominator understates our coverage; counting it in the numerator would
// overstate it. Neither is the truth.
//
// amvic_licensees.activities is the field that separates them and nothing has
// ever used it. This reads it and reports, and writes nothing.
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"); process.exit(1); }
const supabase = createClient(url, key);

// Paginated AND ordered. An unordered .range() over 21,866 rows is how "1,639"
// stopped being reproducible once already -- Postgres is free to return a
// different slice each page without an ORDER BY.
async function all(table, cols) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(cols)
      .order("id", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

function toOrigin(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s || /^n\/?a$/i.test(s)) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try { const u = new URL(s); return u.hostname ? `https://${u.hostname.toLowerCase()}` : null; }
  catch { return null; }
}
const key_ = (o) => o && o.replace(/^https:\/\/www\./, "https://");

const rows = await all("amvic_licensees", "id,name,trade_name,facility_status,facility_type,website,activities");
console.log(`roster rows: ${rows.length}`);

const issued = rows.filter((r) => String(r.facility_status || "").trim() === "Issued");
const withSite = issued.filter((r) => toOrigin(r.website));
console.log(`issued: ${issued.length}   issued with a usable website: ${withSite.length}`);

// --- what activity values exist at all -------------------------------------
const actCount = new Map(), actHosts = new Map();
const norm = (a) => String(typeof a === "string" ? a : (a?.name ?? a?.activity ?? JSON.stringify(a))).trim();
for (const r of withSite) {
  let list = r.activities;
  if (typeof list === "string") { try { list = JSON.parse(list); } catch { list = [list]; } }
  const names = Array.isArray(list) ? list.map(norm).filter(Boolean) : list ? [norm(list)] : ["(none)"];
  const host = key_(toOrigin(r.website));
  for (const n of new Set(names.length ? names : ["(none)"])) {
    actCount.set(n, (actCount.get(n) || 0) + 1);
    if (!actHosts.has(n)) actHosts.set(n, new Set());
    actHosts.get(n).add(host);
  }
}
console.log("\nACTIVITY VALUES ON LICENSEES THAT PUBLISH A WEBSITE");
console.log("=".repeat(74));
console.log(`  ${"activity".padEnd(46)} ${"licensees".padStart(9)} ${"hosts".padStart(7)}`);
for (const [name, n] of [...actCount].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
  console.log(`  ${name.slice(0, 46).padEnd(46)} ${String(n).padStart(9)} ${String(actHosts.get(name).size).padStart(7)}`);
}

// --- the subset a buyer could actually paste a listing from ------------------
// Matched on the activity text rather than a hardcoded list, so a wording
// change in AMVIC's roster shows up as a shift in the table above instead of
// silently emptying this number.
const SELLS = /\b(sales?|deal(er|ership)|retail|wholesal|auction|broker|consign)/i;
const EXCLUDE = /\b(repair|body shop|collision|mechanic|glass|tire|towing|salvage|recycl|rental|rent-a|lease only|parts)\b/i;
const sellHosts = new Set(), otherHosts = new Set();
for (const [name, hosts] of actHosts) {
  const sells = SELLS.test(name) && !EXCLUDE.test(name);
  for (const h of hosts) (sells ? sellHosts : otherHosts).add(h);
}
const onlyOther = [...otherHosts].filter((h) => !sellHosts.has(h));
const allHosts = new Set([...sellHosts, ...otherHosts]);
console.log("\n" + "=".repeat(74));
console.log("THE REAL DENOMINATOR");
console.log("=".repeat(74));
console.log(`  distinct hosts, all licensed activities      ${String(allHosts.size).padStart(6)}`);
console.log(`  hosts licensed to SELL vehicles             ${String(sellHosts.size).padStart(6)}   <-- a buyer can paste one of these`);
console.log(`  hosts with no sales activity at all         ${String(onlyOther.length).padStart(6)}   (repair, tire, parts, rental, salvage)`);
console.log("=".repeat(74));
console.log("Matched on AMVIC's own activity wording; the table above is the audit");
console.log("trail for that match, so a reworded activity shows up rather than hides.");
