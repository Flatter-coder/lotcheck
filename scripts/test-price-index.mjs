// /live-price-index is now one screen: a headline figure and three cells, all
// read live from msrp_catalog. Nothing else. This gate guards THAT page.
//
// It replaces test-price-index-panel.mjs, which pinned a powertrain panel, a
// discount terrain and a 3D histogram that no longer exist. That test kept
// passing after the panels were deleted, because it grepped this file as TEXT
// and the strings it looked for were still sitting in dead code. A green gate
// certifying honesty copy that renders nowhere is worse than no gate, so the
// checks below are written to fail when the page stops doing the thing rather
// than when a string stops appearing.
//
// The properties that matter on a page whose entire content is four numbers:
//
//   1. The numbers are READ, never typed. The markup ships em dashes. A digit
//      hard-coded into the HTML would sit there looking live forever.
//   2. A failed read takes every number down with it. Stale figures under copy
//      that says "read live" is the false-all-clear class.
//   3. The read is fail-closed: paginated to exhaustion, cross-checked against
//      Content-Range, and refused when thin. PostgREST silently caps responses
//      at db-max-rows; a single fetch would publish a subset as the whole
//      catalog the day we cross it.
//   4. Every figure names what it is OF. "Middle value" alone invites the
//      reader to supply their own basis.
//   5. The page claims only what it now does. It stopped reading the market
//      RPC, so it must not still say it checks dealers.
//
// Run: node scripts/test-price-index.mjs
import { readFileSync } from "node:fs";

const FILE = "public/live-price-index.html";
const NL = String.fromCharCode(10);
const raw = readFileSync(FILE, "utf8");

// Strip comments before matching. This file is heavily commented, INCLUDING
// comments that quote the very things being checked for -- matching raw source
// made the old test pass on its own explanation.
function stripComments(text) {
  const kept = [];
  for (const line of text.split(NL)) {
    const t = line.trimStart();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("<!--")) continue;
    kept.push(line);
  }
  let out = kept.join(NL);
  for (const [open, close] of [["/*", "*/"], ["<!--", "-->"]]) {
    let i;
    while ((i = out.indexOf(open)) !== -1) {
      const j = out.indexOf(close, i + open.length);
      if (j === -1) break;
      out = out.slice(0, i) + out.slice(j + close.length);
    }
  }
  return out;
}
const src = stripComments(raw);

// The markup and the script, separated. An assertion about what the page SHOWS
// must not be satisfiable by a string sitting in the script, and vice versa.
const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join(NL);
const markup = src.replace(/<script>[\s\S]*?<\/script>/g, "").replace(/<style>[\s\S]*?<\/style>/g, "");

let pass = 0, fail = 0;
const t = (name, cond, why) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}${NL}       ${why}`); }
};

// The four figures the page exists to show.
const FIGURE_IDS = ["hFig", "hTrims", "hTrims2", "hMakes", "hMakes2"];

// ---------------------------------------------------------------------------
// 1. THE NUMBERS ARE READ, NOT TYPED
// ---------------------------------------------------------------------------

t("every figure ships as a dash, never a number",
  FIGURE_IDS.every((id) => new RegExp(`id="${id}"[^>]*>&mdash;<`).test(markup)),
  "a digit typed into the markup renders instantly and never stops rendering — it would survive a dead catalog, a dead RPC and a dead key, looking live the whole time");

t("no figure is hard-coded anywhere in the markup",
  !/\$\s?\d{2},\d{3}/.test(markup) && !/\b1,1\d\d\b/.test(markup),
  "a catalog figure pasted into the HTML as a placeholder is the same defect as pasting it as content — it goes stale silently");

t("every figure is painted from the catalog read",
  FIGURE_IDS.every((id) => scripts.includes(`"${id}"`)),
  "an element the paint never reaches keeps its dash forever, which reads as 'we have no data' when we do");

// The prose says "N trims across M makes" and the two cells below repeat both
// numbers. All four are painted from one array literal off one summarise()
// result, so the top of the page cannot disagree with the bottom of it.
const paint = scripts.replace(/\s+/g, "");
t("the prose count and the cell count are the same value",
  paint.includes('["hTrims",catalog.trims],["hTrims2",catalog.trims]')
    && paint.includes('["hMakes",catalog.makes],["hMakes2",catalog.makes]'),
  "two derivations of one count drift apart; the sentence would eventually contradict the cell three inches below it");

// ---------------------------------------------------------------------------
// 2. A FAILED READ TAKES EVERY NUMBER DOWN WITH IT
// ---------------------------------------------------------------------------
// This is the one that actually bites. An earlier version of this page wrote to
// board elements in the SUCCESS path; when those elements went away the write
// threw, the catch ran, and the catch threw again on the same missing elements
// -- so the figures the page exists to show were never painted at all, and the
// failure copy never appeared either. Both paths are pinned now.

const catchBlock = (scripts.match(/\.catch\(function\(e\)\{[\s\S]*$/) || [""])[0];

t("the failure path resets every figure",
  FIGURE_IDS.every((id) => catchBlock.includes(`"${id}"`))
    && catchBlock.includes('textContent="\\u2014"'),
  "leaving a figure standing after the read failed puts a stale number under copy that says it was read live");

t("the failure path says so in words",
  catchBlock.includes("Couldn't reach the MSRP catalog"),
  "five dashes and no sentence reads as an empty catalog rather than a failed read — those are different claims");

t("neither path writes to an element that does not exist",
  (() => {
    const ids = new Set([...markup.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
    const wanted = [...scripts.matchAll(/getElementById\("([A-Za-z0-9_-]+)"\)/g)].map((m) => m[1]);
    return wanted.every((id) => ids.has(id));
  })(),
  "this is exactly how the page broke: a write to a removed element threw inside the success path and took the whole paint with it");

t("a thin or empty read is refused, not published",
  scripts.includes("catalog.trims<50") && scripts.includes("!catalog.median"),
  "an empty response summarises to a $0 median and 0 makes, which would render as a confident headline of zero");

// ---------------------------------------------------------------------------
// 3. THE READ IS FAIL-CLOSED
// ---------------------------------------------------------------------------

t("the catalog is paginated to exhaustion",
  scripts.includes("rows.length===0") && scripts.includes("page(offset+rows.length)"),
  "PostgREST caps a response at db-max-rows regardless of the limit asked for; one fetch publishes a subset as the whole catalog");

t("pagination is ordered, so pages cannot overlap or skip",
  scripts.includes("order=msrp.asc"),
  "offset paging over an unordered scan returns rows twice or not at all between requests");

t("a partial read throws instead of rendering",
  scripts.includes("partial catalog read"),
  "Content-Range says how many rows exist; fewer rows than that is a subset, and a subset median is not the catalog median");

t("a runaway read is capped",
  scripts.includes("SAFETY") && scripts.includes("exceeded"),
  "a server that never returns an empty page would spin the loop forever");

t("the headline is a median, not a mean",
  scripts.includes("prices[Math.floor(prices.length/2)]"),
  "the catalog leans premium depending on which manufacturer sites are backfilled most recently, and a mean carries that skew into the headline");

t("only priced rows count toward any figure",
  scripts.includes("Number(r.msrp)>0"),
  "a catalogued trim with no price is coverage we do not have; counting it inflates every figure on the page");

// ---------------------------------------------------------------------------
// 4. EVERY FIGURE NAMES WHAT IT IS OF
// ---------------------------------------------------------------------------
// A number with no stated basis makes the reader invent one. The middle value
// is before freight and fees, and the trim count is OUR coverage -- not the
// number of models for sale in Alberta.

t("the middle value states its basis",
  markup.includes("before freight and fees") && markup.includes("National manufacturer price"),
  "an all-in reader and an ex-freight reader take different numbers from the same figure; the page has to say which it is");

t("the trim count says it is coverage, not the market",
  markup.includes("Our coverage, not the whole market"),
  "without this the count reads as the number of models on sale in Alberta, which it is not");

t("the makes count says what qualifies a make",
  markup.includes("at least one verified trim"),
  "'32 makes' otherwise implies full coverage of 32 manufacturers rather than a foothold in each");

t("the page says who sets MSRP",
  markup.includes("set nationally by the manufacturer, not by the lot"),
  "the whole point of the figure is that the dealer did not choose it — that is the leverage the reader walks in with");

// ---------------------------------------------------------------------------
// 5. THE PAGE CLAIMS ONLY WHAT IT DOES
// ---------------------------------------------------------------------------
// The market cards, the discount terrain and the powertrain panel were removed.
// The reads behind them went with them. Copy describing them must not survive:
// a sentence promising a dealer comparison on a page that performs none is an
// unbacked claim, and it is the easiest kind to leave behind.

t("no market read remains",
  !src.includes("fn_alberta_market_vs_catalog") && !src.includes("fn_alberta_msrp_deviation"),
  "a surviving RPC call is either dead weight or an undisclosed read");

t("no copy promises a dealer comparison",
  !/checked against what Alberta dealers advertise/.test(markup)
    && !/what Alberta dealers advertise against it/.test(src),
  "the page reads the MSRP catalog and nothing else; saying otherwise is a claim with no check behind it");

t("no panel copy outlived its panel",
  !markup.includes("not a representative sample")
    && !markup.includes("not the share of cars on the road")
    && !markup.includes("manufacturer-verified sticker")
    && !markup.includes("freight window"),
  "honesty copy is only honest while the thing it qualifies is on the page; orphaned, it describes something the reader cannot see");

t("no orphaned painter survives",
  !["drawMarket", "drawHist", "bandCounts", "makeMedians", "fuelCounts", "setLive",
    "buildSeries", "redrawHist", "apportion"].some((fn) => scripts.includes(fn)),
  "dead painters are what let the old gate pass on strings nothing rendered");

// ---------------------------------------------------------------------------
// 6. THE INLINED KEY
// ---------------------------------------------------------------------------
// The page reads Supabase directly from the browser, so the key is in the
// source by design -- RLS is what protects the data. That is only true while it
// is the ANON key. A service-role key pasted here would be a full credential
// leak on a public page, and it would look identical at a glance.

t("the inlined key is the anon key",
  (() => {
    const m = raw.match(/window\.LC_ANON="([^"]+)"/);
    if (!m) return false;
    const body = JSON.parse(Buffer.from(m[1].split(".")[1], "base64url").toString("utf8"));
    return body.role === "anon";
  })(),
  "a service-role key here bypasses RLS for anyone who views source");

t("the catalog read is read-only",
  !/method:\s*["'](POST|PATCH|PUT|DELETE)["']/.test(scripts),
  "this page has no reason to write, and a public anon key must never be handed a write path");

console.log(`${NL}${fail ? "❌" : "✅"} price-index: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
