// ── Shared AMVIC "Issued" host set ───────────────────────────────────────────
//
// Two callers need the same fact -- "which hosts does AMVIC currently list as
// an Issued, licensed-to-sell business" -- and until now each would have had
// to reimplement the read-and-normalize logic itself. That is exactly the
// two-authors-per-fact shape this repo keeps finding defects in: two
// independently-written counts of the same thing drift apart silently and
// nobody notices until the numbers disagree in public. [[two-authors-per-fact]]
//
// scripts/audit-dealer-licenses.mjs used to carry this inline; it now imports
// it from here, and scripts/build-alberta-inventory-daily.mjs uses the exact
// same set for its coverage denominator -- one function, one fact.
export function toOrigin(raw) {
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

// A licensee's display name. AMVIC writes the literal "N/A" where a licensee
// has no trade name; copied verbatim it named five dealer_source rows "N/A",
// printed beside prices in the named comps table.
export function licenseeName(r) {
  const trade = String(r?.trade_name ?? "").trim();
  return (trade && !/^n\/?a$/i.test(trade) ? trade : null) || String(r?.name ?? "").trim() || null;
}

// One entry per host from licensee rows. A website shared by licensees at MORE
// THAN ONE ROOFTOP (a distinct name or city) is a dealer group's site: it has
// no single name or city, so both come back null and `rooftops` says how many.
// Keeping the first licensee instead is how https://www.jpautogroup.com -- the
// Jim Pattison group's site -- was filed as "AUDI EDMONTON NORTH, Edmonton"
// and 2,800 of the group's cars were credited to one Audi store (2026-09-24).
// Two licences with the same name and city (a renewal, a second facility
// number) are still one rooftop.
export function rooftopsByHost(rows, keyOf = toOrigin) {
  const byKey = new Map();
  for (const r of rows || []) {
    const key = keyOf(r?.website);
    if (!key) continue;
    const e = byKey.get(key) || { row: r, licensees: 0, rooftops: new Set() };
    e.licensees++;
    e.rooftops.add(`${String(licenseeName(r) ?? "").toLowerCase()}|${String(r.city ?? "").trim().toLowerCase()}`);
    byKey.set(key, e);
  }
  return new Map([...byKey].map(([key, e]) => {
    const one = e.rooftops.size === 1;
    return [key, { key, row: e.row, licensees: e.licensees, rooftops: e.rooftops.size,
      name: one ? licenseeName(e.row) : null, city: one ? (e.row.city || null) : null }];
  }));
}

/** Every distinct, normalized origin among amvic_licensees rows with facility_status = Issued. */
export async function issuedAmvicHosts(supabase) {
  const licensees = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("amvic_licensees").select("website,facility_status")
      .not("website", "is", null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`could not read amvic_licensees: ${error.message}`);
    licensees.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return new Set(
    licensees.filter((r) => /issued/i.test(r.facility_status || ""))
      .map((r) => toOrigin(r.website)).filter(Boolean)
  );
}
