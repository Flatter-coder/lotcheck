// Alberta inventory crawler — builds our own VIN dataset from the inventory
// feeds dealers publish on their own sites.
//
// WHY OURS. Every vehicle-data vendor worth buying also sells to dealers, which
// makes them a switch the other side of the table can ask to have flipped (see
// the vendor policy in CLAUDE.md). This dataset has no vendor, no contract, and
// nothing anyone can revoke for commercial reasons.
//
// WHAT WE TAKE, per unit: the VIN (SM360 calls it serialNo), the dealer's OWN
// date-entered-inventory and days-in-inventory counts, list vs sale price, and
// the basic condition facts. Nothing about a person — no buyer, no owner, no
// contact details. See the migration header for the privacy note.
//
// HOW IT BEHAVES. Identifies itself honestly in the User-Agent, crawls one
// dealer at a time with a delay between requests, caps pages per section, and
// treats any failure as "skip this dealer today" rather than something that
// could corrupt the table. A crawl that returns suspiciously little never
// mass-delists a lot (the guard lives in fn_mark_delisted).
//
// Run (Node 24+, from repo root):
//   node --experimental-strip-types scripts/crawl-alberta-inventory.mjs --dry-run
//   node --experimental-strip-types scripts/crawl-alberta-inventory.mjs --host https://www.tazaparkvw.com --dry-run
//   node --experimental-strip-types scripts/crawl-alberta-inventory.mjs        # writes; needs SUPABASE_* env
//
// --experimental-strip-types is required because we import validateVin from the
// edge functions' shared module rather than writing a second copy of VIN
// validation. One definition, one place to fix.
import { validateVin } from "../supabase/functions/_shared/invariants.ts";

const DRY = process.argv.includes("--dry-run");
const HOST_ARG = (() => { const i = process.argv.indexOf("--host"); return i > -1 ? process.argv[i + 1] : null; })();

// An honest User-Agent. A standing crawler that pretends to be a person is
// harder to defend than one that says who it is and where to complain — and if
// a dealer chooses to block it, that is a signal we want to receive.
const UA = "LotCheckBot/1.0 (+https://lotcheck.ca/about; buyer-side vehicle price verification)";
const PAGE_CAP = 40;          // per section; 24 units/page -> ~960 units
const REQUEST_DELAY_MS = 800; // between page fetches, per dealer
const FETCH_TIMEOUT_MS = 20_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (x) => { const v = Number(x); return Number.isFinite(v) ? v : null; };

// SM360 hands back epoch milliseconds. Anything outside a sane window is a
// system default, not a real date, and must not become a days-on-lot claim.
function entryDate(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 946684800000 || v > 4102444800000) return null;
  return new Date(v).toISOString().slice(0, 10);
}

// One SM360 vehicle -> one row for fn_upsert_listings. Returns null if the unit
// has no valid VIN: a row we cannot key on is worse than no row.
function normalizeSm360(v, section) {
  const check = validateVin(v?.serialNo);
  if (!check.present || !check.valid) return null;
  const list = num(v?.listPrice);
  const sale = num(v?.salePrice);
  return {
    vin: check.vin,
    stock_no: v?.stockNo ?? null,
    year: num(v?.year),
    make: v?.make?.name ?? null,
    model: v?.model?.name ?? null,
    trim: v?.trim?.name ?? null,
    condition: section === "new-inventory" ? "new" : (v?.newVehicle === true ? "new" : "used"),
    odometer_km: num(v?.odometer),
    list_price: list,
    // Some feeds omit salePrice when there is no markdown; fall back to list so
    // "cut to date" reads 0 rather than looking like a giveaway.
    sale_price: sale ?? list,
    date_entry: entryDate(v?.dateEntry),
    days_in_inventory: num(v?.daysInInventory),
    certified: v?.certified === true,
    demo: v?.demo === true,
    damaged: v?.severelyDamagedVehicle === true,
    status: v?.vehicleStatus ?? null,
  };
}

async function fetchPage(host, section, page) {
  const res = await fetch(`${host}/en/${section}/api/listing?page=${page}`, {
    headers: { "User-Agent": UA, Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!/json/.test(res.headers.get("content-type") || "")) throw new Error("non-JSON response");
  return res.json();
}

// Walks every page of one section. Throws on the FIRST page failing (we have
// nothing, so skip the dealer); a later page failing stops pagination but keeps
// what we already have, and reports partial so the caller can skip delisting.
async function crawlSection(host, section) {
  const rows = [];
  let pages = 1, partial = false;
  for (let page = 1; page <= Math.min(pages, PAGE_CAP); page++) {
    let data;
    try {
      data = await fetchPage(host, section, page);
    } catch (e) {
      if (page === 1) throw e;
      console.warn(`    page ${page} failed (${e.message}) — keeping ${rows.length} rows, stopping`);
      partial = true;
      break;
    }
    if (page === 1) pages = num(data?.pagination?.numberOfPages) || 1;
    const vehicles = data?.vehicles || [];
    if (!vehicles.length) break;
    for (const v of vehicles) { const row = normalizeSm360(v, section); if (row) rows.push(row); }
    if (page < Math.min(pages, PAGE_CAP)) await sleep(REQUEST_DELAY_MS);
  }
  if (pages > PAGE_CAP) {
    console.warn(`    ${section}: ${pages} pages exceeds cap ${PAGE_CAP} — crawled ${PAGE_CAP}, rest skipped`);
    partial = true;
  }
  return { rows, partial };
}

async function main() {
  let supabase = null;
  let dealers;

  if (DRY) {
    dealers = HOST_ARG
      ? [{ id: 0, host: HOST_ARG, name: HOST_ARG, sections: ["new-inventory", "used-inventory"] }]
      : [
          { id: 0, host: "https://www.tazaparkvw.com", name: "Taza Park Volkswagen", sections: ["used-inventory"] },
          { id: 0, host: "https://www.infinitinorthcalgary.ca", name: "Infiniti North Calgary", sections: ["used-inventory"] },
        ];
    console.log(`DRY RUN — fetching live feeds, writing nothing.\n`);
  } else {
    const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) { console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (or pass --dry-run)"); process.exit(1); }
    const { createClient } = await import("@supabase/supabase-js");
    supabase = createClient(url, key);
    const { data, error } = await supabase
      .from("dealer_source").select("id,host,name,sections,platform")
      .eq("active", true).eq("platform", "sm360");
    if (error) { console.error("could not read dealer_source:", error.message); process.exit(1); }
    dealers = data || [];
  }

  let totals = { dealers: 0, rows: 0, new: 0, priced: 0, delisted: 0, failed: 0 };

  for (const d of dealers) {
    console.log(`${d.name || d.host}`);
    const seen = [];
    let failed = false, partial = false;

    for (const section of d.sections || ["new-inventory", "used-inventory"]) {
      let result;
      try {
        result = await crawlSection(d.host, section);
      } catch (e) {
        console.warn(`    ${section}: FAILED (${e.message})`);
        failed = true;
        continue;
      }
      partial = partial || result.partial;
      console.log(`    ${section}: ${result.rows.length} units with valid VINs`);
      totals.rows += result.rows.length;

      if (DRY) {
        for (const r of result.rows.slice(0, 3)) {
          const cut = (r.list_price ?? 0) - (r.sale_price ?? 0);
          console.log(`      ${r.vin}  ${r.year} ${r.make} ${r.model} ${r.trim ?? ""} · ${r.days_in_inventory}d since ${r.date_entry ?? "?"} · $${r.list_price}${cut > 0 ? ` -> $${r.sale_price} (cut $${cut})` : ""}`);
        }
        seen.push(...result.rows.map((r) => r.vin));
        continue;
      }

      // Chunked so one dealer's whole lot is not a single oversized payload.
      for (let i = 0; i < result.rows.length; i += 200) {
        const chunk = result.rows.slice(i, i + 200);
        const { data, error } = await supabase.rpc("fn_upsert_listings", { p_dealer_id: d.id, p_rows: chunk });
        if (error) { console.warn(`    upsert failed: ${error.message}`); failed = true; break; }
        totals.new += data?.new || 0;
        totals.priced += data?.price_changes || 0;
      }
      seen.push(...result.rows.map((r) => r.vin));
    }

    if (!DRY) {
      // Only delist after a CLEAN, COMPLETE crawl. A partial or failed run must
      // never be read as "the rest of the lot sold."
      if (!failed && !partial && seen.length) {
        const { data, error } = await supabase.rpc("fn_mark_delisted", { p_dealer_id: d.id, p_seen_vins: seen, p_saw_count: seen.length });
        if (error) console.warn(`    delist failed: ${error.message}`);
        else { totals.delisted += data || 0; if (data) console.log(`    ${data} no longer listed`); }
      } else if (failed || partial) {
        console.log(`    delisting skipped (${failed ? "fetch failed" : "partial crawl"})`);
      }
      await supabase.rpc("fn_record_crawl", { p_dealer_id: d.id, p_ok: !failed, p_error: failed ? "crawl failed" : null });
    }

    if (failed) totals.failed++;
    totals.dealers++;
  }

  console.log(`\n${totals.failed ? "⚠" : "✅"} ${totals.dealers} dealers · ${totals.rows} units · ${totals.new} new · ${totals.priced} price events · ${totals.delisted} delisted · ${totals.failed} failed`);
  if (totals.failed === totals.dealers && totals.dealers > 0) process.exit(1);
}

await main();
