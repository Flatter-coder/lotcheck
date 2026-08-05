// ============================================================================
// Transport Canada VRDB recall matching — the SINGLE source of the recall
// lookup logic, imported by analyze-quote and analyze-listing-url (previously
// each carried its own copy, which drifted and hid the "bZ Woodland" bug in two
// places at once). Pure fetch logic, no Supabase dependency, so the regression
// harness (recalls.test.ts) can exercise the exact code that ships.
//
// Tri-state contract (see make-recalls-fail-safe):
//   { checked:false }                      -> registry unreachable
//   { checked:true, count>0, items }       -> open recalls found
//   { checked:true, count:0, confirmed:true }  -> CONFIRMED clean (safe "none open")
//   { checked:true, count:0, confirmed:false } -> zero, but the model never
//        matched TC's records -> UI must say "couldn't confirm", never all-clear.
//
// HTTP (not HTTPS) on purpose: the Supabase edge runtime (Deno) does not trust
// data.tc.gc.ca's Government-of-Canada TLS cert ("UnknownIssuer"), so https
// fails at connect. The endpoint serves the same JSON over http with no
// redirect. Read-only public data, no credentials on the wire. Confirmed
// 2026-07-22. TC quirk: a multi-year range silently DROPS the newest model
// year's recalls, so list queries are single-year and tcModelKnown uses a PAST
// window (year-10..year-1).
// ============================================================================
export const TC_VRDB_BASE = "http://data.tc.gc.ca/v1.3/api/eng/vehicle-recall-database";
export const TC_RECALLS_PAGE = "https://tc.canada.ca/en/road-transportation/defects-recalls-vehicles-tires-child-car-seats";

export function tcRecordToObj(record: any[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (const f of record || []) {
    if (f?.Name) o[f.Name] = f?.Value?.Literal ?? "";
  }
  return o;
}

export async function tcFetchJson(url: string, timeoutMs: number): Promise<{ ok: boolean; data?: any; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// Ordered model strings to try: the resolved base model, the full string, then
// progressively drop trailing (trim) words. Stop at the first TC hit so
// multi-word base models ("Santa Fe", "Grand Highlander") survive.
export function modelCandidates(model: string, baseModel?: string | null): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  const push = (m?: string | null) => { const v = (m || "").trim(); if (v && !seen.has(v.toUpperCase())) { seen.add(v.toUpperCase()); out.push(v); } };
  push(baseModel); push(model);
  const toks = String(model || "").trim().split(/\s+/);
  for (let n = toks.length - 1; n >= 1; n--) push(toks.slice(0, n).join(" "));
  return out;
}

// Does TC recognise this model at all (in the recent past)? Establishes whether
// a count:0 is a genuine clean bill or a name that never matched.
export async function tcModelKnown(make: string, model: string, year: number): Promise<boolean> {
  const enc = (s: string) => encodeURIComponent(String(s).trim().toUpperCase());
  const res = await tcFetchJson(`${TC_VRDB_BASE}/recall/make-name/${enc(make)}/model-name/${enc(model)}/year-range/${year - 10}-${year - 1}?format=json`, 10000);
  return res.ok && (res.data?.ResultSet?.length ?? 0) > 0;
}

export async function lookupRecalls(year: number, make: string, model: string, baseModel?: string | null): Promise<any> {
  try {
    const enc = (s: string) => encodeURIComponent(String(s).trim().toUpperCase());
    const candidates = modelCandidates(model, baseModel);
    let anyOk = false, matchedModel: string | null = null;
    let byNumber = new Map<string, { recallNumber: string; date: string | null }>();
    for (const cand of candidates) {
      const listRes = await tcFetchJson(`${TC_VRDB_BASE}/recall/make-name/${enc(make)}/model-name/${enc(cand)}/year-range/${year}-${year}?format=json`, 12000);
      if (!listRes.ok) continue;
      anyOk = true;
      const m = new Map<string, { recallNumber: string; date: string | null }>();
      for (const r of (listRes.data?.ResultSet ?? [])) {
        const o = tcRecordToObj(r); const num = o["Recall number"];
        if (num && !m.has(num)) m.set(num, { recallNumber: num, date: o["Recall date"] || null });
      }
      if (m.size > 0) { byNumber = m; matchedModel = cand; break; }
    }
    if (!anyOk) { console.warn("Recall lookup unreachable for", make, model); return { checked: false, error: "registry unreachable", source: "Transport Canada VRDB" }; }

    if (byNumber.size > 0) {
      const nums = Array.from(byNumber.keys()).slice(0, 8);
      const items = await Promise.all(nums.map(async (num) => {
        const detRes = await tcFetchJson(`${TC_VRDB_BASE}/recall-summary/recall-number/${encodeURIComponent(num)}?format=json`, 12000);
        const o = detRes.ok && detRes.data?.ResultSet?.[0] ? tcRecordToObj(detRes.data.ResultSet[0]) : {};
        const comment = (o["COMMENT_ETXT"] || "").replace(/\s+/g, " ").trim();
        return { recallNumber: num, date: byNumber.get(num)!.date, system: o["SYSTEM_TYPE_ETXT"] || null,
          unitsAffected: o["UNIT_AFFECTED_NBR"] ? Number(o["UNIT_AFFECTED_NBR"]) : null, summary: comment ? comment.slice(0, 400) : null };
      }));
      return { checked: true, count: byNumber.size, items, confirmed: true, matchedModel, queriedModel: matchedModel, source: "Transport Canada VRDB", sourceUrl: TC_RECALLS_PAGE };
    }

    // count:0 — a negative recall claim is only SAFE if the model is one TC
    // actually tracks. baseModel (resolved canonically) proves that; otherwise
    // try EACH candidate over the wider window, so a trim or renamed nameplate
    // ("bZ Woodland" -> "bZ", which TC knows via the bZ4X history) still confirms
    // clean instead of degrading to an unconfirmed "couldn't check". Only a model
    // TC has never heard of stays confirmed:false. See make-recalls-fail-safe.
    let confirmed = !!baseModel;
    if (!confirmed) { for (const cand of candidates) { if (await tcModelKnown(make, cand, year)) { confirmed = true; break; } } }
    return { checked: true, count: 0, items: [], confirmed, queriedModel: baseModel || model, source: "Transport Canada VRDB", sourceUrl: TC_RECALLS_PAGE };
  } catch (err) {
    console.warn("lookupRecalls threw:", err);
    return { checked: false };
  }
}
