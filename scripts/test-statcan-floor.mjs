// public/data/statcan-zev.json is what statcan-zev-map.html draws. A daily
// GitHub job rebuilds it and pushes straight to main with contents: write.
//
// WHAT THIS SUITE EXISTS TO STOP. parseLatestYearZevShare reads the CSV by
// literal header names (REF_DATE, GEO, "Vehicle type", Sales, "Fuel type",
// VALUE) and filters on exact label text ("Total, new motor vehicles", "Units",
// "All fuel types", "Zero-emission") plus the ten spellings in
// PROVINCE_ID_MAP. Every one of those belongs to Statistics Canada. A rename
// does not throw -- it filters every row out, latestYear stays 0, and the
// result is {}. Before 2026-09-23 main() wrote that and the workflow pushed it:
// a blank public map, stamped year "0" with a fresh-looking last_checked_at,
// and nothing red anywhere. [[catalog-refresh-can-empty-the-catalog]]
//
// EACH GUARD IS PINNED BY ITS OWN CODE, AND THAT IS THE POINT.
// The first draft of this file asserted `problems.length > 0` per case and
// survived 5 of 7 mutations: several guards fire on the same broken input, so
// deleting any one of them left another to cover for it and the suite stayed
// green over a guard that no longer existed. Asserting the exact code means a
// deleted guard has nothing to hide behind. [[audit-your-own-fix-same-night]]
//
// Run: node scripts/test-statcan-floor.mjs
import { parseLatestYearZevShare, collapseProblems, buildRefreshedPayload } from "./update-statcan-zev.mjs";

let pass = 0, fail = 0;
const check = (name, ok, why = "") => {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${why ? `  -- ${why}` : ""}`); }
};
const codes = (parsed, previous) => collapseProblems(parsed, previous).map((p) => p.code).sort();
const has = (parsed, previous, code) => codes(parsed, previous).includes(code);

// A minimal CSV in StatCan's real shape: ten regions, two fuel types each, and
// an earlier model year so "latest year" has something to choose between.
const HEADER = `"REF_DATE","GEO","DGUID","Vehicle type","Fuel type","Sales","UOM","UOM_ID","SCALAR_FACTOR","SCALAR_ID","VECTOR","COORDINATE","VALUE","STATUS","SYMBOL","TERMINATED","DECIMALS"`;
const row = (year, geo, fuel, value, vtype = "Total, new motor vehicles", sales = "Units") =>
  `"${year}","${geo}","2016A000011124","${vtype}","${fuel}","${sales}","Units",223,"units",0,"v1","1.1.1.1","${value}","","","",0`;

const REGIONS = [
  ["Alberta", 200000, 12000],
  ["Ontario", 700000, 63000],
  ["Quebec", 400000, 60000],
  ["British Columbia and the Territories", 250000, 50000],
  ["Manitoba", 50000, 2000],
  ["Saskatchewan", 45000, 1500],
  ["Nova Scotia", 40000, 2200],
  ["New Brunswick", 35000, 1600],
  ["Prince Edward Island", 8000, 500],
  ["Newfoundland and Labrador", 20000, 700],
];

function csv(regions = REGIONS, opts = {}) {
  const lines = [opts.header ?? HEADER];
  for (const [geo, total, zev] of regions) {
    lines.push(row(2023, geo, opts.allFuelLabel ?? "All fuel types", Math.round(total * 0.9)));
    lines.push(row(2023, geo, opts.zevLabel ?? "Zero-emission", Math.round(zev * 0.5)));
    lines.push(row(opts.year ?? 2024, geo, opts.allFuelLabel ?? "All fuel types", total, opts.vehicleType, opts.salesLabel));
    lines.push(row(opts.year ?? 2024, geo, opts.zevLabel ?? "Zero-emission", zev, opts.vehicleType, opts.salesLabel));
  }
  return lines.join("\n") + "\n";
}

const held = (n, year = "2024") => ({
  year,
  data: Object.fromEntries(REGIONS.slice(0, n).map(([g]) => [g.replace(/[^A-Za-z]/g, ""), {}])),
});
const HELD10 = held(10);

// ------------------------------------------------------------- the happy path
{
  const parsed = parseLatestYearZevShare(csv());
  check("a well-formed release parses all ten regions",
    Object.keys(parsed.data).length === 10, `got ${Object.keys(parsed.data).length}`);
  check("...and takes the LATEST model year, not the first row",
    parsed.year === "2024", `got ${parsed.year}`);
  check("...and computes a share from the two fuel rows",
    parsed.data.Alberta?.zevPct === 6, `got ${JSON.stringify(parsed.data.Alberta)}`);
  check("...and the floor lets it through with NO problems at all",
    codes(parsed, HELD10).length === 0, codes(parsed, HELD10).join(","));
  check("...and buildRefreshedPayload returns the payload the map reads",
    (() => {
      const p = buildRefreshedPayload(parsed, HELD10, { releaseTime: "2026-01-01T12:00", nowIso: "2026-09-23T00:00:00Z" });
      return p.year === "2024" && Object.keys(p.data).length === 10
        && p.data_release_time === "2026-01-01T12:00" && p.last_checked_at === "2026-09-23T00:00:00Z"
        && /Statistics Canada/.test(p.source);
    })(), "");
}

// ---------------------------------------------- each guard, pinned on its own
// no_regions -- every row filtered out. Compared against NO previous file, so
// `collapsed` cannot fire and cover for it.
{
  const cases = [
    ["a renamed column header (VALUE -> OBS_VALUE)", { header: HEADER.replace('"VALUE"', '"OBS_VALUE"') }],
    ["a renamed fuel label (Zero-emission -> Zero emission)", { zevLabel: "Zero emission" }],
    ["a renamed total label (All fuel types -> Total, fuel types)", { allFuelLabel: "Total, fuel types" }],
    ["a renamed vehicle-type label", { vehicleType: "Total, new motor vehicle" }],
    ["a renamed unit label (Units -> Number)", { salesLabel: "Number" }],
  ];
  for (const [name, opts] of cases) {
    const parsed = parseLatestYearZevShare(csv(REGIONS, opts));
    check(`no_regions: ${name}`, has(parsed, null, "no_regions"),
      `parsed ${Object.keys(parsed.data).length} region(s); codes=[${codes(parsed, null)}]`);
  }
}

// no_year -- REF_DATE renamed, so no year parses. Regions vanish too, so this
// is asserted on the CODE, not on "something fired".
{
  const parsed = parseLatestYearZevShare(csv(REGIONS, { header: HEADER.replace('"REF_DATE"', '"PERIOD"') }));
  check("no_year: a renamed REF_DATE column", has(parsed, null, "no_year"),
    `year=${JSON.stringify(parsed.year)}; codes=[${codes(parsed, null)}]`);
}

// too_few_regions -- a real parse of 4 regions against NO previous file, so
// `collapsed` cannot fire and `no_regions` cannot fire.
{
  const parsed = parseLatestYearZevShare(csv(REGIONS.slice(0, 4)));
  check("too_few_regions: 4 of the 10 expected regions, first run",
    has(parsed, null, "too_few_regions") && !has(parsed, null, "no_regions"),
    `codes=[${codes(parsed, null)}]`);
}

// collapsed -- 6 regions is NOT too few on its own (6*2 >= 10), so this case
// isolates the comparison against what we already hold.
{
  const parsed = parseLatestYearZevShare(csv(REGIONS.slice(0, 4)));
  check("collapsed: 4 regions against a held file of 10",
    has(parsed, HELD10, "collapsed"), `codes=[${codes(parsed, HELD10)}]`);
  const six = parseLatestYearZevShare(csv(REGIONS.slice(0, 6)));
  check("...and 6 against 10 is thin but NOT a collapse",
    !has(six, HELD10, "collapsed") && codes(six, HELD10).length === 0, `codes=[${codes(six, HELD10)}]`);
}

// year_backwards -- a complete, healthy parse of an older year, so no other
// guard has anything to say.
{
  const parsed = parseLatestYearZevShare(csv(REGIONS, { year: 2022 }));
  check("year_backwards: a full parse of an older year than the one we hold",
    codes(parsed, HELD10).join(",") === "year_backwards", `codes=[${codes(parsed, HELD10)}]`);
}

// ------------------------------------------ the floor is not optional to reach
{
  let threw = false, problems = null;
  try { buildRefreshedPayload({ year: "0", data: {} }, HELD10, { releaseTime: "x", nowIso: "y" }); }
  catch (e) { threw = true; problems = e.problems; }
  check("buildRefreshedPayload THROWS on a collapsed parse rather than returning one",
    threw && Array.isArray(problems) && problems.length > 0, "the writer must not be able to decline the floor");

  let firstRunThrew = false;
  try { buildRefreshedPayload({ year: "0", data: {} }, null, { releaseTime: "x", nowIso: "y" }); }
  catch { firstRunThrew = true; }
  check("...including on the very first run, with no previous file to compare to",
    firstRunThrew, "nothing to compare against is not permission to publish nothing");

  const ok = parseLatestYearZevShare(csv());
  let goodThrew = false;
  try { buildRefreshedPayload(ok, null, { releaseTime: "x", nowIso: "y" }); } catch { goodThrew = true; }
  check("...and does NOT throw on a good first run", !goodThrew, "");
}

console.log(`\n${pass}/${pass + fail} passed${fail ? `  -- ${fail} FAILING` : "  all green"}`);
process.exit(fail ? 1 : 0);
