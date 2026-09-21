// Regression guard for the silent-green refresh class.
//
// On 2026-08-12 the catalog refresh ran green while Genesis wrote nothing: the
// manufacturer moved its API, the scraper crashed, continue-on-error swallowed
// the crash, and msrp_catalog quietly froze at fetched_at 2026-08-08. Same
// class as the Ford 78 -> 7 wipe and the lease_rate_catalog table that never
// existed while every write to it 404'd behind fatal:false. These cases pin
// the guard verdicts that make each of those a red run.
//
// Run: node scripts/test-catalog-guard.mjs

import { evaluateMake, rowIsStale } from "./catalog-refresh-guard.mjs";

let pass = 0, fail = 0;
function check(label, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "\n        " + detail}`);
  cond ? pass++ : fail++;
}

// The Genesis 2026-08-12 case: rows exist but nothing fresh was written.
let v = evaluateMake({ level: "required", pre: { count: 8, maxId: 1647, maxFetchedAt: "2026-08-08T22:09:56Z" }, post: { count: 8, maxId: 1647, maxFetchedAt: "2026-08-08T22:09:56Z" } });
check("required make with no fresh write fails", v.status === "fail", `got ${v.status}: ${v.reasons}`);

// A normal refresh: delete-then-insert advances max(id).
v = evaluateMake({ level: "required", pre: { count: 8, maxId: 1647 }, post: { count: 23, maxId: 2101 } });
check("fresh write passes", v.status === "ok", `got ${v.status}: ${v.reasons}`);

// GM: zero-writes are known and accepted (no national MSRP; the fractional
// gate rejects computed postal-code prices by design) — warn, never red.
v = evaluateMake({ level: "optional", pre: { count: 58, maxId: 900 }, post: { count: 58, maxId: 900 } });
check("optional make with no fresh write warns, not fails", v.status === "warn", `got ${v.status}`);

// The Ford class: fresh rows written, but the catalog collapsed 78 -> 7.
v = evaluateMake({ level: "required", pre: { count: 78, maxId: 3000 }, post: { count: 7, maxId: 3500 } });
check("count collapse fails even when the write is fresh", v.status === "fail" && /collapsed 78 -> 7/.test(v.reasons.join(" ")), `got ${v.status}: ${v.reasons}`);

// Small catalogs churn (a discontinued model) without meaning a wipe.
v = evaluateMake({ level: "required", pre: { count: 3, maxId: 10 }, post: { count: 2, maxId: 40 } });
check("small-catalog shrink below the floor is ok", v.status === "ok", `got ${v.status}: ${v.reasons}`);

// Exactly half survives; only BELOW half is a collapse.
v = evaluateMake({ level: "required", pre: { count: 20, maxId: 100 }, post: { count: 10, maxId: 160 } });
check("shrink to exactly half is not a collapse", v.status === "ok", `got ${v.status}: ${v.reasons}`);

// A make that never had rows and now does (first Genesis run after the fix).
v = evaluateMake({ level: "required", pre: undefined, post: { count: 78, maxId: 500 } });
check("first-ever rows for a make pass", v.status === "ok", `got ${v.status}: ${v.reasons}`);

// A make with no rows before or after wrote nothing.
v = evaluateMake({ level: "required", pre: undefined, post: undefined });
check("no rows before or after fails (nothing was written)", v.status === "fail", `got ${v.status}`);

// The lease_rate_catalog class: the table isn't in the API schema at all, so
// every write 404s and fatal:false swallows it. That must never read as green.
v = evaluateMake({ level: "required", pre: undefined, post: undefined, tableMissing: true });
check("missing table fails a required check", v.status === "fail" && /does not exist/.test(v.reasons.join(" ")), `got ${v.status}: ${v.reasons}`);
v = evaluateMake({ level: "optional", pre: undefined, post: undefined, tableMissing: true });
check("missing table warns an optional check", v.status === "warn", `got ${v.status}`);

// ---- the partial-refresh class ------------------------------------------
// max(id) advancing proves SOME row was written, never that this make's rows
// were refreshed. On 2026-09-21 the daily FULL refresh had been green for four
// days while 73 rows sat unrewritten for 74h+ (Toyota 34, Lexus 23, Cadillac 8,
// Chevrolet 5, Hyundai 2, Buick 1). Each is a denominator under a live price
// claim, so a make that refreshes 100 of 134 rows is not a pass.
v = evaluateMake({ level: "required", pre: { count: 134, maxId: 900 }, post: { count: 134, maxId: 940, staleCount: 34, oldestFetchedAt: "2026-09-17T11:00:00Z" } });
check("fresh write that leaves rows unrewritten fails", v.status === "fail", `got ${v.status}: ${v.reasons}`);
check("the failure names how many rows and how old", v.reasons.join(" ").includes("34 of 134") && v.reasons.join(" ").includes("2026-09-17"), `reasons: ${v.reasons}`);

// Every row rewritten is the only shape that passes.
v = evaluateMake({ level: "required", pre: { count: 134, maxId: 900 }, post: { count: 134, maxId: 940, staleCount: 0 } });
check("every row rewritten passes", v.status === "ok", `got ${v.status}: ${v.reasons}`);

// Optional makes warn rather than fail, same as every other check here.
v = evaluateMake({ level: "optional", pre: { count: 134, maxId: 900 }, post: { count: 134, maxId: 940, staleCount: 34 } });
check("partial refresh of an optional make warns", v.status === "warn", `got ${v.status}`);

// finance/lease carry no fetched_at, so staleness is UNKNOWN there — null must
// not be read as zero. Number(null) === 0 is how this family of defect returns.
v = evaluateMake({ level: "required", pre: { count: 40, maxId: 10 }, post: { count: 40, maxId: 20, staleCount: null } });
check("unknown staleness is not treated as zero stale", v.status === "ok" && !v.reasons.join(" ").includes("not rewritten"), `got ${v.status}: ${v.reasons}`);

// Caught even when the run ALSO wrote nothing new, and the two reasons are
// reported separately rather than one masking the other.
v = evaluateMake({ level: "required", pre: { count: 134, maxId: 940 }, post: { count: 134, maxId: 940, staleCount: 34 } });
check("stale rows and no fresh write are reported as two reasons", v.status === "fail" && v.reasons.length === 2, `reasons: ${v.reasons}`);

// ---- the staleness COUNTER, not just the verdict built on it -------------
// Testing evaluateMake alone would pass over a counter that always returns 0 —
// the verdict is only as good as the number handed to it.
const SINCE = Date.parse("2026-09-21T11:23:00Z");
check("a row written before the run is stale", rowIsStale("2026-09-17T11:00:00Z", SINCE) === true);
check("a row written during the run is not stale", rowIsStale("2026-09-21T11:40:00Z", SINCE) === false);
check("a row with no fetched_at is stale, not assumed fresh", rowIsStale(null, SINCE) === true);
check("an unparseable fetched_at is stale, not assumed fresh", rowIsStale("not-a-date", SINCE) === true);
check("a row exactly at the cutoff counts as fresh", rowIsStale("2026-09-21T11:23:00Z", SINCE) === false);
check("with no cutoff nothing is judged stale", rowIsStale(null, NaN) === false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
