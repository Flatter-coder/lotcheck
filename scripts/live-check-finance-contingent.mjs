// LIVE check for the S37 finance-contingent detector, GRADED against an
// independent ground truth rather than against itself.
//
// Unit tests only prove the regex does what I wrote. They cannot prove I wrote
// the right regex: the APR extractor once passed 14/14 while matching nothing
// on a real page. So this fetches real listing pages, greps them with a
// separate, deliberately loose pattern, and compares that verdict to the
// detector's. Disagreements are printed with "!!" and are the whole point.
//
// Run: node scripts/live-check-finance-contingent.mjs [url ...]
import { detectFinanceContingent } from "../supabase/functions/_shared/finance-contingent.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Deliberately looser than the shipped detector: it fires on the mere PRESENCE
// of finance-condition vocabulary, with no price-context requirement. So
// "ground=HAS / detector=clean" is the expected reading whenever a page
// conditions only its APR, and is worth eyeballing rather than fixing blindly.
const GROUND = /(in lieu of|finance cash|finance assist|non-?financed? price|only available with[^.]{0,40}financ|must financ\w+ (with|through))/i;

const SITES = process.argv.slice(2).length ? process.argv.slice(2) : [
  "https://www.ford.ca/finance/",
  "https://www.kramermazda.com/new/",
  "https://www.mazda.ca/en/offers/",
  "https://www.crowfootdodge.com/new/",
  "https://www.villagehonda.com/new/",
  "https://www.calgaryhyundai.com/new/",
  "https://www.westgatechev.com/new/",
  "https://www.airdriechrysler.com/new/",
  "https://www.southtownehyundai.com/new/",
  "https://www.silverhillacura.com/new/",
];

let agree = 0, disagree = 0, unreachable = 0;

await Promise.all(SITES.map(async (u) => {
  const host = new URL(u).hostname.replace(/^www\./, "");
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 25_000);
    const r = await fetch(u, { headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "en-CA" }, signal: c.signal });
    clearTimeout(t);
    const h = await r.text();
    const truth = GROUND.test(h);
    const hit = detectFinanceContingent(h);
    const ok = truth === !!hit;
    ok ? agree++ : disagree++;
    console.log(`${ok ? "  " : "!!"} ${host.padEnd(24)} http ${r.status}  ground=${truth ? "HAS " : "none"}  detector=${hit ? hit.reasons.join("|") : "clean"}`);
    if (hit) console.log(`     "${hit.evidence.slice(0, 150)}"`);
  } catch (e) {
    unreachable++;
    console.log(`   ${host.padEnd(24)} ERR ${String(e.message).slice(0, 34)}`);
  }
}));

console.log(`\n${agree} agree · ${disagree} disagree · ${unreachable} unreachable`);
console.log("Disagreements are not automatically bugs -- read the evidence line and decide.");
