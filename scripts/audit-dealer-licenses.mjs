// Audits every ACTIVE dealer_source row against a fresh amvic_licensees read
// (Issued only) and deactivates any host without a confirmed license.
//
// WHY THIS EXISTS SEPARATELY FROM THE WRITE-TIME GATE. discover-dealer-feeds.mjs
// only checks a candidate's license at the moment it is FIRST seeded. Three
// dealer_source rows (Taza Park Volkswagen, Infiniti North Calgary, City GM)
// were hand-seeded directly in the 20260811_alberta_inventory.sql migration,
// before that gate — or any AMVIC cross-check at all — existed. A license can
// also lapse after a dealer was seeded. Being crawlable is not being licensed;
// this script is the one place that re-asks the second question on its own,
// independent of when or how a host entered the table.
//
// Alberta law requires an Issued AMVIC facility license to sell vehicles —
// see the license-gate comment in discover-dealer-feeds.mjs for the same
// reasoning. A host with no confirmed Issued license gets `active = false`
// (not deleted — the row and its crawl history stay, in case a lapsed
// license is later reinstated and the same host should resume).
//
// Run (from repo root):
//   node scripts/audit-dealer-licenses.mjs --dry-run   # report only, write nothing
//   node scripts/audit-dealer-licenses.mjs              # deactivates unconfirmed hosts; needs SUPABASE_* env
const DRY = process.argv.includes("--dry-run");

function toOrigin(raw) {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s || /^(mailto:|tel:)/i.test(s)) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)) return null;
    return `https://${u.hostname}`;
  } catch { return null; }
}

async function main() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"); process.exit(1); }
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(url, key);

  const { data: dealers, error: e1 } = await supabase
    .from("dealer_source").select("id,host,name,platform,active").eq("active", true);
  if (e1) { console.error("could not read dealer_source:", e1.message); process.exit(1); }

  const licensees = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("amvic_licensees").select("website,facility_status")
      .not("website", "is", null)
      .range(from, from + PAGE - 1);
    if (error) { console.error("could not read amvic_licensees:", error.message); process.exit(1); }
    licensees.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  const issuedHosts = new Set(
    licensees.filter((r) => /issued/i.test(r.facility_status || ""))
      .map((r) => toOrigin(r.website)).filter(Boolean)
  );

  const confirmed = dealers.filter((d) => issuedHosts.has(d.host));
  const unconfirmed = dealers.filter((d) => !issuedHosts.has(d.host));

  console.log(`${dealers.length} active dealer_source rows checked against ${issuedHosts.size} Issued AMVIC hosts.`);
  console.log(`  ${confirmed.length} confirmed licensed.`);
  console.log(`  ${unconfirmed.length} with NO confirmed Issued license:`);
  for (const d of unconfirmed) {
    console.log(`    id=${d.id}  ${d.host}  (${d.platform})  ${d.name ?? ""}`);
    // DIAGNOSTIC: is this a real absence, or a formatting mismatch (www vs
    // bare, http vs https) between dealer_source.host and the AMVIC website
    // field? Print any amvic_licensees row whose website contains this host's
    // bare domain, whatever its exact formatting or status, so a false
    // "unlicensed" from string mismatch is visible before anyone acts on it.
    const bareDomain = d.host.replace(/^https?:\/\/(www\.)?/i, "");
    const near = licensees.filter((r) => (r.website || "").toLowerCase().includes(bareDomain.toLowerCase()));
    if (near.length) {
      for (const r of near) console.log(`        near-match on file: website="${r.website}" status="${r.facility_status}"`);
    } else {
      console.log(`        no amvic_licensees row contains "${bareDomain}" in its website field at all`);
    }
  }

  if (!unconfirmed.length) { console.log("\nNothing to deactivate."); return; }
  if (DRY) { console.log("\nDRY RUN — nothing deactivated."); return; }

  const { error: e2 } = await supabase.from("dealer_source")
    .update({ active: false }).in("id", unconfirmed.map((d) => d.id));
  if (e2) { console.error("deactivate failed:", e2.message); process.exit(1); }
  console.log(`\nDeactivated ${unconfirmed.length} dealer_source row(s) lacking a confirmed Issued AMVIC license.`);
}

await main();
