// Two rules about how catalog data reaches Supabase.
//
// 1. EVERY SCRAPER WRITES THROUGH writeCatalogs().
//    5f4259d fixed a real loss -- an MSRP write that throws must not take the
//    finance and lease writes down with it -- and converted twenty scrapers to
//    the shared helper. Two kept their own hand-rolled copy of the sequence and
//    so kept the bug: tci-stack.mjs (Toyota, Lexus) and fca-stack.mjs (Jeep,
//    Ram, Dodge, Chrysler). That is why the very Toyota run that MOTIVATED
//    5f4259d was still losing its rates months later: the collapse guard
//    correctly refuses the MSRP rows, the refusal throws, and 123 finance +
//    120 lease rows already in hand are never written.
//
//    fca-stack carried a second copy of it: the writes sat inside a per-make
//    loop, so a throw on the first make skipped every make after it as well.
//
// 2. THE TCI PLATFORM NEVER WRITES msrp_catalog.
//    Toyota and Lexus expose no published national MSRP. Their price endpoint
//    returns vehicleStartPrice, which is province-calculated: the same Land
//    Cruiser returns twelve distinct values across thirteen provinces, five of
//    them whole dollars that disagree with each other. A whole-dollar filter
//    therefore proves nothing -- at province=ON it ADMITTED 7 of 76 rows, every
//    one an Ontario-calculated figure being stored as a manufacturer price.
//    An MSRP with no known basis must not be published, so this platform writes
//    none and msrp_catalog keeps its hand-seeded Build & Price rows.
//
// Run: node scripts/test-catalog-writes.mjs
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✅ ${n}`); };
const bad = (n, why) => { fail++; console.error(`  ❌ ${n}\n       ${why}`); };
const t = (n, cond, why) => cond ? ok(n) : bad(n, why);

// ── 1. no hand-rolled msrp_catalog writes outside the helper ────────────────
const files = [];
for (const dir of ["scripts", "scripts/lib"]) {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    if (f.isFile() && f.name.endsWith(".mjs")) files.push(join(dir, f.name).split(String.fromCharCode(92)).join("/"));
  }
}
// catalog-io.mjs DEFINES replaceRows; test-* files exercise it deliberately.
const EXEMPT = /scripts\/lib\/catalog-io\.mjs$|scripts\/test-/;
const offenders = files.filter((f) => !EXEMPT.test(f) &&
  /replaceRows\s*\(\s*["']msrp_catalog["']/.test(readFileSync(f, "utf8")));
t("no scraper writes msrp_catalog outside writeCatalogs()",
  offenders.length === 0,
  `these bypass the helper and lose the other tables when MSRP throws:\n       ${offenders.join("\n       ")}`);

// ── 2. the two stacks that were missed now use the helper ───────────────────
for (const f of ["scripts/lib/tci-stack.mjs", "scripts/lib/fca-stack.mjs"]) {
  const src = readFileSync(f, "utf8");
  t(`${f} imports writeCatalogs`,
    /import\s*\{[^}]*\bwriteCatalogs\b[^}]*\}\s*from\s*["']\.\/catalog-io\.mjs["']/.test(src),
    "still hand-rolling the write sequence");
}

// ── 3. fca-stack must not let one make end the loop ─────────────────────────
const fca = readFileSync("scripts/lib/fca-stack.mjs", "utf8");
t("fca-stack keeps makes independent of each other",
  /for \(const make of[\s\S]{0,200}?try \{/.test(fca) && /makeFailures/.test(fca),
  "a throw on one make still aborts the loop, silently costing every make after it");

// ── 4. the TCI platform writes no MSRP ──────────────────────────────────────
const tci = readFileSync("scripts/lib/tci-stack.mjs", "utf8");
t("tci-stack writes rates only",
  /writeCatalogs\([\s\S]{0,220}?ratesOnly:\s*true/.test(tci),
  "Toyota/Lexus have no published national MSRP — writing one stores a province-calculated price");
t("tci-stack passes no msrp rows at all",
  /writeCatalogs\([^)]*msrpRows:\s*\[\]/.test(tci),
  "ratesOnly alone is a flag someone can flip; the rows must also be empty at the call site");
t("the province evidence is recorded where the gate used to be",
  /74681\.92|province-calculated/.test(tci),
  "the reason this platform is rates-only must survive in the file, or someone will 'fix' it back");

console.log(`\n${fail ? "❌" : "✅"} catalog-writes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
