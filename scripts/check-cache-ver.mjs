// A logic fix that ships without a CACHE_VER bump is a fix nobody sees.
//
// Cached reports are keyed by CACHE_VER. Change how analysis behaves without
// changing that key and the stored report is replayed instead — same numbers,
// same report id, looking exactly like a failed deploy. It happened on
// 2026-08-15: the all-in comparison, the ceiling claim, priceVerified and the
// powertrain guard all shipped correctly, and a re-run of the same listing
// returned the identical LC-DD3D-16F with the identical wrong figure. Half an
// hour was spent looking for a bug that was already fixed.
//
// This compares the branch against its merge base: if any file that shapes
// analysis OUTPUT changed and CACHE_VER did not, fail. Deliberately blunt —
// a false alarm costs one keystroke, a miss costs a silent non-deploy.
//
// Run: node scripts/check-cache-ver.mjs [baseRef]
import { execSync } from "node:child_process";

// GITHUB_BASE_REF is a BARE branch name on a PR ("main"), which often does not
// exist as a local ref in a CI checkout -- merge-base then throws and the gate
// skips silently. Qualify it to origin/<ref> unless the caller passed an
// explicit base.
const RAW_BASE = process.argv[2] || process.env.GITHUB_BASE_REF || "origin/main";
const BASE = (process.argv[2] || !process.env.GITHUB_BASE_REF || RAW_BASE.startsWith("origin/"))
  ? RAW_BASE
  : `origin/${RAW_BASE}`;
const CACHE_FILE = "supabase/functions/analyze-listing-url/index.ts";

// Files whose changes alter what a report SAYS. Deliberately not the whole
// repo: a migration, a test or a doc changing must not demand a bump.
const OUTPUT_SHAPING = [
  /^supabase\/functions\/analyze-listing-url\//,
  /^supabase\/functions\/analyze-quote\//,
  // `recalls` joined this list on 2026-08-19, when the recall lookup was
  // consolidated out of the two analyze-* functions into _shared/recalls.ts.
  // Before that move the logic lived inside paths this gate already watched, so
  // the consolidation would silently have created a blind spot: a change to what
  // a recall claim SAYS -- the confirmed semantics, the tri-state, the wording --
  // could ship with no bump, and every cached report would replay the old answer
  // for six hours (CACHE_TTL_MS) while looking like a failed deploy.
  // fee-schedule joined on 2026-08-26: docfee.ts reads the dealer-fee ceilings
  // from it to shape docFeeCheck, so a change to a ceiling value changes what a
  // report SAYS -- the same blind spot recalls/scrapfly had (logic feeding the
  // analysis object living in a shared module the gate didn't watch).
  // fee-ladder joined on 2026-09-01. It decides whether the add-ons point
  // reads ITEMIZED or NONE LISTED and what the buyer is told is negotiable,
  // which is squarely what a report SAYS -- the same reason recalls, scrapfly
  // and fee-schedule are on this list.
  /^supabase\/functions\/_shared\/(msrp-claim|msrp-authority|trim-match|model-identity|deal|docfee|fee-schedule|cpo|condition|marketvalue|d2c-vdp|invariants|incentive-extract|apr-extract|jsonld-vehicle|convertus-vms|verification-checkpoints|recalls|fee-ladder)\./,
  // scrapfly joined this list on 2026-08-20, for the same reason recalls did
  // the day before: attachSealedScreenshot() stamps sourceUrl/capturedAt onto
  // `analysis` before it's signed, and a change to what it stamps (or when)
  // changes what a cached report's signature covers -- exactly the shape of
  // change this gate exists to catch, just living in a shared module instead
  // of analyze-listing-url/index.ts itself.
  /^supabase\/functions\/_shared\/scrapfly\./,
  // get-dealer-sentiment joined on 2026-08-27. It is a separate function, so
  // it sat outside every pattern above -- yet it decides what the Dealer
  // reputation point SAYS: the rating, the review count, and whether the
  // point reads NOT CHECKED at all. A change to that shipped with no bump
  // and every cached report replayed the old answer, which is the same blind
  // spot the recalls note above describes, one function further out.
  /^supabase\/functions\/get-dealer-sentiment\//,
  // capture + vision-limits joined on 2026-08-27, when the whole-page fix moved
  // the capture cap, the refit width and the coverage arithmetic into them.
  // Those numbers decide whether a report shows the WHOLE listing or the top of
  // it, and what the evidence card says about which -- output shaping in the
  // plainest sense, in shared modules the gate did not watch. Same blind spot
  // as recalls and scrapfly above, one file further out.
  /^supabase\/functions\/_shared\/(capture|vision-limits)\./,
  // multi-vehicle joined on 2026-08-27. It decides whether a URL produces a
  // report AT ALL, and which vehicle that report is about -- the most
  // output-shaping decision in the whole scan.
  /^supabase\/functions\/_shared\/multi-vehicle\./,
  // dealer-catalog joined on 2026-08-30. It decides HOW a page is fetched --
  // and on a bot-walled host that is the difference between a report and a
  // 502, so it shapes the output as directly as anything in this list.
  /^supabase\/functions\/_shared\/dealer-catalog\./,
];

const sh = (c) => execSync(c, { encoding: "utf8" }).trim();

let base;
try {
  base = sh(`git merge-base HEAD ${BASE}`);
} catch {
  console.log(`cache-ver: no merge base against ${BASE} — skipping (shallow clone or new branch).`);
  process.exit(0);
}

let changed = sh(`git diff --name-only ${base}..HEAD`).split("\n").filter(Boolean);
// ON A PUSH TO main THIS GATE WAS A GUARANTEED NO-OP. After a merge, HEAD IS
// origin/main, so merge-base returns HEAD, the diff is empty, and the gate
// exits 0 having inspected nothing -- on the very event where a missed
// CACHE_VER bump starts serving stale reports to real buyers. It only ever did
// real work on PR branches. When the base resolves to HEAD itself, fall back to
// the commit that was just pushed (HEAD~1) so the push is actually checked.
// Conservative: only when HEAD~1 exists, so a first or shallow commit still
// skips rather than failing the build.
if (!changed.length) {
  let headSha = null, parent = null;
  try { headSha = sh("git rev-parse HEAD"); } catch { /* ignore */ }
  if (headSha && base === headSha) {
    try { parent = sh("git rev-parse HEAD~1"); } catch { /* no parent to compare */ }
  }
  if (parent) {
    changed = sh(`git diff --name-only ${parent}..HEAD`).split("\n").filter(Boolean);
    if (changed.length) console.log("cache-ver: base resolved to HEAD (push event) — checking the pushed commit against HEAD~1 instead.");
  }
}
if (!changed.length) { console.log("cache-ver: no changes."); process.exit(0); }

// A TEST is not an output. Test files sit next to the modules they pin, so the
// shaping patterns match them too -- and a cache bump is not free: it discards
// every cached report and re-scans every host a buyer returns to. Making a
// test-only edit demand one teaches the next person that this gate cries wolf,
// and a gate people route around protects nothing. [[repeat-fix-pattern]]
//
// Narrow and provable: only *.test.ts / *.test.mjs, which are never imported by
// an edge function. A module that genuinely shapes output still trips the gate.
const IS_TEST = /(^|[\/])[^\/]*\.test\.(ts|mts|js|mjs)$/;
const shaping = changed.filter((f) => !IS_TEST.test(f) && OUTPUT_SHAPING.some((re) => re.test(f)));
if (!shaping.length) {
  console.log("cache-ver: no analysis-output files changed — no bump needed.");
  process.exit(0);
}

// Did the CACHE_VER VALUE change in this range?
//
// Comparing the two values, not merely asking whether the line appeared in the
// diff. The line carries a trailing comment naming what changed, so editing only
// that comment used to satisfy this check -- the diff showed a +const CACHE_VER
// line, the gate went green, and the cache key was byte-identical. A gate that a
// comment can satisfy is not guarding the thing it names.
const readVer = (ref) => {
  try {
    const body = sh(`git show ${ref}:${CACHE_FILE}`);
    return (body.match(/^const CACHE_VER = "([^"]+)"/m) || [])[1] || null;
  } catch { return null; }
};
const before = readVer(base);
const after = readVer("HEAD");

if (before !== null && after !== null && before !== after) {
  console.log(`✅ cache-ver: analysis changed and CACHE_VER moved "${before}" -> "${after}".`);
  process.exit(0);
}
if (before === null || after === null) {
  console.error(`❌ cache-ver: could not read CACHE_VER from ${CACHE_FILE} (base=${before}, head=${after}).`);
  console.error(`   Refusing to pass on an unreadable key rather than assume it moved.`);
  process.exit(1);
}

console.error("❌ cache-ver: analysis OUTPUT changed but CACHE_VER was not bumped.\n");
console.error("These files shape what a report says:");
for (const f of shaping) console.error(`  - ${f}`);
console.error(`\nWithout a bump, cached reports are replayed: buyers see the OLD figures,`);
console.error(`the report id does not change, and it looks like the deploy failed.`);
console.error(`\nFix: edit CACHE_VER in ${CACHE_FILE} (e.g. bump the trailing letter).`);
process.exit(1);
