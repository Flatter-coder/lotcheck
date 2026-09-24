// Regression guard for scripts/lib/press-pricing.mjs — the Subaru
// launch-pricing capture. Fixtures are REAL, fetched 2026-09-23 from
// subaru.ca's own newsroom (scripts/fixtures/subaru-*), because the failure
// mode here is a real page shape nobody anticipated, same reasoning as
// test-fee-stack.mjs.
//
// Run: node scripts/test-press-pricing.mjs
import { readFileSync } from "node:fs";
import {
  parseFeedItems, identifyPricingRelease, extractPricingTable, toCatalogRows,
} from "./lib/press-pricing.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`ok    ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "\n       " + detail : ""}`); }
};

const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const FEED = fx("subaru-newsfeed.xml");
const TRAILSEEKER = fx("subaru-trailseeker-pricing.html");
const SOLTERRA = fx("subaru-solterra-pricing.html");
const UNCHARTED = fx("subaru-uncharted-pricing.html");
const SALES_VOLUME = fx("subaru-july-sales-volume.html");

// ---- the feed itself parses ------------------------------------------------
const items = parseFeedItems(FEED);
check("the real feed yields more than one item", items.length > 3, `got ${items.length}`);
const titles = items.map((i) => i.title);
check("the Trailseeker pricing item is in the real feed",
  titles.some((t) => /TRAILSEEKER/i.test(t)));
check("the pure sales-volume item is ALSO in the real feed (it must not be filtered at parse time)",
  titles.some((t) => /BEST JULY EVER/i.test(t)));

// ---- identifying a pricing release from its title --------------------------
{
  const cases = [
    ["SUBARU ANNOUNCES LOWERED PRICING FOR 2027 TRAILSEEKER", "Trailseeker", 2027, false],
    ["SUBARU IMPROVES VALUE WITH 2027 SOLTERRA PRICING; STARTING MSRP OF $47,995", "Solterra", 2027, false],
    ["SUBARU ANNOUNCES PRICING OF 2027 ALL-ELECTRIC SUBARU UNCHARTED; STARTING AT $40,995 MSRP", "Uncharted", 2027, true],
  ];
  for (const [title, model, year, allElectric] of cases) {
    const got = identifyPricingRelease(title);
    check(`identifies "${title.slice(0, 40)}…"`,
      got && got.model === model && got.year === year && got.allElectric === allElectric,
      JSON.stringify(got));
  }
}

// ---- REFUSALS: missing beats wrong ------------------------------------------
{
  const refuse = [
    ["a pure sales-volume title", "SUBARU CANADA RECORDS BEST JULY EVER"],
    ["no model year at all", "SUBARU ANNOUNCES NEW PRICING FOR TRAILSEEKER"],
    ["no recognised model name", "SUBARU ANNOUNCES 2027 PRICING FOR A NEW MODEL"],
    ["a corporate/financial release that happens to say a dollar figure", "SUBARU TO ENTER CAPTIVE FINANCE BUSINESS IN CANADA"],
    ["a real model + real year with NO pricing language at all", "SUBARU CELEBRATES 2027 FORESTER AS TOP SAFETY PICK"],
  ];
  for (const [label, title] of refuse) {
    check(`refuses: ${label}`, identifyPricingRelease(title) === null, title);
  }
}

// ---- extracting the real pricing table --------------------------------------
{
  const rows = extractPricingTable(TRAILSEEKER);
  check("Trailseeker: 3 trims extracted", rows.length === 3, JSON.stringify(rows));
  check("Trailseeker Touring: MSRP $49,995, EVP $53,152",
    rows.some((r) => r.trim === "Touring" && r.msrp === 49995 && r.allInPrice === 53152), JSON.stringify(rows));
  check("Trailseeker Premier: MSRP $57,995, EVP $61,152",
    rows.some((r) => r.trim === "Premier" && r.msrp === 57995 && r.allInPrice === 61152), JSON.stringify(rows));
}
{
  const rows = extractPricingTable(SOLTERRA);
  check("Solterra: 3 trims extracted", rows.length === 3, JSON.stringify(rows));
  check("Solterra Touring: MSRP $47,995", rows.some((r) => r.trim === "Touring" && r.msrp === 47995));
}
{
  // A DIFFERENT trim-naming shape (FWD/FWD LR/Sport/GT vs Touring/Limited/
  // Premier) — proves the extractor reads the table's own labels rather than
  // an assumed trim vocabulary.
  const rows = extractPricingTable(UNCHARTED);
  check("Uncharted: 4 trims extracted (a different naming shape)", rows.length === 4, JSON.stringify(rows));
  check("Uncharted FWD LR: MSRP $44,995, EVP $48,152",
    rows.some((r) => r.trim === "FWD LR" && r.msrp === 44995 && r.allInPrice === 48152), JSON.stringify(rows));
}
{
  // The real negative case: a genuine Subaru release with zero pricing tables.
  const rows = extractPricingTable(SALES_VOLUME);
  check("a pure sales-volume article yields NO pricing rows", rows.length === 0, JSON.stringify(rows));
}
{
  // Constructed (no real Subaru release currently exhibits a bad figure): a
  // table whose cell is not a plausible whole-dollar MSRP must not be treated
  // as one. Confirms the bounds are real, not decorative.
  const html = `<table class="pricing-table"><tbody>
    <tr><th data-label="Trim">Micro</th><td data-label="MSRP">$9,995</td></tr>
    <tr><th data-label="Trim">Typo</th><td data-label="MSRP">$999,995</td></tr>
    <tr><th data-label="Trim">Cents</th><td data-label="MSRP">$44,995.00</td></tr>
    <tr><th data-label="Trim">Real</th><td data-label="MSRP">$44,995</td></tr>
  </tbody></table>`;
  const rows = extractPricingTable(html);
  check("a figure below the $10k floor ($9,995) is dropped, not stored", !rows.some((r) => r.trim === "Micro"));
  check("a figure above the $250k ceiling ($999,995) is dropped", !rows.some((r) => r.trim === "Typo"));
  check("a figure carrying cents is dropped (Subaru's table never does; a format change, not a price)",
    !rows.some((r) => r.trim === "Cents"));
  check("a clean whole-dollar figure in the same table still comes through",
    rows.some((r) => r.trim === "Real" && r.msrp === 44995));
}

// ---- the full pipeline: item + html -> catalog rows -------------------------
{
  const item = items.find((i) => /TRAILSEEKER/i.test(i.title));
  const rows = toCatalogRows(item, TRAILSEEKER);
  check("Trailseeker pipeline: 3 rows, all year 2027 Subaru Trailseeker",
    rows.length === 3 && rows.every((r) => r.year === 2027 && r.make === "Subaru" && r.model === "Trailseeker"),
    JSON.stringify(rows));
  check("every row carries excl_freight basis AND an all-in figure",
    rows.every((r) => r.price_basis === "excl_freight" && Number.isInteger(r.all_in_price)));
  check("the all-in basis quotes Subaru's OWN EVP definition, not a guess",
    rows.every((r) => /Estimated Vehicle Price/i.test(r.attrs.all_in_basis) && /excludes taxes/i.test(r.attrs.all_in_basis)));
  check("every row carries the article URL as provenance",
    rows.every((r) => r.source_url === item.link && r.source_url.startsWith("https://www.subaru.ca/")));
  check("fetched_at is the RELEASE's own date, not today (this fixture is months old)",
    rows.every((r) => r.fetched_at.startsWith("2026-08-07")), rows[0]?.fetched_at);
  check("fuel_type is null for a gas-lineup title (never guessed from the model name)",
    rows.every((r) => r.fuel_type == null));
}
{
  const item = items.find((i) => /ALL-ELECTRIC SUBARU UNCHARTED/i.test(i.title));
  const rows = toCatalogRows(item, UNCHARTED);
  check("Uncharted pipeline: fuel_type BEV, read from the title's own words",
    rows.length === 4 && rows.every((r) => r.fuel_type === "BEV"));
}
{
  // Solterra IS a BEV, but its real pricing-release title never says
  // "all-electric" (verified — unlike Uncharted's). fuel_type must stay null
  // here rather than being guessed from the model name: a later Solterra
  // release that changes powertrain framing must not silently inherit a stale
  // assumption baked into a hardcoded model list.
  const item = items.find((i) => /SOLTERRA PRICING/i.test(i.title));
  const rows = toCatalogRows(item, SOLTERRA);
  check("Solterra pipeline: fuel_type stays null (the title doesn't say ALL-ELECTRIC)",
    rows.length === 3 && rows.every((r) => r.fuel_type == null),
    "Solterra IS a BEV in reality; this asserts the code refuses to guess it from the name — a real, acceptable gap, not a bug");
}
{
  // A release the title-filter matches but whose page carries no table at all
  // (constructed: no real Subaru release currently exhibits this, but the code
  // path must be proven, not assumed, since it is the whole "missing beats
  // wrong" contract of this file).
  const item = { title: "SUBARU ANNOUNCES PRICING FOR 2027 FORESTER", link: "https://example.invalid/x", pubDate: "1/1/2027" };
  const rows = toCatalogRows(item, "<html><body>page redesigned, no table here</body></html>");
  check("a matched title with no pricing table writes NOTHING (no prose fallback)", rows.length === 0);
}

// ---- the runner must call THESE functions, not a copy of them --------------
{
  const src = readFileSync(new URL("./capture-subaru-press-pricing.mjs", import.meta.url), "utf8");
  check("the runner imports parseFeedItems/identifyPricingRelease/toCatalogRows from this module",
    /from\s+"\.\/lib\/press-pricing\.mjs"/.test(src)
    && /\bparseFeedItems\b/.test(src) && /\bidentifyPricingRelease\b/.test(src) && /\btoCatalogRows\b/.test(src));
  check("the runner writes with upsert:true, never a bare writeCatalogs call",
    /upsert:\s*true/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
