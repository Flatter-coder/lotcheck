// One-off probe: detect SM360 vs Convertus feeds on candidate dealers and
// confirm they carry finance/lease APR. Run: node scripts/probe-dealers.mjs
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const CANDIDATES = {
  Infiniti: ["https://www.infinitinorthcalgary.ca", "https://www.401dixieinfiniti.ca", "https://www.infinitinorthvancouver.ca"],
  Lincoln:  ["https://www.woodridgelincoln.com", "https://www.waterloolincoln.com", "https://northstarlincoln.ca", "https://www.bigmlincoln.ca"],
  GM:       ["https://www.citygm.com", "https://www.gatewaychevrolet.ca", "https://www.steelechev.com", "https://www.capitalchev.ca"],
};

async function trySM360(host) {
  try {
    const r = await fetch(`${host}/en/new-inventory/api/listing?page=1`, { headers: { "User-Agent": UA, Accept: "application/json", "X-Requested-With": "XMLHttpRequest" } });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "";
    if (!/json/.test(ct)) return null;
    const d = await r.json();
    const veh = d?.vehicles || [];
    if (!veh.length) return { platform: "SM360", note: "endpoint ok but 0 vehicles" };
    const withFin = veh.filter(v => Number(v?.paymentOptions?.finance?.term?.apr) > 0).length;
    const withLease = veh.filter(v => Number(v?.paymentOptions?.lease?.term?.apr) > 0).length;
    const makes = [...new Set(veh.map(v => v?.make?.name).filter(Boolean))];
    return { platform: "SM360", vehicles: veh.length, withFin, withLease, makes, pages: d?.pagination?.numberOfPages };
  } catch (e) { return null; }
}

async function tryConvertus(host) {
  // Fetch an inventory page, detect the plugin, extract the cp (dealer/inventory id).
  for (const path of ["/vehicles/new/", "/en/new-inventory/", "/"]) {
    try {
      const r = await fetch(`${host}${path}`, { headers: { "User-Agent": UA } });
      if (!r.ok) continue;
      const html = await r.text();
      if (!/convertus-vms|convertus\.rocks/i.test(html)) continue;
      const m = html.match(/["']?cp["']?\s*[:=]\s*["']?(\d{2,6})/i)
             || html.match(/inventory[_-]?id["']?\s*[:=]\s*["']?(\d{2,6})/i)
             || html.match(/dealer[_-]?id["']?\s*[:=]\s*["']?(\d{2,6})/i);
      const cp = m ? m[1] : null;
      return { platform: "Convertus", cp, note: cp ? `cp=${cp}` : "plugin present, cp not found in HTML" };
    } catch (e) { /* next */ }
  }
  return null;
}

for (const [make, hosts] of Object.entries(CANDIDATES)) {
  console.log(`\n=== ${make} ===`);
  for (const host of hosts) {
    const sm = await trySM360(host);
    const cv = sm ? null : await tryConvertus(host);
    const res = sm || cv;
    console.log(`  ${host}\n    ${res ? JSON.stringify(res) : "no known feed (or blocked)"}`);
  }
}
