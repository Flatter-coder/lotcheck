// A lit "Live" dot must be backed by a read that actually returned.
//
// Three surfaces broke this rule at the same time, each by substituting
// something merely correlated with a successful read for the read itself:
//
//   alberta.html   static `class="pill live"` — nothing evaluated at all
//                  (fixed 7979db0, locked by test:alberta-dealers)
//   ledger         `loaded = !apiUsageLoading` — a FAILED read clears the
//                  loading flag too, so it lit green over data it never got
//   LiveTicker     `listings.length > 0` — never false, because useListings
//                  SEEDS its state with DEMO_LISTINGS; it answered "live" for
//                  fourteen invented cars at invented prices
//
// This locks the decision function AND the three call-site contracts, because
// the function alone cannot stop a surface from ignoring it.
//
// Run: node scripts/test-live-dot.mjs
import { readFileSync } from "node:fs";
import { liveState, LIVE_MAX_AGE_MS } from "../src/lib/live-state.js";

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✅ ${n}`); };
const bad = (n, why) => { fail++; console.error(`  ❌ ${n}\n       ${why}`); };
const eq = (n, got, want) => got === want ? ok(n) : bad(n, `got "${got}", wanted "${want}"`);

const NOW = 1_700_000_000_000;

console.log("liveState — nothing but a real timestamp may light it");
// Every shape a failed or absent read leaves behind.
for (const [label, v] of [["null", null], ["undefined", undefined], ["0", 0],
                          ["empty string", ""], ["NaN", NaN], ["false", false],
                          ["negative", -1], ["a non-numeric string", "soon"]])
  eq(`${label} is unavailable`, liveState(v, LIVE_MAX_AGE_MS, NOW), "unavailable");

eq("a fresh timestamp is live", liveState(NOW - 1000, LIVE_MAX_AGE_MS, NOW), "live");
eq("a Date object works too", liveState(new Date(NOW - 1000), LIVE_MAX_AGE_MS, NOW), "live");
eq("exactly at the limit is still live", liveState(NOW - LIVE_MAX_AGE_MS, LIVE_MAX_AGE_MS, NOW), "live");
eq("one ms past the limit is aged", liveState(NOW - LIVE_MAX_AGE_MS - 1, LIVE_MAX_AGE_MS, NOW), "aged");
eq("an old read is aged, not unavailable", liveState(NOW - 864e5, LIVE_MAX_AGE_MS, NOW), "aged");
// A skewed clock must not produce a permanently-live badge.
eq("a future timestamp is unavailable", liveState(NOW + 60_000, LIVE_MAX_AGE_MS, NOW), "unavailable");

console.log("\ncall sites — the rule is useless if a surface routes around it");
// Strip whole-line comments before matching. These assertions are about what
// the CODE does, and the code is heavily commented — including comments that
// quote the very defects being checked for ("`loaded = !apiUsageLoading` used to
// live here"). Matching raw source made this test fail on its own explanation.
// Only full-line comments are removed, so nothing inside a string or a URL is
// touched.
const app = readFileSync("src/App.jsx", "utf8")
  .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

const contract = (name, condition, why) => condition ? ok(name) : bad(name, why);

contract("App.jsx imports the shared liveState",
  /import\s*\{[^}]*\bliveState\b[^}]*\}\s*from\s*["']\.\/lib\/live-state\.js["']/.test(app),
  "no import — a second copy of the rule will drift from this one");

contract("no live badge is gated on !apiUsageLoading",
  !/\bloaded\s*=\s*!\s*apiUsageLoading/.test(app),
  "found `loaded = !apiUsageLoading` — a failed read satisfies that too");

contract("useApiUsage exposes lastReadAt",
  /return\s*\{\s*usage,\s*usageLoading,\s*lastReadAt\s*\}/.test(app),
  "the hook must report WHEN a read succeeded, not just that none is pending");

contract("lastReadAt is set only on the success path",
  /setUsage\(data\|\|\[\]\);\s*setLastReadAt\(/.test(app),
  "setLastReadAt must sit beside setUsage inside the try, never in catch/finally");

contract("the verification ledger badge takes a read timestamp",
  /VERIFICATION LEDGER\s*<LiveDot\s+readAt=\{apiUsageReadAt\}/.test(app),
  "the ledger must feed LiveDot a real timestamp");

contract("VerifLiveDot is gone",
  !/function\s+VerifLiveDot\s*\(/.test(app),
  "a component that renders lit unconditionally is the defect — it must not come back");

contract("LiveTicker gates its dot on isLive, not on array length",
  /function LiveTicker\(\{listings,\s*isLive,/.test(app) && /const isReal\s*=\s*!!isLive/.test(app),
  "listings.length>0 is never false — useListings seeds state with DEMO_LISTINGS");

contract("the ticker dot only renders when real",
  /\{isReal && <span className="lc-ticker-dot"\/>\}/.test(app),
  "the blinking dot must not render over demo rows");

contract("demo rows are labelled",
  /className="lc-ticker-sample"/.test(app),
  "sample data must say it is sample data");

contract("isLive is actually passed to LiveTicker",
  /<LiveTicker[^>]*\bisLive=\{isLive\}/.test(app),
  "the prop exists but nothing supplies it — the gate would be permanently false");

console.log(`\n${fail ? "❌" : "✅"} live-dot: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
