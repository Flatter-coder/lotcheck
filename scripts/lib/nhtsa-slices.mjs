/* Fetching NHTSA's complaint corpus without being banned, and without mistaking
 * a block for an empty dataset.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY GUARD BELOW EXISTS BECAUSE THE THING IT GUARDS WAS OBSERVED, 2026-09-14.
 *
 * 1. FLAT_CMPL.zip WAS BROKEN FOR UP TO FIFTEEN MONTHS, AND IS STILL REFUSED.
 *    On 2026-09-14 NHTSA's page advertised 354 MB while the object served was
 *    3,225,032 bytes -- 56,997 records ending 1996-10-10, about 1.5% of the
 *    corpus. It had been 340 MB on 2025-05-31 (Wayback) and was rewritten daily
 *    throughout, so the publisher's pipeline reported success on every run while
 *    shipping a truncated file.
 *
 *    REPAIRED 2026-09-15 10:24 GMT: it now serves 371,852,420 bytes, and
 *    COMPLAINTS_RECEIVED_1995-1999.zip was repaired the day before -- 193,122
 *    rows, CMPLID contiguous from 1, covering the full range its name claims.
 *    The 136,125-record hole is closed.
 *
 *    IT STAYS REFUSED ANYWAY. A file that silently served 1.5% of itself for
 *    over a year, daily, without its publisher noticing, has demonstrated that
 *    its health is not something we can read off a successful download. The
 *    seven slices cost one extra request each and carry their own row floors.
 *    A source being healthy today is not a reason to remove the guard that
 *    would have caught it yesterday.
 *
 * 2. A BLOCK IS INDISTINGUISHABLE FROM DATA. Both static.nhtsa.gov and
 *    api.nhtsa.gov sit behind one Akamai property that answers HTTP 403 with
 *    ~500 bytes of text/html -- no 429, no Retry-After, no rate-limit header --
 *    at a .zip URL. A job that streams the response to disk writes an HTML error
 *    page named .zip and parses zero rows. So: content is validated, never the
 *    status code alone.
 *
 * 3. RETRYING EXTENDS THE BAN. After it trips, polite polling at 1 req/5s stayed
 *    403 for 304s and had not recovered; 600s of TOTAL SILENCE cleared it.
 *    Ordinary backoff prolongs the outage it is trying to recover from, so the
 *    first 403 aborts the whole run. [[cost-exploit-guards]]
 *
 * 4. UPSTREAM IS NOT DAILY, WHATEVER IT SAYS. Measured Last-Modified across the
 *    seven slices spanned 2026-08-09 to 2026-09-11 -- one slice 36 days stale
 *    while NHTSA's page claimed daily updates. Freshness is therefore reported
 *    from each slice's own Last-Modified, never from this job's run time.
 *    [[live-data-green-dot]]
 */

import { createHash } from "node:crypto";

export const SLICE_HOST = "https://static.nhtsa.gov/odi/ffdd/cmpl";

/* The seven period files ARE the corpus. Listed explicitly rather than
 * discovered, so a slice silently disappearing upstream fails loudly here
 * instead of quietly shrinking the catalogue. [[catalog-refresh-can-empty-catalog]]
 *
 * minRows is 85% of the count actually PARSED on 2026-09-14, recorded beside it.
 * The first version of these floors was guessed and immediately failed a healthy
 * slice (2000-2004 parsed 289,823 against a guessed floor of 300,000) -- a guard
 * calibrated from imagination cries wolf on day one and gets switched off by
 * day two. The comment carries the observed figure so the next person can
 * re-derive the floor instead of trusting it.
 *
 * Note these count VEHICLE rows -- a parsed row carrying a year, a make and a
 * model. Equipment, tyre and child-seat complaints live in the same file and are
 * not part of this catalogue.
 */
export const SLICES = [
  { name: "COMPLAINTS_RECEIVED_1995-1999", minRows: 46802 },   // read 55,062 on 2026-09-14
  { name: "COMPLAINTS_RECEIVED_2000-2004", minRows: 246349 },   // read 289,823 on 2026-09-14
  { name: "COMPLAINTS_RECEIVED_2005-2009", minRows: 186008 },   // read 218,833 on 2026-09-14
  { name: "COMPLAINTS_RECEIVED_2010-2014", minRows: 323568 },   // read 380,669 on 2026-09-14
  { name: "COMPLAINTS_RECEIVED_2015-2019", minRows: 411314 },   // read 483,899 on 2026-09-14
  { name: "COMPLAINTS_RECEIVED_2020-2024", minRows: 350986 },   // read 412,925 on 2026-09-14
  { name: "COMPLAINTS_RECEIVED_2025-2026", minRows: 160871 },   // read 189,260 on 2026-09-14
];

/* Refused by name, with the reason attached, so nobody re-adds it from the
 * documentation -- which still recommends it.
 */
export const FORBIDDEN_SOURCE = "FLAT_CMPL";
export const FORBIDDEN_REASON =
  "FLAT_CMPL.zip is truncated upstream: NHTSA advertises 354 MB and serves ~3 MB " +
  "(56,997 records ending 1996-10-10). Build from the seven COMPLAINTS_RECEIVED_* slices.";

export class BannedError extends Error {
  constructor(url) {
    super(`NHTSA returned 403 for ${url}. This is the Akamai rate control, not a missing file. ` +
      `ABORTING the run: retrying extends the ban (600s of total silence was required to clear it). ` +
      `No partial catalogue is written.`);
    this.name = "BannedError";
    this.fatal = true;
  }
}

export function assertNotForbidden(name) {
  if (String(name).toUpperCase().includes(FORBIDDEN_SOURCE)) {
    throw new Error(`refusing to read ${name}: ${FORBIDDEN_REASON}`);
  }
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);   // "PK\x03\x04"

/* One slice. Returns {changed:false} on 304 -- the cheap, normal answer.
 *
 * `since` is the Last-Modified this job stored for that slice last time. A quiet
 * day is seven conditional requests and seven 304s: no download, no bandwidth,
 * and almost no exposure to the rate control.
 */
export async function fetchSlice(slice, since, deps = {}) {
  assertNotForbidden(slice.name);
  const fetchFn = deps.fetch || globalThis.fetch;
  const url = `${SLICE_HOST}/${slice.name}.zip`;
  const headers = {
    "User-Agent": deps.userAgent ||
      "LotCheck/1.0 (+https://lotcheck.ca; buyer-side used-vehicle report; contact hello@lotcheck.ca)",
  };
  if (since) headers["If-Modified-Since"] = since;

  const res = await fetchFn(url, { headers, redirect: "follow" });

  if (res.status === 304) return { changed: false, url, lastModified: since };
  if (res.status === 403) throw new BannedError(url);
  if (!res.ok) throw new Error(`${slice.name}: HTTP ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());

  // CONTENT, NOT STATUS. A 403 HTML page can arrive with a 200 from a cache or a
  // proxy, and HEAD on these objects returns no Content-Length, so size cannot
  // be pre-checked. The bytes decide.
  if (!buf.subarray(0, 4).equals(ZIP_MAGIC)) {
    const head = buf.subarray(0, 160).toString("latin1").replace(/\s+/g, " ");
    throw new Error(`${slice.name}: body is not a zip (${buf.length} bytes). ` +
      `A block or an error page served at a .zip URL looks exactly like this: ${head}`);
  }
  return {
    changed: true, url, buf,
    bytes: buf.length,
    lastModified: res.headers.get("last-modified") || null,
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
}

/* Field positions, 0-indexed, from NHTSA's own CMPL.txt record layout. */
export const F = {
  CMPLID: 0, ODINO: 1, MFR: 2, MAKE: 3, MODEL: 4, YEAR: 5,
  CRASH: 6, FAILDATE: 7, FIRE: 8, INJURED: 9, DEATHS: 10,
  COMPDESC: 11, CITY: 12, STATE: 13, VIN: 14, DATEA: 15, LDATE: 16,
  MILES: 17, OCCURRENCES: 18, CDESCR: 19, CMPL_TYPE: 20,
  // Field 46 in NHTSA's numbering. "V" is a vehicle; the same file also
  // carries tyre, equipment and child-seat complaints, which are not this
  // catalogue and would inflate every count if left in.
  PROD_TYPE: 45,
};

export function parseRow(line) {
  const p = line.split("\t");
  if (p.length < 21) return null;
  const year = Number(p[F.YEAR]);
  return {
    odino: p[F.ODINO],
    make: (p[F.MAKE] || "").trim().toUpperCase(),
    model: (p[F.MODEL] || "").trim().toUpperCase(),
    // "MODEL YEAR, 9999 IF UNKNOWN or N/A" -- 9999 is a null, not a year.
    year: year && year !== 9999 && year >= 1900 && year <= 2100 ? year : null,
    crash: p[F.CRASH] === "Y",
    fire: p[F.FIRE] === "Y",
    injured: Number(p[F.INJURED]) || 0,
    deaths: Number(p[F.DEATHS]) || 0,
    system: p[F.COMPDESC],
    cmplType: (p[F.CMPL_TYPE] || "").trim().toUpperCase(),
    descr: p[F.CDESCR] || "",
    prodType: (p[F.PROD_TYPE] || "").trim().toUpperCase(),
  };
}

/* A slice that parses to far fewer rows than it has ever held is a truncation,
 * which is precisely how FLAT_CMPL failed for up to fifteen months without
 * anyone noticing. A floor per slice turns that into a red run.
 */
export function assertSliceSane(slice, rowCount) {
  if (rowCount < slice.minRows) {
    throw new Error(`${slice.name}: parsed ${rowCount.toLocaleString()} rows, floor is ` +
      `${slice.minRows.toLocaleString()}. Upstream truncation looks exactly like this — ` +
      `FLAT_CMPL.zip has been serving 1.5% of its own advertised size since at least 2025. ` +
      `Refusing to rebuild the catalogue from a short file.`);
  }
}
