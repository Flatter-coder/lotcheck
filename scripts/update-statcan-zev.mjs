
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

async function fetchWithRetry(url, opts, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, opts);
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

function parseLatestYearZevShare(csvText) {
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
    const { year, data } = parseLatestYearZevShare(csvText);
    payload = {
      source: "Statistics Canada. Table 20-10-0086-01, New motor vehicle sales, by vehicle type, annual. Statistics Canada Open Licence.",
      year,
      data_release_time: releaseTime,
      last_checked_at: nowIso,
      data,
    };
  } else {
    console.log(`No new StatCan release (still ${releaseTime}) — just updating last_checked_at.`);
    payload = { ...previous, last_checked_at: nowIso };
  }

  await mkdir("public/data", { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2) + "\n");
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
