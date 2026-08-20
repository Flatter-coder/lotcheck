// Transport Canada VRDB sweep — the READ half of the daily recall check.
//
// Kept free of Supabase and of process.env so scripts/test-recall-sweep.mjs can
// exercise the exact code that ships against a stub fetch.
//
// ---------------------------------------------------------------------------
// THE TRAP THIS FILE EXISTS TO SURVIVE
// ---------------------------------------------------------------------------
// The VRDB truncates at 25 rows by default, with no ordering guarantee — and
// the response carries no count, no envelope, no "hasMore" flag. Measured
// 2026-08-19:
//
//   /recall/make-name/TOYOTA/year-range/2025-2025      -> 25 rows, 13 recalls
//   ...the same query with &limit=200                  -> 42 rows, 23 recalls
//
// Nine real recalls — RAV4 2026201, CAMRY 2025693, HIGHLANDER 2025694 among
// them — were simply absent from the default response, and nothing in that
// response said so. A daily check built on it would report "no new recalls"
// every morning while sitting on a 43% blind spot, and the buyer-facing
// consequence of that is a false clean bill. Same shape as #240, where the
// AMVIC candidate list was paginated with no ORDER BY.
//
// A wide year-range makes it worse, because there the truncation is invisible
// rather than merely lossy: /year-range/2020-2026 returns 25 rows containing
// only 2020 and 2021, so the newest model years look like they have no recalls
// at all. (The note in supabase/functions/_shared/recalls.ts reads this as "TC
// drops the newest model year". It is not a year rule — it is the page cap.)
//
// So: ask for far more than could exist, and treat "got exactly what I asked
// for" as PROOF OF TRUNCATION rather than proof of completeness.
// ---------------------------------------------------------------------------
export const TC_VRDB_BASE = "http://data.tc.gc.ca/v1.3/api/eng/vehicle-recall-database";

// HTTP, not HTTPS, and the reason is recorded in _shared/recalls.ts: the Deno
// edge runtime does not trust data.tc.gc.ca's GoC certificate chain. Node here
// would accept https, but both callers must agree on one URL or they can
// disagree about what "the registry" said. Read-only public data, no credentials.
export const UA =
  "LotCheck/1.0 (+https://lotcheck.ca) Canadian vehicle recall monitoring; contact vic.todorovic@gmail.com";

// Opening ask. Comfortably above most makes (Toyota: 1,599 rows / 313 recalls),
// but NOT a number to trust on its own — the first live run of this sweep proved
// why. At limit=5000, Ford came back with exactly 5,000 rows: its true size is
// 5,167 rows / 1,343 distinct recalls, so the "safe" number was already too
// small on day one, for the make with the most recalls in Canada.
//
// A fixed limit is therefore a guess with an expiry date — recalls only ever
// accumulate. So the sweep ESCALATES instead of guessing: ask, and if the answer
// exactly fills the ask, ask for far more. Completeness is then something the
// registry demonstrates (a response strictly smaller than what we asked for),
// not something we assume.
export const SWEEP_LIMIT = 5000;
export const SWEEP_LIMIT_MAX = 200000;   // ~39x the largest make today

export function recordToObject(record) {
  const o = {};
  for (const f of record || []) if (f?.Name) o[f.Name] = f?.Value?.Literal ?? "";
  return o;
}

// TC dates arrive as "12/5/2024 12:00:00 AM" (M/D/YYYY). Returns an ISO date or
// null — never a guess, and never today's date as a stand-in, because a wrong
// date here would make an old recall look new on the next diff.
export function parseRecallDate(raw) {
  const m = String(raw || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const mo = Number(m[1]), d = Number(m[2]), y = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// One make's complete recall history, or an explicit refusal — never a partial
// set dressed up as a complete one.
//
// Returns { ok:true, rows:[...], raw_rows:n } on a read we can stand behind, or
// { ok:false, reason, detail } otherwise. There is deliberately no third state:
// a caller cannot accidentally treat a failure as an empty registry, because a
// failure carries no rows array at all.
export async function sweepMake(make, {
  fetchImpl = fetch, limit = SWEEP_LIMIT, maxLimit = SWEEP_LIMIT_MAX, timeoutMs = 30000,
} = {}) {
  let set = null, asked = limit, escalations = 0;

  // Ask, and keep asking bigger while the answer exactly fills the ask. A
  // response strictly smaller than the limit is the registry showing us the end
  // of the list; anything else is us looking at a page edge.
  for (;;) {
    const url = `${TC_VRDB_BASE}/recall/make-name/${encodeURIComponent(String(make).toUpperCase())}` +
                `?format=json&limit=${asked}`;
    let res, body;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      res = await fetchImpl(url, {
        signal: controller.signal,
        headers: { "User-Agent": UA, Accept: "application/json" },
      });
    } catch (e) {
      return { ok: false, reason: "unreachable", detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return { ok: false, reason: "http_error", detail: `HTTP ${res.status}` };
    try { body = await res.json(); }
    catch (e) { return { ok: false, reason: "bad_json", detail: e instanceof Error ? e.message : String(e) }; }

    set = body?.ResultSet;
    if (!Array.isArray(set)) return { ok: false, reason: "bad_shape", detail: "no ResultSet array" };

    if (set.length < asked) break;          // proven complete: the list ended before our ask did

    // THE GUARD. Saturation means the server stopped early and said nothing
    // about it, so we cannot know what is missing.
    if (asked >= maxLimit) {
      return {
        ok: false,
        reason: "truncated",
        detail: `returned ${set.length} rows at limit ${asked} (escalated ${escalations}x); the registry is still capping the response`,
      };
    }
    asked = Math.min(asked * 8, maxLimit);
    escalations++;
  }

  const rows = [];
  for (const rec of set) {
    const o = recordToObject(rec);
    const number = String(o["Recall number"] || "").trim();
    const model = String(o["Model name"] || "").trim();
    const year = Number(o["Year"]);
    if (!number || !model || !Number.isInteger(year)) continue;  // unusable row, not a recall we can key
    rows.push({
      recall_number: number,
      make: String(make),
      tc_make: String(o["Make name"] || "").trim() || null,
      manufacturer: String(o["Manufacturer Name"] || "").trim() || null,
      model,
      year,
      recall_date: parseRecallDate(o["Recall date"]),
    });
  }

  // ZERO IS NEVER A FACT HERE. TC matches the make name as a string, so an
  // unrecognised name returns an empty ResultSet that is indistinguishable from
  // "this manufacturer has never had a recall". Measured 2026-08-19 across all
  // 35 canonical makes: every single one has recalls, the smallest being
  // Polestar at 11. So an empty sweep means the NAME failed, not the registry —
  // and silently accepting it would write "no recalls" for a whole marque.
  if (!rows.length) {
    return {
      ok: false,
      reason: "empty",
      detail: `no usable recall rows for "${make}" — every canonical make has recalls, so this is a name TC does not recognise, not a clean marque`,
    };
  }

  return { ok: true, rows, raw_rows: set.length, asked, escalations };
}

// The tuple that makes a recall actionable for a buyer. One recall number covers
// several models and years, and a buyer only cares about theirs — so the key is
// the intersection, not the recall number alone.
export function recallKey(r) {
  return `${r.recall_number}|${String(r.make).toUpperCase()}|${String(r.model).toUpperCase()}|${r.year}`;
}

export function diffRecalls(fresh, known) {
  const seen = known instanceof Set ? known : new Set((known || []).map(recallKey));
  const added = [];
  for (const r of fresh) if (!seen.has(recallKey(r))) added.push(r);
  return added;
}

// A make that had recalls yesterday and reports zero today has almost certainly
// hit an upstream fault, not had its recalls withdrawn — recalls are not
// retracted in bulk. Same rule the daily APR report runs on: an empty read is an
// ERROR, never a fact. Returns null when the sweep is safe to write.
export function collapseRefusal(make, freshCount, knownCount, { maxCollapsePct = 50 } = {}) {
  if (!knownCount) return null;                      // nothing on file yet, nothing to collapse
  if (freshCount === 0) {
    return `${make}: registry returned 0 recalls but ${knownCount} were on file. ` +
           `Recalls are not withdrawn in bulk — treating this as an upstream fault, not as "no recalls".`;
  }
  const dropPct = ((knownCount - freshCount) / knownCount) * 100;
  if (dropPct > maxCollapsePct) {
    return `${make}: recall count collapsed ${dropPct.toFixed(1)}% (${knownCount} -> ${freshCount}), ` +
           `above the ${maxCollapsePct}% ceiling. Refusing to overwrite.`;
  }
  return null;
}
