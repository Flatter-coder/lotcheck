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
// Per section. City GM's new inventory alone is 60 pages, so the old cap of 40
// silently truncated about a third of the largest lot in the seed — and a big
// lot is exactly where days-on-lot leverage lives, so that is the worst place
// to lose coverage. 150 pages is ~3,600 units at 24/page, comfortably past any
// real Alberta dealer, and the cap stays only as a runaway-pagination backstop.
// Hitting it still marks the crawl partial, which suppresses delisting.
const PAGE_CAP = 150;
const REQUEST_DELAY_MS = 800; // between page fetches, per dealer
const FETCH_TIMEOUT_MS = 20_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (x) => { const v = Number(x); return Number.isFinite(v) ? v : null; };
// Feeds use 0 to mean "not stated" for prices and day counts — a real Ford
// F-150 came back with asking_price 0 and days_on_lot 0. Storing those as
// literal zeros would put a free car and a same-day arrival in the dataset and
// poison every average built on it. Absent is absent.
const pos = (x) => { const v = Number(x); return Number.isFinite(v) && v > 0 ? v : null; };

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
  const list = pos(v?.listPrice);
  const sale = pos(v?.salePrice);
  return {
    vin: check.vin,
    stock_no: v?.stockNo ?? null,
    year: num(v?.year),
    make: v?.make?.name ?? null,
    model: v?.model?.name ?? null,
    trim: v?.trim?.name ?? null,
    condition: section === "new-inventory" ? "new" : (v?.newVehicle === true ? "new" : "used"),
    odometer_km: num(v?.odometer),
    msrp: null,                          // SM360's listing feed states no MSRP
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

// ── Convertus ───────────────────────────────────────────────────────────────
// A WordPress plugin (convertus-vms) that proxies to vms.prod.convertus.rocks.
// The API host 403s a direct hit, so the dealer's own site is the way in — the
// same route scripts/lib/convertus-stack.mjs already uses for rate catalogs.
// Addressed by the dealer's `cp` id (the page's inventoryId), stored in
// dealer_source.platform_id.
//
// Confirmed live 2026-08-11 against two Alberta dealers: 76/76 valid VINs, and
// days_on_lot present on 99 of 100 units.
//
// DELIBERATELY IGNORED: invoice_price and wholesale_price. The names promise
// dealer cost; the data does not deliver it — on Denham Ford's new lot
// invoice_price is populated on every unit and simply mirrors msrp
// ($40,889 vs $40,889). Presenting that as "the dealer's invoice" would be a
// fabricated claim of exactly the kind the report exists to catch. If we ever
// want a cost anchor it has to be sourced, not inferred from a field name.
const CVT_PAGE = 50;
const cvtEndpoint = (cp, pg, sc) =>
  `https://vms.prod.convertus.rocks/api/filtering/?cp=${cp}&ln=en&pg=${pg}&pc=${CVT_PAGE}&dc=false&qs=&im=&svs=&sc=${sc}` +
  `&v1=&st=&ai=&oem=&dp=&in_transit=true&in_stock=true&on_order=true&sn=&view=grid` +
  `&pnpi=msrp&pnpm=none&pnpf=inte&pupi=msrp&pupm=none&pupf=inte&nnpi=none&nnpm=none&nnpf=none&nupi=none&nupm=none&nupf=none&po=`;

async function fetchConvertusPage(host, cp, pg, sc) {
  const url = `${host}/wp-content/plugins/convertus-vms/include/php/ajax-vehicles.php` +
    `?endpoint=${encodeURIComponent(cvtEndpoint(cp, pg, sc))}&action=vms_data`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest", Referer: `${host}/vehicles/${sc}/` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let d = await res.json();
  if (d?.data) d = d.data;
  return d;
}

// Convertus reports days_on_lot but no entry DATE, so we derive one by
// subtracting. That is arithmetic on the dealer's own number, not our estimate —
// but it inherits their precision, so it can only ever be a day-resolution floor.
function entryFromDays(days) {
  const n = pos(days);
  if (n == null || n > 3650) return null;
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

function normalizeConvertus(v, sc) {
  const check = validateVin(v?.vin);
  if (!check.present || !check.valid) return null;
  const strip = (s) => (typeof s === "string" ? s.replace(/<[^>]*>/g, "").trim() : null) || null;
  const asking = pos(v?.asking_price);
  const final = pos(v?.final_price) ?? pos(v?.internet_price) ?? asking;
  const msrp = pos(v?.msrp);
  return {
    vin: check.vin,
    stock_no: v?.stock_number ?? null,
    year: num(v?.year),
    make: v?.make ?? null,
    model: v?.model ?? null,
    trim: strip(v?.search_trim) ?? strip(v?.trim),
    condition: sc === "new" ? "new" : "used",
    odometer_km: num(v?.odometer),
    msrp,
    list_price: asking ?? final,
    sale_price: final ?? asking,
    date_entry: entryFromDays(v?.days_on_lot),
    days_in_inventory: pos(v?.days_on_lot),
    certified: v?.certified === true || v?.certified === 1 || v?.certified === "1",
    demo: v?.demo === true || v?.demo === 1 || v?.demo === "1",
    damaged: null,                       // Convertus states no equivalent — null, never false
    status: v?.in_transit ? "IN_TRANSIT" : (v?.on_order ? "ON_ORDER" : "FOR_SALE"),
  };
}

async function crawlConvertus(host, cp, sc) {
  const rows = [];
  let total = CVT_PAGE, pg = 1, partial = false;
  while ((pg - 1) * CVT_PAGE < total && pg <= PAGE_CAP) {
    let d;
    try {
      d = await fetchConvertusPage(host, cp, pg, sc);
    } catch (e) {
      if (pg === 1) throw e;
      console.warn(`    page ${pg} failed (${e.message}) — keeping ${rows.length} rows, stopping`);
      partial = true;
      break;
    }
    total = num(d?.summary?.total_vehicles) ?? total;
    const results = d?.results || [];
    if (!results.length) break;
    for (const v of results) { const row = normalizeConvertus(v, sc); if (row) rows.push(row); }
    pg++;
    if ((pg - 1) * CVT_PAGE < total) await sleep(REQUEST_DELAY_MS);
  }
  return { rows, partial };
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
      ? [{ id: 0, host: HOST_ARG, name: HOST_ARG, platform: "sm360", sections: ["new-inventory", "used-inventory"] }]
      : [
          { id: 0, host: "https://www.tazaparkvw.com", name: "Taza Park Volkswagen", platform: "sm360", sections: ["used-inventory"] },
          { id: 0, host: "https://www.denhamford.ca", name: "Denham Ford", platform: "convertus", platform_id: "1285", sections: ["new", "used"] },
          { id: 0, host: "https://www.northhillmazda.com", name: "North Hill Mazda", platform: "convertus", platform_id: "2246", sections: ["used"] },
        ];
    console.log(`DRY RUN — fetching live feeds, writing nothing.\n`);
  } else {
    const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) { console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (or pass --dry-run)"); process.exit(1); }
    const { createClient } = await import("@supabase/supabase-js");
    supabase = createClient(url, key);
    let q = supabase
      .from("dealer_source").select("id,host,name,sections,platform,platform_id")
      .eq("active", true).in("platform", ["sm360", "convertus"]);
    // --host re-crawls ONE dealer. Useful after raising a limit or fixing an
    // adapter: no reason to re-walk seven healthy lots to re-read the eighth.
    if (HOST_ARG) q = q.eq("host", HOST_ARG);
    const { data, error } = await q;
    if (error) { console.error("could not read dealer_source:", error.message); process.exit(1); }
    dealers = data || [];
    if (HOST_ARG && !dealers.length) { console.error(`no active dealer matches --host ${HOST_ARG}`); process.exit(1); }
  }

  let totals = { dealers: 0, rows: 0, new: 0, priced: 0, delisted: 0, failed: 0 };

  for (const d of dealers) {
    console.log(`${d.name || d.host}`);
    const seen = [];
    let failed = false, partial = false;

    // Each platform names its sections differently: SM360 uses the URL segment
    // (new-inventory), Convertus uses the sc= param value (new).
    const isCvt = d.platform === "convertus";
    const sections = d.sections?.length ? d.sections : (isCvt ? ["new", "used"] : ["new-inventory", "used-inventory"]);
    if (isCvt && !d.platform_id) { console.warn(`    skipped: convertus dealer with no platform_id (cp)`); totals.failed++; totals.dealers++; continue; }

    for (const section of sections) {
      let result;
      try {
        result = isCvt
          ? await crawlConvertus(d.host, d.platform_id, section)
          : await crawlSection(d.host, section);
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
          const offMsrp = r.msrp && r.sale_price ? r.msrp - r.sale_price : 0;
          const days = r.days_in_inventory != null ? `${r.days_in_inventory}d since ${r.date_entry ?? "?"}` : "days not stated";
          const price = r.sale_price != null ? `$${r.sale_price}` : "price not stated";
          console.log(`      ${r.vin}  ${r.year} ${r.make} ${r.model} ${(r.trim ?? "").slice(0, 28)} · ${days} · ${price}${cut > 0 ? ` (cut $${cut} off own list)` : ""}${offMsrp > 0 ? ` ($${offMsrp} off $${r.msrp} MSRP)` : ""}`);
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
