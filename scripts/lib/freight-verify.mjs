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

import { parseRobots, isPathAllowed } from "./robots.mjs";

// Every status that means THE FIGURE WAS NOT RE-READ, whatever the cause, ours
// or theirs. It is one list because the caller's refusal threshold has to count
// all of them: splitting a status without adding it here is how a threshold gets
// silently loosened by a refactor.
export const NOT_READ = ["unreachable", "blocked", "dead_link", "bad_url", "no_source", "robots_disallowed", "robots_unreachable"];

export const STATUS_NOTE = {
  bad_url: "the stored row carries no usable source URL, so there is nothing to re-read",
  no_source: "the stored row names no source at all",
  unreachable: "we could not reach the manufacturer's page; the stored figure is unchanged and unverified",
  robots_disallowed: "the manufacturer's robots.txt disallows this path for our agent, so we did not fetch it. Their decision; the stored figure is unchanged and unverified.",
  robots_unreachable: "the manufacturer's robots.txt could not be fetched (server error or no answer), which RFC 9309 treats as a full disallow, so we did not fetch the page. The stored figure is unchanged and unverified.",
};

// ── robots.txt, the way RFC 9309 defines honouring it ───────────────────────
// 2xx: obey the rules for our agent. 4xx: the file is "unavailable" and the
// crawler MAY access anything (§2.3.1.3) -- Mazda's API gateway answers 403 for
// every unknown path, robots.txt included. 5xx or no answer: "unreachable",
// which MUST be read as a complete disallow (§2.3.1.4). The inventory crawl is
// stricter (only a 404 counts as "no file") because it reads dealers' sites
// under a legal hold; this job reads manufacturers' own published figures, once
// a day, one request per figure, and the standard is the bar.
export function robotsVerdict(status, text, path) {
  const s = Number(status) || 0;
  if (s >= 200 && s < 300) {
    // Crawl-delay rides along: Stellantis's newsroom asks for 20 seconds.
    const rules = parseRobots(text, "lotcheckbot");
    return isPathAllowed(rules, path) ? { ok: true, crawlDelay: rules.crawlDelay ?? null } : { ok: false, status: "robots_disallowed" };
  }
  if (s >= 400 && s < 500) return { ok: true };
  return { ok: false, status: "robots_unreachable" };
}

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
//
// Nissan Canada's own releases sometimes drop the dollar sign ("Selling Price
// includes CA2,095 freight and PDI"), so a bare CA counts too -- but only in
// front of a comma-grouped figure, so "CA2026" never reads as money. Maserati
// prints "CAD 2,200".
const MONEY = /(?:CAD\s?|CA\$|CA(?=\d{1,3},\d{3})|\$)\s?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,6})(?:\.[0-9]{2})?/g;

// The words a maker prints around this charge. Deliberately broad on the label
// (every maker words it differently) and narrow on the distance to the figure.
const FREIGHT_WORDS = /(freight|destination|delivery and destination|pre[- ]?delivery|\bPDI\b|transport(ation)?\s+charge)/i;

export function moneyNear(text, { within = 160 } = {}) {
  // Markup is not text: Polestar prints "$<strong>2,800</strong> Freight and
  // PDI", and the tag between the sign and the digits hid the figure.
  const t = String(text || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
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

// ── Reading a maker's JSON rather than guessing at its page ─────────────────
// A configurator page is usually an empty shell that JavaScript fills in, so a
// plain GET reads nothing and the row sits at not_stated forever. The same
// numbers arrive as JSON from the maker's own API, where they carry a NAME:
// Hyundai's `delivery`, Mazda's {"title":"Freight","price":1455}. Reading the
// name is exact; reading "a dollar figure near the word freight" is not. [PR #504]

const num = (v) => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

function walk(node, visit) {
  if (Array.isArray(node)) { for (const x of node) walk(x, visit); return; }
  if (node && typeof node === "object") { visit(node); for (const v of Object.values(node)) walk(v, visit); }
}

/** Every number held under a property called `key` (any depth, any case). */
export function numbersAtKey(json, key) {
  const want = String(key).toLowerCase();
  const out = [];
  walk(json, (o) => {
    for (const [k, v] of Object.entries(o)) {
      if (k.toLowerCase() !== want) continue;
      const n = num(v);
      if (n !== null && n > 0) out.push(n);
    }
  });
  return [...new Set(out)];
}

/** Line items shaped {title|name|label, price|amount|value}, by their label. */
export function amountsByLabel(json, labels) {
  const out = Object.fromEntries(Object.keys(labels).map((k) => [k, []]));
  walk(json, (o) => {
    const name = String(o.title ?? o.name ?? o.label ?? "").trim().toLowerCase();
    if (!name) return;
    const n = num(o.price ?? o.amount ?? o.value);
    if (n === null) return;
    for (const [part, label] of Object.entries(labels)) {
      if (name === String(label).toLowerCase() && !out[part].includes(n)) out[part].push(n);
    }
  });
  return out;
}

// A data block a page carries inside its HTML: Infiniti's hidden
// <iframe id="individualVehiclePriceJSON">, Kia's HTML-escaped `"models":[...]`
// arrays (fourteen of them on one build-and-price page, one per model family).
// Returns EVERY block after every occurrence of the marker that parses, so a
// path starts with "*" to walk them; [] when none does.
export function embeddedJson(html, marker, { unescape = false } = {}) {
  let h = String(html || "").replace(/&#34;|&quot;/g, '"').replace(/&amp;/g, "&");
  // Ford ships its data as a JavaScript string: "[{"model":"E-Transit..."
  if (unescape) {
    h = h.replace(/\\x([0-9a-fA-F]{2})/g, (_, x) => String.fromCharCode(parseInt(x, 16)))
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, x) => String.fromCharCode(parseInt(x, 16)));
  }
  const out = [];
  for (let at = h.indexOf(marker); at >= 0; at = h.indexOf(marker, at + 1)) {
    const rel = h.slice(at + marker.length - 1).search(/[{[]/);
    if (rel < 0) break;
    const open = at + marker.length - 1 + rel;
    const close = matchBracket(h, open);
    if (close < 0) continue;
    try { out.push(JSON.parse(h.slice(open, close + 1))); } catch { /* not a clean block here */ }
  }
  return out;
}

function matchBracket(s, open) {
  const oc = s[open], cc = oc === "[" ? "]" : "}";
  let depth = 0, inStr = false, esc = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === oc) depth++;
    else if (c === cc && --depth === 0) return i;
  }
  return -1;
}

// One step down a path, over every node reached so far:
//   "name"            that property
//   "*"               every element of an array / value of an object
//   "model=K4&year=2026"  the array elements whose fields all equal these
function stepInto(nodes, step) {
  if (step === "*") {
    return nodes.flatMap((n) => (Array.isArray(n) ? n : n && typeof n === "object" ? Object.values(n) : []));
  }
  if (step.includes("=")) {
    const conds = step.split("&").map((c) => c.split("="));
    const hit = (el) => el && typeof el === "object" && conds.every(([k, v]) => String(el[k]) === v);
    return nodes.flatMap((n) => (Array.isArray(n) ? n.filter(hit) : hit(n) ? [n] : []));
  }
  return nodes.map((n) => n?.[step]).filter((v) => v !== undefined);
}

// "PDI Charge $250, freight $1,875" -- a maker that prints its two lines in
// prose (Mitsubishi Canada's price guides). Each label must sit directly in
// front of its own dollar figure.
export function labelsInText(text, labels) {
  const t = String(text || "").replace(/\s+/g, " ");
  const out = {};
  for (const [part, label] of Object.entries(labels)) {
    const esc = String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`${esc}\\s*(?:of|:)?\\s*\\$\\s?([0-9]{1,3}(?:,[0-9]{3})*|[0-9]+)(?:\\.[0-9]{2})?`, "gi");
    out[part] = [...new Set([...t.matchAll(re)].map((m) => Number(m[1].replace(/,/g, ""))))];
  }
  return out;
}

// Rivian's builder serialises its data as a flat list of key, value, key,
// value -- "destinationFee",2695,"docFee",300 -- so the figure is simply the
// number that follows the name.
export function numbersAfter(text, marker) {
  const esc = String(marker).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${esc}[^0-9A-Za-z]{0,6}([0-9]+(?:\\.[0-9]+)?)`, "g");
  return [...new Set([...String(text || "").matchAll(re)].map((m) => Number(m[1])))];
}

/**
 * What the source states, read the way the row says to read it.
 *   read.embedded  a data block inside an HTML page, found by a marker
 *   read.path      steps down the JSON to THIS model (see stepInto). VW, Kia
 *                  and Toyota each answer every model in one response; the
 *                  path is what binds a figure to its own model and year
 *   read.key       numbers under that property name
 *   read.labels    {part: label} line items, for a maker that itemises freight
 *                  and PDI as two numbers (with read.text: in prose, not JSON)
 *   read.after     the number that follows a field name in serialised data
 *   read.unescape  the embedded block is a JavaScript string (" for ")
 *   (none)         dollar figures printed near freight/destination/PDI wording
 * Returns { seen } or { parts } or { error }.
 */
export function figuresIn(body, read = {}) {
  if (read.labels && read.text) return { parts: labelsInText(body, read.labels) };
  if (read.after) return { seen: numbersAfter(body, read.after).filter((n) => n >= 900 && n <= 9000) };
  if (!read.path && !read.key && !read.labels && !read.embedded) return { seen: moneyNear(body) };
  let root;
  if (read.embedded) {
    root = embeddedJson(body, read.embedded, { unescape: read.unescape === true });
    if (!root.length) return { error: `the page no longer carries its "${read.embedded}" data block; the stored amount is unchanged and unverified` };
  } else {
    try { root = typeof body === "string" ? JSON.parse(body) : body; }
    catch { return { error: "the source did not answer JSON, so the named field could not be read; the stored amount is unchanged and unverified" }; }
  }
  let nodes = [root];
  for (const step of read.path || []) {
    nodes = stepInto(nodes, step);
    if (!nodes.length) {
      return { error: `the maker's response no longer carries "${(read.path || []).join(" > ")}" -- the model may have left the offer or the feed; nothing is known about its freight and the stored amount is unchanged and unverified` };
    }
  }
  if (read.key) {
    return { seen: [...new Set(nodes.flatMap((n) => numbersAtKey(n, read.key)))].filter((n) => n >= 900 && n <= 9000) };
  }
  if (read.labels) {
    const parts = Object.fromEntries(Object.keys(read.labels).map((k) => [k, []]));
    for (const n of nodes) {
      for (const [k, v] of Object.entries(amountsByLabel(n, read.labels))) for (const x of v) if (!parts[k].includes(x)) parts[k].push(x);
    }
    return { parts };
  }
  return { seen: [...new Set(nodes.flatMap((n) => moneyNear(typeof n === "string" ? n : JSON.stringify(n))))] };
}

const $ = (n) => "$" + Number(n).toLocaleString("en-CA");

// THE DATE A CHANGE WAS FIRST SEEN travels in the stored note, so a figure that
// moved three weeks ago does not read as news every morning, and one that moved
// today is not buried under yesterday's.
const FIRST_READ = /first read (\d{4}-\d{2}-\d{2})/;

/**
 * Compare one catalogue row against the source it cites.
 *
 * Returns { status, seen, note }:
 *   confirmed   the source states the amount we hold
 *   drifted     the source states a DIFFERENT freight figure -- a CHANGE since
 *               the day we captured ours, and the note carries both dates
 *   not_stated  the source loaded but names no freight figure we could read --
 *               NOT evidence the charge changed, only that we did not read it
 *   blocked / dead_link / unreachable / bad_url / no_source / robots_*  -- see NOT_READ
 *
 * `opts.today` is the read date; `opts.previous` is the stored result for this
 * row ({status, note}), which is where a change's first-seen date comes from.
 */
export function verifyRow(row, page, http = null, opts = {}) {
  const src = sourceUrlOf(row?.source_url ?? row?.sourceUrl ?? row?.url);
  if (!src.url) {
    // A row we could not source says WHY, in the catalogue; that reason is the
    // note, so the backlog is a list of answered questions, not blanks.
    const why = row?.unsourced ? `unsourced: ${row.unsourced}` : STATUS_NOTE[src.why];
    return { status: src.why, seen: [], note: why };
  }

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

  const got = figuresIn(page, row?.read || {});
  if (got.error) return { status: "not_stated", seen: [], note: got.error };

  // Itemised makers: each published line is checked against its own number. We
  // never compare our bundle to a figure the maker did not print.
  if (row?.parts && got.parts) {
    const p = got.parts;
    const seen = Object.values(p).flat();
    if (Object.values(p).some((list) => !list.length)) {
      return { status: "not_stated", seen, note: "the maker's response no longer itemises both freight and PDI; the stored amounts are unchanged and unverified" };
    }
    const statedText = Object.entries(p).map(([k, v]) => `${k} ${v.map($).join("/")}`).join(" + ");
    if (Object.keys(row.parts).every((k) => (p[k] || []).includes(Number(row.parts[k])))) {
      return { status: "confirmed", seen, note: `the source states ${statedText}` };
    }
    const heldText = Object.entries(row.parts).map(([k, v]) => `${k} ${$(v)}`).join(" + ");
    return driftNote(row, heldText, statedText, seen, opts);
  }

  const seen = got.seen || [];
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
  if (seen.includes(want)) return { status: "confirmed", seen, note: `the source states ${$(want)}` };
  return driftNote(row, $(want), seen.map($).join(" / "), seen, opts);
}

function driftNote(row, heldText, statedText, seen, { today = new Date().toISOString().slice(0, 10), previous } = {}) {
  const prevFirst = previous?.status === "drifted" ? FIRST_READ.exec(String(previous.note || ""))?.[1] : null;
  const first = prevFirst || today;
  return {
    status: "drifted", seen, firstSeen: first,
    note: `CHANGED: we hold ${heldText}, captured ${row?.capturedOn || "on an unrecorded date"}; `
      + `on ${today} the source states ${statedText} -- first read ${first}. `
      + `Re-read the source and update the row by hand -- this job never rewrites a figure.`,
  };
}

const statusOf = (p) => (typeof p === "string" ? p : p?.status);

/**
 * Which results make the run red.
 *
 * A CHANGE IS RED. Every row with a sourceUrl was read off that exact source on
 * its capturedOn date, so a source that now states a different figure is a
 * change since that date -- not a matcher gap to report in amber and scroll
 * past. That is what this job is for: freight rising quietly is the move nobody
 * announces. It is safe to make red because each source is read by the maker's
 * own field name, or bound to its model by a JSON path, and every one was
 * confirmed by this job before it was committed; a page that loads but says
 * nothing is `not_stated`, never drift. (Until 2026-09-24 drift was red only
 * against a previous confirmed state held in freight_verification -- a table
 * that did not exist in production, so the red path could never fire.)
 *
 * `regressed` still names the rows confirmed on a previous run, so the report
 * can say "this agreed last time".
 */
export function assess(results, { previous = {} } = {}) {
  // A ROW WITH NO URL AND A ROW THAT REFUSED TO LOAD ARE DIFFERENT PROBLEMS.
  // Rows we could not source are a named backlog (each says why, in the
  // catalogue); the refusal threshold is measured only over rows that actually
  // had a page to fetch, because a guard that fires on healthy data the first
  // time it runs gets switched off before it catches anything real.
  const noSource = results.filter((r) => r.status === "no_source" || r.status === "bad_url");
  const attempted = results.filter((r) => !noSource.includes(r));
  const failedToRead = attempted.filter((r) => NOT_READ.includes(r.status));
  const drifted = results.filter((r) => r.status === "drifted");
  const regressed = drifted.filter((d) => statusOf(previous[d.key]) === "confirmed");
  const confirmed = results.filter((r) => r.status === "confirmed");

  // Of the figures we could have checked, did we check most of them? With most
  // of the attempts failing, "no drift" means "nothing was examined".
  const mostlyUnread = attempted.length > 0 && failedToRead.length > attempted.length / 2;

  return {
    confirmed: confirmed.length,
    drifted: drifted.length,
    changed: drifted,
    regressed,
    noSource: noSource.length,
    attempted: attempted.length,
    failedToRead: failedToRead.length,
    total: results.length,
    mostlyUnread,
    red: drifted.length > 0 || mostlyUnread,
  };
}
