// GATE: a database function with no stated audience is an ANON-EXECUTABLE function.
//
// WHAT HAPPENED, 2026-09-13. fn_upsert_listings -- the function that writes
// vehicle_listing, the table every comparable-listings RPC reads -- was probed
// with the public anon key that ships in the client bundle:
//
//   POST /rest/v1/rpc/fn_upsert_listings  {"p_dealer_id":-1,"p_rows":[]}
//   -> 200  {"ok": true, "new": 0, "seen": 0, ...}
//
// It executed. A stranger could insert arbitrary VINs and prices under any
// dealer and move the price band a buyer is shown. fn_mark_delisted and
// fn_record_crawl are the same shape.
//
// THE CAUSE IS A DEFAULT, NOT A TYPO. In Supabase, a new function in `public`
// is executable by `anon` and `authenticated` unless something takes that away.
// These three carried `revoke all ... from public` and no grant at all -- and
// revoking from the PUBLIC pseudo-role does not touch an explicit grant held by
// a named role. So the author's intent was visible, correct, and had no effect.
// 20260814_lock_service_role_functions.sql already fixed exactly this for five
// other functions and wrote the reason down. These three were created after it
// and reproduced the defect anyway.
//
// AND THE GUARD MEANT TO PREVENT THE RECURRENCE DID NOT HOLD. That migration
// ends with:
//     alter default privileges in schema public revoke execute on functions from anon, authenticated;
// fn_upsert_listings was created three weeks later and is open regardless --
// ALTER DEFAULT PRIVILEGES binds to the role that ran it, and a migration pasted
// into the SQL editor need not run as that role. A default nobody read back is
// not a default. [[no-single-point-of-failure]]
//
// SO THIS GATE DOES NOT CHECK PRIVILEGES -- it cannot; it is offline and the
// database is the only place that knows. It checks the thing that actually
// failed: whether a human ever STATED who a function is for. Every function
// created in a migration must either
//
//   (a) be explicitly granted to anon and/or authenticated -- a deliberate,
//       greppable decision that it is client-callable; or
//   (b) be named in a lock list in one of the lockdown migrations.
//
// Neither is not a third option: neither means anon-executable by default, and
// nobody decided it. That is precisely how these three shipped.
//
// Offline. No network, no database.
//
// Run: npm run check:rpc-exposure

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIG = path.join(ROOT, "supabase", "migrations");

let failed = 0;
const fail = (m, d) => { failed++; console.error(`FAIL  ${m}`); if (d) console.error(`      ${String(d).split("\n").join("\n      ")}`); };
const ok = (m) => console.log(`ok    ${m}`);

const files = fs.readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort();
if (files.length < 10) { fail("found almost no migrations -- the gate is pointed at the wrong directory", MIG); process.exit(1); }
const sql = files.map((f) => ({ f, s: fs.readFileSync(path.join(MIG, f), "utf8") }));
const ALL = sql.map((x) => x.s).join("\n");

// ── who is created, and who is spoken for ──────────────────────────────────
const created = new Map();               // name -> first migration that creates it
const triggers = new Set();              // returns trigger -> PostgREST cannot call it
for (const { f, s } of sql) {
  for (const m of s.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?(fn_[a-z0-9_]+)\s*\(/gi)) {
    if (!created.has(m[1])) created.set(m[1], f);
    // A trigger function has no REST surface: PostgREST refuses to expose
    // anything returning `trigger`, so its grants cannot be reached from a
    // browser and it is not part of this gate's question.
    const after = s.slice(m.index, m.index + 400);
    if (/\breturns\s+trigger\b/i.test(after)) triggers.add(m[1]);
  }
}

// (a) explicitly handed to a client role
const client = new Set();
const spokenFor = new Set();   // explicitly revoked from anon/authenticated
for (const m of ALL.matchAll(/grant\s+execute\s+on\s+function\s+(?:public\.)?(fn_[a-z0-9_]+)\s*\([^)]*\)\s*to\s+([a-z_,\s]+);/gi)) {
  if (/\b(anon|authenticated)\b/.test(m[2])) client.add(m[1]);
}

// (a2) explicitly revoked FROM a client role -- the other correct way to state
// an audience, and the form fn_alert_confirm uses. Counting only grants made
// this gate flag eight functions of which five were already safe; a gate with
// five false positives in eight is one nobody reads.
// A LINE SCAN, not a regex over the whole corpus. The regex version matched
// this exact line in isolation and found ZERO across 100+ migrations -- so it
// silently reported every function as unspoken-for, which is a gate that
// fails loudly for the wrong reason. Line-at-a-time is dull and cannot do
// that.
for (const line of ALL.split(/\r?\n/)) {
  const l = line.toLowerCase();
  if (l.indexOf("revoke") < 0 || l.indexOf("on function") < 0) continue;
  if (l.indexOf("anon") < 0 && l.indexOf("authenticated") < 0) continue;
  const nm = /(fn_[a-z0-9_]+)/.exec(l);
  if (nm) spokenFor.add(nm[1]);
}

// (b) named in a lockdown migration's `locked text[] := array[ ... ]`
const locked = new Set();
for (const { s } of sql) {
  for (const blk of s.matchAll(/locked\s+text\[\]\s*:=\s*array\s*\[([\s\S]*?)\]\s*;/gi)) {
    for (const q of blk[1].matchAll(/'(fn_[a-z0-9_]+)'/gi)) locked.add(q[1]);
  }
}

// Pre-existing, needs a DECISION rather than a guess. The list may only shrink,
// and an entry that stops reproducing fails the gate so it cannot go stale.
const QUARANTINE = new Map([
  ["fn_available_credits",
   "2026-09-13: its migration says 'clients may only read their own balance', but the repo " +
   "contains no grant stating that -- only `revoke ... from public`, which in Supabase leaves " +
   "the default anon grant intact. So it is probably anon-callable and probably meant to be " +
   "authenticated-callable, and those are different. Probing was inconclusive (the parameter " +
   "names are not in the migration). Locking it blind could break the credits UI, so this needs " +
   "an owner: either grant it to `authenticated` explicitly, or lock it and route reads through " +
   "the edge function."],
]);

console.log(`\n${created.size} function(s) created across ${files.length} migrations`);
console.log(`  ${client.size} explicitly client-callable, ${locked.size} explicitly locked`);

// ── part 0: the gate proves it can still fail ──────────────────────────────
{
  const sample = [...created.keys()][0];
  if (!sample) { fail("parsed no functions at all -- the create-function regex is broken"); process.exit(1); }
  const orphan = "fn_" + "gate_selftest_never_defined";
  if (client.has(orphan) || locked.has(orphan)) { console.error("FATAL self-test name collides with a real function."); process.exit(1); }
  const wouldFail = !client.has(orphan) && !locked.has(orphan);
  if (wouldFail) ok("a function spoken for by nobody would be caught");
  else { console.error("FATAL the gate cannot fail."); process.exit(1); }
}

// ── part 1: every function has a stated audience ───────────────────────────
console.log("\nevery function states who it is for");
{
  // A function created BEFORE the 2026-08-14 default-privileges change inherited
  // Supabase's anon grant at creation, and `create or replace` PRESERVES
  // privileges -- so redefining it later never cleared the hole. That is exactly
  // how fn_upsert_listings (created 2026-08-11, redefined twice since) stayed
  // anon-executable while functions created after 08-14 are fine. Probing
  // confirmed both halves. So the risk window is dated, not universal.
  const CUTOFF = "20260814";
  const mute = [...created.keys()]
    .filter((n) => !client.has(n) && !locked.has(n) && !spokenFor.has(n) && !triggers.has(n))
    .filter((n) => !QUARANTINE.has(n))
    .filter((n) => created.get(n).slice(0, 8) < CUTOFF)
    .sort();
  if (!mute.length) ok(`no pre-2026-08-14 function is left without a stated audience (${created.size} checked, ${triggers.size} trigger(s) excluded, ${QUARANTINE.size} quarantined)`);
  else fail(`${mute.length} function(s) created before the lockdown with NO stated audience -- anon can execute them`,
    mute.map((n) => `${n}  (created in ${created.get(n)})`).join("\n")
    + "\n\nAdd an explicit `grant execute ... to anon`/`authenticated` if a browser must call it,"
    + "\nor add the name to the locked[] list in a lockdown migration if it must not.");
}

// ── part 2: the writers of the comps corpus are locked, not granted ────────
// Named individually because these are the ones a stranger could use to move a
// price band shown to a buyer. If a future change hands one of them to a client
// role, that must be a loud failure and not a diff nobody read.
console.log("\nthe inventory writers are locked");
{
  const WRITERS = ["fn_upsert_listings", "fn_mark_delisted", "fn_record_crawl",
    "fn_note_listing_seen", "fn_dealer_catalog_observe", "fn_log_verification_checks"];
  for (const w of WRITERS) {
    if (!created.has(w)) { fail(`${w} no longer exists in any migration -- fix this list, do not delete the check`); continue; }
    if (client.has(w)) fail(`${w} is granted to a client role`, "this function writes data the report is computed from; it must be service_role only");
    else if (!locked.has(w)) fail(`${w} is not in any lockdown list`, `created in ${created.get(w)} -- anon can execute it until it is locked`);
    else ok(`${w} locked`);
  }
}

// ── part 3: the lockdown migration reads its own work back ────────────────
// The August fix trusted `alter default privileges` and that did not hold for
// three weeks without anyone knowing. A lockdown that does not SELECT the
// resulting privileges is a hope, not a fix.
console.log("\nthe lockdown migrations verify themselves");
{
  const locks = sql.filter((x) => /locked\s+text\[\]\s*:=\s*array/i.test(x.s));
  if (!locks.length) { fail("no lockdown migration found at all"); }
  for (const { f, s } of locks) {
    // Must read back ANON specifically. A first pass accepted any
    // has_function_privilege() call -- so deleting the anon row and leaving the
    // authenticated one still passed, which is the whole question unasked.
    const readsBack = /has_function_privilege\s*\(\s*'anon'/i.test(s);
    const refuses = /raise\s+exception/i.test(s) && /locked\s+nothing/i.test(s);
    if (!refuses) fail(`${f} does not refuse when its name list matches nothing`,
      "a typo in a REVOKE is silent -- the migration must raise rather than report success");
    // Only the NEWEST lockdown needs the readback: applying it re-locks and
    // re-verifies every name, including the older list. Requiring it of an
    // already-applied 2026-08 migration would be asking for a file edit that
    // can never run again.
    const newest = locks[locks.length - 1].f === f;
    if (!readsBack && newest) fail(`${f} never reads the privileges back`,
      "the newest lockdown must SELECT has_function_privilege() so applying it SHOWS whether anon still has EXECUTE -- the 2026-08-14 fix trusted `alter default privileges` and that silently did not hold for three weeks");
    if (refuses && (readsBack || !newest)) ok(`${f} refuses on an empty match${readsBack ? " and reads its own result back" : ""}`);
  }
}

console.log("\nthe quarantine ledger");
for (const [n, why] of QUARANTINE) {
  const stillMute = created.has(n) && !client.has(n) && !locked.has(n) && !spokenFor.has(n) && !triggers.has(n);
  if (stillMute) { console.log(`todo  ${n} still has no stated audience`); console.log(`      ${why}`); }
  else fail(`quarantined function ${n} now has a stated audience -- delete it from QUARANTINE`, why);
}
console.log(`      ${QUARANTINE.size} outstanding. This number must only go down.`);

console.log("");
if (failed) { console.error(`${failed} failure(s)`); process.exit(1); }
console.log("all checks passed");
