// ============================================================================
// WHY DID THAT SCAN FAIL? — read the breadcrumb instead of guessing at it.
//
// WHY THIS EXISTS. analyze-listing-url writes a diagnostic breadcrumb on every
// failed scan, and its own comment says why:
//
//     "a hollow/failed PAID scan must be diagnosable from SQL alone -- edge
//      console logs live only in the dashboard, and three hollow reports in two
//      days each burned a round-trip through Vic just to learn WHICH layer died"
//
// The breadcrumb has been written faithfully ever since. Nobody could read it.
// Reading api_usage_log needs the service key, the service key lives in repo
// secrets, and there was no way to run a query with it — so every failure since
// has been diagnosed by inference from a screenshot, which is how the same
// Advantage Ford link got three different theories in one day.
//
// This closes that. It reads ONLY, prints the trace, and never writes anything.
//
// THE BREADCRUMB'S SHAPE, so the output can be read without the source open:
//
//   Nimble failed: <errBody> | direct=ok:NNNN|fail | preRender=html:N,shot:N|null
//                  | <rescueTrace> | sfErr=<lastScrapflyError>
//
//   direct=     the shared browser-UA GET. `fail` means walled, hung or refused.
//   preRender=  what the pre-warmed Scrapfly ASP render delivered. `null` means
//               it never ran or returned nothing.
//   sfErr=      why Scrapfly's LAST render call failed.
//
// Run (Node 24+, from repo root; needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY):
//   node scripts/scan-forensics.mjs                      # last 20 failures
//   node scripts/scan-forensics.mjs --hours 6
//   node scripts/scan-forensics.mjs --grep advantageford
//   node scripts/scan-forensics.mjs --all                # successes too
// ============================================================================

const ARG = (n, d = null) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const HOURS = Number(ARG("--hours", "24")) || 24;
const LIMIT = Number(ARG("--limit", "20")) || 20;
const GREP = ARG("--grep");
const ALL = process.argv.includes("--all");

const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) { console.error("Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }

const { createClient } = await import("@supabase/supabase-js");
const supabase = createClient(URL_, KEY);

const since = new Date(Date.now() - HOURS * 3_600_000).toISOString();

let q = supabase.from("api_usage_log")
  .select("created_at,feature,success,error_message,cost_usd,input_tokens,output_tokens")
  .gte("created_at", since)
  .order("created_at", { ascending: false })
  .limit(LIMIT);
if (!ALL) q = q.eq("success", false);
if (GREP) q = q.ilike("error_message", `%${GREP}%`);

const { data, error } = await q;
if (error) { console.error("could not read api_usage_log:", error.message); process.exit(1); }

console.log(`\n${data.length} row(s) in the last ${HOURS}h${ALL ? "" : " (failures only)"}${GREP ? ` matching "${GREP}"` : ""}\n`);

// The layers, pulled out of the breadcrumb so the answer is readable at a glance
// rather than reconstructed from a long string every time.
const layer = (msg, key) => {
  const m = String(msg || "").match(new RegExp(`${key}=([^|]*)`));
  return m ? m[1].trim() : null;
};

for (const r of data) {
  const when = new Date(r.created_at).toISOString().replace("T", " ").slice(0, 19);
  console.log(`${when}  ${r.feature}  ${r.success ? "OK" : "FAIL"}${r.cost_usd ? `  $${r.cost_usd}` : ""}`);
  const msg = r.error_message || "";
  if (!msg) { console.log("   (no message)\n"); continue; }

  const direct = layer(msg, "direct"), pre = layer(msg, "preRender"), sf = layer(msg, "sfErr");
  if (direct || pre || sf) {
    // WHICH LAYER DIED, named. This is the whole point of the file.
    console.log(`   direct read : ${direct ?? "-"}${direct === "fail" ? "   <- the plain GET was refused/hung" : ""}`);
    console.log(`   ASP render  : ${pre ?? "-"}${pre === "null" ? "   <- the anti-bot render produced nothing" : ""}`);
    if (sf && sf !== "none") console.log(`   scrapfly    : ${sf}`);
    const nimble = msg.split("|")[0].replace(/^Nimble failed:\s*/, "").trim();
    if (nimble) console.log(`   nimble      : ${nimble.slice(0, 200)}`);
  } else {
    console.log(`   ${msg.slice(0, 400)}`);
  }
  // AND THE RAW LINE, ALWAYS. The pretty view above only knows the keys it was
  // written for, so the first time the breadcrumb gained new fields
  // (pageSrc / jsonLdVeh / convertus / d2c -- added the moment they were the
  // answer) this reader silently dropped exactly the part worth reading.
  // A diagnostic that filters its own evidence is the thing it replaces.
  console.log(`   raw: ${msg}`);
  console.log();
}

// A failed scan that still cost the buyer a credit is its own defect, and it is
// invisible in this table — the ledger lives elsewhere. Say so rather than let
// the absence read as "nothing was charged". [[never-charge-to-ask-a-question]]
if (!ALL && data.length) {
  console.log("Note: this table records the SCAN, not the credit. A failure here should have");
  console.log("released the hold; confirm against the credit ledger before concluding it did.");
}
