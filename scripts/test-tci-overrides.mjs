// Regression suite for the Toyota/Lexus catalog overrides (tci-overrides.mjs).
// Run: node scripts/test-tci-overrides.mjs
//
// Locks the fix for the 2026 Lexus TX MSRP defect: the scraper stored the gas
// TX 350 trims as Hybrid and named the base "Premium" instead of "Luxury", so a
// TX 350 Luxury listing resolved to $81,484 (F SPORT 3). These overrides run on
// every refresh; if one drifts, this fails before it reaches the catalog.

import { readFileSync } from "node:fs";
import { TCI_OVERRIDES, addTciAliases, applyTciOverrides, flagAllOnePowertrain } from "./lib/tci-overrides.mjs";
import { modelPowertrain } from "./lib/tci-stack.mjs";
import { catKey } from "./lib/catalog-io.mjs";

let pass = 0, fail = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); cond ? pass++ : fail++; };

// A realistic corrupt scrape: every TX trim tagged Hybrid, base named PREMIUM.
const corruptTx = [
  { year: 2026, make: "Lexus", model: "TX", trim: "PREMIUM",          msrp: 69855, fuel_type: "Hybrid" },
  { year: 2026, make: "Lexus", model: "TX", trim: "Ultra Luxury",     msrp: 72608, fuel_type: "Hybrid" },
  { year: 2026, make: "Lexus", model: "TX", trim: "F SPORT 3",        msrp: 81484, fuel_type: "Hybrid" },
];
const other = [{ year: 2026, make: "Lexus", model: "NX", trim: "Signature", msrp: 48000, fuel_type: "Gas" }];

const { rows, replaced } = applyTciOverrides([...corruptTx, ...other], "Lexus");
const tx = rows.filter((r) => r.model === "TX");
const lux = tx.find((r) => r.trim === "Luxury");

// Assert the TX entry by key, not by count: an override applies even when the
// scrape produced no rows for it (the RX line below is REFUSED upstream, so it
// arrives with zero scraped rows and still inserts), so `replaced` grows with
// every override, not with every corrupt input.
const txRep = replaced.find((r) => r.key === "lexus|tx|2026");
check("the corrupt TX rows are dropped and replaced", !!txRep && txRep.dropped === 3);
check("TX 350 Luxury is $69,855, Gas (the reported bug's correct value)", !!lux && lux.msrp === 69855 && lux.fuel_type === "Gas");
check("the base trim is 'Luxury', never 'PREMIUM'", tx.some((r) => r.trim === "Luxury") && !tx.some((r) => r.trim === "PREMIUM"));
check("no gas TX 350 trim is tagged Hybrid", !tx.some((r) => ["Luxury", "Ultra Luxury", "Executive 7-Pass", "F SPORT 3", "Executive 6-Pass", "F SPORT 3 + Towing Hitch"].includes(r.trim) && r.fuel_type !== "Gas"));
check("the TX 500h hybrids are present and tagged Hybrid", tx.some((r) => r.trim === "F SPORT Performance 2" && r.fuel_type === "Hybrid"));
check("non-overridden models pass through untouched", rows.some((r) => r.model === "NX" && r.msrp === 48000));

// ── 2026 Lexus RX 350 (gasoline) — lexusofroyaloak.com, 2026-09-02 ──────────
// The feed lists the RX 350 packages under series "RX" tagged "Hybrid
// Available"; inferFuel flattens that to Hybrid; the refresh guard then refuses
// the whole gas line (the "RX Hybrid" sibling proves the mis-tag) and NOTHING is
// written. The served catalog held ten hybrid/PHEV RX rows and no gas RX, and
// a gas RX 350 buyer was shown the hybrid ladder as "the factory range".
{
  const feedRx = [ // what the feed actually emits for series RX (dry run 2026-09-02 09:40Z), all mis-tagged
    { year: 2026, make: "Lexus", model: "RX", trim: "Luxury",             msrp: 68299, fuel_type: "Hybrid" },
    { year: 2026, make: "Lexus", model: "RX", trim: "F SPORT 2",          msrp: 70799, fuel_type: "Hybrid" },
    { year: 2026, make: "Lexus", model: "RX", trim: "Ultra Luxury",       msrp: 71804, fuel_type: "Hybrid" },
    { year: 2026, make: "Lexus", model: "RX", trim: "Executive",          msrp: 76304, fuel_type: "Hybrid" },
    { year: 2026, make: "Lexus", model: "RX", trim: "F SPORT 3",          msrp: 76304, fuel_type: "Hybrid" },
    { year: 2026, make: "Lexus", model: "RX", trim: "F SPORT Black Line", msrp: 79164, fuel_type: "Hybrid" },
  ];
  const hybridRx = [ // the real hybrid series, already correct, must not be touched
    { year: 2026, make: "Lexus", model: "RX Hybrid", trim: "Premium", msrp: 63645, fuel_type: "Hybrid" },
    { year: 2026, make: "Lexus", model: "RX Plug-in Hybrid", trim: "Ultra Premium", msrp: 78495, fuel_type: "PHEV" },
  ];
  const { rows: r2, replaced: rep2 } = applyTciOverrides([...feedRx, ...hybridRx], "Lexus");
  const rx = r2.filter((r) => r.model === "RX");
  const rxRep = rep2.find((r) => r.key === "lexus|rx|2026");
  check("RX: the six mis-tagged gas rows are dropped and replaced", !!rxRep && rxRep.dropped === 6 && rxRep.inserted === 7);
  check("RX: every gas RX 350 row is tagged Gas, none Hybrid", rx.length === 7 && rx.every((r) => r.fuel_type === "Gas"));
  check("RX: Premium base is present at $60,885 (the trim the feed refused as grade STD)", rx.some((r) => r.trim === "Premium" && r.msrp === 60885));
  check("RX: Luxury is $68,299 — the feed's own ex-freight figure, fuel corrected", rx.some((r) => r.trim === "Luxury" && r.msrp === 68299));
  // Five independent package deltas from Lexus.ca all land on the same base:
  // that arithmetic is the pinned configuration, so lock it.
  const base = rx.find((r) => r.trim === "Premium")?.msrp;
  const deltas = { "Luxury": 7414, "F SPORT 2": 9914, "Ultra Luxury": 10919, "Executive": 15419, "F SPORT 3": 15419, "F SPORT Black Line": 18279 };
  check("RX: every package row equals Premium + Lexus.ca's published package delta",
    Object.entries(deltas).every(([t, d]) => rx.find((r) => r.trim === t)?.msrp === base + d));
  check("RX: the hybrid and plug-in series pass through untouched",
    r2.some((r) => r.model === "RX Hybrid" && r.msrp === 63645 && r.fuel_type === "Hybrid")
    && r2.some((r) => r.model === "RX Plug-in Hybrid" && r.fuel_type === "PHEV"));
  check("RX: the all-one-powertrain guard is quiet once corrected", flagAllOnePowertrain(rx).length === 0);
}

// A different make must not be touched by a Lexus override.
check("override is make-scoped", applyTciOverrides(corruptTx, "Toyota").replaced.length === 0);

// The guard catches the corrupt all-Hybrid TX, and is quiet once corrected.
check("guard flags the all-Hybrid TX (>=4 trims would fire)", flagAllOnePowertrain([...corruptTx,
  { year: 2026, make: "Lexus", model: "TX", trim: "A", msrp: 1, fuel_type: "Hybrid" }]).length === 1);
check("guard is quiet after the override (mixed Gas + Hybrid)", flagAllOnePowertrain(tx).length === 0);

// THE SIBLING MUST NAME THE SAME POWERTRAIN (2026-09-25). The 2026 RAV4 is
// hybrid-only; its only sibling is the plug-in. Refusing it dropped all seven
// hybrid trims and left the 2026 RAV4 to captured rows no job refreshes.
{
  const t = (model, trim, fuel) => ({ make: "Toyota", model, year: 2026, trim, msrp: 40000, fuel_type: fuel });
  const rav4 = ["LE", "XLE", "XLE Premium", "Woodland", "XSE", "Limited", "XSE Technology Package"].map((x) => t("RAV4", x, "Hybrid"));
  const phev = ["SE", "XSE", "GR-S", "XSE Technology Package"].map((x) => t("RAV4 Plug-in Hybrid", x, "PHEV"));
  const f = flagAllOnePowertrain([...rav4, ...phev]);
  check("a hybrid-only line with only a PLUG-IN sibling is not a proven mis-tag", !f.some((x) => x.key === "Toyota|RAV4|2026" && x.proven));
  const nx = ["Premium", "Luxury", "F SPORT 2", "Ultra Luxury"].map((x) => ({ make: "Lexus", model: "NX", year: 2026, trim: x, msrp: 50000, fuel_type: "Hybrid" }));
  const f2 = flagAllOnePowertrain(nx, { knownNameplates: ["Lexus|2026|nx hybrid"] });
  check("...while an 'NX Hybrid' sibling still proves a bare NX tagged Hybrid is the gas line", f2.some((x) => x.key === "Lexus|NX|2026" && x.proven));
  const r4 = ["SR5", "TRD Sport", "TRD Off Road Premium", "Limited"].map((x) => t("4Runner", x, "Hybrid"));
  check("...and a '4Runner Hybrid' sibling still refuses the gas 4Runner tagged Hybrid", flagAllOnePowertrain(r4, { knownNameplates: ["Toyota|2026|4runner hybrid"] }).some((x) => x.proven));
}

// Every override row is a whole-dollar MSRP with a real fuel — the same bar the
// scraper's own quality gate applies.
const allRows = TCI_OVERRIDES.flatMap((o) => o.rows);
check("every override MSRP is a positive whole dollar", allRows.every((r) => Number.isInteger(r.msrp) && r.msrp > 0));
check("every override fuel is Gas/Hybrid/PHEV/BEV", allRows.every((r) => ["Gas", "Hybrid", "PHEV", "BEV"].includes(r.fuel_type)));


// ---------------------------------------------------------------------------
// THE 2026-09-22 4RUNNER WRITE. The guard's evidence must not be the batch.
//
// Toyota's feed returned "4Runner" that morning WITHOUT "4Runner Hybrid" — the
// hybrid rows survive only as carry-forward, which the guard cannot see. The
// sibling proof evaporated, `proven` went false, the refusal degraded to a
// warning, and four gasoline trims were written to msrp_catalog tagged Hybrid.
//
// The catalogue's own history proves the mis-tag twice over: it already held
// the nameplate "4Runner Hybrid", and it already held a Gas row for the
// identical $55,520 base, captured 2026-08-16. Either fact alone is enough.
//
// These are the rows as they actually landed. Do not tidy them.
const RUNNER_2026_09_22 = [
  { make: "Toyota", model: "4Runner", year: 2026, trim: "SR5", msrp: 55520, fuel_type: "Hybrid" },
  { make: "Toyota", model: "4Runner", year: 2026, trim: "TRD Sport", msrp: 60322, fuel_type: "Hybrid" },
  { make: "Toyota", model: "4Runner", year: 2026, trim: "TRD Off Road Premium", msrp: 65462, fuel_type: "Hybrid" },
  { make: "Toyota", model: "4Runner", year: 2026, trim: "Limited 7 Passenger", msrp: 69644, fuel_type: "Hybrid" },
];

{
  const batchOnly = flagAllOnePowertrain(RUNNER_2026_09_22);
  check("4Runner: the batch alone still cannot prove it (this is the defect)",
    batchOnly.length === 1 && batchOnly[0].proven === false);

  const bySibling = flagAllOnePowertrain(RUNNER_2026_09_22, {
    knownNameplates: ["Toyota|2026|4runner hybrid"],
  });
  check("4Runner: a sibling the CATALOGUE holds proves it",
    bySibling[0]?.proven === true && bySibling[0]?.why === "powertrain_marked_sibling",
    JSON.stringify(bySibling[0]));

  const byFlip = flagAllOnePowertrain(RUNNER_2026_09_22, {
    priorFuels: new Map([["Toyota|4Runner|2026", new Set(["Gas"])]]),
  });
  check("4Runner: a nameplate flipping away from Gas proves it independently",
    byFlip[0]?.proven === true && byFlip[0]?.why === "flipped_away_from_gas",
    JSON.stringify(byFlip[0]));

  // Either proof alone must be sufficient: a fix that needs both is a fix that
  // fails whenever one source of evidence is missing, which is how we got here.
  check("4Runner: each proof is sufficient on its own",
    bySibling[0]?.proven === true && byFlip[0]?.proven === true);
}

// ---- the flip proof must not fire on honest data -------------------------
{
  // Sienna is genuinely hybrid-only and its nameplate carries no marker. The
  // catalogue has always held it as Hybrid, so there is nothing to contradict.
  const sienna = ["LE", "XLE", "Limited", "Woodland", "Platinum"]
    .map((t) => ({ make: "Toyota", model: "Sienna", year: 2026, trim: t, fuel_type: "Hybrid" }));
  const f = flagAllOnePowertrain(sienna, {
    priorFuels: new Map([["Toyota|Sienna|2026", new Set(["Hybrid"])]]),
  });
  check("Sienna: hybrid-only line warns but is NEVER refused",
    f.length === 1 && f[0].proven === false,
    "refusing it would cost real coverage on a correctly-tagged line");

  // A line that legitimately gains hybrid trims stays mixed, so it is not even
  // flagged — the guard only looks at all-one-fuel groups.
  const camry = [{ make: "Toyota", model: "Camry", year: 2026, trim: "LE", fuel_type: "Gas" },
    ...["SE", "XLE", "XSE"].map((t) => ({ make: "Toyota", model: "Camry", year: 2026, trim: t, fuel_type: "Hybrid" }))];
  check("a mixed line is not flagged at all",
    flagAllOnePowertrain(camry, { priorFuels: new Map([["Toyota|Camry|2026", new Set(["Gas", "Hybrid"])]]) }).length === 0);

  // No history at all (a make's first-ever scrape) must not refuse everything.
  check("an empty history falls back to batch-only, never to refusing all",
    flagAllOnePowertrain(RUNNER_2026_09_22, { knownNameplates: [], priorFuels: new Map() })[0].proven === false);
}

// ---- the caller must actually pass the history ---------------------------
// A guard that CAN see the catalogue and is never given it is the same defect.
{
  const stack = readFileSync(new URL("./lib/tci-stack.mjs", import.meta.url), "utf8");
  check("tci-stack reads the catalogue's powertrain history",
    /readPowertrainHistory\(/.test(stack));
  check("tci-stack passes BOTH proofs to the guard",
    /knownNameplates:\s*history\.nameplates/.test(stack) && /priorFuels:\s*history\.fuels/.test(stack),
    "passing one and not the other silently halves the evidence");
  // A PROVEN MIS-TAG MUST WITHHOLD THE ROWS, not merely print. The original
  // defect was exactly this: the guard fired, console.warn ran, and the rows
  // were written anyway. Asserting that the guard FLAGS is not the same as
  // asserting that the caller REFUSES.
  check("a proven flag builds the refused set",
    stack.includes("refusedKeys = new Set(powertrainFlags.filter((s) => s.proven)"),
    "refusedKeys must be derived from proven — an empty Set here writes the rows");
  check("the refused rows are actually withheld from the write",
    /keptMsrpRows\s*=\s*refusedKeys\.size/.test(stack) && stack.includes("!refusedKeys.has("),
    "the filtered set, not msrpRows, must reach writeCatalogs");
  check("it is writeCatalogs that receives the FILTERED rows",
    /msrpRows:\s*keptMsrpRows/.test(stack),
    "passing msrpRows here would write the very rows the guard refused");
  check("the read happens BEFORE the guard runs",
    stack.indexOf("readPowertrainHistory(") < stack.indexOf("flagAllOnePowertrain(msrpRows"));
}

// The summary belongs at the END. It sat at line 91 with 60 lines of
// assertions appended below it, so those assertions never ran and the suite
// reported 18/18 green over untested code — the same shape as the gate that
// exits before its own checks.

// ---- the override's own date means VERIFIED, not WRITTEN ------------------
// The rows are re-asserted on every run, but nobody re-reads Lexus.ca each
// morning. Stamping the run timestamp would claim a daily re-verification that
// does not happen — the figure would look current while being exactly as old.
//
// The honest cost is that these 17 rows read as weeks stale beside a scraper's
// fresh ones. A stale scrape and an unre-verified hand-seeded figure need
// DIFFERENT remedies — fix the scraper, or re-read the manufacturer's page —
// and fetched_at alone cannot tell them apart, so each row carries its own
// provenance.
{
  const { rows } = applyTciOverrides([], "Lexus");
  const seeded = rows.filter((r) => r.attrs && r.attrs.seeded === "tci-override");

  check("every injected row is marked as hand-seeded",
    seeded.length === rows.length && rows.length > 0,
    `${seeded.length} of ${rows.length}`);

  check("fetched_at is the FROZEN verification date, not a run timestamp",
    rows.every((r) => r.fetched_at === "2026-08-26T00:00:00.000Z"),
    "stamping new Date() would claim a re-verification that never happened");

  // The decisive one: a run timestamp would be within seconds of now.
  const RUN = Date.now();
  check("fetched_at is not within a day of the run",
    rows.every((r) => Math.abs(RUN - Date.parse(r.fetched_at)) > 86_400_000),
    "a fresh-looking date on a figure nobody re-read is the defect, not the fix");

  check("each row records WHEN it was verified",
    rows.every((r) => r.attrs && /^\d{4}-\d{2}-\d{2}$/.test(String(r.attrs.verified_on || ""))),
    JSON.stringify(rows[0] && rows[0].attrs));

  check("...and says what its age MEANS, so the right remedy is obvious",
    rows.every((r) => r.attrs && /re-asserted every run, not re-read/.test(String(r.attrs.freshness_note || ""))),
    "age here means unre-verified, not a failing scraper");

  check("the verification date agrees with fetched_at",
    rows.every((r) => String(r.fetched_at).slice(0, 10) === r.attrs.verified_on));
}

// ---------------------------------------------------------------------------
// POWERTRAIN IS READ PER MODEL, NOT PER SERIES (2026-09-26).
// Toyota publishes one "4Runner" series and one "Corolla Cross" series that
// carry both gas and hybrid models. The series-level tag called every model
// Hybrid, so the gas trims were either refused (and went stale) or -- on lines
// with no marked sibling (Tacoma, Tundra, Highlander) -- stored as Hybrid.
{
  check("a hybrid engine code (-FXS) reads Hybrid",
    modelPowertrain({ engine: "A25A-FXS" }, "Hybrid") === "Hybrid");
  check("a gas engine code (-FKS / -FTS) reads Gas under a Hybrid-tagged series",
    modelPowertrain({ engine: "M20A-FKS" }, "Hybrid") === "Gas" && modelPowertrain({ engine: "T24A-FTS" }, "Hybrid") === "Gas");
  check("i-FORCE MAX reuses the gas turbo code, so the model's own text wins",
    modelPowertrain({ engine: "T24A-FTS", powertrainText: "2.4L i-FORCE MAX turbocharged hybrid" }, "Gas") === "Hybrid");
  check("a bare shared block (V35A) decides by name: 'i-FORCE V6' is gas, 'i-FORCE MAX' is hybrid",
    modelPowertrain({ engine: "V35A", powertrainText: "3.4L Twin Turbo i-FORCE V6 with 10-Speed" }, "Hybrid") === "Gas" &&
    modelPowertrain({ engine: "V35A", powertrainText: "3.4L i-FORCE MAX" }, "Hybrid") === "Hybrid");
  check("a plug-in or electric series keeps its tag (the engine code can't tell PHEV from HEV)",
    modelPowertrain({ engine: "A25A-FXS" }, "PHEV") === "PHEV" && modelPowertrain({ engine: "" }, "BEV") === "BEV");
  check("no evidence returns null, so the series tag stands (missing beats a guess)",
    modelPowertrain({ engine: "" }, "Hybrid") === null && modelPowertrain(null, "Gas") === null);
}

// ---------------------------------------------------------------------------
// A SECOND NAME IS WRITTEN FROM THE LIVE ROWS, EVERY RUN.
// "RAV4 Hybrid" 2026 was a one-time migration copy of the RAV4 rows; it froze
// at its capture and failed the freshness guard on every refresh.
{
  const live = [
    { make: "Toyota", year: 2026, model: "RAV4", trim: "LE", msrp: 40000, fuel_type: "Hybrid" },
    { make: "Toyota", year: 2026, model: "RAV4", trim: "XLE", msrp: 41300, fuel_type: "Hybrid" },
    { make: "Toyota", year: 2026, model: "RAV4", trim: "XSE", msrp: 50900, fuel_type: "Hybrid" },
    { make: "Toyota", year: 2026, model: "RAV4", trim: "LIMITED", msrp: 52000, fuel_type: "Hybrid" },
    { make: "Toyota", year: 2026, model: "Camry", trim: "SE", msrp: 36000, fuel_type: "Hybrid" },
  ];
  const out = addTciAliases(live);
  const alias = out.filter((r) => r.model === "RAV4 Hybrid");
  check("each live RAV4 row gets its 'RAV4 Hybrid' twin", alias.length === 4);
  check("...at today's figure, not a frozen copy",
    alias.find((r) => r.trim === "LIMITED")?.msrp === 52000);
  check("...marked alias_of with a reason and today's date",
    alias.every((r) => r.attrs?.alias_of === "RAV4" && r.attrs?.alias_reason &&
      r.attrs?.alias_resynced_at === new Date().toISOString().slice(0, 10)));
  check("the live rows are untouched", out.filter((r) => r.model === "RAV4").every((r) => !r.attrs?.alias_of));
  check("other lines get no alias", out.filter((r) => r.model.startsWith("Camry")).length === 1);

  // The alias is OUR second name for the same line -- it must never serve as
  // the "marked sibling" that proves the bare RAV4 a gas line, nor be judged itself.
  const flags = flagAllOnePowertrain(out);
  check("an alias row never proves its own line a mis-tag",
    !flags.some((f) => f.proven && f.key.includes("|RAV4|")));
  check("an alias row is not judged on its own", !flags.some((f) => f.key.includes("RAV4 Hybrid")));
}

// ---------------------------------------------------------------------------
// AN OVERRIDE RETIRES ITSELF WHERE THE FEED AGREES (2026-09-26).
// With powertrain read per model, the feed's RX 350 rows match the verified
// figures to the dollar; the frozen copies were failing the freshness guard.
{
  const now = "2026-09-26T08:00:00.000Z";
  const feedRx = [
    { year: 2026, make: "Lexus", model: "RX", trim: "Premium", msrp: 60885, fuel_type: "Gas", fetched_at: now },
    { year: 2026, make: "Lexus", model: "RX", trim: "LUXURY",  msrp: 68299, fuel_type: "Gas", fetched_at: now },
    { year: 2026, make: "Lexus", model: "RX", trim: "F SPORT 2", msrp: 70999, fuel_type: "Gas", fetched_at: now }, // moved
  ];
  const { rows: r3, replaced: rep3 } = applyTciOverrides(feedRx, "Lexus");
  const rx = r3.filter((r) => r.model === "RX");
  const prem = rx.find((r) => r.trim === "Premium");
  const lux = rx.find((r) => r.trim === "Luxury");
  const fs2 = rx.find((r) => r.trim === "F SPORT 2");
  check("an agreeing feed row is written fresh, not frozen", prem?.fetched_at === now && prem?.attrs?.override_confirmed === true);
  check("...under the verified trim spelling (case differs in the feed)", !!lux && lux.fetched_at === now);
  check("a disagreeing feed row never wins: the verified figure stands", fs2?.msrp === 70799 && fs2?.attrs?.seeded === "tci-override");
  const rxRep = rep3.find((r) => r.key === "lexus|rx|2026");
  check("...and the disagreement is reported", rxRep?.confirmed === 2 && rxRep?.disagree.length === 1 && /F SPORT 2/.test(rxRep.disagree[0]));
  check("a trim the feed lacks keeps its verified row", rx.some((r) => r.trim === "F SPORT Black Line" && r.attrs?.seeded === "tci-override"));
  check("still exactly one row per verified trim", rx.length === 7 && new Set(rx.map((r) => r.trim)).size === 7);
}

// ---------------------------------------------------------------------------
// CASE IS NOT IDENTITY. The captured "Limited" ($52,350, which carried $350 of
// paint) and the feed's "LIMITED" ($52,000) were two keys, so the live figure
// never superseded the stale one.
{
  check("trim case and spacing do not split a key",
    catKey({ year: 2026, model: "RAV4", trim: "Limited" }) === catKey({ year: 2026, model: "RAV4", trim: "LIMITED " }));
  check("model case does not split a key",
    catKey({ year: 2026, model: "RAV4 Hybrid", trim: "XLE" }) === catKey({ year: 2026, model: "Rav4  hybrid", trim: "XLE" }));
  check("different trims still differ",
    catKey({ year: 2026, model: "RAV4", trim: "XLE" }) !== catKey({ year: 2026, model: "RAV4", trim: "XSE" }));
  check("a missing trim is its own key, not 'null'",
    catKey({ year: 2026, model: "RAV4", trim: null }) === "2026|rav4|");
}

console.log(`\n${pass}/${pass + fail} passed${fail ? "  -- FAILING" : "  all green"}`);
process.exit(fail ? 1 : 0);
