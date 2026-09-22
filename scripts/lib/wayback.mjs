// The Internet Archive, for model years the manufacturer no longer publishes.
//
// WHY. msrp_catalog holds 1,509 rows for model years 2025-2027 and THREE rows
// for everything older. That is the archived-MSRP gap, and it is why roughly
// three quarters of Alberta's used listings cannot be priced: without knowing
// what a 2016 car cost new, nothing downstream can say anything about it.
//
// Manufacturers delete old model years. The Internet Archive does not.
// hyundaicanada.com/en/showroom/2016/veloster is gone from Hyundai and held by
// the archive, with $18,599 still on it.
//
// WHY THIS SOURCE AND NOT A VENDOR. The archive is a nonprofit library. It has
// no dealer customers, so there is nobody for a dealership to ask to cut us
// off — which is the whole test a data source has to pass here. And a dated
// snapshot is itself the evidence: "this is what the maker published on that
// date" is checkable by anyone, which is what a dispute-proof claim needs.
//
// WHAT THIS MODULE WILL NOT DO. It will not fetch a price. It finds and
// retrieves ARCHIVED PAGES and nothing more; reading a figure off one is the
// caller's job, against the maker's own wording, exactly as a live capture is.
// An archived page is a weaker claim than a live one in one specific way -- it
// was true on a date -- so every caller must carry that date with the figure.

import { politeFetch } from "./polite-fetch.mjs";

/**
 * Did we really read a page, or just the archive's own furniture?
 *
 * A snapshot of a JS shell returns a banner, a nav and nothing else — a few
 * hundred characters. Treating that as "the maker published no price" is the
 * absence-read-as-knowledge shape, so the floor is explicit and testable
 * rather than buried in a fetch helper no offline test can reach.
 */
export function isReadablePage(text) {
  return typeof text === "string" && text.trim().length >= 600;
}

/** Timestamps the archive uses: YYYYMMDDhhmmss. */
const TS = /^\d{14}$/;

// THE MAKER'S OWN SITE, OR NOTHING. The archive holds everything, including
// every marketplace and forum that ever quoted a price. A dealer's or
// aggregator's archived page is not a manufacturer figure and must never be
// catalogued as one -- the same rule that governs a live capture, applied to a
// source where it is far easier to forget.
const NEVER = [
  "autotrader", "kijiji", "cargurus", "facebook", "craigslist", "carpages",
  "clutch.ca", "canadadrives", "carfax", "vinaudit", "edmunds", "kbb",
  "reddit", "forum", "blogspot", "wordpress", "medium.com", "youtube",
  "wikipedia", "pinterest", "twitter", "x.com", "instagram",
];

/** Is this host one we may treat as a manufacturer source? */
export function isManufacturerHost(host) {
  const h = String(host || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  if (!h || !h.includes(".")) return false;
  return !NEVER.some((bad) => h.includes(bad));
}

/**
 * What the archive holds for a URL pattern.
 *
 * `pattern` may end in `*` to match a prefix — "hyundaicanada.com/en/showroom/*".
 * Returns [{ timestamp, original, status }], oldest first, 200s only.
 */
export async function cdxSearch(pattern, opts = {}) {
  const limit = Number.isFinite(opts.limit) ? opts.limit : 200;
  const collapse = opts.collapse === false ? "" : "&collapse=urlkey";
  const from = opts.from ? `&from=${opts.from}` : "";
  const to = opts.to ? `&to=${opts.to}` : "";
  const url = `http://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(pattern)}`
    + `&output=json&limit=${limit}&filter=statuscode:200${collapse}${from}${to}`;

  const res = await politeFetch(url, { timeoutMs: opts.timeoutMs || 45_000 });
  if (!res.ok) throw new Error(`CDX HTTP ${res.status}`);
  const text = await res.text();
  let rows;
  try { rows = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(rows) || rows.length < 2) return [];

  // Row 0 is the header. Read the columns by NAME: the archive has changed
  // their order before, and a positional read would silently return timestamps
  // as URLs.
  const header = rows[0].map((h) => String(h));
  const iTs = header.indexOf("timestamp");
  const iOrig = header.indexOf("original");
  const iStatus = header.indexOf("statuscode");
  if (iTs < 0 || iOrig < 0) return [];

  const out = [];
  for (const r of rows.slice(1)) {
    const timestamp = String(r[iTs] || "");
    const original = String(r[iOrig] || "");
    if (!TS.test(timestamp) || !original) continue;
    if (!isManufacturerHost(original)) continue;
    out.push({ timestamp, original, status: iStatus >= 0 ? String(r[iStatus]) : "200" });
  }
  return out;
}

/** The fetchable URL for one snapshot. `id_` asks for the page as captured. */
export function snapshotUrl(timestamp, original, opts = {}) {
  if (!TS.test(String(timestamp))) return null;
  if (!original) return null;
  const flag = opts.raw ? "id_" : "";
  return `http://web.archive.org/web/${timestamp}${flag}/${original}`;
}

/** The capture date as YYYY-MM-DD, which every figure read from it must carry. */
export function capturedOn(timestamp) {
  const t = String(timestamp || "");
  if (!TS.test(t)) return null;
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
}

/**
 * Fetch one snapshot and return its visible text.
 *
 * Returns null when the archive has no usable copy. Null means "we could not
 * read it" and never "the maker did not publish it" — the distinction this
 * codebase keeps having to re-learn.
 */
export async function fetchSnapshotText(timestamp, original, opts = {}) {
  const url = snapshotUrl(timestamp, original, opts);
  if (!url) return null;
  let res;
  try { res = await politeFetch(url, { timeoutMs: opts.timeoutMs || 45_000 }); }
  catch { return null; }
  if (!res.ok) return null;
  const html = await res.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  return isReadablePage(text) ? text : null;
}

/**
 * The model year a page is ABOUT, read from the text — never from the capture
 * date or the URL folder.
 *
 * scrape-archived-toyota.mjs learned this the hard way: a MY2020 launch is
 * filed under /releases/2019/ because the car goes on sale the autumn before.
 * Taking the folder puts every archived price one year out, in a catalogue
 * whose entire job is to be pinned to a model year.
 *
 * `hint` is the model name; the year must appear beside it.
 */
export function modelYearFromText(text, hint) {
  const t = String(text || "");
  const model = String(hint || "").trim();
  if (!t || !model) return null;
  const esc = model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // "2016 Veloster" or "Veloster 2016", within a few characters of each other.
  const before = new RegExp(`(19|20)\\d{2}(?=[^0-9]{0,12}${esc})`, "i");
  const after = new RegExp(`${esc}[^0-9]{0,12}((?:19|20)\\d{2})`, "i");
  const m = t.match(before) || t.match(after);
  if (!m) return null;
  const year = Number(m[0].match(/(?:19|20)\d{2}/)[0]);
  // A model year outside living memory of a used car is a match on something
  // else — a copyright line, an address, a founding date.
  if (year < 1990 || year > 2030) return null;
  return year;
}
