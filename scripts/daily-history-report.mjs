// DAILY HISTORY REPORT — what changed across tracked Alberta listings in a window.
//
// Vic, 2026-09-11: "going fowards, i will ask (daily history report in last 24h)".
//
// Reads the anon RPC `fn_listing_history_24h`, the same public endpoint
// alberta-inventory-daily.html already uses. No service-role key, no writes,
// nothing this could break.
//
// WHAT IT REFUSES TO DO.
//   * Lead with totals. A standing count repeated every morning says nothing;
//     the movement is the product.
//   * Call a delisting a sale. We stopped seeing it advertised. That is all we
//     observed, and it is all this prints.
//   * Print "nothing happened" when the truth is "we did not look". If no crawl
//     landed in the window, that is the headline, not an empty list.
//   * Imply a motive when a price moves, in either direction.
//
// Run:  node scripts/daily-history-report.mjs [--hours=24] [--limit=300] [--json]

const SUPA = process.env.SUPABASE_URL || "https://debigtyjhjamipooajhk.supabase.co";
// The ANON key, which is public by design and already shipped in
// public/alberta-inventory-daily.html. It grants exactly what the public page
// has: execute on the read-only RPCs. Overridable for another environment.
const ANON = process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlYmlndHlqaGphbWlwb29hamhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NjQ4OTEsImV4cCI6MjA5ODQ0MDg5MX0.PujrRSJA_CWQKEtzGLtbAwk2Uq6VZAJDKEyS56exP9A";

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const HOURS = Number(arg("hours", 24));
const LIMIT = Number(arg("limit", 300));
const AS_JSON = process.argv.includes("--json");

const money = (n) => (n == null || !Number.isFinite(Number(n)))
  ? null : "$" + Math.round(Number(n)).toLocaleString("en-CA");
const car = (e) => [e.year, e.make, e.model, e.trim].filter(Boolean).join(" ") || "(unnamed listing)";
const where = (e) => [e.city, e.dealerName].filter(Boolean).join(" · ") || "(dealer not named)";
const when = (s) => (s ? String(s).replace("T", " ").replace(/Z$/, "") : "unknown");

// Fields whose value is the dealer's own claim about the car. An odometer that
// moves is a different kind of event from a trim string being tidied up, and
// the report should not flatten the two.
const MATERIAL = new Set(["odometer_km", "damaged", "certified", "condition", "date_entry", "days_in_inventory"]);
const FIELD_LABEL = {
  odometer_km: "Odometer", damaged: "Damaged flag", certified: "Certified flag",
  condition: "Condition", date_entry: "Dealer's own date on lot", days_in_inventory: "Dealer's own days-in-inventory",
  trim: "Trim", status: "Status", stock_no: "Stock number", msrp: "MSRP",
  demo: "Demo flag", year: "Year", make: "Make", model: "Model",
};

async function main() {
  const res = await fetch(`${SUPA}/rest/v1/rpc/fn_listing_history_24h`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_hours: HOURS, p_limit: LIMIT }),
  });
  if (!res.ok) {
    console.error(`Could not read the history: HTTP ${res.status} ${res.statusText}`);
    console.error(await res.text().catch(() => ""));
    console.error("");
    console.error("If this is a 404 on the function, the 20260911 migration has not been applied yet.");
    process.exitCode = 1;
    return;
  }
  const d = await res.json();
  if (AS_JSON) { console.log(JSON.stringify(d, null, 2)); return; }

  const cov = d.coverage || {};
  const c = d.counts || {};
  const events = d.events || [];

  console.log(`DAILY HISTORY — last ${d.windowHours ?? HOURS}h`);
  console.log("=".repeat(60));

  // Coverage first, and bluntly. A report over no reads is not an empty market.
  if (!Number(cov.readsInWindow)) {
    console.log("");
    console.log("  NO CRAWL LANDED IN THIS WINDOW.");
    console.log("  Nothing below is a statement about the market — we did not look.");
    console.log("  (The standing crawl is off pending counsel; it runs on demand.)");
    console.log("");
    return;
  }
  // TWO SEPARATE FACTS, NOT A RATIO. dealersRead counts every dealer seen in the
  // window INCLUDING ones since deactivated; dealersActive is today's roster.
  // The first can legitimately exceed the second -- the first real run of this
  // report returned 35 read against 32 active -- and "35 of 32 active (109.4%)"
  // reads as a broken report, which is the kind of figure that makes a reader
  // stop trusting the ones underneath it.
  const read = Number(cov.dealersRead) || 0, active = Number(cov.dealersActive) || 0;
  console.log(`  Reads in window : ${cov.readsInWindow}  (${when(cov.firstReadAt)} → ${when(cov.lastReadAt)})`);
  console.log(`  Dealers read    : ${read} in this window${read > active ? " (some no longer on the active roster)" : ""}`);
  console.log(`  Dealers active  : ${active} today — a sample of Alberta, never the whole market`);
  console.log("");
  console.log(`  Arrived ${c.new ?? 0} · price moves ${c.priceMoves ?? 0} · detail changes ${c.fieldChanges ?? 0} · stopped being advertised ${c.delisted ?? 0}`);
  if (d.truncated) console.log(`  (capped at ${LIMIT} events — raise --limit to see the rest)`);

  const of = (k) => events.filter((e) => e.kind === k);

  // Detail changes lead, because they are the ones nothing else would catch and
  // the ones a dispute turns on.
  const fields = of("field_change");
  const material = fields.filter((e) => MATERIAL.has(e.field));
  const cosmetic = fields.filter((e) => !MATERIAL.has(e.field));
  if (material.length) {
    console.log("");
    console.log(`LISTING DETAILS THAT CHANGED — ${material.length}`);
    console.log("-".repeat(60));
    for (const e of material) {
      console.log(`  ${FIELD_LABEL[e.field] || e.field}: ${e.oldValue ?? "(blank)"} → ${e.newValue ?? "(blank)"}`);
      console.log(`      ${car(e)} · ${where(e)}`);
      console.log(`      VIN ${e.vin || "(not read)"} · ${when(e.at)}`);
    }
  }
  if (cosmetic.length) console.log(`\n  (+ ${cosmetic.length} other field edits: ${[...new Set(cosmetic.map((e) => FIELD_LABEL[e.field] || e.field))].join(", ")})`);

  const moves = of("price_move");
  if (moves.length) {
    console.log("");
    console.log(`PRICE MOVES — ${moves.length}`);
    console.log("-".repeat(60));
    for (const e of moves) {
      const dir = Number(e.price) > Number(e.prevPrice) ? "up" : "down";
      console.log(`  ${dir} ${money(e.prevPrice)} → ${money(e.price)}   ${car(e)}`);
      console.log(`      ${where(e)} · ${when(e.at)}`);
    }
  }

  const arrived = of("new");
  if (arrived.length) {
    console.log("");
    console.log(`NEWLY ADVERTISED — ${arrived.length}`);
    console.log("-".repeat(60));
    for (const e of arrived) console.log(`  ${money(e.price) ?? "price not stated"}  ${car(e)} · ${where(e)}`);
  }

  const gone = of("delisted");
  if (gone.length) {
    console.log("");
    console.log(`STOPPED BEING ADVERTISED — ${gone.length}`);
    console.log("-".repeat(60));
    console.log("  We stopped seeing these on the dealer's own page. That is what we observed.");
    console.log("  It is not proof of a sale: a car can be pulled, moved between lots, or relisted.");
    for (const e of gone) console.log(`  ${money(e.price) ?? "price not stated"}  ${car(e)} · ${where(e)} · ${when(e.at)}`);
  }

  if (!events.length) {
    console.log("");
    console.log("  The crawl ran and found no changes in this window.");
  }
  console.log("");
}

main().catch((e) => { console.error(e?.message || e); process.exitCode = 1; });
