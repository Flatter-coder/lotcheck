// Freight + PDI drift detection — the pure half, so it can be tested with no
// network and no database.
//
// WHY THIS EXISTS. Vic, 2026-09-17, looking at a 2026 BMW X3 at BMW Royal Oak:
//
//     MSRP              $60,400.00
//     Freight and PDI    $4,395.00
//
// That is 7.3% of MSRP, and it is $1,625 above the highest freight figure the
// catalogue held for ANY make (Volvo XC60, $2,770) and 2.3x the lowest (Toyota
// RAV4, $1,930). His read was that freight differs drastically between makers
// and nobody is watching it. The catalogue held 11 of 35 makes and had no
// refresh job of any kind.
//
// WHY IT MATTERS MORE THAN A LINE ITEM. In an all-in-pricing province the
// advertised price INCLUDES freight, so an ex-freight MSRP cannot be compared
// against it. Doing exactly that told a buyer a dealer had marked a 4Runner up
// by $3,164 when they had not — freight, A/C, the levies and the retailer admin
// fee were all inside the advertised figure (fixed in PR #492). Freight is the
// largest of those lines, so a freight figure is what turns a refusal into an
// honest comparison.
//
// IT VERIFIES, IT NEVER REWRITES. Drift is reported; no amount is ever
// auto-corrected. A regex confident enough to overwrite a freight charge is
// confident enough to invent one, and an invented freight charge feeds a
// markup accusation about a named dealer. Same posture as warranty-verify.
//
// WE DO NOT ANSWER A 403 BY PRETENDING TO BE CHROME. A manufacturer's site
// declining an identified client is their decision; it is recorded as `blocked`
// and counted, never routed around. [[dealer-tos-daily-checks]]

// Every status that means THE FIGURE WAS NOT RE-READ, whatever the cause, ours
// or theirs. It is one list because the caller's refusal threshold has to count
// all of them: splitting a status without adding it here is how a threshold gets
// silently loosened by a refactor.
export const NOT_READ = ["unreachable", "blocked", "dead_link", "bad_url", "no_source"];

export const STATUS_NOTE = {
  bad_url: "the stored row carries no usable source URL, so there is nothing to re-read",
  no_source: "the stored row names no source at all",
  unreachable: "we could not reach the manufacturer's page; the stored figure is unchanged and unverified",
};

/** A source URL we can actually fetch, or the reason we cannot. */
export function sourceUrlOf(raw) {
  const s = String(raw || "").trim();
  if (!s) return { url: null, why: "no_source" };
  if (!/^https?:\/\//i.test(s)) return { url: null, why: "bad_url" };
  return { url: s, why: null };
}

// Money as printed on a Canadian manufacturer page: $2,195 / $2,195.00 / CA$4,395
// Four digits minimum: freight is never a two-digit number, and matching small
// figures would pull in A/C charges ($100) and tire levies ($20) as if they were
// freight.
const MONEY = /(?:CA)?\$\s?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,6})(?:\.[0-9]{2})?/g;

// The words a maker prints around this charge. Deliberately broad on the label
// (every maker words it differently) and narrow on the distance to the figure.
const FREIGHT_WORDS = /(freight|destination|delivery and destination|pre[- ]?delivery|\bPDI\b|transport(ation)?\s+charge)/i;

export function moneyNear(text, { within = 160 } = {}) {
  const t = String(text || "").replace(/\s+/g, " ");
  const out = [];
  let m;
  const re = new RegExp(FREIGHT_WORDS.source, "gi");
  while ((m = re.exec(t)) !== null) {
    const window = t.slice(Math.max(0, m.index - within), m.index + within);
    MONEY.lastIndex = 0;
    let mm;
    while ((mm = MONEY.exec(window)) !== null) {
      const n = Number(mm[1].replace(/,/g, ""));
      // A plausible Canadian freight charge. Below this it is a levy or an A/C
      // charge; above it, a vehicle price that happened to sit near the word.
      if (n >= 900 && n <= 9000) out.push(n);
    }
  }
  return [...new Set(out)];
}

/**
 * Compare one catalogue row against the page it cites.
 *
 * Returns { status, seen, note }:
 *   confirmed   the page states the amount we hold
 *   drifted     the page states a DIFFERENT freight figure
 *   not_stated  the page loaded but names no freight figure at all -- which is
 *               NOT evidence the charge changed, only that we did not read it
 *   blocked / dead_link / unreachable / bad_url / no_source  -- see NOT_READ
 */
export function verifyRow(row, page, http = null) {
  const src = sourceUrlOf(row?.source_url ?? row?.url);
  if (!src.url) return { status: src.why, seen: [], note: STATUS_NOTE[src.why] };

  if (page == null) {
    const code = Number(http) || 0;
    if (code === 403 || code === 401 || code === 429) {
      return {
        status: "blocked", seen: [],
        note: `the manufacturer's site answered HTTP ${code} to an identified request. The stored figure is unchanged and unverified. This is their refusal, not a broken link.`,
      };
    }
    if (code === 404 || code === 410) {
      return {
        status: "dead_link", seen: [],
        note: `the stored source URL returns HTTP ${code}. The page has moved or gone; the URL needs replacing. Ours to fix.`,
      };
    }
    return { status: "unreachable", seen: [], note: STATUS_NOTE.unreachable };
  }

  const seen = moneyNear(page);
  if (!seen.length) {
    // A SHELL IS NOT A FINDING. A page that loaded but states no freight figure
    // anywhere is evidence we did not read the charge, not that the maker
    // dropped it. Calling that "drifted" is how a verifier earns a reputation
    // for crying wolf and gets switched off.
    return {
      status: "not_stated", seen: [],
      note: "the page loaded but states no freight or PDI figure we could read; the stored amount is unchanged and unverified",
    };
  }

  const want = Number(row?.amount);
  if (seen.includes(want)) {
    return { status: "confirmed", seen, note: `the page states $${want.toLocaleString("en-CA")}` };
  }
  return {
    status: "drifted", seen,
    note: `we hold $${want.toLocaleString("en-CA")}; the page states ${seen.map((n) => "$" + n.toLocaleString("en-CA")).join(" / ")}. Re-read the source and update the row by hand -- this job never rewrites a figure.`,
  };
}

/**
 * Which drift is worth a red run.
 *
 * Only a make we have CONFIRMED before and can no longer confirm. A make that
 * has never been confirmed is a gap in the matcher, not a finding about the
 * manufacturer -- reported loudly every run, and fixed by improving the read.
 * Copied deliberately from warranty-verify, which learned it the hard way: a
 * first probe called three of six makes "drifted" and all three were the
 * flattening of a table, not a change of terms.
 */
export function assess(results, { previous = {} } = {}) {
  // A ROW WITH NO URL AND A ROW THAT REFUSED TO LOAD ARE DIFFERENT PROBLEMS, and
  // counting them together would make this job red on the day it was written --
  // the eleven figures the catalogue already held name a source in prose, not a
  // link, so none of them can be re-read at all. That is a backlog of ours, and
  // it is reported every run with its own count. A threshold that fires on
  // healthy data the first time it runs gets switched off before it ever catches
  // anything real, so the refusal below is measured only over the rows that
  // actually had a page to fetch.
  const noSource = results.filter((r) => r.status === "no_source" || r.status === "bad_url");
  const attempted = results.filter((r) => !noSource.includes(r));
  const failedToRead = attempted.filter((r) => NOT_READ.includes(r.status));
  const drifted = results.filter((r) => r.status === "drifted");
  const regressed = drifted.filter((d) => previous[d.key] === "confirmed");
  const confirmed = results.filter((r) => r.status === "confirmed");

  // Of the figures we could have checked, did we check most of them? With most
  // of the attempts failing, "no drift" means "nothing was examined".
  const mostlyUnread = attempted.length > 0 && failedToRead.length > attempted.length / 2;

  return {
    confirmed: confirmed.length,
    drifted: drifted.length,
    regressed,
    noSource: noSource.length,
    attempted: attempted.length,
    failedToRead: failedToRead.length,
    total: results.length,
    mostlyUnread,
    // A figure that WAS confirmed and no longer is, is a real change in the
    // world. Everything else is reported and stays amber.
    red: regressed.length > 0 || mostlyUnread,
  };
}
