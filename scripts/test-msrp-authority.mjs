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

// ── Configuration mismatch is not an accusation (2026-08-12, live defect) ────
// A 2026 Mustang Mach-E Premium AWD listed at a $66,015 sticker was matched to
// Ford's base Premium ($49,990) and the difference reported as dealer sticker
// inflation. Catalog rows pin a TRIM, not a configuration; AWD and extended
// range are options above that price. Naming a named dealer for $16,025 of
// padding on that evidence is exactly the claim we cannot defend.
check("huge gap over an exact row is NOT called inflation",
  resolveMsrpAuthority({ statedMsrp: 66015, ref: exact(49990, "Premium"), make: "Ford" }),
  { inflation: null });
check("...and the row stops posing as this unit's sticker",
  resolveMsrpAuthority({ statedMsrp: 66015, ref: exact(49990, "Premium"), make: "Ford" }),
  { msrp: 66015, basis: "dealer_stated", source: "listing" });
check("...attached instead as a starting reference, not an exact one",
  resolveMsrpAuthority({ statedMsrp: 66015, ref: exact(49990, "Premium"), make: "Ford" }).reference,
  { msrp: 49990, basis: "starting_at", trim: "Premium" });

// The true positives must survive: real padding measured on live listings.
check("3.1% / $1,350 padding is still named (Escape PHEV)",
  resolveMsrpAuthority({ statedMsrp: 45244, ref: exact(43894, "Plug-In Hybrid"), make: "Ford" }).inflation,
  { dealerStated: 45244, manufacturer: 43894, overBy: 1350 });
check("11.9% / $4,965 padding is still named (Bronco Sport)",
  resolveMsrpAuthority({ statedMsrp: 46755, ref: exact(41790, "Big Bend"), make: "Ford" }).inflation,
  { dealerStated: 46755, manufacturer: 41790, overBy: 4965 });
check("both thresholds required: 25% but only $5k stays an inflation call",
  resolveMsrpAuthority({ statedMsrp: 25000, ref: exact(20000, "Base"), make: "Kia" }).inflation,
  { overBy: 5000 });
check("both thresholds required: $20k but only 12% stays an inflation call",
  resolveMsrpAuthority({ statedMsrp: 186000, ref: exact(166000, "Base"), make: "Porsche" }).inflation,
  { overBy: 20000 });
// A dealer figure BELOW the manufacturer's is a discount, never a mismatch.
check("a lower dealer figure still loses to the exact manufacturer price",
  resolveMsrpAuthority({ statedMsrp: 40000, ref: exact(49990, "Premium"), make: "Ford" }),
  { msrp: 49990, basis: "exact", inflation: null });

console.log(`\n${pass}/${pass + fail} passed${fail ? "  -- FAILING" : "  all green"}`);
process.exit(fail ? 1 : 0);
