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

const BASE = process.argv[2] || process.env.GITHUB_BASE_REF || "origin/main";
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
  /^supabase\/functions\/_shared\/(msrp-claim|msrp-authority|trim-match|model-identity|deal|docfee|invariants|incentive-extract|apr-extract|jsonld-vehicle|convertus-vms|verification-checkpoints|recalls)\./,
  // scrapfly joined this list on 2026-08-20, for the same reason recalls did
  // the day before: attachSealedScreenshot() stamps sourceUrl/capturedAt onto
  // `analysis` before it's signed, and a change to what it stamps (or when)
  // changes what a cached report's signature covers -- exactly the shape of
  // change this gate exists to catch, just living in a shared module instead
  // of analyze-listing-url/index.ts itself.
  /^supabase\/functions\/_shared\/scrapfly\./,
];

const sh = (c) => execSync(c, { encoding: "utf8" }).trim();

let base;
try {
  base = sh(`git merge-base HEAD ${BASE}`);
} catch {
  console.log(`cache-ver: no merge base against ${BASE} — skipping (shallow clone or new branch).`);
  process.exit(0);
}

const changed = sh(`git diff --name-only ${base}..HEAD`).split("\n").filter(Boolean);
if (!changed.length) { console.log("cache-ver: no changes."); process.exit(0); }

const shaping = changed.filter((f) => OUTPUT_SHAPING.some((re) => re.test(f)));
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
