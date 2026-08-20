// The daily recall check has one failure mode that matters more than the rest:
// reporting "no new recalls" when there are some. Everything here defends that.
//
// THE BUG THAT MADE THIS NECESSARY. Transport Canada's VRDB truncates a response
// at 25 rows with no ordering guarantee, and the payload carries no count, no
// envelope, no "hasMore". Measured 2026-08-19 against the live registry:
//
//   /recall/make-name/TOYOTA/year-range/2025-2025      -> 25 rows, 13 recalls
//   ...the same query with &limit=200                  -> 42 rows, 23 recalls
//
// Nine real recalls (RAV4 2026201, CAMRY 2025693, HIGHLANDER 2025694, …) were
// absent from the default response with nothing to indicate it. Built naively,
// a daily check would have gone green every morning on a 43% blind spot — and a
// recall sweep that quietly under-reports is worse than none, because it looks
// like coverage.
//
// Run: node scripts/test-recall-sweep.mjs
import { readFileSync } from "node:fs";
import {
  sweepMake, diffRecalls, recallKey, collapseRefusal, parseRecallDate, SWEEP_LIMIT, SWEEP_LIMIT_MAX, UA,
} from "./lib/tc-recalls.mjs";

const NL = String.fromCharCode(10);
let pass = 0, fail = 0;
const t = (name, cond, why) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}${NL}       ${why}`); }
};

// ---- a stub registry, so this gate never touches the network ---------------
const rec = (o) => Object.entries(o).map(([Name, lit]) => ({ Name, Value: { Literal: String(lit) } }));
const row = (n, model, year, date = "12/5/2024 12:00:00 AM") =>
  rec({ "Recall number": n, "Manufacturer Name": "TOYOTA", "Model name": model, "Make name": "TOYOTA", Year: year, "Recall date": date });
const reply = (set) => async () => ({ ok: true, status: 200, json: async () => ({ ResultSet: set }) });

// ---------------------------------------------------------------------------
// 1. A CAPPED RESPONSE IS NEVER TAKEN AT FACE VALUE
// ---------------------------------------------------------------------------
{
  // A registry that caps at EVERY size can never prove completeness, so it must
  // end as a refusal — with no rows for a caller to mistake for an empty one.
  const capped = async (url) => {
    const lim = Number(new URL(url).searchParams.get("limit"));
    return { ok: true, status: 200, json: async () => ({ ResultSet: Array.from({ length: lim }, (_, i) => row(`R${i}`, "RAV4", 2024)) }) };
  };
  const r = await sweepMake("Toyota", { fetchImpl: capped, limit: 100, maxLimit: 800 });
  t("a response that saturates every ask is refused",
    r.ok === false && r.reason === "truncated",
    `got ${JSON.stringify(r).slice(0, 140)} — a full page means the server capped us and said nothing; accepting it writes a knowingly-incomplete set`);
  t("a refused sweep carries no rows at all",
    r.rows === undefined,
    "a caller must not be able to treat a truncated read as an empty registry — the failure must have no rows array to mistake for one");
}
{
  const r = await sweepMake("Toyota", { fetchImpl: reply([row("2024737", "RAV4", 2024)]), limit: 10 });
  t("a response below the ask is accepted",
    r.ok === true && r.rows.length === 1 && r.escalations === 0,
    "the guard must not reject — or re-ask on — an ordinary complete read");
}
{
  // The boundary that matters: exactly `limit` rows is indistinguishable from a
  // capped page, so it must trigger another ask rather than be accepted.
  let asks = 0;
  const atLimitOnce = async (url) => {
    asks++;
    const lim = Number(new URL(url).searchParams.get("limit"));
    return { ok: true, status: 200, json: async () => ({ ResultSet: Array.from({ length: Math.min(lim, 10) }, (_, i) => row(`X${i}`, "RAV4", 2024)) }) };
  };
  const r = await sweepMake("Toyota", { fetchImpl: atLimitOnce, limit: 10 });
  t("exactly-at-the-ask triggers another ask, it is not assumed complete",
    asks === 2 && r.ok === true && r.rows.length === 10,
    `asks=${asks} — 10 rows for an ask of 10 could be the end of the list or the edge of a page, and only a bigger ask tells them apart`);
}

// ---------------------------------------------------------------------------
// 2. A FAILED READ IS NEVER AN EMPTY REGISTRY
// ---------------------------------------------------------------------------
{
  const thrown = await sweepMake("Toyota", { fetchImpl: async () => { throw new Error("ECONNRESET"); } });
  t("a network failure is not ok and has no rows",
    thrown.ok === false && thrown.reason === "unreachable" && thrown.rows === undefined,
    "an unreachable registry must never render the same as a registry with nothing in it");
  const http = await sweepMake("Toyota", { fetchImpl: async () => ({ ok: false, status: 503 }) });
  t("an HTTP error is not ok and has no rows",
    http.ok === false && http.reason === "http_error" && http.rows === undefined,
    "same contract for a 5xx as for a dead socket");
  const junk = await sweepMake("Toyota", { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  t("a malformed payload is not ok and has no rows",
    junk.ok === false && junk.reason === "bad_shape" && junk.rows === undefined,
    "a body without a ResultSet is a failed read, not zero recalls");
}

// ---------------------------------------------------------------------------
// 3. AN EMPTY OR COLLAPSED SWEEP IS AN UPSTREAM FAULT, NOT A FACT
// ---------------------------------------------------------------------------
// Zero has its own branch on purpose. A 100% drop would also trip the
// percentage rule, but the operator reading the log gets a different diagnosis
// from "collapsed 100.0%" than from "the registry returned nothing" — and only
// the second one points at the upstream. Assert the reason, not just the refusal.
t("zero recalls against a non-empty history is refused, and says why",
  (collapseRefusal("Toyota", 0, 313) || "").includes("not withdrawn in bulk"),
  "recalls are not withdrawn in bulk — a make that had 313 and now reports 0 has an upstream fault (the daily-APR rule: an empty read is an ERROR, never 'withdrawn')");
t("a >50% collapse is refused",
  collapseRefusal("Toyota", 100, 313) !== null,
  "a halving of a make's recall history means the read is wrong, not that history changed");
t("an ordinary sweep is not refused",
  collapseRefusal("Toyota", 314, 313) === null && collapseRefusal("Toyota", 300, 313) === null,
  "growth and normal churn must pass, or the job cries wolf daily and gets ignored");
t("the first-ever sweep for a make has nothing to collapse against",
  collapseRefusal("Polestar", 11, 0) === null,
  "with nothing on file yet, a normal first sweep must be allowed through");

{
  // Measured live 2026-08-19: all 35 canonical makes have recalls, the smallest
  // being Polestar at 11. TC matches the make as a STRING, so an unrecognised
  // name returns an empty ResultSet that looks exactly like a spotless marque.
  const r = await sweepMake("Notamake", { fetchImpl: reply([]) });
  t("an empty sweep is a failure, not a clean marque",
    r.ok === false && r.reason === "empty" && r.rows === undefined,
    "an unrecognised make name returns zero rows; accepting that would publish 'no recalls' for an entire manufacturer");
}

{
  // Ford proved the fixed limit wrong on the sweep's FIRST live run: it returned
  // exactly 5,000 rows at limit=5,000, and its true size is 5,167 rows / 1,343
  // recalls. A fixed ceiling is a guess with an expiry date, so the sweep
  // escalates until the registry shows it the end of the list.
  let asks = [];
  const rows120 = Array.from({ length: 120 }, (_, i) => row(`R${i}`, "F-150", 2024));
  const escalating = async (url) => {
    const lim = Number(new URL(url).searchParams.get("limit"));
    asks.push(lim);
    return { ok: true, status: 200, json: async () => ({ ResultSet: rows120.slice(0, Math.min(lim, 120)) }) };
  };
  const r = await sweepMake("Ford", { fetchImpl: escalating, limit: 100, maxLimit: 100000 });
  t("a saturated response escalates instead of being accepted or refused",
    r.ok === true && r.rows.length === 120 && asks.length > 1 && asks[1] > asks[0],
    `asks=${JSON.stringify(asks)} — at limit=100 the registry returned 100; only a bigger ask can prove whether that was the end`);
  t("escalation stops as soon as the answer is provably complete",
    r.asked > 100 && r.raw_rows < r.asked,
    "a response strictly smaller than the ask IS the proof of completeness — asking further would be wasted calls");
}
{
  // But escalation must not become an infinite excuse: a registry that caps at
  // every size is still a truncated read, and must end as a refusal.
  const always = async (url) => {
    const lim = Number(new URL(url).searchParams.get("limit"));
    return { ok: true, status: 200, json: async () => ({ ResultSet: Array.from({ length: lim }, (_, i) => row(`R${i}`, "F-150", 2024)) }) };
  };
  const r = await sweepMake("Ford", { fetchImpl: always, limit: 100, maxLimit: 800 });
  t("a registry that caps at every size ends in refusal, not an endless climb",
    r.ok === false && r.reason === "truncated",
    "escalation is a way to prove completeness, never a way to eventually accept a capped page");
}

// ---------------------------------------------------------------------------
// 4. "NEW" MEANS NEW TO THE BUYER'S ACTUAL CAR
// ---------------------------------------------------------------------------
{
  const known = [{ recall_number: "2024737", make: "Toyota", model: "RAV4", year: 2024 }];
  const fresh = [
    { recall_number: "2024737", make: "Toyota", model: "RAV4", year: 2024 },   // same
    { recall_number: "2024737", make: "Toyota", model: "RAV4", year: 2025 },   // same recall, other year
    { recall_number: "2024737", make: "Toyota", model: "CAMRY", year: 2024 },  // same recall, other model
    { recall_number: "2026201", make: "Toyota", model: "RAV4", year: 2024 },   // genuinely new
  ];
  const added = diffRecalls(fresh, known);
  t("the diff key is recall + make + model + year, not the recall number alone",
    added.length === 3,
    `got ${added.length}; one recall number covers many models and years, and a buyer only cares about the intersection that is theirs`);
  t("an already-known recall is not re-reported",
    !added.some((r) => r.recall_number === "2024737" && r.model === "RAV4" && r.year === 2024),
    "re-reporting known recalls daily trains the reader to ignore the report");
  t("the key is case-insensitive on make and model",
    recallKey({ recall_number: "1", make: "toyota", model: "rav4", year: 2024 }) ===
    recallKey({ recall_number: "1", make: "TOYOTA", model: "RAV4", year: 2024 }),
    "TC returns upper case and our catalog is mixed case; a case difference must not manufacture a fake new recall every single day");
}

// ---------------------------------------------------------------------------
// 5. DATES ARE PARSED OR NULL — NEVER GUESSED
// ---------------------------------------------------------------------------
t("a TC date parses to ISO",
  parseRecallDate("12/5/2024 12:00:00 AM") === "2024-12-05",
  "M/D/YYYY is the VRDB format");
t("an unparseable date is null, not today",
  parseRecallDate("") === null && parseRecallDate("soon") === null && parseRecallDate("13/45/2024") === null,
  "substituting today's date would make an old recall look new on the next diff — the one thing this job must never do");

// ---------------------------------------------------------------------------
// 6. WIRING — the job must actually be able to run, and must not send
// ---------------------------------------------------------------------------
const script = readFileSync("scripts/check-recalls-daily.mjs", "utf8");
const wf = readFileSync(".github/workflows/recall-check-daily.yml", "utf8");
const makesTs = readFileSync("supabase/functions/_shared/makes.ts", "utf8");

t("the workflow is scheduled daily",
  /cron:\s*["']\d+\s+\d+\s+\*\s+\*\s+\*["']/.test(wf),
  "a recall check that only runs on demand is the situation this replaced");

// The 46-day lesson: a workflow outside .github/workflows never runs and never
// fails. check:jobs enforces this repo-wide; pinned here too because this file
// is the one whose silence would be most costly.
t("the workflow lives where GitHub looks",
  wf.includes("name: Recall check (daily)"),
  "read from .github/workflows/recall-check-daily.yml — if this throws, the file is not where GitHub reads workflows from");

t("the sweep guard runs before the sweep",
  wf.indexOf("test:recall-sweep") > 0 && wf.indexOf("test:recall-sweep") < wf.indexOf("check-recalls-daily.mjs"),
  "the offline contract check is free; running it after the sweep would let a broken build write first");

// Standing rule: scheduled jobs COMPUTE and STAGE, they never deliver.
t("the job has no outbound delivery path",
  !/nodemailer|sendgrid|resend|postmark|mailgun|twilio|slack\.com|hooks\.|webhook|sendEmail|email-quote-report/i.test(script),
  "scheduled jobs compute and stage; sending a recall notice to anyone is a separate approved act");
t("the staged output says it was not sent",
  script.includes("STAGED, not sent") && script.includes("Nothing has been sent"),
  "the summary must state plainly that staging is not delivery, so nobody assumes buyers were notified");

// SEEDING IS NOT DETECTING. The cold run finds 40,471 recalls "not on file" —
// issued over 57 years, not overnight. Reporting those as new would be false on
// its face and would teach the reader that this report is noise, which is how a
// monitor dies. A first sweep records a baseline silently.
t("a first sweep records a baseline instead of reporting everything as new",
  script.includes("const seeding = known.size === 0;") &&
  script.includes("const added = seeding ? [] : diffRecalls(got.rows, known);"),
  "without this the cold start stages 40,471 'new' recalls and every later real alert is buried in that habit");
t("the baseline sweep is distinguishable afterwards",
  script.includes('status: seeding ? "seeded" : "ok"'),
  "recall_sweep must record WHICH runs were baselines, or a later audit cannot tell a seeded make from a checked one");
t("new recalls are grouped by recall, not listed per model-year",
  script.includes("byRecall") && script.includes("Covering ${allNew.length} model-year"),
  "one recall spans every affected year (Ford 2026339 covers EXPLORER 2020-2026); a row per year turns a few real events into a wall");

t("a partial sweep exits red",
  script.includes("process.exit(failures.length ? 1 : 0)"),
  "'didn't resolve' is RED, never neutral — a green run must mean every make was actually read");
{
  // Every failure branch inside the per-make loop has to fall through to the
  // next make. Counted rather than merely present: the guard that only asked
  // whether the wiring existed *somewhere* is the one that missed PR #220.
  const loop = script.slice(script.indexOf("for (const make of makes)"));
  const NEWLINE = String.fromCharCode(10);
  const continues = loop.split(NEWLINE + "    continue;").length - 1;
  const throws = loop.split(NEWLINE + "    throw ").length - 1;
  t("every failure path inside the make loop falls through to the next make",
    continues >= 3 && throws === 0,
    `found ${continues} fall-through(s) and ${throws} throw(s); one OEM's outage must never cost the other 34 makes their sweep`);
}
t("a failed make is recorded, not silently skipped",
  script.includes("status: got.reason") && script.includes("wrote: false"),
  "an unreadable make must leave a trace, or a green-looking run hides a make that has not been checked in weeks");

t("the sweep identifies itself to the government endpoint",
  UA.includes("LotCheck") && UA.includes("http"),
  "an anonymous client is how the Overpass dealer job got 406'd on every mirror for a month");

// A make added to makes.ts but not here would simply never be swept, and nothing
// would look wrong. Pin the two lists together.
{
  const canon = (makesTs.match(/const CANONICAL_MAKES\s*=\s*\[([\s\S]*?)\]/) || [])[1] || "";
  const inTs = [...canon.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const inJob = [...(script.match(/const MAKES\s*=\s*\[([\s\S]*?)\]/) || ["", ""])[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const missing = inTs.filter((m) => !inJob.includes(m));
  const extra = inJob.filter((m) => !inTs.includes(m));
  t(`every canonical make is swept (${inTs.length} makes)`,
    inTs.length > 0 && missing.length === 0 && extra.length === 0,
    `missing from the sweep: ${missing.join(", ") || "none"} | not a canonical make: ${extra.join(", ") || "none"}`);
}

// The migration has to exist, or the job writes into nothing.
{
  const mig = readFileSync("supabase/migrations/20260819_vehicle_recall.sql", "utf8");
  t("the state tables exist and are RLS-locked with no anon grant",
    mig.includes("create table if not exists public.vehicle_recall") &&
    mig.includes("create table if not exists public.recall_sweep") &&
    /alter table public\.vehicle_recall enable row level security/.test(mig) &&
    mig.includes("revoke all on public.vehicle_recall from anon, authenticated"),
    "same posture as city_dealer_index — the sweep writes it, nothing public reads it");
  t("the natural key is unique so a re-sweep cannot duplicate",
    mig.includes("unique (recall_number, make, model, year)"),
    "without it the upsert has nothing to conflict on and every daily run appends the whole registry again");
  t("first_seen_at is defaulted, not written by the job",
    mig.includes("first_seen_at  timestamptz not null default now()") &&
    !script.includes("first_seen_at:"),
    "if the job set first_seen_at on every upsert, every recall would look new every day and the diff would be meaningless");
}

console.log(`${NL}${fail ? "❌" : "✅"} recall-sweep: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
