// ============================================================================
// Regression suite for the dealer's own price ladder.
//
// WHY: Vic's used 2025 GMC Acadia at Advantage Ford was reported as
// "Add-ons & fee audit -- NONE LISTED / No dealer extras were itemized" while
// the page printed Market Price $51,999, Doc Fee +$899, AMVIC fee +$10,
// Dealer Discount -$3,009, Your Price $49,899 -- reconciling to the cent.
//
// Every "real page" fixture below is verbatim page text captured on
// 2026-08-31. The three dealers use three different ladder wordings, which is
// the point: this cannot be tuned to one platform.
//
// Run (Node 24+, from repo root):
//   node --experimental-strip-types supabase/functions/_shared/fee-ladder.test.ts
// ============================================================================

import { readFeeLadder, ladderFees } from "./fee-ladder.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  -- ${detail}` : ""}`); }
};

// --- real pages -------------------------------------------------------------
const ADVANTAGE = ") Price Market Price $51,999 * Doc Fee +$899 * AMVIC fee +$10 * Dealer Discount -$3,009 Your Price $49,899 $49,899 All fees included excluding GST";
const MACLEOD = "STK : AM9416 VIN : 1GKENNRS4SJ239416 Regular Price $49,995 Discount \\-$2,500 Your Price $47,495 plus GST Price $341.10 / bi-weekly plus GST";
const SHAW = "Retail Price $59,900, Dealer Discount -$1,500, Sale Price $58,400 . Installed Options Ebony twilight metallic $495";

console.log("\nReal dealer pages, captured 2026-08-31");

const adv = readFeeLadder(ADVANTAGE);
check("Advantage Ford: the ladder that was reported as NONE LISTED is read", adv !== null);
check("...base is the Market Price", adv?.base === 51999, `got ${adv?.base}`);
check("...total is the advertised Your Price", adv?.total === 49899, `got ${adv?.total}`);
check("...the $899 doc fee is found", adv?.lines.some((l) => l.amount === 899 && l.kind === "add") === true);
check("...and classified as documentation", adv?.lines.find((l) => l.amount === 899)?.feeLabel === "documentation");
check("...the $10 AMVIC levy is found too", adv?.lines.some((l) => l.amount === 10) === true);
check("...but AMVIC is NOT the dealer's charge -- it is a regulator levy they pass through",
  adv?.lines.find((l) => l.amount === 10)?.dealerCharge === false);
check("...the $3,009 discount is a deduction, not an add-on",
  adv?.lines.find((l) => l.amount === 3009)?.kind === "deduct");
check("...so the add-ons audit sees exactly one dealer charge: the doc fee",
  JSON.stringify(ladderFees(adv)) === JSON.stringify([{ name: "Doc Fee", amount: 899, feeLabel: "documentation" }]),
  JSON.stringify(ladderFees(adv)));

const mac = readFeeLadder(MACLEOD);
check("Macleod Trail: a markdown-escaped minus still reads", mac !== null);
check("...and its bi-weekly payment is not mistaken for a ladder line",
  mac?.lines.every((l) => l.amount !== 341) === true);
check("...discount-only ladder yields no dealer add-ons", ladderFees(mac).length === 0);

const shaw = readFeeLadder(SHAW);
check("Shaw GMC: Retail -> Sale wording reads", shaw?.base === 59900 && shaw?.total === 58400);

console.log("\nThe arithmetic is the safety net");

// The parser's FIRST draft required 3+ digits and silently skipped "+$10".
// The sum then missed by exactly $10 and the ladder was refused -- which is the
// behaviour this pins. A ladder that does not close is not published.
check("a ladder that does not add up is refused, not published",
  readFeeLadder("Market Price $51,999 Doc Fee +$899 Your Price $49,899") === null);

check("no base -> no ladder",
  readFeeLadder("Doc Fee +$899 AMVIC fee +$10 Your Price $49,899") === null);

check("no total -> no ladder",
  readFeeLadder("Market Price $51,999 Doc Fee +$899") === null);

check("a base and total with no adjustments is not a ladder worth claiming",
  readFeeLadder("Market Price $51,999 Your Price $51,999") === null);

check("an unsigned number beside a label is NOT assumed to be a fee",
  // $500 has no sign and no deduction word, so it is ignored -- and without it
  // nothing reconciles, so the whole ladder is refused rather than half-read.
  readFeeLadder("Market Price $51,999 Protection Package $500 Your Price $52,499") === null);

console.log("\nThings that are not ladder lines");

check("financing payments are excluded by the words after the amount",
  readFeeLadder("Market Price $51,999 Doc Fee +$899 AMVIC fee +$10 Dealer Discount -$3,009 Your Price $49,899 Payment $412.00 / bi-weekly")?.lines
    .every((l) => l.amount !== 412) === true);

check("a repeated mobile copy of the box does not double-count",
  readFeeLadder(ADVANTAGE + " " + ADVANTAGE)?.lines.length === 3,
  String(readFeeLadder(ADVANTAGE + " " + ADVANTAGE)?.lines.length));

check("junk in, null out",
  readFeeLadder(null) === null && readFeeLadder("") === null && readFeeLadder("no prices here at all") === null);

check("a page with prices but no ladder wording yields nothing",
  readFeeLadder("This 2025 GMC Acadia is $49,899 and a great deal at $49,899 today") === null);

check("ladderFees(null) is empty, never a throw", ladderFees(null).length === 0);

console.log(`\n${pass}/${pass + fail} passed${fail ? "  -- FAILING" : "  all green"}`);
if (fail) (globalThis as never as { process?: { exit?: (n: number) => void } }).process?.exit?.(1);
