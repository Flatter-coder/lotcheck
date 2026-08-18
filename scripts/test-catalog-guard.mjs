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

import { evaluateMake } from "./catalog-refresh-guard.mjs";

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

// ── 'preserved': the make writes NOTHING and keeps what it has ──────────────
// Toyota and Lexus publish no national MSRP -- their price endpoint returns a
// province-calculated figure -- so those scrapers write no msrp_catalog rows
// and the hand-seeded Build & Price rows stand. 'required' was wrong for them
// (it demands a fresh write that will never come, so the job is red forever),
// and 'optional'/'skip' are wrong too: both accept silence, which is exactly
// what hides the two real failures below.
v = evaluateMake({ level: "preserved", pre: { count: 48, maxId: 9224 }, post: { count: 48, maxId: 9224 } });
check("preserved: nothing written and nothing lost is ok", v.status === "ok", `got ${v.status}: ${v.reasons}`);

v = evaluateMake({ level: "preserved", pre: { count: 48, maxId: 9224 }, post: { count: 7, maxId: 9300 } });
check("preserved: rows APPEARING fails (the rates-only rule was undone)", v.status === "fail", `got ${v.status}: ${v.reasons}`);

v = evaluateMake({ level: "preserved", pre: { count: 48, maxId: 9224 }, post: { count: 12, maxId: 9224 } });
check("preserved: rows DISAPPEARING fails (a preserved table keeps what it had)", v.status === "fail", `got ${v.status}: ${v.reasons}`);

// The existing levels must be untouched by the addition.
v = evaluateMake({ level: "required", pre: { count: 48, maxId: 9224 }, post: { count: 48, maxId: 9224 } });
check("required still fails when nothing fresh was written", v.status === "fail", `got ${v.status}`);
v = evaluateMake({ level: "optional", pre: { count: 48, maxId: 9224 }, post: { count: 48, maxId: 9224 } });
check("optional still only warns", v.status === "warn", `got ${v.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
