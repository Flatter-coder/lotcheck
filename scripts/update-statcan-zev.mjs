
// Checks Statistics Canada Table 20-10-0086-01 ("New motor vehicle sales, by
// vehicle type, annual") for a new release, and rebuilds public/data/statcan-zev.json
// if one exists. Intended to run daily via GitHub Actions.
//
// Honesty note: this table is published ANNUALLY. Running this daily doesn't
// mean the underlying numbers change daily — it means LotCheck confirms daily
// that it still has the latest release StatCan has published. The JSON output
// always records both "last_checked_at" (every run) and "data_release_time"
// (only changes when StatCan actually re-publishes) so the frontend can be
// honest about which claim it's making.

import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PRODUCT_ID = 20100086;
const OUTPUT_PATH = "public/data/statcan-zev.json";

const PROVINCE_ID_MAP = {
  "Quebec": "Quebec",
  "British Columbia and the Territories": "BritishColumbia",
  "Ontario": "Ontario",
  "Prince Edward Island": "PrinceEdwardIsland",
  "New Brunswick": "NewBrunswick",
  "Nova Scotia": "NovaScotia",
  "Manitoba": "Manitoba",
  "Alberta": "Alberta",
  "Saskatchewan": "Saskatchewan",
  "Newfoundland and Labrador": "NewfoundlandLabrador",
};

// Identify ourselves on every request, from the one place they all pass through.
// StatCan currently serves an anonymous Node fetch fine, so this is not fixing a
// live break — it is refusing to depend on that staying true. The Alberta dealer
// map made exactly this assumption against Overpass and got HTTP 406 from every
// mirror, which read as "the upstream is down" for four straight weekly runs.
// Putting it in fetchWithRetry rather than at each call site means a new call
// cannot forget it.
const USER_AGENT = "LotCheck/1.0 (StatCan ZEV refresh; +https://lotcheck.ca)";

async function fetchWithRetry(url, opts, attempts = 3) {
  const withUA = { ...opts, headers: { ...(opts?.headers || {}), "User-Agent": USER_AGENT } };
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, withUA);
      if (res.ok) return res;
      if (i === attempts - 1) throw new Error(`Request failed: ${res.status}`);
    } catch (err) {
      if (i === attempts - 1) throw err;
    }
    await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
}

async function getReleaseTime() {
  const res = await fetchWithRetry("https://www150.statcan.gc.ca/t1/wds/rest/getCubeMetadata", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ productId: PRODUCT_ID }]),
  });
  if (!res.ok) throw new Error(`getCubeMetadata failed: ${res.status}`);
  const [result] = await res.json();
  if (result.status !== "SUCCESS") throw new Error("getCubeMetadata returned non-success status");
  return result.object.releaseTime;
}

async function downloadAndParseCsv() {
  const linkRes = await fetchWithRetry(
    `https://www150.statcan.gc.ca/t1/wds/rest/getFullTableDownloadCSV/${PRODUCT_ID}/en`
  );
  const linkJson = await linkRes.json();
  if (linkJson.status !== "SUCCESS") throw new Error("getFullTableDownloadCSV failed");

  const zipRes = await fetchWithRetry(linkJson.object);
  const zipBuffer = Buffer.from(await zipRes.arrayBuffer());

  // Minimal zip extraction without a native dependency: Node 18+ has no
  // built-in unzip, so shell out to `unzip` (present on GitHub Actions'
  // ubuntu-latest runners by default).
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const tmp = mkdtempSync(join(tmpdir(), "statcan-"));
  const zipPath = join(tmp, "table.zip");
  writeFileSync(zipPath, zipBuffer);
  execFileSync("unzip", ["-o", zipPath, "-d", tmp]);
  const csvText = readFileSync(join(tmp, `${PRODUCT_ID}.csv`), "utf-8");

  return csvText;
}

export function parseLatestYearZevShare(csvText) {
  // StatCan's CSV export starts with a UTF-8 BOM, which corrupts the first
  // header name ("REF_DATE" becomes "\uFEFFREF_DATE") if not stripped.
  const clean = csvText.replace(/^\uFEFF/, "");
  const lines = clean.split("\n").filter(Boolean);
  const header = parseCsvLine(lines[0]);
  const idx = Object.fromEntries(header.map((h, i) => [h.replace(/"/g, ""), i]));

  const rows = lines.slice(1).map(parseCsvLine);

  let latestYear = 0;
  for (const r of rows) {
    const year = Number(r[idx.REF_DATE]?.replace(/"/g, ""));
    if (year > latestYear) latestYear = year;
  }

  const byProvince = {};
  for (const r of rows) {
    const year = Number(r[idx.REF_DATE]?.replace(/"/g, ""));
    const geo = r[idx.GEO]?.replace(/"/g, "");
    const vehicleType = r[idx["Vehicle type"]]?.replace(/"/g, "");
    const sales = r[idx.Sales]?.replace(/"/g, "");
    const fuelType = r[idx["Fuel type"]]?.replace(/"/g, "");
    const value = r[idx.VALUE]?.replace(/"/g, "");

    if (year !== latestYear) continue;
    if (vehicleType !== "Total, new motor vehicles") continue;
    if (sales !== "Units") continue;
    const provinceId = PROVINCE_ID_MAP[geo];
    if (!provinceId) continue;

    byProvince[provinceId] ??= {};
    if (fuelType === "All fuel types") byProvince[provinceId].totalSales = Number(value) || null;
    if (fuelType === "Zero-emission") byProvince[provinceId].zevSales = Number(value) || null;
  }

  const result = {};
  for (const [id, v] of Object.entries(byProvince)) {
    if (v.totalSales && v.zevSales != null) {
      result[id] = {
        totalSales: v.totalSales,
        zevSales: v.zevSales,
        zevPct: Math.round((v.zevSales / v.totalSales) * 1000) / 10,
      };
    }
  }
  return { year: String(latestYear), data: result };
}

// Tiny CSV line parser that handles quoted fields with commas inside them.
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}


// WHAT STOPS A COLLAPSE REACHING THE MAP.
//
// parseLatestYearZevShare indexes the CSV by literal header names (REF_DATE,
// GEO, "Vehicle type", Sales, "Fuel type", VALUE) and filters on exact label
// text ("Total, new motor vehicles", "Units", "All fuel types",
// "Zero-emission") plus the ten spellings in PROVINCE_ID_MAP. Every one of
// those is StatCan's to rename, and a rename does not throw -- it filters
// every row out. latestYear stays 0 and result stays {}.
//
// main() then wrote that, and the workflow pushed it to main with
// contents: write. public/data/statcan-zev.json is what statcan-zev-map.html
// renders, so an upstream header change would have blanked a public map and
// stamped it year "0", with nothing red anywhere.
//
// [[catalog-refresh-can-empty-the-catalog]] is the same rule for the MSRP
// catalogue: a refresh is allowed to change the numbers, never to empty them.
// A refusal here writes NOTHING -- not even last_checked_at, because that
// field is a claim that we confirmed something, and on this path we did not.
const EXPECTED_REGIONS = Object.keys(PROVINCE_ID_MAP).length;
const SOURCE_CREDIT =
  "Statistics Canada. Table 20-10-0086-01, New motor vehicle sales, by vehicle type, annual. Statistics Canada Open Licence.";

export function collapseProblems({ year, data }, previous) {
  const problems = [];
  const got = Object.keys(data || {}).length;
  const had = previous && previous.data ? Object.keys(previous.data).length : 0;

  if (!Number(year)) problems.push({ code: "no_year", why: `no model year parsed (year=${JSON.stringify(year)}) -- REF_DATE is probably renamed or empty` });
  if (got === 0) problems.push({ code: "no_regions", why: `zero regions parsed out of ${EXPECTED_REGIONS} expected -- a header or a label has almost certainly changed` });
  else if (got * 2 < EXPECTED_REGIONS) problems.push({ code: "too_few_regions", why: `only ${got} of ${EXPECTED_REGIONS} expected regions parsed` });

  if (had && got * 2 < had) problems.push({ code: "collapsed", why: `regions collapsed from ${had} to ${got} against the file we already hold` });
  if (previous && previous.year && Number(year) < Number(previous.year)) {
    problems.push({ code: "year_backwards", why: `model year went BACKWARDS: we hold ${previous.year}, this parse says ${year}` });
  }
  return problems;
}

// THE FLOOR LIVES WITH THE PAYLOAD, NOT BESIDE IT.
//
// While proving this guard by mutation, one mutation removed the
// collapseProblems() call from main() and the suite stayed green -- because
// the suite tested the checker and main() was free not to ask it. A guard
// that the writer can decline to consult is a guard with an off switch.
// So the only way to build the payload runs the floor first, and the mutation
// that skips it no longer type-checks as a thing you can write.
export function buildRefreshedPayload(parsed, previous, { releaseTime, nowIso }) {
  const problems = collapseProblems(parsed, previous);
  if (problems.length) {
    const err = new Error("statcan-zev: refusing to write a collapsed refresh");
    err.problems = problems;
    throw err;
  }
  return {
    source: SOURCE_CREDIT,
    year: parsed.year,
    data_release_time: releaseTime,
    last_checked_at: nowIso,
    data: parsed.data,
  };
}

async function main() {
  const nowIso = new Date().toISOString();
  const releaseTime = await getReleaseTime();

  let previous = null;
  if (existsSync(OUTPUT_PATH)) {
    try {
      previous = JSON.parse(await (await import("node:fs/promises")).readFile(OUTPUT_PATH, "utf-8"));
    } catch {
      previous = null;
    }
  }

  const releaseChanged = !previous || previous.data_release_time !== releaseTime;

  let payload;
  if (releaseChanged) {
    console.log(`New StatCan release detected (${releaseTime}) — re-downloading full table.`);
    const csvText = await downloadAndParseCsv();
    const parsed = parseLatestYearZevShare(csvText);
    try {
      payload = buildRefreshedPayload(parsed, previous, { releaseTime, nowIso });
    } catch (err) {
      if (!err.problems) throw err;
      console.error(`Refusing to write ${OUTPUT_PATH}. StatCan published a new release and this run could not read it:`);
      for (const pr of err.problems) console.error(`  - [${pr.code}] ${pr.why}`);
      console.error("");
      console.error("The file on disk is LEFT AS IT WAS -- including last_checked_at, which is a");
      console.error("claim that we confirmed something, and on this path we did not. Stale is");
      console.error("recoverable; a blank public map stamped with a fresh-looking date is not.");
      console.error("Check whether StatCan renamed a column or a label in table 20-10-0086-01,");
      console.error("then fix the literals in parseLatestYearZevShare and PROVINCE_ID_MAP.");
      process.exit(1);
    }
  } else {
    console.log(`No new StatCan release (still ${releaseTime}) — just updating last_checked_at.`);
    payload = { ...previous, last_checked_at: nowIso };
  }

  await mkdir("public/data", { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2) + "\n");
  console.log(`Wrote ${OUTPUT_PATH}`);
}

// Run only when invoked directly. Until 2026-09-23 main() ran at module load,
// so importing this file to test its parser would have downloaded a 60MB zip
// from StatCan and rewritten public/data/statcan-zev.json as a side effect of
// the import. An untestable guard is a guard nobody checks. Same shape as
// crawl-alberta-inventory.mjs. argv[1] is absent under `node -e`, so guard it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
