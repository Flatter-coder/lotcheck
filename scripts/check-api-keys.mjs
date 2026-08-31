#!/usr/bin/env node
// DAILY 6AM: is every API key still alive, and when does it die?
//
// Vic, 2026-08-31: "i need daily checks 6am everty making sure all API Keys
// still running it will great to know when they expire so i can reset then
// all".
//
// WHAT PROMPTED IT. The Scrapfly key had been returning 401 for an unknown
// period and nothing noticed, because the code that believed it was checking
// the key was really checking that the variable was non-empty:
//
//     export function scrapflyEnabled() { return !!SCRAPFLY_API_KEY }
//
// So a rejected key read as "enabled", the anti-bot render returned null on
// every walled dealer host, and a buyer saw "we could not read this page" --
// which looks exactly like a page that had nothing on it. The failure was
// invisible by construction. [[no-single-point-of-failure]]
//
// TWO STORES, BOTH CHECKED. A key can live in a GitHub repo secret (what the
// workflows use) and in a Supabase function secret (what a BUYER'S SCAN uses),
// and those two can disagree. Only the buyer-facing half matters to a report,
// and until now only the other half could be checked at all:
//
//   * this environment's keys      -> called directly from here
//   * production's function secrets -> asked via the key-health edge function,
//                                      which returns verdicts and never values
//
// EXPIRY, HONESTLY. Only the Supabase keys are JWTs with a real `exp`. For
// every other vendor, "no expiry published" is the true answer and a guessed
// date would be worse than none, so this prints the distinction rather than
// blurring it. [[present-without-creating-questions]]
//
// RED, NOT A NOTE. Exits 1 when a buyer-facing key is dead or expires within
// EXPIRY_WARN_DAYS. A daily check that logs a dead key and exits 0 is the same
// as no check at all.
//
// REPORTS, NEVER SENDS. [[never-send-without-approval]]
//
// Run: node scripts/check-api-keys.mjs

const EXPIRY_WARN_DAYS = 30;
const UA = "LotCheck/1.0 (API key health check; +https://lotcheck.ca)";
const TIMEOUT = 25_000;

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

const problems = [];
const warnings = [];

const pad = (s, n) => String(s).padEnd(n);
const DAY = 86_400_000;

function daysUntil(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.round((t - Date.now()) / DAY) : null;
}

// --- this environment's keys ------------------------------------------------
// Checked directly, because in CI these ARE the repo secrets. A key present
// here but rejected is a broken workflow; a key absent here that a workflow
// names is a workflow that has been running on an empty string.
async function checkLocal(name, label, run) {
  const raw = (process.env[name] || "").trim();
  if (!raw) return { name, label, state: "absent", detail: "not set in this environment" };
  try {
    const r = await run(raw);
    return { name, label, ...r };
  } catch (e) {
    return { name, label, state: "unclear", detail: String(e?.name || e?.message).slice(0, 60) };
  }
}

function statusVerdict(status, okDetail) {
  if (status >= 200 && status < 300) return { state: "working", detail: okDetail };
  if (status === 401 || status === 403) return { state: "rejected", detail: `HTTP ${status}` };
  if (status === 402) return { state: "rejected", detail: "HTTP 402 - payment required / quota exhausted" };
  // 429 and 5xx are about the vendor's day, not our credential. Calling them a
  // dead key sends Vic to rotate something that was fine.
  return { state: "unclear", detail: `HTTP ${status} - not a verdict on the key` };
}

function jwtExpiry(token) {
  try {
    const p = token.split(".")[1];
    if (!p) return null;
    const json = Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const exp = JSON.parse(json)?.exp;
    return typeof exp === "number" ? new Date(exp * 1000).toISOString() : null;
  } catch { return null; }
}

const local = await Promise.all([
  checkLocal("SCRAPFLY_API_KEY", "Scrapfly", async (k) => {
    const u = new URL("https://api.scrapfly.io/account");
    u.searchParams.set("key", k);
    const r = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT) });
    if (!r.ok) return statusVerdict(r.status, "");
    const j = await r.json().catch(() => null);
    if (j?.account?.suspended) return { state: "rejected", detail: "account SUSPENDED" };
    const u2 = j?.subscription?.usage?.scrape;
    return { state: "working", detail: u2 ? `${u2.current}/${u2.limit} credits used` : "accepted" };
  }),
  checkLocal("SUPABASE_SERVICE_ROLE_KEY", "Supabase (service role)", async (k) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      headers: { apikey: k, authorization: `Bearer ${k}`, "User-Agent": UA },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    return { ...statusVerdict(r.status, "accepted by PostgREST"), expiresAt: jwtExpiry(k) };
  }),
  checkLocal("APIFY_TOKEN", "Apify", async (k) => {
    const r = await fetch(`https://api.apify.com/v2/users/me?token=${encodeURIComponent(k)}`,
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT) });
    return statusVerdict(r.status, "authenticated");
  }),
  checkLocal("SUPABASE_ACCESS_TOKEN", "Supabase (management)", async (k) => {
    const r = await fetch("https://api.supabase.com/v1/projects",
      { headers: { authorization: `Bearer ${k}`, "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT) });
    return statusVerdict(r.status, "authenticated");
  }),
]);

console.log("=".repeat(78));
console.log("API KEY HEALTH — this environment (the GitHub repo secrets, in CI)");
console.log("=".repeat(78));
for (const c of local) {
  const exp = c.expiresAt ? `  expires ${c.expiresAt.slice(0, 10)} (${daysUntil(c.expiresAt)}d)` : "";
  console.log(`  ${pad(c.label, 26)} ${pad(c.state.toUpperCase(), 9)} ${c.detail}${exp}`);
  if (c.state === "rejected") problems.push(`${c.name} (workflows) is REJECTED: ${c.detail}`);
  if (c.state === "absent") warnings.push(`${c.name} is not set in this environment`);
  const d = daysUntil(c.expiresAt);
  if (d !== null && d <= EXPIRY_WARN_DAYS) problems.push(`${c.name} expires in ${d} day(s) — rotate it`);
}

// --- production's function secrets ------------------------------------------
console.log("");
console.log("=".repeat(78));
console.log("API KEY HEALTH — production (the Supabase function secrets a BUYER depends on)");
console.log("=".repeat(78));

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.log("  cannot ask production: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  problems.push("production could not be asked — the buyer-facing keys are UNCHECKED");
} else {
  let body = null, httpErr = "";
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/key-health`, {
      method: "POST",
      headers: { authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text().catch(() => "");
    if (res.ok) { try { body = JSON.parse(text); } catch { httpErr = "unparseable response"; } }
    else httpErr = `HTTP ${res.status} ${text.slice(0, 140)}`;
  } catch (e) { httpErr = String(e?.name || e?.message).slice(0, 80); }

  if (!body) {
    // Deliberately loud. "We could not check" must never read the same as
    // "we checked and it was fine".
    console.log(`  key-health did not answer: ${httpErr}`);
    console.log("  (if it is not deployed yet, run the deploy-edge-functions workflow)");
    problems.push(`the buyer-facing keys are UNCHECKED — key-health did not answer: ${httpErr}`);
  } else {
    for (const v of body.vendors || []) {
      const d = daysUntil(v.expiresAt);
      const exp = v.expiryKnown && v.expiresAt ? `  expires ${v.expiresAt.slice(0, 10)} (${d}d)` : "  no expiry published";
      console.log(`  ${pad(v.vendor + " / " + v.key, 40)} ${pad(v.state.toUpperCase(), 9)} ${v.detail}${exp}`);
      if (v.state === "rejected") problems.push(`PRODUCTION ${v.key} is REJECTED by ${v.vendor}: ${v.detail}`);
      if (v.state === "absent" && v.buyerFacing) problems.push(`PRODUCTION ${v.key} is NOT CONFIGURED — the feature that needs it is silently off`);
      if (d !== null && d <= EXPIRY_WARN_DAYS) problems.push(`PRODUCTION ${v.key} expires in ${d} day(s) — rotate it`);
    }
    console.log("");
    for (const s of body.shared || []) {
      console.log(`  ${pad("internal / " + s.key, 40)} ${pad(String(s.state).toUpperCase(), 9)} ${s.detail}`);
      if (s.state === "absent") warnings.push(`${s.key} is not configured in production`);
    }
  }
}

// --- verdict ----------------------------------------------------------------
console.log("");
console.log("=".repeat(78));
if (warnings.length) {
  console.log("NOTED (not failing):");
  for (const w of warnings) console.log(`  - ${w}`);
}
if (!problems.length) {
  console.log("ALL KEYS HEALTHY. Nothing expires within " + EXPIRY_WARN_DAYS + " days.");
  console.log("=".repeat(78));
  process.exit(0);
}
console.error("PROBLEMS FOUND:");
for (const p of problems) console.error(`  - ${p}`);
console.error("=".repeat(78));
console.error("Scrapfly: fix with `npm run key:scrapfly`, then run the sync-scrapfly-key");
console.error("workflow so the SUPABASE half is updated too — key:scrapfly alone only");
console.error("fixes the workflows, not what buyers depend on.");
process.exit(1);
