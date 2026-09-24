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

import { freightCatalog, freightFor } from "../supabase/functions/_shared/fee-schedule.ts";
import { verifyRow, assess, moneyNear, sourceUrlOf, NOT_READ, robotsVerdict, numbersAtKey, amountsByLabel } from "./lib/freight-verify.mjs";

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

// ── 1b. every row can be re-read, or says why it cannot ───────────────────
// 2026-09-24: 38 of 45 rows named their source in prose only, so the daily job
// re-read 7 and reported the rest as a backlog nobody owned. A row now carries
// a sourceUrl on the MAKER'S OWN domain, or an `unsourced` reason in words --
// never a guessed URL, and never neither.
console.log("1b. each row: a maker-owned source URL or a stated reason, a model year, what it covers");
{
  // WHOSE PAGE IT IS, per make. The vendor rule (CLAUDE.md): a freight figure
  // is the substance of a report, so it comes from the manufacturer and nobody
  // else -- not a dealer's site, not a window-sticker service, not a
  // marketplace. A new make fails here until its own domains are named, which
  // is the review this list exists to force.
  const MAKER_DOMAINS = {
    Acura: ["acura.ca", "api.honda.ca"],
    // BMW's configurator (configure.bmw.ca) reads its prices from this host.
    BMW: ["bmw.ca", "bmw.cloud"],
    Chevrolet: ["chevrolet.ca", "gm.ca"],
    Chrysler: ["chrysler.ca", "stellantisnorthamerica.com"],
    Ford: ["ford.ca"],
    Honda: ["honda.ca", "hondanews.ca", "api.honda.ca"],
    Hyundai: ["hyundaicanada.com"],
    Infiniti: ["infiniti.ca", "infinitinews.com"],
    Jeep: ["jeep.ca", "stellantisnorthamerica.com"],
    Kia: ["kia.ca"],
    Lexus: ["lexus.ca"],
    Lincoln: ["lincolncanada.com", "lincoln.ca"],
    Lucid: ["lucidmotors.com"],
    Maserati: ["maserati.com"],
    // Mazda's own configurator calls this API Gateway (scripts/scrape-mazda.mjs);
    // the host is AWS's, the answer is Mazda Canada's.
    Mazda: ["mazda.ca", "n8xgyscaa3.execute-api.ca-central-1.amazonaws.com"],
    MINI: ["mini.ca"],
    Mitsubishi: ["mitsubishi-motors.ca", "mitsubishi-motors-pr.ca"],
    Nissan: ["nissan.ca", "nissannews.com"],
    Polestar: ["polestar.com"],
    Porsche: ["porsche.com"],
    Ram: ["ramtruck.ca", "stellantisnorthamerica.com"],
    Rivian: ["rivian.com"],
    Subaru: ["subaru.ca"],
    Toyota: ["toyota.ca"],
    Volkswagen: ["vw.ca", "vwtools.ca"],
    Volvo: ["volvocars.com"],
  };
  const seenKey = new Map();
  for (const r of freightCatalog()) {
    const who = `${r.make} ${r.model} MY${r.modelYear}`;
    // "current": the maker's live price list names no year (BMW) -- see Fee.
    if (r.modelYear !== "current" && (!Number.isInteger(r.modelYear) || r.modelYear < 2025 || r.modelYear > 2028)) {
      fail(`${who}: modelYear is a current model year`, r.modelYear, "2025..2028 or \"current\"");
    }
    if (r.modelYear === "current" && !r.read) fail(`${who}: a "current" row is read from a live price list`, r.read, "a read spec");
    if (r.covers !== "freight_pdi" && r.covers !== "freight_only") {
      fail(`${who}: covers says whether PDI is inside the figure`, r.covers, "freight_pdi | freight_only");
    }
    // ONE ROW PER (make, model, year). freightFor would silently answer with
    // the first, and the verifier's upsert refuses two rows for one key.
    const k = `${r.make}|${r.model}|${r.modelYear}`.toLowerCase();
    if (seenKey.has(k)) fail(`${who}: duplicate row`, k, "one row per make, model and model year");
    seenKey.set(k, true);

    const hasUrl = /^https:\/\//.test(String(r.sourceUrl || ""));
    const hasReason = String(r.unsourced || "").trim().length >= 20;
    if (!hasUrl && !hasReason) fail(`${who}: a re-readable https sourceUrl or an unsourced reason`, { sourceUrl: r.sourceUrl, unsourced: r.unsourced }, "one of them");
    if (hasUrl && r.unsourced) fail(`${who}: sourced AND unsourced`, r.unsourced, "not both");
    if (hasUrl) {
      const host = new URL(r.sourceUrl).hostname.toLowerCase();
      const own = MAKER_DOMAINS[r.make];
      if (!own) fail(`${who}: MAKER_DOMAINS names ${r.make}'s own domains`, r.make, "an entry");
      else if (!own.some((d) => host === d || host.endsWith("." + d))) {
        fail(`${who}: source is on ${r.make}'s own domain`, host, own.join(" | "));
      }
    }
    // An itemised row is the maker's two printed lines; the bundle is their
    // arithmetic, checked here, and the verifier reads each line by its label.
    if (r.parts) {
      if (r.parts.freight + r.parts.pdi !== r.amount) fail(`${who}: parts add up to the amount`, r.parts, r.amount);
      if (!r.read?.labels?.freight || !r.read?.labels?.pdi) fail(`${who}: an itemised row reads each line by its label`, r.read, "labels.freight + labels.pdi");
    }
  }
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

// ── 7. a change is red, whether or not a previous run confirmed it ─────────
// Until 2026-09-24 drift was red only against a confirmed state stored in
// freight_verification -- a table that had never been created in production,
// so every write 404'd, every run was green, and the red path could not fire.
// A sourced row was read off its source on capturedOn; a different figure
// there now is a change since that date.
console.log("7. a changed figure is red; a previous confirmation is named, not required");
{
  const res = [{ key: "BMW|X3", status: "drifted" }];
  eq("never confirmed by a run -> still red", assess(res, { previous: {} }).red, true);
  eq("was confirmed -> red", assess(res, { previous: { "BMW|X3": "confirmed" } }).red, true);
  eq("the regression is named", assess(res, { previous: { "BMW|X3": { status: "confirmed" } } }).regressed.length, 1);
  eq("not_stated is never red", assess([{ key: "a", status: "not_stated" }, { key: "b", status: "confirmed" }]).red, false);
}

// ── 8. robots.txt, as RFC 9309 defines honouring it ───────────────────────
console.log("8. robots.txt: obey 2xx rules, 4xx = no file, 5xx/no answer = disallow");
{
  const rules = "User-agent: *\nDisallow: /private/\n\nUser-agent: LotCheckBot\nDisallow: /api/\n";
  eq("our agent's own group wins", robotsVerdict(200, rules, "/api/prices").status, "robots_disallowed");
  eq("an allowed path passes", robotsVerdict(200, rules, "/en/offers").ok, true);
  eq("403 on robots.txt is 'unavailable' -> allowed (§2.3.1.3)", robotsVerdict(403, "", "/x").ok, true);
  eq("404 -> allowed", robotsVerdict(404, "", "/x").ok, true);
  eq("500 -> complete disallow (§2.3.1.4)", robotsVerdict(500, "", "/x").status, "robots_unreachable");
  eq("no answer -> complete disallow", robotsVerdict(0, "", "/x").status, "robots_unreachable");
  for (const s of ["robots_disallowed", "robots_unreachable"]) {
    if (!NOT_READ.includes(s)) fail(`NOT_READ covers ${s}`, NOT_READ, "includes " + s);
  }
}

// ── 9. reading the maker's own JSON by name ───────────────────────────────
console.log("9. JSON sources: a field by name, a line item by label, a model by path");
{
  // Hyundai's trimallpurchaseOptions: `delivery` beside msrp and fees.
  const hy = JSON.stringify({ data: { msrp: 32999, delivery: 2200, purchaseOptions: [{ options: [{ dealerAdminFee: 799, fedAirTax: 100 }] }] } });
  eq("key: delivery", verifyRow({ sourceUrl: "https://x.ca", amount: 2200, read: { key: "delivery" } }, hy).status, "confirmed");
  eq("key: a changed delivery is drift", verifyRow({ sourceUrl: "https://x.ca", amount: 2100, read: { key: "delivery" } }, hy).status, "drifted");
  eq("key: msrp beside it is not freight", numbersAtKey(JSON.parse(hy), "delivery").join(","), "2200");

  // Mazda's Trims API: freight and PDE are two printed lines.
  const mz = JSON.stringify({ data: { trims: [{ financial: { fees: [
    { title: "Administration Fee", price: 795 }, { title: "A/C Tax", price: 100 },
    { title: "Freight", price: 1455 }, { title: "PDE", price: 740 }, { title: "AMVIC", price: 10 },
  ] } }] } });
  const row = { sourceUrl: "https://x.ca", amount: 2195, parts: { freight: 1455, pdi: 740 }, read: { labels: { freight: "Freight", pdi: "PDE" } } };
  eq("labels: both lines confirm", verifyRow(row, mz).status, "confirmed");
  eq("labels: the admin fee is not read as either", JSON.stringify(amountsByLabel(JSON.parse(mz), { freight: "Freight", pdi: "PDE" })), '{"freight":[1455],"pdi":[740]}');
  eq("labels: one line moving is drift", verifyRow({ ...row, parts: { freight: 1355, pdi: 740 }, amount: 2095 }, mz).status, "drifted");
  eq("labels: a line gone is not_stated, not drift",
    verifyRow(row, JSON.stringify({ data: { trims: [{ financial: { fees: [{ title: "Freight", price: 1455 }] } }] } })).status, "not_stated");

  // VW answers every model in ONE response. The path is what binds a figure
  // to its model: without it, the Jetta's $2,050 would "confirm" any row.
  const vw = JSON.stringify({ 2026: {
    jetta: { trims: [{ offers: [{ legal: "a 2026 Jetta ... $2,050 freight and PDI, $100 air conditioning levy" }] }] },
    atlas: { trims: [{ offers: [{ legal: "a 2026 Atlas ... $2,250 freight and PDI, $100 air conditioning levy" }] }] },
  } });
  eq("path: Atlas reads Atlas", verifyRow({ sourceUrl: "https://x.ca", amount: 2250, read: { path: ["2026", "atlas"] } }, vw).status, "confirmed");
  eq("path: the Jetta's figure does not confirm the Atlas",
    verifyRow({ sourceUrl: "https://x.ca", amount: 2050, read: { path: ["2026", "atlas"] } }, vw).status, "drifted");
  eq("path: a model gone from the response is not_stated, not drift",
    verifyRow({ sourceUrl: "https://x.ca", amount: 2175, read: { path: ["2026", "taos"] } }, vw).status, "not_stated");
  eq("a page that is not JSON is not_stated", verifyRow({ sourceUrl: "https://x.ca", amount: 1, read: { key: "delivery" } }, "<html>").status, "not_stated");
}

// ── 10. a change is dated, and keeps the date it was first seen ───────────
console.log("10. a change names the capture date, today, and the day it first appeared");
{
  const r = { sourceUrl: "https://x.ca", amount: 2250, capturedOn: "2026-09-24", read: { path: ["2026", "atlas"] } };
  const page = JSON.stringify({ 2026: { atlas: { legal: "$2,450 freight and PDI" } } });
  const first = verifyRow(r, page, 200, { today: "2026-10-01" });
  eq("status", first.status, "drifted");
  if (!/captured 2026-09-24/.test(first.note) || !/on 2026-10-01/.test(first.note) || !/first read 2026-10-01/.test(first.note)) {
    fail("the note carries the capture date, the read date and the first-seen date", first.note, "all three");
  }
  const later = verifyRow(r, page, 200, { today: "2026-10-05", previous: { status: "drifted", note: first.note } });
  eq("a change already seen keeps its first date", later.firstSeen, "2026-10-01");
  const fresh = verifyRow(r, page, 200, { today: "2026-10-05", previous: { status: "confirmed", note: "the source states $2,250" } });
  eq("a change after a confirmation is dated today", fresh.firstSeen, "2026-10-05");
}

// ── 11. the catalogue answers for the right year and the right line ───────
console.log("11. freightFor: the model year picks the figure; a destination-only figure says so");
{
  const years = new Map();
  for (const r of freightCatalog()) {
    const k = `${r.make}|${r.model}`;
    (years.get(k) || years.set(k, []).get(k)).push(r);
  }
  for (const [k, rows] of years) {
    const [make, model] = k.split("|");
    const current = rows.find((r) => r.modelYear === "current");
    for (const r of rows) if (r !== current) eq(`${k} MY${r.modelYear}`, freightFor(make, model, r.modelYear)?.amount, r.amount);
    // A dated row answers only its own year. A "current" row -- the maker's live
    // price list, no year named -- answers any year we hold no dated row for.
    const other = 2030;
    eq(`${k}: a year we do not hold`, freightFor(make, model, other)?.amount ?? null, current ? current.amount : null);
    const amounts = new Set(rows.map((r) => r.amount));
    if (amounts.size > 1) eq(`${k}: no year, figures differ by year -> null`, freightFor(make, model), null);
    else eq(`${k}: no year, every year agrees -> that figure`, freightFor(make, model)?.amount, rows[0].amount);
  }
  for (const r of freightCatalog()) eq(`${r.make} ${r.model} MY${r.modelYear} covers`, freightFor(r.make, r.model, r.modelYear)?.covers, r.covers);
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
