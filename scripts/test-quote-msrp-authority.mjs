// Regression suite: the UPLOAD path must obey the same MSRP authority rule as
// the listing path.
//
// WHY THIS EXISTS. On 2026-08-13 a report accused a named dealer of an
// $18,900 markup because msrp_catalog was missing the IONIQ 9's top trims.
// That was fixed -- in analyze-listing-url ONLY. A dealer red-team on
// 2026-08-15 found the identical defamation live on analyze-quote, which had
// its own unguarded copy: `verifiedMsrp ?? statedMsrpOnDocument` let ANY
// catalog hit win regardless of match quality, so a missing trim fell through
// to "model_only_approximate" (which returns the CHEAPEST row for the model)
// and wrote, verbatim and ECDSA-signed, that a $81,499 window sticker should
// have been $59,999. It rode into the email, the PDF, the share link and the
// leverage score's "not an opinion" note.
//
// The rule, one line: only an EXACT trim match may displace a dealer's stated
// MSRP or support an inflation callout. A fuzzy substring hit and a
// model-level floor are references, never accusations.
//
// Run: node scripts/test-quote-msrp-authority.mjs

import { resolveMsrpAuthority } from "../supabase/functions/_shared/msrp-authority.js";

// Mirrors analyze-quote's buildAnalysis mapping exactly.
function decide({ statedOnDocument, catalogValue, catalogMatchType, catalogTrim = null, make = "Hyundai" }) {
  const basis = catalogMatchType === "exact" ? "exact" : "starting_at";
  return resolveMsrpAuthority({
    statedMsrp: Number(statedOnDocument) || 0,
    ref: catalogValue != null ? { msrp: Number(catalogValue), trim: catalogTrim, basis, sourceUrl: null } : null,
    make,
  });
}

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "  -- " + detail : ""}`); }
};

// 1. THE INCIDENT. Catalog missing the loaded trim -> model-level floor.
{
  const d = decide({ statedOnDocument: 81499, catalogValue: 59999, catalogMatchType: "model_only_approximate" });
  check("IONIQ 9: floor must NOT become the report's MSRP", d.msrp === 81499, `msrp=${d.msrp}`);
  check("IONIQ 9: no inflation accusation from a floor", d.inflation === null, JSON.stringify(d.inflation));
  check("IONIQ 9: dealer's figure keeps its honest label", d.basis === "dealer_stated" && d.source === "listing", `${d.basis}/${d.source}`);
  check("IONIQ 9: floor is attached as a reference instead", !!d.reference && Number(d.reference.msrp) === 59999, JSON.stringify(d.reference));
}

// 2. A fuzzy substring hit (ilike '%trim%', limit 1, no ordering) is NOT exact
// evidence and must behave like the floor.
{
  const d = decide({ statedOnDocument: 81499, catalogValue: 64999, catalogMatchType: "fuzzy_trim", catalogTrim: "Preferred AWD" });
  check("fuzzy trim match cannot displace the dealer's MSRP", d.msrp === 81499, `msrp=${d.msrp}`);
  check("fuzzy trim match raises no accusation", d.inflation === null);
}

// 3. A genuine EXACT match still does its job -- the fix must not disarm the
// real inflation callout.
{
  const d = decide({ statedOnDocument: 40000, catalogValue: 33609, catalogMatchType: "exact", catalogTrim: "Preferred" });
  check("exact match: catalog figure wins", d.msrp === 33609, `msrp=${d.msrp}`);
  check("exact match: real padding IS still named", !!d.inflation && d.inflation.overBy === 6391, JSON.stringify(d.inflation));
  check("exact match: labelled exact/catalog", d.basis === "exact" && d.source === "catalog");
}

// 4. Exact match, immaterial gap -> no accusation (msrp-authority's own 3%/$800
// floor, which the old quote-path 2% test did not have).
{
  const d = decide({ statedOnDocument: 33800, catalogValue: 33609, catalogMatchType: "exact" });
  check("exact match, trivial gap -> no accusation", d.inflation === null, JSON.stringify(d.inflation));
  check("exact match, trivial gap -> dealer figure still visible", d.dealerStatedMsrp === 33800);
}

// 5. No catalog row at all -> the dealer's number stands, clearly labelled.
{
  const d = decide({ statedOnDocument: 66015, catalogValue: null, catalogMatchType: "not_found" });
  check("no catalog row -> dealer figure stands", d.msrp === 66015 && d.basis === "dealer_stated");
  check("no catalog row -> no reference invented", d.reference === null);
}

// 6. No stated MSRP on the document + only a floor -> the floor may be shown,
// but must stay labelled as a floor so no surface treats it as this trim's price.
{
  const d = decide({ statedOnDocument: null, catalogValue: 59999, catalogMatchType: "model_only_approximate" });
  check("no stated MSRP: floor is usable but labelled starting_at", d.msrp === 59999 && d.basis === "starting_at", `${d.msrp}/${d.basis}`);
  check("no stated MSRP: still no accusation", d.inflation === null);
}

// 7. The leverage-score gate: an over-MSRP claim requires basis === "exact".
// Mirrors the guard in computeLeverageScore.
{
  const floor = decide({ statedOnDocument: 81499, catalogValue: 59999, catalogMatchType: "model_only_approximate" });
  const exact = decide({ statedOnDocument: 40000, catalogValue: 33609, catalogMatchType: "exact" });
  const wouldNarrate = (d) => d.basis === "exact";
  check("leverage score stays silent on a floor", wouldNarrate(floor) === false);
  check("leverage score still speaks on an exact match", wouldNarrate(exact) === true);
}

console.log(`\n${pass}/${pass + fail} passed${fail ? "  -- FAILING" : "  all green"}`);
process.exit(fail ? 1 : 0);
