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

// A DOMAIN IS A STRONGER IDENTITY CLAIM THAN A NAME, and the page states more
// than one of them.
//
// 2026-09-12: a real customer report said "No dealer name was confirmed to
// match against AMVIC's public registry" for XPERTS AUTO SALES LTD., whose
// licence B2036047 (Issued, expires Feb-28-2027) was sitting in our own copy of
// the registry the whole time. The listing lives on xpertsautos.com; AMVIC
// records the website as xpertsauto.ca. Host-only matching compared those two,
// found them different, and moved on.
//
// But the PAGE names three domains, not one:
//     xpertsautos.com   the host serving the listing
//     xpertsauto.com    the website printed in its contact block
//     xpertsauto.ca     the domain of sales@xpertsauto.ca
// The third is an EXACT match for the registry's. Collecting every domain a
// page states and comparing each one exactly is therefore enough — no fuzzy
// domain matching, no edit distance, no stripping a trailing "s" and hoping.
// That matters here more than usual: 21 AMVIC rows match "*XPERT*", several in
// Calgary, several expired or closed, so anything loose risks printing
// "AUTO EXPERT LTD. — Expired" against a licensed business. A wrong licence on
// a named dealer is the exposure in [[ai-defamation-entity-match-lesson]];
// an absent one is merely a gap.
export function normHost(raw) {
  const h = String(raw || "")
    .trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")   // scheme
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]
    .replace(/\.$/, "");
  // Reject anything that is not plausibly a registrable domain.
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) ? h : "";
}

// Every domain a listing page claims for its dealer: the host it is served
// from, any website it prints, and the domain of any e-mail address on it.
// Deliberately NOT every link on the page — a rail of manufacturer or finance
// links would drag in domains the dealer does not own.
// A DOMAIN THAT IS NOT THE DEALER'S CANNOT IDENTIFY THE DEALER.
//
// Run against two real pages this function already leaked three: autoshouse.com
// (correct), plus sentry.io from an error-tracker config and domain.com from a
// form placeholder. Neither belongs to the dealer, and identity matching on
// something a dealer merely EMBEDS is how you print someone else's licence.
//
// Free mail is the dangerous half. A small lot really does put @gmail.com on
// its listings, so the domain is real, harvestable — and shared with thousands
// of other businesses. Matching on it would not be a near-miss; it would
// confidently attach whichever AMVIC row happened to list gmail.com to every
// dealer using Gmail. Never identity. [[ai-defamation-entity-match-lesson]]
const NOT_IDENTITY = new Set([
  // free / consumer mail
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.ca", "outlook.com", "live.com",
  "live.ca", "yahoo.com", "yahoo.ca", "ymail.com", "aol.com", "icloud.com", "me.com",
  "shaw.ca", "telus.net", "sympatico.ca", "protonmail.com", "proton.me", "msn.com",
  // placeholders that appear in form markup
  "domain.com", "example.com", "example.org", "email.com", "yourdomain.com", "site.com",
  // vendors a dealer site embeds
  "sentry.io", "google.com", "googleapis.com", "gstatic.com", "facebook.com", "fb.com",
  "cloudflare.com", "jquery.com", "bootstrapcdn.com", "cloudfront.net", "hubspot.com",
  "wordpress.com", "wix.com", "squarespace.com", "godaddy.com", "shopify.com",
]);

export function pageDomains({ sourceUrl, statedWebsites, emails } = {}) {
  const out = new Set();
  const add = (v) => {
    const h = normHost(v);
    if (!h || NOT_IDENTITY.has(h)) return;
    // Also drop a bare two-label public suffix that slipped through.
    if (h.split(".").length < 2) return;
    out.add(h);
  };
  add(sourceUrl);
  for (const w of statedWebsites || []) add(w);
  for (const e of emails || []) {
    const at = String(e || "").split("@")[1];
    if (at) add(at);
  }
  return [...out];
}

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
// Pull the dealer's own domains out of a listing page.
//
// DELIBERATELY NARROW. Harvesting every href would drag in manufacturer sites,
// finance partners, CDNs, analytics and — worst — OTHER dealers linked from a
// rail, and any of those could carry its own AMVIC row. We take only what the
// dealer states about ITSELF:
//   * the host the listing is served from
//   * the domain of any e-mail address printed on the page
//   * a domain written immediately after a "Website:" style label
// The e-mail domain is what rescues the case this was built for: the page for
// a 2017 Model X printed sales@xpertsauto.ca, and xpertsauto.ca is exactly what
// AMVIC holds — while the host it was served from, xpertsautos.com, is not.
export function domainsFromText(text, sourceUrl) {
  const t = String(text || "");
  // m[0], the WHOLE address — pageDomains() splits on "@" itself, so handing it
  // the captured domain made every e-mail silently drop out. Caught only by
  // running this against the real page, and it had removed exactly the evidence
  // this function exists for: the domain that matches AMVIC is an e-mail's.
  const emails = [...t.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)].map((m) => m[0]);
  const stated = [...t.matchAll(/\bweb\s?site\s*[:\-]?\s*((?:https?:\/\/)?(?:www\.)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/gi)].map((m) => m[1]);
  return pageDomains({ sourceUrl, statedWebsites: stated, emails });
}

export function matchLicensee(rows, sig) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const name = sig?.dealerName || "";
  const city = normName(sig?.dealerCity || "").split(" ")[0] || "";
  // Every domain the page claims, not just the one it is served from.
  const hosts = sig?.domains && sig.domains.length
    ? sig.domains.map(normHost).filter(Boolean)
    : [normHost(sig?.website)].filter(Boolean);
  const hostSet = new Set(hosts);
  const rowHost = (r) => normHost(r.website);

  // ---- WEBSITE PATH, ahead of the name --------------------------------------
  // An exact domain match identifies a business more reliably than a storefront
  // name does, and it works when the name is missing entirely — which is the
  // case that produced a blank AMVIC card on a licensed dealer.
  //
  // REFUSES ON AMBIGUITY. If two registry rows claim the same domain we cannot
  // say which one this dealer is, and guessing prints a licence number against
  // a named business. Absent beats wrong. The one exception is the same
  // superseded-record rule the name path uses: several rows for one storefront
  // where exactly one is current is not ambiguity, it is history.
  if (hostSet.size) {
    const byHost = rows.filter((r) => { const h = rowHost(r); return h && hostSet.has(h); });
    if (byHost.length) {
      const liveHost = byHost.filter((r) => classifyStatus(r.facility_status) === "valid");
      if (liveHost.length === 1) {
        return { row: liveHost[0], confidence: 0.99, basis: `website (${rowHost(liveHost[0])}) matches the registry` };
      }
      if (liveHost.length === 0 && byHost.length === 1) {
        return { row: byHost[0], confidence: 0.95, basis: `website (${rowHost(byHost[0])}) matches the registry` };
      }
      // Several current licences on one domain: a group with multiple lots.
      // Only the name can separate them, so fall through rather than pick.
    }
  }

  if (!name) return null;
  const host = hosts[0] || "";

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

  // SUPERSEDED RECORDS -- the most dangerous failure this matcher can have.
  //
  // Dealerships change hands, and the registry KEEPS the old operator's record
  // under the same storefront name. Fish Creek Nissan has three: a 2014 record
  // under a numbered company ("Closed - Voluntarily"), a 2019 one, and the
  // CURRENT operator's licence (Issued to 2027) filed under the combined trade
  // name "FISH CREEK NISSAN/CALGARY N MOTORS LP". Scoring on name alone picks
  // the dead 2014 record -- an exact string match -- and we told a buyer that a
  // licensed, operating dealer was closed (2026-08-11). That is precisely the
  // false, damaging claim this module exists to prevent.
  //
  // The rule: a storefront that holds a CURRENT licence is licensed. Old
  // records for the same storefront are history, not evidence. Combined trade
  // names mean token overlap alone misses the live record, so treat any row
  // whose name CONTAINS the dealer's name as referring to the same storefront.
  const q = normName(name);
  const mentionsQuery = (r) => {
    const legal = normName(r.name || "");
    const trade = r.trade_name && r.trade_name !== "N/A" ? normName(r.trade_name) : "";
    return (legal && legal.includes(q)) || (trade && trade.includes(q));
  };
  const scoreOf = (r) => Math.max(nameScore(name, r.name || ""), r.trade_name && r.trade_name !== "N/A" ? nameScore(name, r.trade_name) : 0);
  const aliases = rows.filter((r) => r === best.row || scoreOf(r) >= 0.72 || mentionsQuery(r));

  // RANK ON THE EVIDENCE, NOT ON ROW ORDER.
  //
  // This used to be `(city ? 2 : 0) + (expiry ? 1 : 0)` — which ignores how well
  // the row's NAME actually matches, so every currently-licensed Calgary row
  // with an expiry date scored identically and `sort()[0]` returned whichever
  // PostgREST happened to hand back first. Measured 2026-09-12 on the real
  // registry: "Auto House" over its 21 real candidates, 200 shuffles of the same
  // rows, produced SEVEN different businesses —
  //     AUTO HOUSE LTD. (correct)      58/200
  //     SUMMIT AUTO HOUSE LTD.         96/200
  //     ELSHAYAT, AHMED                21/200   <- a named individual
  //     CANADA AUTO HOUSE LTD.         16/200
  //     AUTO HOUSE SUNRIDGE / SG        9/200
  // So 71% of the time the card printed a DIFFERENT business's live licence
  // number under "AUTO HOUSE — AMVIC PASS VALID". A real customer report on
  // 2026-09-12 landed on the correct 29% by luck.
  //
  // A wrong licence number attached to a named business is the exposure shape in
  // [[ai-defamation-entity-match-lesson]] — and unlike a missing card, it is a
  // confident false statement. The name score now dominates the ordering, an
  // exact host beats everything, and city/expiry stay as tie-breakers only.
  const rank = (r) =>
    scoreOf(r) * 1000
    + (host && normHost(r.website) === host ? 500 : 0)
    + (city && normName(r.city || "").includes(city) ? 2 : 0)
    + (r.expiry_date ? 1 : 0);
  const live = aliases.filter((r) => classifyStatus(r.facility_status) === "valid");
  if (live.length) {
    // Report the current licence. The card prints the legal name and licence
    // number alongside it, so the buyer can see exactly whose record this is.
    // Sorted on the evidence, then tie-broken on the licence number so the
    // result is identical whatever order the rows arrived in.
    const ordered = live.slice().sort((a, b) =>
      rank(b) - rank(a) || String(a.registration_number || "").localeCompare(String(b.registration_number || "")));
    const chosen = ordered[0];

    // REFUSE WHEN THE EVIDENCE CANNOT SEPARATE TWO BUSINESSES.
    // Deterministic ordering stops the answer changing between runs, but a
    // stable wrong answer is still wrong. If the runner-up is a DIFFERENT legal
    // entity scoring just as well, nothing here identifies which one this dealer
    // is, and printing either attaches a real licence number to the wrong named
    // business. An absent card is a gap; a confident wrong one is a claim.
    // Compared on the RAW name, not normName. normName strips ltd/inc/corp —
    // which is exactly what separates "CITY MOTORS LTD." from "CITY MOTORS
    // INC.", two different companies with two different licence numbers. Using
    // the normalised form here silently declared them the same business and
    // waved the tie through, which is the error this guard exists to stop.
    const rawName = (r) => String(r?.name || "").trim().toLowerCase().replace(/\s+/g, " ");
    const runnerUp = ordered[1];
    if (runnerUp && rawName(runnerUp) !== rawName(chosen)
        && Math.abs(rank(chosen) - rank(runnerUp)) < 1) {
      return null;
    }
    return { row: chosen, confidence: Number(best.score.toFixed(2)), basis: aliases.length > 1 ? "current licence (supersedes older records)" : "name" };
  }

  // No live licence anywhere under this name. Every alias says "not currently
  // licensed"; report the most recent such record rather than the oldest.
  const byRecency = aliases.slice().sort((a, b) => {
    const t = (r) => Date.parse(r.expiry_date || "") || 0;
    return (t(b) - t(a)) || (rank(b) - rank(a));
  });
  const chosen = byRecency[0] || best.row;
  return { row: chosen, confidence: Number(best.score.toFixed(2)), basis: aliases.length > 1 ? "most recent record" : "name" };
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
