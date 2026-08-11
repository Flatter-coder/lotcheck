// Regression suite: manufacturer price beats dealer-stated (Vic, 2026-08-11).
// Run: node scripts/test-msrp-authority.mjs
//
// Cases come from the 20-listing benchmark, where a dealer-stated figure won by
// default on Buick Envista, Ford Escape and two Hyundai listings because the
// override only fired when the dealer's number was INFLATED.

import { resolveMsrpAuthority } from "../supabase/functions/_shared/msrp-authority.js";

const exact = (msrp, trim = "Preferred") => ({ msrp, trim, basis: "exact", sourceUrl: "https://www.buick.ca/en/suvs/envista" });
const floor = (msrp, trim = null) => ({ msrp, trim, basis: "starting_at", sourceUrl: "https://www.ford.ca/suvs/escape/models/" });

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = Object.entries(want).every(([k, v]) => JSON.stringify(got[k]) === JSON.stringify(v));
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`}`);
  ok ? pass++ : fail++;
};

// THE FIX: an exact manufacturer figure wins even when the dealer's number is
// LOWER or equal -- previously it only won when the dealer inflated.
check("exact beats a LOWER dealer-stated figure",
  resolveMsrpAuthority({ statedMsrp: 32000, ref: exact(33609) }),
  { msrp: 33609, basis: "exact", source: "catalog", dealerStatedMsrp: 32000, inflation: null });

check("exact beats a slightly higher dealer figure (no inflation claim)",
  resolveMsrpAuthority({ statedMsrp: 33800, ref: exact(33609) }),
  { msrp: 33609, basis: "exact", dealerStatedMsrp: 33800, inflation: null });

check("materially inflated sticker is still named as a tactic",
  resolveMsrpAuthority({ statedMsrp: 40000, ref: exact(33609) }),
  { msrp: 33609, basis: "exact", inflation: { dealerStated: 40000, manufacturer: 33609, overBy: 6391 } });

check("identical figures -> nothing to flag",
  resolveMsrpAuthority({ statedMsrp: 33609, ref: exact(33609) }),
  { msrp: 33609, basis: "exact", dealerStatedMsrp: null, inflation: null });

// A FLOOR must never displace the dealer's number -- it is not this unit's sticker.
check("starting_at floor does NOT override the dealer",
  resolveMsrpAuthority({ statedMsrp: 37594, ref: floor(35000), make: "Ford" }),
  { msrp: 37594, basis: "dealer_stated", source: "listing" });

check("...but the floor is attached as a reference",
  resolveMsrpAuthority({ statedMsrp: 37594, ref: floor(35000), make: "Ford" }).reference,
  { msrp: 35000, basis: "starting_at", make: "Ford" });

// No catalog row at all.
check("no catalog figure -> dealer's number stands, labelled",
  resolveMsrpAuthority({ statedMsrp: 66015, ref: null }),
  { msrp: 66015, basis: "dealer_stated", source: "listing", reference: null });

// No dealer figure: the catalog supplies it normally.
check("no dealer figure, exact row -> catalog exact",
  resolveMsrpAuthority({ statedMsrp: 0, ref: exact(33609) }),
  { msrp: 33609, basis: "exact", source: "catalog", dealerStatedMsrp: null });

check("no dealer figure, floor row -> catalog floor",
  resolveMsrpAuthority({ statedMsrp: 0, ref: floor(35000) }),
  { msrp: 35000, basis: "starting_at", source: "catalog" });

console.log(`\n${pass}/${pass + fail} passed${fail ? "  -- FAILING" : "  all green"}`);
process.exit(fail ? 1 : 0);
