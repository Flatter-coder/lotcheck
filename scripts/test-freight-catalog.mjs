// Freight + PDI catalogue and its daily verifier — offline, no network, no DB.
//
// WHAT THIS IS FOR. Vic, 2026-09-17, on a 2026 BMW X3 at BMW Royal Oak:
//
//     MSRP              $60,400.00
//     Freight and PDI    $4,395.00
//
// 7.3% of MSRP, $1,625 above the highest freight figure the catalogue held for
// any make (Volvo XC60, $2,770) and 2.3x the lowest (Toyota RAV4, $1,930). The
// catalogue covered 12 rows across 35 makes and had no refresh job of any kind.
//
// This figure is not trivia. In an all-in-pricing province the advertised price
// INCLUDES freight, so an ex-freight MSRP compared against it produces a markup
// that is not there -- that is how a buyer was told a dealer had added $3,164 to
// a 4Runner when they had not (PR #492). A wrong freight charge is a false
// accusation about a named business.
//
// Run: node --experimental-strip-types scripts/test-freight-catalog.mjs

import { freightCatalog } from "../supabase/functions/_shared/fee-schedule.ts";
import { verifyRow, assess, moneyNear, sourceUrlOf, NOT_READ } from "./lib/freight-verify.mjs";

let failures = 0;
const fail = (what, got, want) => {
  failures++;
  console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
};
const eq = (what, got, want) => { if (got !== want) fail(what, got, want); };

// ── 1. every stored figure can be defended ────────────────────────────────
console.log("1. every freight row names its source, its date and a plausible amount");
{
  const rows = freightCatalog();
  if (!rows.length) fail("the catalogue is not empty", 0, "at least one row");
  for (const r of rows) {
    const who = `${r.make} ${r.model}`;
    if (!r.make || !r.model) fail(`${who}: make and model`, r, "both set");
    if (!r.source) fail(`${who}: source`, r.source, "a source");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.capturedOn || ""))) {
      fail(`${who}: capturedOn is a date`, r.capturedOn, "YYYY-MM-DD");
    }
    // A FREIGHT CHARGE IS NEVER A SMALL NUMBER. Below this band it is an A/C
    // charge ($100), a tire levy ($20) or an AMVIC fee ($10) that got read as
    // freight; above it, a vehicle price. Both mistakes are real: moneyNear has
    // to look near the word "freight" for exactly this reason.
    if (!(r.amount >= 900 && r.amount <= 9000)) {
      fail(`${who}: amount is a plausible Canadian freight charge`, r.amount, "900..9000");
    }
    // The label is the maker's own wording, and it is what tells a reader
    // whether PDI is inside the figure. "Freight and PDI $2,195" and
    // "Destination $2,195" are not the same claim.
    if (!r.label) fail(`${who}: label`, r.label, "the maker's own wording");
  }
  console.log(`   ${rows.length} row(s) checked`);
}

// ── 2. a figure with no re-readable URL is reported, never assumed fresh ──
console.log("2. a row with no source URL is 'no_source', not silently confirmed");
{
  eq("no url at all", verifyRow({ amount: 2000 }, "page text").status, "no_source");
  eq("a prose source is not a URL", verifyRow({ source_url: "Toyota Canada Build & Price" }, "x").status, "bad_url");
  eq("sourceUrlOf rejects prose", sourceUrlOf("Nissan Canada press room").why, "bad_url");
  eq("sourceUrlOf accepts a link", sourceUrlOf("https://www.bmw.ca/x3").url, "https://www.bmw.ca/x3");
}

// ── 3. reading the right number off a real fee stack ──────────────────────
console.log("3. the A/C charge and the tire levy are not freight");
{
  // The shape these pages actually take, from the BMW listing that started this.
  const page = "Prices exclude Freight and PDI of $4,395, air conditioning charge of $100, "
    + "tire levy of $20 and AMVIC fee of $10.";
  const seen = moneyNear(page);
  eq("only the freight figure is read", seen.join(","), "4395");
  // WHY THE SMALL FEES ARE EXCLUDED, stated correctly. An earlier version of
  // this file credited the lower bound of the plausibility band, and an
  // injection that widened that band to $5 still passed -- because $100, $20 and
  // $10 are two and three digit figures that the money pattern never matches in
  // the first place. The assertion was true for a reason it did not name, which
  // left the band itself untested. What the band really protects against is the
  // number on the OTHER side: a vehicle price sitting near the freight wording.
  eq("a 3-digit fee is not money this pattern reads", moneyNear("freight $100").join(","), "");
  eq("MSRP beside the freight line is not freight",
    moneyNear("Freight and PDI $4,395. MSRP $60,400.").join(","), "4395");
  eq("a six-figure price near the word is refused",
    moneyNear("destination charge applies. Total price $104,900.").join(","), "");
  eq("confirmed when it agrees", verifyRow({ source_url: "https://x.ca", amount: 4395 }, page).status, "confirmed");
  eq("drifted when it does not", verifyRow({ source_url: "https://x.ca", amount: 4195 }, page).status, "drifted");
}
{
  // Bundled vs itemised: both must read, because makers differ and the label is
  // what records which one it is.
  eq("Delivery and Destination wording", moneyNear("Delivery and Destination Charge: $1,930").join(","), "1930");
  eq("Freight & PDI wording", moneyNear("Freight & PDI $2,185").join(","), "2185");
  eq("CA$ prefix", moneyNear("freight and PDI of CA$2,080").join(","), "2080");
}

// ── 4. a page that says nothing is not a finding ──────────────────────────
console.log("4. a shell page is 'not_stated' -- we did not read it, the maker did not change it");
{
  const r = verifyRow({ source_url: "https://x.ca", amount: 2195 }, "Welcome to our Canadian site.");
  eq("status", r.status, "not_stated");
  if (r.status === "drifted") fail("a silent page must never read as drift", r.status, "not_stated");
}

// ── 5. their refusal is not our outage, and we never route around it ──────
console.log("5. a 403 is recorded as the manufacturer's refusal");
{
  eq("403", verifyRow({ source_url: "https://x.ca", amount: 1 }, null, 403).status, "blocked");
  eq("429", verifyRow({ source_url: "https://x.ca", amount: 1 }, null, 429).status, "blocked");
  eq("404", verifyRow({ source_url: "https://x.ca", amount: 1 }, null, 404).status, "dead_link");
  eq("network failure", verifyRow({ source_url: "https://x.ca", amount: 1 }, null, 0).status, "unreachable");
  // Every one of these means the figure was NOT re-read, and the refusal
  // threshold counts all of them. Splitting a status without adding it to
  // NOT_READ is how a threshold gets loosened by a refactor.
  for (const s of ["unreachable", "blocked", "dead_link", "bad_url", "no_source"]) {
    if (!NOT_READ.includes(s)) fail(`NOT_READ covers ${s}`, NOT_READ, "includes " + s);
  }
}

// ── 6. THE CALIBRATION. Day one must not be red ───────────────────────────
// The twelve figures the catalogue already held name a source in prose, not a
// link, so none can be re-read. That is our backlog. A guard that fires on
// healthy data the first time it runs gets switched off before it catches
// anything real, so the refusal is measured only over rows that HAD a page.
console.log("6. a backlog of missing URLs is amber; a failure to read real pages is red");
{
  const allNoSource = Array.from({ length: 12 }, (_, i) => ({ key: "k" + i, status: "no_source" }));
  const a1 = assess(allNoSource);
  eq("12 rows with no URL are not red", a1.red, false);
  eq("and they are counted", a1.noSource, 12);

  // Now the real signal: pages we COULD have read, and most refused.
  const mostBlocked = [
    { key: "a", status: "blocked" }, { key: "b", status: "blocked" },
    { key: "c", status: "blocked" }, { key: "d", status: "confirmed" },
  ];
  eq("3 of 4 fetchable pages unreadable is red", assess(mostBlocked).red, true);

  // A backlog alongside a healthy read must not drag the run red.
  const mixed = [
    { key: "a", status: "no_source" }, { key: "b", status: "no_source" },
    { key: "c", status: "no_source" }, { key: "d", status: "confirmed" },
  ];
  eq("a backlog beside a good read stays green", assess(mixed).red, false);
}

// ── 7. drift goes red only against our OWN confirmed history ──────────────
console.log("7. drift is red only where we confirmed the figure before");
{
  const res = [{ key: "BMW|X3", status: "drifted" }];
  eq("never confirmed -> amber", assess(res, { previous: {} }).red, false);
  eq("was confirmed -> red", assess(res, { previous: { "BMW|X3": "confirmed" } }).red, true);
  eq("the regression is named", assess(res, { previous: { "BMW|X3": "confirmed" } }).regressed.length, 1);
}

if (failures) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log(
  `\nOK — ${freightCatalog().length} freight figure(s) defensible, the A/C charge and tire levy are never ` +
  `mistaken for freight, a silent page is not drift, a 403 is their refusal, and a backlog of missing ` +
  `source URLs is reported without turning the run red.`,
);
