// Supabase Edge Function: search-recalls
//
// Powers the free "Recall lookup" tool on /live-price-index. Takes a free-text
// query like "2022 Honda Civic" and returns any matching open recalls from
// Transport Canada's public Vehicle Recall Database (VRDB).
//
//   GET /search-recalls?q=2022%20Honda%20Civic
//
// Response shape is built to match exactly what the page's render(data, q)
// expects (confirmed against the live-price-index.html script, not guessed):
//   {
//     "count": number,                 // total distinct recalls found
//     "match_quality": "exact"         // year+make+model matched as typed
//                    | "no_year"       // no hit for that year; widened across years
//                    | "no_make"       // (reserved) model+year matched a different make
//                    | "model_only",   // only the model was usable
//     "results": [
//       { "title": string,             // recall system, e.g. "Brakes"
//         "vehicle": string,           // "2022 Honda Civic"
//         "detail": string }           // summary snippet · Recall <num> · <date>
//     ]
//   }
//
// The VRDB primitives (base URL, record parsing, timed fetch) now come from
// ../_shared/recalls.ts. They used to be copied into this file -- this header
// said so, in as many words: "lifted from analyze-quote's lookupRecalls()".
// That is how the codebase ended up with four copies, which then drifted.
//
// No secrets required. This function reads a public government API and touches
// no Supabase table, so the injected SUPABASE_URL / SERVICE_ROLE_KEY are unused.

// The three VRDB primitives come from the shared module. This file used to
// declare its own TC_VRDB_BASE, tcRecordToObj and tcFetchJson — the header
// below still says the logic was "lifted from analyze-quote", which is exactly
// how four copies came to exist. What is NOT shared is deliberate: the list and
// detail fetches here answer a different contract (free-text query, year
// widening, page-shaped results), so they stay local rather than being bent to
// fit lookupRecalls.
import { TC_VRDB_BASE, tcRecordToObj, tcFetchJson } from "../_shared/recalls.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const JSON_HEADERS = { ...CORS_HEADERS, "Content-Type": "application/json" };

// HTTP (not HTTPS) on purpose: the Supabase edge runtime (Deno) does not trust
// data.tc.gc.ca's Government-of-Canada TLS certificate ("invalid peer
// certificate: UnknownIssuer"), so an https fetch fails at connect time. The
// endpoint serves the same JSON over plain http with no redirect, which avoids
// the cert problem. Confirmed 2026-07-22 in analyze-quote. Since this is a
// read-only public dataset with no credentials or personal data on the wire,
// plain http here is acceptable.
// Two-word makes we want to keep together when splitting free text. Everything
// else is treated as a single-token make followed by the model.
const TWO_WORD_MAKES = new Set([
  "land rover", "alfa romeo", "aston martin", "general motors",
  "mercedes benz", "mercedes-benz", "rolls royce",
]);

// ── Free-text parsing ───────────────────────────────────────────────────────
// "2022 Honda Civic" -> { year:2022, make:"Honda", model:"Civic" }
// "Honda Civic 2022" -> same (year can lead or trail)
// "Honda Civic"      -> { year:null, make:"Honda", model:"Civic" }
function parseQuery(raw: string): { year: number | null; make: string | null; model: string | null } {
  const cleaned = String(raw || "").trim().replace(/\s+/g, " ");
  if (!cleaned) return { year: null, make: null, model: null };

  const tokens = cleaned.split(" ");
  let year: number | null = null;

  // Pull the first token that looks like a plausible model year (1970–next+1).
  const nextYear = new Date().getUTCFullYear() + 1;
  const yearIdx = tokens.findIndex((t) => /^\d{4}$/.test(t) && Number(t) >= 1970 && Number(t) <= nextYear);
  if (yearIdx !== -1) {
    year = Number(tokens[yearIdx]);
    tokens.splice(yearIdx, 1);
  }

  if (tokens.length === 0) return { year, make: null, model: null };

  // Detect a leading two-word make before falling back to single-token make.
  const firstTwo = (tokens[0] + " " + (tokens[1] || "")).toLowerCase();
  let make: string;
  let modelTokens: string[];
  if (tokens.length >= 2 && TWO_WORD_MAKES.has(firstTwo)) {
    make = tokens.slice(0, 2).join(" ");
    modelTokens = tokens.slice(2);
  } else {
    make = tokens[0];
    modelTokens = tokens.slice(1);
  }

  const model = modelTokens.join(" ") || null;
  return { year, make: titleCase(make), model: model ? titleCase(model) : null };
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── TC VRDB helpers (mirrors analyze-quote) ─────────────────────────────────
// TC dates arrive as "10/19/2023 12:00:00 AM". Trim the time and reformat to a
// friendly "Oct 2023". Manual parse to avoid any runtime timezone surprises.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatRecallDate(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return raw.split(" ")[0] || null;
  const month = Number(m[1]);
  const year = m[3];
  if (month >= 1 && month <= 12) return `${MONTHS[month - 1]} ${year}`;
  return year;
}

// One VRDB list query for a given year range. Returns the distinct recall
// numbers with their dates, or an error the caller can surface honestly.
async function fetchRecallList(
  make: string, model: string, y1: number, y2: number,
): Promise<{ ok: boolean; byNumber?: Map<string, { date: string | null }>; error?: string }> {
  const enc = (s: string) => encodeURIComponent(String(s).trim().toUpperCase());
  const url = `${TC_VRDB_BASE}/recall/make-name/${enc(make)}/model-name/${enc(model)}/year-range/${y1}-${y2}?format=json`;
  const res = await tcFetchJson(url, 12000);
  if (!res.ok) return { ok: false, error: res.error };
  const rows: any[] = res.data?.ResultSet ?? [];
  const byNumber = new Map<string, { date: string | null }>();
  for (const r of rows) {
    const o = tcRecordToObj(r);
    const num = o["Recall number"];
    if (num && !byNumber.has(num)) byNumber.set(num, { date: formatRecallDate(o["Recall date"] || null) });
  }
  return { ok: true, byNumber };
}

// Fetch the human-readable detail for each recall number, in parallel. The
// recall date comes from the list record (reliable — same field the production
// analyze-quote path reads), not from the detail record.
async function fetchRecallDetails(
  items: Array<{ num: string; date: string | null }>, vehicleLabel: string,
): Promise<Array<{ title: string; vehicle: string; detail: string }>> {
  const enc = (s: string) => encodeURIComponent(s);
  return Promise.all(items.map(async ({ num, date }) => {
    const detRes = await tcFetchJson(`${TC_VRDB_BASE}/recall-summary/recall-number/${enc(num)}?format=json`, 12000);
    const o = detRes.ok && detRes.data?.ResultSet?.[0] ? tcRecordToObj(detRes.data.ResultSet[0]) : {};
    const system = (o["SYSTEM_TYPE_ETXT"] || "").trim();
    const comment = (o["COMMENT_ETXT"] || "").replace(/\s+/g, " ").trim();

    const title = system || "Safety recall";
    const bits: string[] = [];
    if (comment) bits.push(comment.length > 160 ? comment.slice(0, 157).trimEnd() + "…" : comment);
    bits.push(`Recall ${num}`);
    if (date) bits.push(date);
    return { title, vehicle: vehicleLabel, detail: bits.join(" · ") };
  }));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const { year, make, model } = parseQuery(q);

  // Without at least a make and a model we can't hit the VRDB endpoint at all.
  // Return an empty result rather than an error so the page shows its clean
  // "no recalls on record" state instead of the scary "search unavailable".
  if (!make || !model) {
    return new Response(
      JSON.stringify({ count: 0, match_quality: "model_only", results: [] }),
      { headers: JSON_HEADERS },
    );
  }

  try {
    const nextYear = new Date().getUTCFullYear() + 1;
    let matchQuality: "exact" | "no_year" | "model_only" = "exact";
    let byNumber = new Map<string, { date: string | null }>();

    if (year) {
      // First try the exact year the user asked for.
      const exact = await fetchRecallList(make, model, year, year);
      if (!exact.ok) {
        return new Response(
          JSON.stringify({ error: "registry_unreachable", detail: exact.error }),
          { status: 502, headers: JSON_HEADERS },
        );
      }
      byNumber = exact.byNumber!;

      // No hit for that specific year -> widen across all years so the buyer
      // still sees whether this model has a recall history. The page shows a
      // "showing wider results" banner when match_quality isn't "exact".
      if (byNumber.size === 0) {
        const wide = await fetchRecallList(make, model, 1970, nextYear);
        if (wide.ok && wide.byNumber!.size > 0) {
          byNumber = wide.byNumber!;
          matchQuality = "no_year";
        }
      }
    } else {
      // No year given: search the whole history. No "exact year" to miss, so
      // this stays "exact" (no widening banner).
      const wide = await fetchRecallList(make, model, 1970, nextYear);
      if (!wide.ok) {
        return new Response(
          JSON.stringify({ error: "registry_unreachable", detail: wide.error }),
          { status: 502, headers: JSON_HEADERS },
        );
      }
      byNumber = wide.byNumber!;
    }

    if (byNumber.size === 0) {
      return new Response(
        JSON.stringify({ count: 0, match_quality: matchQuality, results: [] }),
        { headers: JSON_HEADERS },
      );
    }

    const vehicleLabel = [year, make, model].filter(Boolean).join(" ");
    const items = Array.from(byNumber.entries())
      .slice(0, 8)
      .map(([num, v]) => ({ num, date: v.date }));
    const results = await fetchRecallDetails(items, vehicleLabel);

    return new Response(
      JSON.stringify({ count: byNumber.size, match_quality: matchQuality, results }),
      { headers: JSON_HEADERS },
    );
  } catch (err) {
    console.error("search-recalls error:", err);
    return new Response(
      JSON.stringify({ error: "internal_error" }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
});
