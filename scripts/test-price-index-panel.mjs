// The /live-price-index powertrain panel reports COVERAGE, not market share.
//
// It shipped once as a 100%-stacked bar whose largest segment was labelled for
// the untagged trims: 695 of 1,084, 64% of the width, telling a buyer nothing
// they could act on and repeating the "recorded: 36%" chip already in the corner.
//
// Rescaling the coloured part is NOT an available fix. Powertrain is recorded
// for ~36% of the catalogue and that subset is skewed -- the untagged majority
// is overwhelmingly gas, which is exactly why per-powertrain MEDIANS are
// withheld on this same panel. Any part-to-whole geometry lets a reader convert
// our coverage into an apparent market share and conclude the market is mostly
// electrified. It is not.
//
// Three properties keep it honest, and this pins them:
//   1. No part-to-whole geometry -- rows sharing no whole, so there is nothing
//      to read a share off even for a reader who ignores every label.
//   2. No count-ordering -- sorting makes a leaderboard, and a leaderboard of
//      OUR coverage reads as a ranking of what is common on the road.
//   3. The sample-not-representative sentence, in words, on the panel.
//
// Run: node scripts/test-price-index-panel.mjs
import { readFileSync } from "node:fs";

const FILE = "public/live-price-index.html";
const NL = String.fromCharCode(10);
const raw = readFileSync(FILE, "utf8");

// Strip comments before matching. This file is heavily commented, INCLUDING
// comments that quote the very things being checked for. Matching raw source
// made this test fail on its own explanation -- the trap test:live-dot hit.
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

let pass = 0, fail = 0;
const t = (name, cond, why) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}${NL}       ${why}`); }
};

t("no stacked-bar geometry in the powertrain panel",
  !src.includes('class="pt-bar"') && !src.includes('id="ptBar"') && !src.includes(".pt-bar{"),
  "a stacked bar implies a whole, so a share can be read off it — but the panel measures coverage of a skewed 36% subset");

t("no segment for the untagged trims",
  !src.includes("Unrecorded"),
  "695 of 1,084 as a chart segment is 64% of the width spent on something a buyer cannot act on");

t("rows are not sorted by count",
  !src.includes("rows.sort("),
  "sorting makes a leaderboard, and a leaderboard of our coverage reads as a ranking of what is common on the road");

t("the panel says the recorded set is not representative",
  src.includes("not a representative sample"),
  "without this sentence the counts read as a market share");

t("the panel says what the counts describe",
  src.includes("what LotCheck has verified") && src.includes("not the share of cars on the road"),
  "the scope must be stated on the panel, not inferred by the reader");

t("the untagged count is still disclosed in words",
  src.includes("are not shown here"),
  "removing the segment must not remove the fact — that would be hiding the gap rather than reporting it");

// THE ONE THAT ACTUALLY BIT. The panel's bar was first written as
// <span class="track">, which collided with the ticker's global .track rule --
// display:flex, white-space:nowrap, and animation:scroll 46s translating it to
// -50%. Every bar in the panel was being dragged sideways by the ticker's
// marquee. It looked like paint corruption and it was a name collision.
//
// The ticker is gone now, but the lesson is the name: a bare, generic class in a
// single-file page is shared by everything that ever uses it. Panel elements
// carry a pt- prefix, and this pins that so the next generic name cannot creep
// back in and silently inherit somebody else's animation.
t("panel classes are prefixed, not generic",
  src.includes("ptx-") && !src.includes("class="+String.fromCharCode(34)+"track"+String.fromCharCode(34)),
  "a generic .track once collided with the ticker marquee and dragged the panel sideways");

// THE HONESTY PROPERTY OF THIS DESIGN. The plates are deliberately IDENTICAL:
// they encode no magnitude, so there is nothing in the geometry to misread as a
// share. The counts live in the ledger as text. If a future change ever sized a
// plate by its count, the panel would start implying a distribution drawn from a
// skewed 36% sample -- the exact inversion the medians are withheld to avoid.
t("plates are a fixed size, never sized by their count",
  /.ptx-plate{[^}]*width:104px[^}]*height:104px/.test(src.replace(/s+/g, "")),
  "a plate whose size varies with n turns this back into a magnitude chart");

t("plate depth comes from position, not from the data",
  src.includes("var z=(2-idx)*26"),
  "Z spacing must be a constant times the index; deriving it from n re-encodes magnitude");

t("the stack sits in a real 3D context",
  src.includes("preserve-3d") && src.includes("perspective:"),
  "without perspective and preserve-3d the exploded stack collapses flat");

t("no element in the panel carries a bare generic class",
  !/class="(track|fill|bar|row|item)"/.test(src),
  "single-file page: a bare class name is global, so it inherits whatever else defines it");

t("no orphaned bar helpers remain",
  !src.includes("fitPtIcons") && !src.includes('id="ptLab"') && !src.includes('id="ptChip"'),
  "helpers that measure elements which no longer exist");

console.log(`${NL}${fail ? "❌" : "✅"} price-index-panel: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
