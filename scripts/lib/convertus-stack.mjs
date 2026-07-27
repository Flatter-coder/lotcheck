// ── Convertus VMS dealer-feed scraper (AutoSync / AutoCanada dealers) ───────
// Ford/Nissan/GM dealers on the Convertus ("AutoSync") platform expose their
// inventory — with the manufacturer MSRP AND the full finance/lease rate ladder
// — through a WordPress ajax proxy that forwards to the Convertus VMS API
// (the API host itself 403s a direct hit; the dealer proxy is the way in):
//   {dealer}/wp-content/plugins/convertus-vms/include/php/ajax-vehicles.php
//     ?endpoint={urlenc: https://vms.prod.convertus.rocks/api/filtering/?cp={cp}&…}&action=vms_data
//   -> { results:[ { year, make, model, search_trim, msrp,
//                    finance:[{finance_term, finance_rate}],
//                    lease:[{lease_term, lease_rate}] } ], summary:{total_vehicles} }
// Used for the RATES the manufacturer sites hide (Ford estimate-payment app,
// Nissan gated GraphQL) — run rates-only so it layers on the existing MSRP.
// The per-dealer `cp` id = the page's inventoryId/dealer_id.
import { sleep, writeCatalogs, parseArgs, UA } from "./catalog-io.mjs";

const PC = 50; // vehicles per page
const endpoint = (cp, pg) => `https://vms.prod.convertus.rocks/api/filtering/?cp=${cp}&ln=en&pg=${pg}&pc=${PC}&dc=false&qs=&im=&svs=&sc=new&v1=&st=&ai=&oem=&dp=&in_transit=true&in_stock=true&on_order=true&sn=&view=grid&pnpi=msrp&pnpm=none&pnpf=inte&pupi=msrp&pupm=none&pupf=inte&nnpi=none&nnpm=none&nnpf=none&nupi=none&nupm=none&nupf=none&po=`;

async function fetchPage(host, cp, pg) {
  const url = `${host}/wp-content/plugins/convertus-vms/include/php/ajax-vehicles.php?endpoint=${encodeURIComponent(endpoint(cp, pg))}&action=vms_data`;
  const r = await fetch(url, { headers: { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest", "Referer": `${host}/vehicles/new/` } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  let d = await r.json(); if (d?.data) d = d.data;
  return d;
}

export async function run(cfg) {
  // cfg: { make, dealers:[{host, cp}], ratesOnly }
  const args = parseArgs();
  const today = new Date().toISOString().slice(0, 10);
  const wantMake = cfg.make.toUpperCase();
  const byTrim = new Map();
  const finSeen = new Set(), leaseSeen = new Set();
  const financeRows = [], leaseRows = [];

  for (const { host, cp } of cfg.dealers) {
    let total = PC, pg = 1;
    while ((pg - 1) * PC < total) {
      let d;
      try { d = await fetchPage(host, cp, pg); } catch { break; }
      total = Number(d?.summary?.total_vehicles) || total;
      const veh = d?.results || (Array.isArray(d) ? d : Object.values(d || {}).find(Array.isArray)) || [];
      for (const v of veh) {
        if ((v.make || "").toUpperCase() !== wantMake && !wantMake.startsWith((v.make || "___").toUpperCase())) continue;
        const year = Number(v.year);
        const model = (v.model || "").trim();
        const trim = (v.search_trim || v.trim || "").toString().replace(/<[^>]*>/g, "").trim() || null;
        const msrp = Number(v.msrp);
        if (!year || !model) continue;
        if (args.year && year !== Number(args.year)) continue;

        if (msrp > 0) { const key = `${year}|${model}|${trim}`; const prev = byTrim.get(key); if (!prev || msrp < prev.msrp) byTrim.set(key, { year, make: cfg.make, model, trim, msrp, fuel_type: null, fetched_at: new Date().toISOString() }); }
        for (const f of (Array.isArray(v.finance) ? v.finance : [])) {
          const term = Number(f.finance_term), apr = Number(f.finance_rate);
          const k = `${model}|${term}`;
          if (term && apr > 0 && !finSeen.has(k)) { finSeen.add(k); financeRows.push({ make: cfg.make, model, apr, term_months: term, promo: false, effective_date: today }); }
        }
        for (const l of (Array.isArray(v.lease) ? v.lease : [])) {
          const term = Number(l.lease_term), apr = Number(l.lease_rate);
          const k = `${model}|${term}`;
          if (term && apr > 0 && !leaseSeen.has(k)) {
            leaseSeen.add(k);
            // Track A: capture the inputs the edge fn needs to COMPUTE the
            // payment (money-factor formula). Validated 2026-07-27 against a
            // Denham Ford VDP (2025 Escape 60mo, $0 down): residual base = MSRP,
            // capCost = selling price (lease_initial_price); computed $476/mo vs
            // advertised $484/mo (1.65% — within tolerance), so payment_source
            // = 'computed'. residual is a whole-number % in the feed (e.g. 38).
            const residualPct = Number(l.lease_residual) > 0 ? Number(l.lease_residual) / 100 : null;
            const capCost = Number(l.lease_initial_price) || null; // = negotiated selling price
            const down = Number(l.lease_amount) || null;
            leaseRows.push({
              make: cfg.make, model, apr, term_months: term,
              annual_km: Number(l.lease_km_allowance) || null,
              residual_pct: residualPct, cap_cost: capCost, down_payment: down,
              payment_source: residualPct != null ? "computed" : null,
              effective_date: today,
            });
          }
        }
      }
      await sleep(150);
      pg++;
    }
  }
  const msrpRows = [...byTrim.values()];
  console.log(`[${cfg.make}] ${msrpRows.length} MSRP, ${financeRows.length} finance, ${leaseRows.length} lease rows across ${new Set([...financeRows, ...leaseRows].map(r => r.model)).size} models (Convertus dealer feed${cfg.ratesOnly ? ", rates-only" : ""}).`);
  await writeCatalogs(cfg.make, { msrpRows, financeRows, leaseRows }, { ratesOnly: cfg.ratesOnly });
}
