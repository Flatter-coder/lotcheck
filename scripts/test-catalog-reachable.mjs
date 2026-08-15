// Every model name seeded into msrp_catalog must be reachable by the lookup.
//
// THE DEFECT THIS PINS. lookupCatalogMsrp queries
//   .ilike("model", canonicalModel(make, listingModel) || rawModel)
// with NO wildcard, so the query is an exact case-insensitive match. If a
// catalog row is keyed "RAV4 Hybrid" but canonicalModel reduces every RAV4
// listing to "RAV4", that row is never returned to anyone. The migration
// succeeds, the row count looks right, and the report finds nothing — a seed
// that reads as finished and is inert.
//
// Five of 2026-08-15's seeds were in exactly that state: Crown Signia,
// RAV4 Hybrid, RAV4 Plug-in Hybrid, 4Runner Hybrid, Corolla Cross Hybrid.
//
// AND ONE OF THEM WAS WORSE THAN INERT. "Crown Signia Limited" resolved to
// "Crown" — a different car with its own "Limited" trim, a different engine and
// roughly $3,000 less at the base. The lookup would have found an exact trim
// match on the wrong vehicle and reported it as authoritative. Not a blank: a
// confident wrong number, which is the one outcome that hands a dealer the
// argument. Same shape as the Mustang Mach-E / Mustang trap models.ts was
// written to prevent.
//
// Run: node scripts/test-catalog-reachable.mjs

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalModel } from "../supabase/functions/_shared/models.ts";

const DIR = "supabase/migrations";
let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "\n        " + detail}`);
  cond ? pass++ : fail++;
};

// Pull (make, model) pairs out of every msrp_catalog insert.
const seeded = new Map();
for (const f of readdirSync(DIR).filter((x) => x.endsWith(".sql"))) {
  const sql = readFileSync(join(DIR, f), "utf8").replace(/--[^\n]*/g, " ");
  if (!/insert\s+into\s+public\.msrp_catalog/i.test(sql)) continue;
  for (const m of sql.matchAll(/\(\s*\d{4}\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,/g)) {
    const key = `${m[1]}|${m[2]}`;
    if (!seeded.has(key)) seeded.set(key, { make: m[1], model: m[2], file: f });
  }
}

check("migrations actually yielded model names to check", seeded.size > 0,
  "parser found nothing — it has drifted from the migration format, which would make this gate silently vacuous");

// NULL IS SAFE, and this distinction is the whole point. The call site is
//   lookupCatalogMsrp(year, make, baseModel || analysis.model, ...)
// so when canonicalModel returns null the RAW model string is used, which is
// the key the row is stored under — the lookup works. models.ts is explicit
// that unknown models return null precisely so callers fall back "never a wrong
// match".
//
// What is NOT safe is a DIFFERENT non-null answer: that silently queries
// another nameplate, and if rows exist under it the report gets a confident
// wrong MSRP instead of an honest blank.
for (const { make, model, file } of seeded.values()) {
  const resolved = canonicalModel(make, model);
  const safe = resolved === null || resolved === model;
  const collides = resolved && model.startsWith(resolved + " ");
  check(`${make} "${model}" resolves to itself or falls through`,
    safe,
    `canonicalModel("${make}","${model}") = "${resolved}" — the lookup queries that instead, so ${file}'s rows are unreachable` +
    (collides ? `. WORSE: "${resolved}" is a real nameplate, so a listing matches the WRONG vehicle rather than finding nothing.` : ""));
}

// The specific collision, stated outright so it cannot regress quietly.
check("Crown and Crown Signia stay distinct",
  canonicalModel("Toyota", "Crown Signia Limited") === "Crown Signia" &&
  canonicalModel("Toyota", "Crown Limited") === "Crown",
  `Signia -> ${canonicalModel("Toyota", "Crown Signia Limited")}, Crown -> ${canonicalModel("Toyota", "Crown Limited")}`);

check("an electrified nameplate never resolves to its gas sibling",
  canonicalModel("Toyota", "RAV4 Hybrid XLE AWD") === "RAV4 Hybrid" &&
  canonicalModel("Toyota", "RAV4 Plug-in Hybrid XSE") === "RAV4 Plug-in Hybrid" &&
  canonicalModel("Toyota", "4Runner Hybrid Trailhunter") === "4Runner Hybrid" &&
  canonicalModel("Toyota", "RAV4 XLE") === "RAV4",
  "an electrified listing resolving to the gas base is the $13,687 4Runner error");

console.log(`\n${pass}/${pass + fail} passed${fail ? `  — ${fail} FAILING` : "  ✓ all green"}`);
process.exit(fail ? 1 : 0);
