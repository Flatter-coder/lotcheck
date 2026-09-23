// Ask the nightly job's OWN reader what it sees on a manufacturer page.
//
// Not a gate. A diagnostic, kept because "the extractor cannot see it" and "the
// manufacturer does not publish it" produce identical output from
// verify-warranty-catalog.mjs -- status `uncited`, note "find a URL that states
// it" -- and the two call for opposite fixes. One is a regex; the other is
// deleting a figure from a signed report.
//
// It goes through politeFetch and htmlToText exactly as the job does, so what
// it prints is what the job sees, not what a browser renders.
//
// Run:
//   node scripts/probe-warranty-page.mjs <url> <field>=<term> [<field>=<term> ...]
// e.g.
//   node scripts/probe-warranty-page.mjs https://mini.ca/en/owners/mini-service basic_coverage=4-year/80,000 km
import { politeFetch } from "./lib/polite-fetch.mjs";
import { htmlToText, verifyRow, normalizePage, fieldCoveredOnPage, VERIFY_FIELDS } from "./lib/warranty-verify.mjs";

const [, , url, ...pairs] = process.argv;
if (!url) { console.error("usage: probe-warranty-page.mjs <url> <field>=<term> ..."); process.exit(2); }

const row = { source_url: url };
for (const p of pairs) {
  const i = p.indexOf("=");
  if (i < 0) { console.error(`bad pair: ${p}`); process.exit(2); }
  row[p.slice(0, i)] = p.slice(i + 1);
}

const res = await politeFetch(url, { timeoutMs: 25_000 });
console.log(`HTTP ${res.status}`);
if (!res.ok) { console.log(verifyRow(row, null, res.status)); process.exit(0); }

const page = htmlToText(await res.text());
console.log(`extracted ${page.length} characters of body text\n`);

const norm = normalizePage(page);
for (const f of VERIFY_FIELDS) {
  if (!row[f]) continue;
  console.log(`${f}  (stored: ${row[f]})`);
  console.log(`  subject found near a term on this page: ${fieldCoveredOnPage(f, page)}`);
}

// Show the neighbourhood of every year/distance pair, so a human can see what
// the job had to work with rather than trusting a boolean.
console.log("\nyear/distance pairs visible to the reader:");
const RE = /(?:\d{1,2}\s*-?\s*(?:year|yr)s?|\d{2,3}\s*months?)[^;]{0,40}?(?:unlimited|\d{4,7}\s*(?:km|kilometre|kilometer))|(?:unlimited|\d{4,7}\s*(?:km|kilometre|kilometer))[^;]{0,40}?(?:\d{1,2}\s*-?\s*(?:year|yr)s?|\d{2,3}\s*months?)/g;
let m, n = 0;
while ((m = RE.exec(norm)) && n < 25) {
  n++;
  console.log(`  ${String(n).padStart(2)}. ...${norm.slice(Math.max(0, m.index - 70), m.index + m[0].length + 70).trim()}...`);
}
if (!n) console.log("  (none -- the page is client-rendered, blocked, or not a warranty page)");

console.log("\nverifyRow:");
const r = verifyRow(row, page, res.status);
console.log(`  status: ${r.status}`);
if (r.note) console.log(`  note:   ${r.note}`);
for (const [f, v] of Object.entries(r.fields || {})) {
  if (v.state === "absent") continue;
  console.log(`  ${f}: ${v.state}${v.pairs?.length ? `  [${v.pairs.map((p) => `${p.years}y/${p.km}${p.found === false ? " NOT FOUND" : ""}`).join(", ")}]` : ""}`);
}
