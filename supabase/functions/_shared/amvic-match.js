// AMVIC licensee matching (check #11). Plain ES module so it runs in BOTH the
// Deno edge functions and the Node regression suite (same pattern as
// trim-match.js / tradein-detect.js).
//
// DEFAMATION-SAFE CONTRACT (non-negotiable — see memory: defamation-proof-and-
// compliant, make-recalls-fail-safe):
//   * We only assert a licence status on a CONFIDENT match.
//   * A non-match is "unverified", NEVER "unlicensed". Absence of a record is
//     not evidence of anything — the registry is keyed on legal names that
//     often differ from the storefront brand.
//   * The status string is the regulator's own wording, verbatim, never
//     paraphrased into an accusation.

const CORP_WORDS = /\b(inc|incorporated|ltd|limited|llc|llp|corp|corporation|co|company|holdings|enterprises|group|the)\b/g;

export function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.,'"()]/g, " ")
    .replace(CORP_WORDS, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const tokens = (s) => normName(s).split(" ").filter(Boolean);

// Jaccard-ish token overlap, order-independent ("Okotoks Toyota" vs "Toyota of
// Okotoks"), plus a containment bonus for the common "brand + city" pattern.
export function nameScore(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.length || !B.length) return 0;
  const setA = new Set(A), setB = new Set(B);
  const hits = A.filter((t) => setB.has(t)).length;
  const overlap = hits / Math.max(A.length, B.length);
  // "Okotoks Toyota" fully inside "Okotoks Toyota Sales Ltd" is a strong signal
  // even though the longer name dilutes the raw overlap.
  const contained = (A.every((t) => setB.has(t)) || B.every((t) => setA.has(t))) ? 0.15 : 0;
  return Math.min(1, overlap + contained);
}

/**
 * Pick the AMVIC record for a dealer, or return null when we can't be sure.
 * @param {Array} rows candidate rows (name_key/trade_key/city_key/facility_status/...)
 * @param {{dealerName?:string, dealerCity?:string, website?:string}} sig
 * @returns {{row:object, confidence:number, basis:string}|null}
 */
export function matchLicensee(rows, sig) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const name = sig?.dealerName || "";
  if (!name) return null;
  const city = normName(sig?.dealerCity || "").split(" ")[0] || "";
  const host = String(sig?.website || "").replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0].toLowerCase();

  let best = null;
  for (const r of rows) {
    const legal = nameScore(name, r.name || r.name_key || "");
    const trade = r.trade_name && r.trade_name !== "N/A" ? nameScore(name, r.trade_name) : 0;
    let score = Math.max(legal, trade);
    // A matching city is corroboration, not identity — small bump only.
    if (city && normName(r.city || "").includes(city)) score += 0.08;
    // An exact website-host match is the strongest signal the registry offers.
    const rHost = String(r.website || "").replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0].toLowerCase();
    if (host && rHost && host === rHost) score += 0.35;
    if (!best || score > best.score) best = { row: r, score };
  }
  if (!best) return null;

  // Confidence gate. 0.72 was chosen so "Okotoks Toyota" matches "OKOTOKS
  // TOYOTA LTD." but a generic single word ("Auto") can never carry a claim.
  const strongTokens = tokens(name).length >= 2;
  if (best.score < 0.72 || !strongTokens) return null;

  // Ambiguity guard. The thing that actually matters is whether the ANSWER is
  // in doubt, not whether two rows look alike: a registry commonly holds
  // several records for one business (extra locations, renewals), and refusing
  // those made us silently skip real dealers -- Advantage Ford has two
  // identical "ADVANTAGE FORD SALES LTD." rows, both Issued, and we reported
  // nothing (2026-08-11). So: find the near-ties, and only refuse when they
  // disagree about who the business is or what its status is.
  const scoreOf = (r) => Math.max(nameScore(name, r.name || ""), r.trade_name && r.trade_name !== "N/A" ? nameScore(name, r.trade_name) : 0);
  const contenders = rows.filter((r) => r === best.row || best.score - scoreOf(r) < 0.1);
  const sameBusiness = (a, b) => normName(a.name || a.trade_name || "") === normName(b.name || b.trade_name || "");
  const conflicted = contenders.some((r) => !sameBusiness(r, best.row) || classifyStatus(r.facility_status) !== classifyStatus(best.row.facility_status));
  if (conflicted) return null;

  // Same business, same status across every contender -- pick the most useful
  // record: the one whose city matches, else the one that expires latest.
  const rank = (r) => (city && normName(r.city || "").includes(city) ? 2 : 0) + (r.expiry_date ? 1 : 0);
  const chosen = contenders.slice().sort((a, b) => rank(b) - rank(a))[0] || best.row;

  return { row: chosen, confidence: Number(best.score.toFixed(2)), basis: contenders.length > 1 ? "name (multiple records agree)" : "name" };
}

/** Classify the regulator's verbatim status into a report tone. */
export function classifyStatus(status) {
  const s = String(status || "");
  // Statuses observed in the live registry (full pull, 2026-08-10):
  // Issued 8275 | Expired - Required to Reapply 5164 | Closed - Voluntarily 4439
  // | N/A 3662 | Expired 237 | Cancelled by Registrar 75 | Suspended 12
  // | Deceased 3 | Active 1
  if (/^issued|^active/i.test(s)) return "valid";
  if (/suspend|cancel/i.test(s)) return "action";     // regulator took action
  if (/expired/i.test(s)) return "expired";
  if (/closed|deceased/i.test(s)) return "closed";
  return "unknown";                                   // incl. "N/A" -- no claim
}
