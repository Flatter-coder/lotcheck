// Used-vehicle APR catalogue: manufacturers' certified pre-owned finance rates,
// from their own Canadian sites (lib/cpo-rates.mjs has the readers and why).
//
// Replaces each make's rows only when its page read; a make that did not read
// keeps its previous rows and is named in the summary, so the daily report's
// check mark turns amber instead of the catalogue quietly emptying.
//
//   node scripts/scrape-cpo-rates.mjs            # dry run without SUPABASE_*
//   CATALOG_STATUS_OUT=status.json node scripts/scrape-cpo-rates.mjs
import { writeFileSync } from "node:fs";
import { UA, sleep } from "./lib/catalog-io.mjs";
import { readToyota, readSubaru, readNissan, readMini, readVw, gmLadders, gmLegal, readGm, readStatement } from "./lib/cpo-rates.mjs";

// Every make the 2026-09-25 survey covered. Those without a reader are listed
// so the summary counts them as not yet accounted for, never as done.
export const TRACKED = ["Toyota", "Nissan", "Subaru", "MINI", "Volkswagen", "GM", "Honda", "Acura", "Infiniti",
  "Ford", "Audi", "Volvo", "Mitsubishi", "BMW", "Mercedes-Benz", "Lexus", "Mazda", "Hyundai", "Kia", "Genesis", "Stellantis", "Porsche"];

const GM_LEGAL = (p) => `https://www.gmcpo.ca/api/assets/gm-cpo/canada/english/disclosures/benefit-disclosure/${p}/financing.json`;
const SOURCES = {
  Toyota: { url: "https://www.toyota.ca/en/vehicles/certified-used/", read: readToyota },
  Subaru: { url: "https://www.subaru.ca/WebPage.aspx?WebPageID=16796&WebSiteID=282", read: readSubaru },
  Nissan: { url: "https://www.nissan.ca/certified-pre-owned.html", read: readNissan },
  MINI: { url: "https://mini.ca/en/shopping/mini-next/list", read: readMini },
  Volkswagen: { url: "https://globalapi.vwtools.ca/volkswagen/cpo-rates", read: readVw, json: true },
  Honda: { url: "https://cuv.honda.ca/honda-certified-advantages.html", read: (h, u) => readStatement("Honda", h, u) },
  Acura: { url: "https://cuv.acura.ca/certified-acura-benefits.html", read: (h, u) => readStatement("Acura", h, u) },
  Infiniti: { url: "https://www.infiniti.ca/certified-pre-owned.html", read: (h, u) => readStatement("Infiniti", h, u) },
};

async function get(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/json;q=0.9,*/*;q=0.8" }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

async function readMake(make) {
  if (make === "GM") {
    const url = "https://www.gmcpo.ca/offers/";
    const ladders = gmLadders(await get(url));
    const legal = {};
    for (const { prog } of ladders) { await sleep(1500); try { legal[prog] = gmLegal(await get(GM_LEGAL(prog))); } catch (e) { console.warn(`  GM ${prog} legal: ${e.message}`); } }
    return readGm(ladders, legal, url);
  }
  const s = SOURCES[make];
  const body = await get(s.url);
  return s.read(s.json ? JSON.parse(body) : body, make === "Volkswagen" ? "https://www.vw.ca/en/certified-preowned.html" : s.url);
}

async function main() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": "LotCheckBot/1.0 (+https://lotcheck.ca/about)" };
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Edmonton" });
  const read = [], failed = [];
  for (const make of [...Object.keys(SOURCES), "GM"]) {
    let rows = [];
    try { rows = await readMake(make); } catch (e) { console.warn(`  ${make}: ${e.message}`); }
    if (!rows.length) { failed.push(make); console.warn(`  ${make}: page did not read -- previous rows kept`); await sleep(1500); continue; }
    const pub = rows.filter((r) => r.status === "published");
    console.log(`  ${make}: ${rows[0].status === "published" ? `${pub.length} published rate(s), ${Math.min(...pub.map((r) => r.apr))}% lowest` : rows[0].status}`);
    if (url && key) {
      const del = await fetch(`${url}/rest/v1/cpo_rate_catalog?make=eq.${encodeURIComponent(make)}`, { method: "DELETE", headers });
      const ins = del.ok ? await fetch(`${url}/rest/v1/cpo_rate_catalog`, { method: "POST", headers: { ...headers, Prefer: "return=minimal" }, body: JSON.stringify(rows.map((r) => ({ ...r, read_on: today }))) }) : del;
      if (!ins.ok) { failed.push(make); console.warn(`  ${make}: write failed HTTP ${ins.status} ${await ins.text()}`); await sleep(1500); continue; }
    }
    read.push(make);
    await sleep(1500);
  }
  const notCovered = TRACKED.filter((m) => !SOURCES[m] && m !== "GM");
  console.log(`\nread ${read.length}: ${read.join(", ")}${failed.length ? `\nnot read today: ${failed.join(", ")}` : ""}\nno reader yet (blocked, unclear or no national page found): ${notCovered.join(", ")}`);
  if (process.env.CATALOG_STATUS_OUT) {
    writeFileSync(process.env.CATALOG_STATUS_OUT, JSON.stringify({
      state: read.length === 0 ? "red" : read.length === TRACKED.length ? "green" : "amber",
      covered: read.length, of_total: TRACKED.length, unit: "makes",
      note: `${read.length} of ${TRACKED.length} makes read from their own certified pre-owned pages (a rate, or their own statement that the lender sets it)` +
        (failed.length ? `; did not read today: ${failed.join(", ")}` : "") +
        `; not yet readable: ${notCovered.join(", ")}.`,
    }));
  }
  if (!read.length) process.exit(1);
}

if (process.argv[1]?.endsWith("scrape-cpo-rates.mjs")) main().catch((e) => { console.error(e); process.exit(1); });
