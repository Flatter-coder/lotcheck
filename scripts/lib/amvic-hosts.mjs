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
