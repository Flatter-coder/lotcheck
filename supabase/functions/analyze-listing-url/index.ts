// analyze-listing-url
//
// Takes a dealer listing URL (a page like calgaryhyundai.com/inventory/...),
// fetches its real rendered content via Nimble's Extract API (handles
// JavaScript-rendered pricing that a plain fetch would miss -- confirmed
// necessary on real dealer inventory pages, not a hypothetical), then
// analyzes the extracted text with Claude.
//
// Returns the SAME { analysis: {...} } shape as analyze-quote, so
// QuoteCheckPage can render both with the same existing UI -- no new
// results screen needed. Field meanings shift slightly for a listing page
// vs. a formal quote (see the prompt below) but the schema is identical.
//
// Requires two secrets on this function:
// - ANTHROPIC_API_KEY (same key already used by analyze-quote)
// - NIMBLE_API_KEY (from the Nimble Dashboard -- a separate account/key
//   from Claude's own connector access to Nimble; this function calls
//   Nimble's REST API directly and needs its own key)
//
// 2026-07-20 fix: a real dealer listing (centaursubaru.ca, EDealer
// platform) timed out after 20s on vx8, then again on vx10+wait, then
// again on the vx10 retry -- roughly a minute of nothing, confirmed via
// the actual edge function logs ("Nimble extract via vx8 failed: timed
// out after 20000ms"). The SAME url succeeded immediately via BOTH vx6
// and vx8 through a separate Nimble access path, which rules out the
// target site blocking anything and rules out a wrong endpoint/request
// shape -- sdk.nimbleway.com/v1/extract confirmed live and correctly
// routed (returns a clean, fast 401 with no credentials, not a hang).
// That leaves something specific to this account/key's vx8 path being
// slow or queued for reasons not visible from the code itself. Rather
// than chase that further blind, vx6 (cheaper, and now proven twice on
// this exact page) is added as the very first attempt, ahead of vx8 --
// if it keeps working, this class of failure disappears without needing
// to fully explain the vx8 timeout. vx8 and vx10+wait remain as the
// fallback chain, untouched, in case some other site genuinely needs
// them.
//
// 2026-07-22 latency fix: vx6 and vx8 used to run in STRICT SEQUENCE, so
// a JS-heavy dealer page that vx6 can't render (vx6 does no JS rendering)
// cost a full wasted vx6 timeout -- up to 8s of dead air -- BEFORE vx8
// even started. Confirmed the dominant structural cost of a slow scan:
// measured 26.8s total on a live request, most of it before Claude ever
// ran. Fix: race vx6 and vx8 CONCURRENTLY and take the first one that
// returns usable content, so the response is as fast as whichever cheap
// driver actually works, with zero sequential dead time between them.
// vx10 (the expensive JS+stealth driver) is deliberately NOT raced in
// from the start -- it stays a fallback that only fires when both cheap
// drivers genuinely fail, preserving the existing cost tiering. When a
// winner lands, the losing in-flight request is aborted so a race never
// pays for a driver it no longer needs.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const NIMBLE_API_KEY = Deno.env.get("NIMBLE_API_KEY");
const CLAUDE_MODEL = "claude-sonnet-5";

// Per-URL analysis cache TTL. A dealer listing's price/incentives can
// shift, but not minute-to-minute, so a short cache turns repeat scans of
// the same link (re-checks, shared links, popular vehicles) into instant
// responses and avoids re-paying for a Nimble scrape + Claude call. 6h
// balances freshness against hit rate.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

const PRICING_CHANGE_DATE = new Date("2026-09-01T00:00:00Z");
function computeCost(inputTokens: number, outputTokens: number): number {
  const now = new Date();
  const introPricing = now < PRICING_CHANGE_DATE;
  const inputRatePerMillion = introPricing ? 2 : 3;
  const outputRatePerMillion = introPricing ? 10 : 15;
  return (inputTokens * inputRatePerMillion + outputTokens * outputRatePerMillion) / 1_000_000;
}

async function logUsage(fields: {
  success: boolean;
  inputTokens?: number | null;
  outputTokens?: number | null;
  errorMessage?: string | null;
}) {
  try {
    const cost = fields.inputTokens != null && fields.outputTokens != null
      ? computeCost(fields.inputTokens, fields.outputTokens)
      : null;
    const { error } = await supabase.from("api_usage_log").insert({
      feature: "listing_url",
      success: fields.success,
      input_tokens: fields.inputTokens ?? null,
      output_tokens: fields.outputTokens ?? null,
      cost_usd: cost,
      error_message: fields.errorMessage ?? null,
    });
    if (error) console.warn("⚠️ api_usage_log insert failed:", error.message);
  } catch (err) {
    console.warn("⚠️ api_usage_log insert threw:", err);
  }
}

// Same override as analyze-quote: real, LotCheck-owned warranty data takes
// priority over Claude's own-knowledge guess whenever the make is on file.
// Listing pages especially benefit from this, since they rarely state
// warranty terms explicitly and Claude's guess here is doing more work.
async function applyVerifiedWarranty(analysis: any): Promise<void> {
  if (!analysis || analysis.vehicleCondition !== "new" || !analysis.make) return;
  try {
    const { data, error } = await supabase
      .from("manufacturer_warranties")
      .select("basic_coverage, powertrain_coverage, corrosion_coverage, roadside_assistance, hybrid_ev_coverage, source_url")
      .ilike("make", analysis.make)
      .maybeSingle();
    if (error) {
      console.warn("⚠️ manufacturer_warranties lookup failed:", error.message);
      if (analysis.standardWarranty) analysis.standardWarranty.verified = false;
      return;
    }
    if (!data) {
      if (analysis.standardWarranty) analysis.standardWarranty.verified = false;
      return;
    }
    const parts = [`${data.basic_coverage} comprehensive`, `${data.powertrain_coverage} powertrain`];
    if (data.corrosion_coverage) parts.push(`${data.corrosion_coverage} corrosion`);
    analysis.standardWarranty = {
      coverage: parts.join(", "),
      note: `Included at no extra cost with every new ${analysis.make} -- verified against ${analysis.make}'s official Canadian warranty terms, not an AI estimate.`,
      verified: true,
      roadsideAssistance: data.roadside_assistance ?? null,
      hybridEvCoverage: data.hybrid_ev_coverage ?? null,
      sourceUrl: data.source_url,
    };
  } catch (err) {
    console.warn("⚠️ applyVerifiedWarranty threw:", err);
    if (analysis.standardWarranty) analysis.standardWarranty.verified = false;
  }
}

// Fuel type is a fixed fact about a specific year/make/model -- not
// something that should ever need interpreting from a dealer page's own
// text, exactly the same reasoning that already applies to MSRP
// (lookupVerifiedMsrp-equivalent, see analyze-quote) and warranty terms
// (applyVerifiedWarranty just above). Direct motivation: the Gateway
// Toyota C-HR case (2026-07-22), where the page's own "Fuel Type:
// Gasoline" label was flat wrong -- Toyota's own official spec pages
// confirm the 2026 C-HR is a genuine 77-kWh BEV. No prompt wording
// reliably fixes a page that contradicts itself; a verified lookup does,
// the same way msrp_catalog already replaces guessing at MSRP.
//
// Piggybacks on msrp_catalog (same table already planned for MSRP
// verification, extended with a fuel_type column) rather than a separate
// table -- one VinAudit/Black Book backfill populates both. Matches on
// year+make+model only (not trim) since fuel type is a model-level fact,
// not a trim-level one, for the overwhelming majority of vehicles.
//
// Falls back to whatever the page extraction said when there's no
// catalog match -- which is EVERY case right now, since the catalog
// itself has no rows until the VinAudit backfill runs (pending,
// September). Never throws, never blocks the report either way.
async function applyVerifiedFuelType(analysis: any): Promise<void> {
  if (!analysis || !analysis.year || !analysis.make || !analysis.model) return;
  try {
    const { data, error } = await supabase
      .from("msrp_catalog")
      .select("fuel_type")
      .eq("year", analysis.year)
      .ilike("make", analysis.make)
      .ilike("model", analysis.model)
      .not("fuel_type", "is", null)
      .limit(1)
      .maybeSingle();
    if (error) {
      console.warn("⚠️ msrp_catalog fuel_type lookup failed:", error.message);
      analysis.fuelTypeVerified = false;
      return;
    }
    if (!data?.fuel_type) {
      analysis.fuelTypeVerified = false;
      return;
    }
    analysis.fuelType = data.fuel_type;
    analysis.fuelTypeVerified = true;
  } catch (err) {
    console.warn("⚠️ applyVerifiedFuelType threw:", err);
    analysis.fuelTypeVerified = false;
  }
}

// VIN pattern validity check -- a real, deterministic verification with no
// external data and zero false-positive risk. A North American VIN carries
// its own ISO 3779 check digit in position 9, computed from the other 16
// characters; a valid VIN's check digit always reconciles, so a mismatch
// means a typo/transposition on the listing (or a fabricated VIN). Also
// enforces the format rules (17 chars, and I/O/Q are never used). Returns a
// structured result the report can surface as "VIN pattern valid".
function validateVin(vinRaw: any): { present: boolean; valid?: boolean; vin?: string; reason?: string } {
  if (typeof vinRaw !== "string" || !vinRaw.trim()) return { present: false };
  const vin = vinRaw.trim().toUpperCase().replace(/\s+/g, "");
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
    const reason = vin.length !== 17
      ? `A VIN must be 17 characters; this one is ${vin.length}.`
      : `This VIN contains a letter (I, O, or Q) that VINs never use -- likely a mis-read.`;
    return { present: true, valid: false, vin, reason };
  }
  const translit: Record<string, number> = {
    A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:1,K:2,L:3,M:4,N:5,P:7,R:9,S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9,
    "0":0,"1":1,"2":2,"3":3,"4":4,"5":5,"6":6,"7":7,"8":8,"9":9,
  };
  const weights = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += translit[vin[i]] * weights[i];
  const rem = sum % 11;
  const expected = rem === 10 ? "X" : String(rem);
  const actual = vin[8];
  const valid = actual === expected;
  return {
    present: true,
    valid,
    vin,
    reason: valid
      ? "VIN check digit validates -- the number is internally consistent."
      : `VIN check digit doesn't validate (position 9 is "${actual}", should be "${expected}") -- likely a typo or transposed character on the listing. Worth confirming the exact VIN with the dealer.`,
  };
}

// Open-recall lookup against Transport Canada's live Vehicle Recalls
// Database (VRDB) -- the real federal registry, queried at report time,
// NO API key required (confirmed 2026-07-22). This makes the "Open recalls
// (Transport Canada)" stage a genuine check. Two steps: (1) list recalls
// for this exact year/make/model, (2) fetch each recall's affected system +
// plain-language summary. Never throws: any error/timeout yields
// { checked:false } so the report still renders.
// HTTP (not HTTPS) on purpose: the Supabase edge runtime (Deno) does not
// trust data.tc.gc.ca's Government-of-Canada TLS certificate ("invalid peer
// certificate: UnknownIssuer"), so an https fetch fails at connect time. The
// endpoint serves the same JSON over plain http with no redirect, which
// avoids the cert problem. Confirmed 2026-07-22.
const TC_VRDB_BASE = "http://data.tc.gc.ca/v1.3/api/eng/vehicle-recall-database";
const TC_RECALLS_PAGE = "https://tc.canada.ca/en/road-transportation/defects-recalls-vehicles-tires-child-car-seats";

function tcRecordToObj(record: any[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (const f of record || []) {
    if (f?.Name) o[f.Name] = f?.Value?.Literal ?? "";
  }
  return o;
}

async function tcFetchJson(url: string, timeoutMs: number): Promise<{ ok: boolean; data?: any; error?: string }> {
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

async function lookupRecalls(year: number, make: string, model: string): Promise<any> {
  try {
    const enc = (s: string) => encodeURIComponent(String(s).trim().toUpperCase());
    const listUrl = `${TC_VRDB_BASE}/recall/make-name/${enc(make)}/model-name/${enc(model)}/year-range/${year}-${year}?format=json`;
    const listRes = await tcFetchJson(listUrl, 12000);
    // Unreachable registry must NOT masquerade as "no recalls" -- report it
    // honestly so the UI can say "couldn't verify" instead of a false all-clear.
    if (!listRes.ok) {
      console.warn("Recall list fetch failed:", listRes.error, listUrl);
      return { checked: false, error: listRes.error, source: "Transport Canada VRDB" };
    }
    const rows: any[] = listRes.data?.ResultSet ?? [];
    const byNumber = new Map<string, { recallNumber: string; date: string | null }>();
    for (const r of rows) {
      const o = tcRecordToObj(r);
      const num = o["Recall number"];
      if (num && !byNumber.has(num)) byNumber.set(num, { recallNumber: num, date: o["Recall date"] || null });
    }
    if (byNumber.size === 0) {
      return { checked: true, count: 0, items: [], source: "Transport Canada VRDB", sourceUrl: TC_RECALLS_PAGE };
    }
    // Detail (affected system + summary) for up to 8 recalls, in parallel.
    const nums = Array.from(byNumber.keys()).slice(0, 8);
    const items = await Promise.all(nums.map(async (num) => {
      const detRes = await tcFetchJson(`${TC_VRDB_BASE}/recall-summary/recall-number/${encodeURIComponent(num)}?format=json`, 12000);
      const o = detRes.ok && detRes.data?.ResultSet?.[0] ? tcRecordToObj(detRes.data.ResultSet[0]) : {};
      const comment = (o["COMMENT_ETXT"] || "").replace(/\s+/g, " ").trim();
      return {
        recallNumber: num,
        date: byNumber.get(num)!.date,
        system: o["SYSTEM_TYPE_ETXT"] || null,
        unitsAffected: o["UNIT_AFFECTED_NBR"] ? Number(o["UNIT_AFFECTED_NBR"]) : null,
        summary: comment ? comment.slice(0, 400) : null,
      };
    }));
    return { checked: true, count: byNumber.size, items, source: "Transport Canada VRDB", sourceUrl: TC_RECALLS_PAGE };
  } catch (err) {
    console.warn("lookupRecalls threw:", err);
    return { checked: false };
  }
}

// Financing math check: reconcile the dealer's OWN disclosed payment stream
// against the stated total obligation. Deliberately conservative to avoid
// false flags -- it only calls a quote "inconsistent" when the gap is bigger
// than Canadian sales tax could explain (payment is often captured before
// tax while the total is tax-included, a legitimate ~5-15% gap). No external
// data. Sets analysis.financingCheck.
function computeFinancingCheck(analysis: any): void {
  const f = analysis?.financing;
  if (!f || typeof f !== "object") return;
  const pay = Number(f.paymentAmount);
  const term = Number(f.termMonths);
  const total = Number(f.totalObligation);
  const freq = f.paymentFrequency;
  const perYear = freq === "weekly" ? 52 : freq === "biweekly" ? 26 : freq === "monthly" ? 12 : null;
  if (!pay || !term || !total || !perYear) return; // not enough disclosed to check
  const nPayments = Math.round((term / 12) * perYear);
  const expected = pay * nPayments;
  if (expected <= 0) return;
  const ratio = total / expected;
  let consistent: boolean;
  let note: string;
  if (ratio >= 0.98 && ratio <= 1.02) {
    consistent = true;
    note = `${nPayments} ${freq} payments of $${pay.toLocaleString()} total about $${Math.round(expected).toLocaleString()}, matching the disclosed total obligation of $${total.toLocaleString()}.`;
  } else if (ratio > 1.02 && ratio <= 1.16) {
    consistent = true;
    note = `${nPayments} payments of $${pay.toLocaleString()} (about $${Math.round(expected).toLocaleString()} before tax) reconcile with the disclosed total of $${total.toLocaleString()} once sales tax is added.`;
  } else {
    consistent = false;
    const dir = ratio < 1 ? "less than" : "more than";
    note = `The disclosed total obligation ($${total.toLocaleString()}) is ${dir} ${nPayments} payments of $${pay.toLocaleString()} (about $${Math.round(expected).toLocaleString()}) by more than sales tax explains — worth asking the dealer to reconcile these numbers.`;
  }
  analysis.financingCheck = {
    checked: true,
    consistent,
    disclosedTotalObligation: total,
    computedFromPayments: Math.round(expected),
    paymentsCounted: nPayments,
    note,
  };
}

// Odometer plausibility check: compares the stated mileage against what's
// typical for the vehicle's age (Canadian average ~20,000 km/year). Its real
// value is catching the classic odometer-rollback red flag -- mileage that is
// implausibly LOW for the age -- and flagging a "new" listing that shows more
// than delivery distance. No external data. Sets analysis.odometerCheck.
function computeOdometerCheck(analysis: any): void {
  const km = Number(analysis.odometerKm);
  const year = Number(analysis.year);
  if (!year || !Number.isFinite(km) || km < 0) return;
  const nowYear = new Date().getUTCFullYear();
  const age = Math.max(0, nowYear - year);
  const isNew = analysis.vehicleCondition === "new";
  let flag = false;
  let note: string;
  if (isNew || age <= 0) {
    if (km <= 500) {
      note = `${km.toLocaleString()} km — consistent with a new vehicle (delivery/demo distance).`;
    } else {
      flag = true;
      note = `Listed as new but shows ${km.toLocaleString()} km — more than typical delivery distance. Ask whether it was a demo or loaner, which can affect the warranty start date and the price.`;
    }
  } else {
    const typical = age * 20000;
    const low = age * 10000;
    if (km < low * 0.6) {
      flag = true;
      note = `${km.toLocaleString()} km is unusually low for a ${age}-year-old vehicle (typical is around ${typical.toLocaleString()} km). Low mileage is a genuine selling point — but confirm it against a VIN history report, since implausibly low mileage is also the classic sign of an odometer rollback.`;
    } else if (km > age * 30000) {
      note = `${km.toLocaleString()} km is higher than average for its age (typical is around ${typical.toLocaleString()} km) — factor the extra wear and reduced remaining warranty into the price.`;
    } else {
      note = `${km.toLocaleString()} km is in the normal range for a ${age}-year-old vehicle (typical is around ${typical.toLocaleString()} km).`;
    }
  }
  analysis.odometerCheck = { checked: true, km, flag, note };
}

// Negotiation leverage score (0-10): a transparent, DETERMINISTIC function of
// the verified findings already on the report -- never an AI guess or a
// random number (which is exactly what the welcome page promises: "computed
// from verified findings only"). Starts near zero (a clean deal gives a
// buyer little to push on) and adds weight for each documented problem:
// price over MSRP, flagged fees, open recalls, financing that doesn't
// reconcile. The `basis` array lists precisely what drove the number so it's
// fully traceable. Must run AFTER msrp/recalls/financing are populated.
function computeLeverageScore(analysis: any): void {
  const basis: string[] = [];
  let score = 2.0; // a clean, fair deal has little documented leverage

  const msrp = Number(analysis.msrp) || null;
  const quoted = Number(analysis.quotedPrice) || null;
  if (msrp && quoted) {
    const deltaPct = (quoted - msrp) / msrp;
    if (deltaPct > 0.005) {
      score += Math.min(2.5, deltaPct * 100 * 0.3);
      basis.push(`priced $${Math.round(quoted - msrp).toLocaleString()} over MSRP`);
    } else if (deltaPct < -0.02) {
      score -= 1.0;
      basis.push(`already priced below MSRP`);
    }
  }
  const flagged = Number(analysis.totalFlaggedCost) || 0;
  if (flagged > 0) {
    score += Math.min(2.0, flagged / 1000);
    basis.push(`$${flagged.toLocaleString()} in flagged fees`);
  }
  const rc = analysis.recalls;
  if (rc?.checked && rc.count > 0) {
    score += Math.min(2.0, rc.count * 0.7);
    basis.push(`${rc.count} open Transport Canada recall${rc.count > 1 ? "s" : ""}`);
  }
  if (analysis.financingCheck?.checked && analysis.financingCheck.consistent === false) {
    score += 1.0;
    basis.push(`financing numbers that don't reconcile`);
  }

  score = Math.max(0, Math.min(10, Math.round(score * 10) / 10));
  analysis.leverageScore = {
    score,
    computed: true,
    basis,
    note: basis.length
      ? `Computed only from the verified findings above (${basis.join("; ")}) — not an opinion.`
      : `No pricing red flags, flagged fees, or open recalls surfaced, so this report alone gives limited documented leverage.`,
  };
}

// Fast, authoritative MSRP path: look the vehicle up in msrp_catalog
// (year/make/model/trim) BEFORE ever paying for the slow manufacturer-site
// scrape. When the catalog has the row this is a single ~10ms DB read
// instead of a ~30s search+extract+Claude round trip -- the same
// verified-source-over-guessing principle already behind
// applyVerifiedFuelType. Returns null (never throws) on any miss, so the
// manufacturer fallback still runs.
//
// Trim matching is deliberately conservative: MSRP varies a lot by trim
// (e.g. CX-5 GX $36,300 vs GT Premium $46,700), so a wrong-trim match is
// worse than no match. It only accepts an UNAMBIGUOUS hit -- an exact
// normalized trim match, or a single containment match -- never a guess
// across trims.
async function lookupCatalogMsrp(
  year: number,
  make: string,
  model: string,
  trim: string | null,
): Promise<number | null> {
  try {
    const { data, error } = await supabase
      .from("msrp_catalog")
      .select("trim, msrp")
      .eq("year", year)
      .ilike("make", make)
      .ilike("model", model)
      .not("msrp", "is", null);
    if (error) {
      console.warn("⚠️ msrp_catalog MSRP lookup failed:", error.message);
      return null;
    }
    const rows = (data ?? []).filter((r: any) => r.msrp != null && !isNaN(Number(r.msrp)));
    if (rows.length === 0) return null;
    const num = (r: any) => Number(r.msrp);

    // Only one row for this year/make/model and no trim to disambiguate --
    // safe to use it directly.
    if (rows.length === 1 && !trim) return num(rows[0]);

    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const want = trim ? norm(trim) : "";

    // 1) exact normalized trim match
    let hits = want ? rows.filter((r: any) => r.trim && norm(r.trim) === want) : [];
    // 2) otherwise containment either direction (dealer "GT Premium" vs
    //    catalog "GT (Premium Package)") -- accepted only if it lands on
    //    exactly one row, never an ambiguous set.
    if (hits.length === 0 && want) {
      hits = rows.filter((r: any) => r.trim && (norm(r.trim).includes(want) || want.includes(norm(r.trim))));
    }
    if (hits.length === 1) {
      const v = num(hits[0]);
      console.log(`Catalog MSRP hit: ${year} ${make} ${model} ${trim ?? ""} -> ${v}`);
      return v;
    }
    console.log(`Catalog MSRP: ${rows.length} row(s) for ${year} ${make} ${model} but no unambiguous trim match for "${trim ?? ""}" -- deferring to manufacturer fallback.`);
    return null;
  } catch (err) {
    console.warn("lookupCatalogMsrp threw:", err);
    return null;
  }
}

// Small, curated map of manufacturer -> official Canadian site domain.
// Used to restrict the manufacturer-site MSRP fallback lookup to a
// trustworthy, authoritative source only -- never a random blog or a
// different dealer's page. Started with Honda, Toyota, Nissan (2026-07-
// 22); expanded same day to the full A-Z list of Canadian manufacturer
// domains Vic provided. A make not in this list just means the fallback
// quietly doesn't fire for that manufacturer -- never an error. A couple
// of common alternate spellings (e.g. "mercedes") are included alongside
// the canonical make name, since it's not certain which form the page
// extraction will produce for every listing.
const MANUFACTURER_DOMAINS: Record<string, string> = {
  acura: "acura.ca",
  "alfa romeo": "alfaromeo.ca",
  "aston martin": "astonmartin.com",
  audi: "audi.ca",
  bentley: "bentleymotors.com",
  bmw: "bmw.ca",
  buick: "buick.ca",
  cadillac: "cadillac.ca",
  chevrolet: "chevrolet.ca",
  chrysler: "chrysler.ca",
  dodge: "dodge.ca",
  ferrari: "ferrari.com",
  fiat: "fiatcanada.com",
  ford: "ford.ca",
  genesis: "genesis.ca",
  gmc: "gmccanada.ca",
  honda: "honda.ca",
  hyundai: "hyundaicanada.com",
  infiniti: "infiniti.ca",
  jaguar: "jaguar.ca",
  jeep: "jeep.ca",
  kia: "kia.ca",
  lamborghini: "lamborghini.com",
  "land rover": "landrover.ca",
  lexus: "lexus.ca",
  lincoln: "lincolncanada.com",
  lotus: "lotuscars.com",
  maserati: "maserati.ca",
  mazda: "mazda.ca",
  mclaren: "cars.mclaren.com",
  "mercedes-benz": "mercedes-benz.ca",
  mercedes: "mercedes-benz.ca",
  mini: "mini.ca",
  mitsubishi: "mitsubishi-motors.ca",
  nissan: "nissan.ca",
  polestar: "polestar.com",
  porsche: "porsche.com",
  ram: "ramtruck.ca",
  "ram trucks": "ramtruck.ca",
  rivian: "rivian.com",
  "rolls-royce": "rolls-roycemotorcars.com",
  subaru: "subaru.ca",
  tesla: "tesla.com",
  toyota: "toyota.ca",
  volkswagen: "vw.ca",
  vw: "vw.ca",
  volvo: "volvocars.com",
};


// Fallback MSRP source: only called when the dealer's own page genuinely
// didn't disclose an MSRP at all -- confirmed real case, Calgary Honda
// Civic listing, "MSRP: Not shown on quote" / "Quoted price: Not found".
// Rather than give up, search the manufacturer's OWN official Canadian
// site for this exact year/make/model/trim and extract MSRP from
// whatever real page comes back -- the same "verified source over a
// page that might not have the answer" reasoning already behind
// msrp_catalog, just usable TODAY instead of waiting on a September
// data backfill.
//
// Uses Nimble's Search API (https://sdk.nimbleway.com/v1/search) --
// same NIMBLE_API_KEY already configured for this function, a different
// endpoint from the /v1/extract already used for dealer pages.
// include_domains locks results to that one manufacturer's own domain;
// deep_search:true means the actual page content comes back in this
// same call, no separate fetch step needed.
//
// Returns null (never throws) if the manufacturer isn't in the small
// curated list yet, the search comes up empty, or Claude can't find a
// clear MSRP for this exact trim in whatever content comes back -- this
// is a best-effort fallback, never a required step, and should never be
// the reason a report fails.
async function lookupManufacturerMsrp(
  year: number,
  make: string,
  model: string,
  trim: string | null,
): Promise<number | null> {
  const domain = MANUFACTURER_DOMAINS[make.toLowerCase()];
  if (!domain || !NIMBLE_API_KEY || !ANTHROPIC_API_KEY) {
    console.log(
      `Manufacturer MSRP lookup skipped for "${make}": ` +
        `domain=${domain ?? "none (not in MANUFACTURER_DOMAINS)"}, ` +
        `NIMBLE_API_KEY=${NIMBLE_API_KEY ? "set" : "MISSING"}, ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY ? "set" : "MISSING"}`,
    );
    return null;
  }

  console.log(`Manufacturer MSRP lookup starting: ${year} ${make} ${model} ${trim ?? ""} via ${domain}`);

  // Same timeout/wait values as fetchListingContent's TIMEOUT_MS/
  // VX10_WAIT_MS below (kept as separate local constants rather than a
  // larger refactor of that function's scoping -- same reasoning: 30s
  // per attempt, bounded well under Supabase's 150s per-request ceiling).
  const MFR_TIMEOUT_MS = 30_000;
  const MFR_VX10_WAIT_MS = 6_000;

  try {
    // Step 1: cheap search, purely to find the right URL. Confirmed via
    // direct testing (2026-07-22) that manufacturer build-and-price/
    // Confirmed via direct testing (2026-07-22) that "build and price"/
    // configurator tools fail to yield usable content across MULTIPLE
    // manufacturers -- Honda's "configure" AND "trims" pages, Toyota's
    // "build-price" tool all returned zero usable content even with full
    // JS rendering -- while a Mazda PRESS RELEASE worked cleanly on the
    // first try. This is a real, consistent pattern, not one manufacturer
    // being difficult: build-and-price TOOLS are unreliable to scrape
    // regardless of brand, while static announcement pages and spec PDFs
    // are not. Query steers toward the latter accordingly.
    const query = `${year} ${make} ${model} ${trim ?? ""} pricing announcement press release MSRP Canada`.trim();
    const searchRes = await fetch("https://sdk.nimbleway.com/v1/search", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${NIMBLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        max_results: 5,
        deep_search: false,
        include_domains: [domain],
        country: "CA",
        locale: "en",
      }),
    });

    if (!searchRes.ok) {
      console.warn("Manufacturer MSRP search failed:", searchRes.status, await searchRes.text());
      return null;
    }

    const searchData = await searchRes.json();
    const results = searchData.results || [];
    console.log(
      `Manufacturer MSRP search returned ${results.length} result(s) for "${query}": ` +
        results.map((r: any) => r.url).join(", "),
    );
    if (results.length === 0) return null;

    // Pick the result most likely to actually carry this trim's MSRP, and
    // -- critically -- refuse to spend the expensive vx10 extract on one
    // that can't. Two categories are worthless here and are dropped:
    //   * build/configure tools -- documented above as unreliable to scrape
    //   * the brand's homepage / any bare root URL -- a homepage can never
    //     contain a specific trim's price, so extracting it is ~30s of pure
    //     wasted latency. Confirmed live (2026-07-22): a Honda search fell
    //     back to https://www.honda.ca/ and returned no MSRP after a full
    //     ~30s extract, on exactly the payment-first listings this fallback
    //     exists to help.
    const avoidPattern = /\/(build|configure)[a-z-]*\//i;
    const preferPattern = /media|news|press|newsroom|\.pdf/i;
    const isRootUrl = (u: string): boolean => {
      try { const p = new URL(u).pathname.replace(/\/+$/, ""); return p === "" || p === "/"; }
      catch { return true; } // unparseable -> unusable, treat as root
    };
    const modelWord = model.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ")[0];
    const candidates = results.filter((r: any) => r.url && !avoidPattern.test(r.url) && !isRootUrl(r.url));
    // Prefer a press/media/PDF page, then a page whose path names this
    // model (a model page is far likelier to carry pricing than a generic
    // section), then any remaining real content page.
    const targetUrl =
      candidates.find((r: any) => preferPattern.test(r.url))?.url ||
      (modelWord ? candidates.find((r: any) => { try { return new URL(r.url).pathname.toLowerCase().includes(modelWord); } catch { return false; } })?.url : undefined) ||
      candidates[0]?.url ||
      null;
    // Nothing but homepages/build tools came back -- skip the extract
    // entirely rather than burn ~30s on a page that cannot contain the
    // answer. This is the common payment-first case, so the saving is real.
    if (!targetUrl) {
      console.log(`Manufacturer MSRP: no viable content URL among ${results.length} result(s) for ${year} ${make} ${model} (only homepage/build pages); skipping extract to save latency.`);
      return null;
    }
    console.log(`Manufacturer MSRP: selected ${targetUrl} from ${candidates.length} viable candidate(s).`);

    // Step 2: the real content fetch, using the SAME JS-rendering driver
    // (vx10 + explicit wait) already proven reliable on JS-heavy DEALER
    // pages all session -- manufacturer configurator pages need the
    // identical treatment, confirmed by direct testing just now.
    const extractResult = await nimbleExtract(targetUrl, "vx10", MFR_TIMEOUT_MS, MFR_VX10_WAIT_MS);
    if (!extractResult.ok) {
      console.warn(`Manufacturer MSRP page extract failed for ${targetUrl}:`, extractResult.errBody);
      return null;
    }

    const pageContent = (extractResult.data?.data?.markdown || "").slice(0, 15000);
    console.log(`Manufacturer MSRP page extracted from ${targetUrl}, content.length=${pageContent.length}`);
    if (!pageContent.trim()) {
      console.log("Manufacturer MSRP page extract returned no usable content.");
      return null;
    }

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 300,
        system:
          `You are looking for the manufacturer's suggested retail price (MSRP) for one specific vehicle trim on its own official Canadian manufacturer website. Find the MSRP for exactly: ${year} ${make} ${model}${trim ? " " + trim : ""}. Only use a price you can clearly attribute to this exact trim -- if the content shows multiple trims, pick the matching one, don't average or guess across trims. Return ONLY this JSON object, nothing else, no markdown fence: {"msrp": number or null}`,
        messages: [{ role: "user", content: pageContent }],
      }),
    });

    if (!claudeRes.ok) {
      console.warn("Manufacturer MSRP extraction call failed:", claudeRes.status, await claudeRes.text());
      return null;
    }

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content?.[0]?.text ?? "{}";
    try {
      const parsed = JSON.parse(rawText.replace(/```json|```/g, "").trim());
      const result = typeof parsed.msrp === "number" ? parsed.msrp : null;
      console.log(`Manufacturer MSRP lookup concluded for ${year} ${make} ${model}: ${result ?? "no clear MSRP found in the content"}`);
      return result;
    } catch {
      console.warn("Couldn't parse manufacturer MSRP extraction:", rawText);
      return null;
    }
  } catch (err) {
    console.warn("lookupManufacturerMsrp threw:", err);
    return null;
  }
}

type NimbleResult =
  | { ok: true; data: any }
  | { ok: false; errBody: string; timedOut: boolean };

// A single, time-bounded Nimble extract attempt. Distinguishes a timeout
// (this specific attempt genuinely never came back -- retrying the
// identical driver/wait combination just waits again) from a fast
// rejection like a 401/403/429 (confirmed separately to be
// intermittent/account-based, so a retry can genuinely succeed where the
// last attempt didn't).
//
// externalSignal (2026-07-22): lets a caller abort this attempt from the
// outside -- used by the vx6/vx8 race in fetchListingContent so that once
// one driver returns usable content, the other in-flight request is
// cancelled instead of running to completion and billing for a result
// nobody will read. Combined with the internal timeout: whichever fires
// first aborts the fetch.
async function nimbleExtract(
  url: string,
  driver: string,
  timeoutMs: number,
  waitMs?: number,
  externalSignal?: AbortSignal,
): Promise<NimbleResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    const body: Record<string, unknown> = { url, driver, formats: ["markdown"] };
    if (waitMs) body.wait = waitMs;
    const res = await fetch("https://sdk.nimbleway.com/v1/extract", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${NIMBLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      // formats: ["markdown"] asks Nimble for clean, LLM-ready text rather
      // than raw HTML -- cheaper and faster to feed to Claude. "render" is
      // omitted -- confirmed via a real response warning that it's ignored
      // once "driver" is set explicitly.
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.ok) {
      const data = await res.json();
      // A 200/success from Nimble itself doesn't guarantee usable content
      // -- confirmed live (2026-07-22, toyotaonthetrail.ca): vx8 returned
      // status="success", status_code=200, but markdown.length=0. That
      // used to count as a successful attempt here, which short-circuited
      // the escalation loop before vx10 (the driver actually likely to
      // help) ever got tried. 100 chars is a low bar -- any real listing
      // page's markdown will be far longer than that; this only catches
      // genuinely empty/near-empty responses (likely bot-detection or a
      // blank shell), not legitimately short pages.
      const md = data?.data?.markdown;
      if (typeof md === "string" && md.trim().length >= 100) {
        return { ok: true, data };
      }
      return { ok: false, errBody: `200 response but content too short (markdown.length=${md?.length ?? 0})`, timedOut: false };
    }
    return { ok: false, errBody: await res.text(), timedOut: false };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    return { ok: false, errBody: timedOut ? `timed out after ${timeoutMs}ms` : String(err), timedOut };
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
  }
}

// Tags a pending nimbleExtract promise with the driver that produced it,
// so the race below can report which driver won or which ones failed
// without threading that label through NimbleResult itself.
function labelled(driver: string, promise: Promise<NimbleResult>): Promise<{ driver: string; result: NimbleResult }> {
  return promise.then((result) => ({ driver, result }));
}

// Resolves as soon as the FIRST labelled attempt returns usable content
// ({ winner }); if every attempt fails, resolves with { winner: null } and
// all the failures for logging. Unlike Promise.race (which would resolve on
// the first SETTLED promise, success or failure), this waits past a failing
// attempt for a slower sibling that might still succeed -- exactly what the
// vx6/vx8 race needs, since vx6 often fails fast on JS-heavy pages while vx8
// is still working.
function firstUsable(
  attempts: Array<Promise<{ driver: string; result: NimbleResult }>>,
): Promise<{ winner: { driver: string; result: NimbleResult } | null; failures: Array<{ driver: string; result: NimbleResult }> }> {
  return new Promise((resolve) => {
    let remaining = attempts.length;
    const failures: Array<{ driver: string; result: NimbleResult }> = [];
    let done = false;
    for (const attempt of attempts) {
      attempt.then((labelledResult) => {
        if (done) return;
        if (labelledResult.result.ok) {
          done = true;
          resolve({ winner: labelledResult, failures });
        } else {
          failures.push(labelledResult);
          if (--remaining === 0) resolve({ winner: null, failures });
        }
      });
    }
  });
}

// Fetches a dealer listing page, escalating driver strength only when
// actually needed rather than always paying for the heaviest option:
//  1. vx6 AND vx8 raced CONCURRENTLY (2026-07-22) -- the two cheap/fast
//     tiers. First one to return usable content wins; the loser is
//     aborted. Previously these ran in strict sequence, so a JS-heavy
//     page that vx6 can't render cost a full wasted vx6 timeout (up to
//     8s) before vx8 even started. Racing them removes that dead time
//     entirely -- the response is now as fast as whichever cheap driver
//     actually works. vx6 does no JS rendering; vx8 is fast and cheap and
//     handles most dealer platforms whose pricing renders synchronously
//     (e.g. Convertus/Achilles-based sites).
//  2. vx10 (JS rendering + stealth) WITH an explicit 6-second wait, if
//     BOTH cheap drivers fail. Confirmed on a live test that this exact
//     combination -- not just vx10 alone -- is what actually surfaces
//     some dealer platforms' real listing content (price, VIN, rebates):
//     that content loads in asynchronously after the initial render, and
//     without an explicit wait, Nimble was returning either an incomplete
//     page (missing the vehicle-specific block entirely) or timing out
//     outright trying to detect the page was "done." vx10 is the costliest
//     tier, so it stays a fallback and is never raced in from the start.
//  3. One more vx10+wait attempt ONLY if that first vx10 attempt was a
//     fast rejection, not a timeout -- confirmed separately that the same
//     URL can succeed on one fetch and fail on another even with vx10
//     both times, so a single vx10 rejection isn't reliable evidence the
//     page is genuinely unreachable. A timeout is different: retrying the
//     identical wait/driver combination just waits again for no new
//     reason to expect a different outcome.
async function fetchListingContent(url: string): Promise<{ data: any; driver: string } | { errBody: string }> {
  // Per-attempt caps. Bumped from 20s to 30s on 2026-07-22, after two
  // different real dealer sites (Calgary Honda, Gateway Toyota -- different
  // platforms, no query-string in common) both failed with "timed out
  // after 20000ms" on ALL four attempts within the same 15-minute window.
  // Nimble's own SDK docs list a 3-minute default timeout as their norm,
  // which suggests 20s per attempt may simply be too tight for some of the
  // heavier, JS-rendered inventory pages this function targets -- not a
  // sign Nimble itself is down (checked: no public outage reported).
  //
  // 30s, not something closer to Nimble's own 3-minute default, because
  // Supabase enforces a 150s hard ceiling PER REQUEST (separate from the
  // longer worker wall-clock limit) -- if that's hit first, Supabase kills
  // the function outright with a raw 504 instead of this function's own
  // graceful "couldn't load that page" card. With vx6/vx8 now RACED rather
  // than sequential, the worst-case path is max(vx6 8s, vx8 30s) + vx10
  // 36s + vx10-retry 36s = 102s, comfortably under that ceiling with room
  // for the Claude call afterward.
  const TIMEOUT_MS = 30_000;
  const VX6_TIMEOUT_MS = 8_000; // vx6 does no JS rendering -- if it's going to succeed at all it returns fast; capping it at 8s means a race where vx6 can't handle the page falls through to vx8's result promptly instead of holding a slot for the full 30s
  const VX8_TIMEOUT_MS = 30_000;
  const VX10_WAIT_MS = 6_000;

  // Phase 1: race the two cheap/fast drivers. A shared AbortController lets
  // the winner cancel the loser's in-flight request so we don't bill for a
  // result nobody reads.
  const raceAbort = new AbortController();
  const raced = await firstUsable([
    labelled("vx6", nimbleExtract(url, "vx6", VX6_TIMEOUT_MS, undefined, raceAbort.signal)),
    labelled("vx8", nimbleExtract(url, "vx8", VX8_TIMEOUT_MS, undefined, raceAbort.signal)),
  ]);
  if (raced.winner) {
    raceAbort.abort(); // cancel the losing driver, if it's still running
    return { data: raced.winner.result.data, driver: raced.winner.driver };
  }
  for (const f of raced.failures) {
    console.warn(`Nimble extract via ${f.driver} failed:`, f.result.errBody);
  }

  // Phase 2: escalate to vx10 (JS render + stealth) with an explicit wait.
  let result = await nimbleExtract(url, "vx10", TIMEOUT_MS, VX10_WAIT_MS);
  if (result.ok) return { data: result.data, driver: "vx10" };
  console.warn("Nimble extract via vx10 (wait 6s) failed:", result.errBody);

  if (result.timedOut) return { errBody: result.errBody };

  await new Promise((r) => setTimeout(r, 1000));
  result = await nimbleExtract(url, "vx10", TIMEOUT_MS, VX10_WAIT_MS);
  if (result.ok) return { data: result.data, driver: "vx10-retry" };
  console.warn("Nimble extract via vx10 (wait 6s, retry) failed:", result.errBody);
  return { errBody: result.errBody };
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM_PROMPT = `You are analyzing the extracted text content of a Canadian car dealership's vehicle listing web page, for a buyer using LotCheck.

This is a live inventory listing page, not a formal itemized quote document -- it typically shows a sticker/list price, sometimes an advertised discount or rebate with conditions attached, vehicle specs, and financing/lease estimates. Some listing pages (especially "payment-first" pages with no standalone advertised price) DO disclose itemized fees the same way a formal quote would -- freight/PDI, dealer-installed accessories, protection packages, excise taxes -- typically inside the lease/finance legal disclosure text rather than as a separate visible list. Extract those the same way you would from a formal quote; don't assume they're absent just because this is a listing page.

Extract the following as a single JSON object, with EXACTLY these fields and no others:

{
  "vehicle": string,              // e.g. "2026 Hyundai IONIQ 5 Preferred" -- year, make, model, trim
  "year": number | null,
  "make": string | null,
  "model": string | null,
  "trim": string | null,           // just the trim level, e.g. "Sport", "XSE AWD", "Preferred" -- separate from make/model so a manufacturer-site lookup can target the exact trim, not just guess it back out of the combined "vehicle" string above.
  "vin": string | null,            // the full 17-character VIN if it appears anywhere on the page (usually in a specs/vehicle-details table). Copy it EXACTLY as printed, no spaces. null if not shown.
  "odometerKm": number | null,     // the odometer reading / mileage in kilometres if shown (e.g. "41,220 km" -> 41220, "10 km" -> 10). Numbers only, no units or commas. null if not shown.
  "fuelType": "BEV" | "PHEV" | "Hybrid" | "Gas" | "Diesel" | null,  // Confirmed via real testing (2026-07-22, Gateway Toyota C-HR listing) that a dealer page's marketing/description prose can genuinely contradict its own structured spec sheet -- that listing's spec table said "Fuel Type: Gasoline" while ALSO listing an electric motor, 77-kWh battery, NACS charging port, and electric driving range. An earlier version of this note said to trust the structured "Fuel Type:" label in cases like this -- that turned out to be BACKWARDS. Checking Toyota Canada's own official spec pages and press release confirmed the 2026 C-HR genuinely IS a 77-kWh BEV; the "Fuel Type: Gasoline" label was the dealer's own error (almost certainly a stale inventory-system default never updated for a brand-new model-year nameplate change), not the detailed EV specs. The corrected rule: when a single categorical label (a bare "Fuel Type:", "Engine:", or similar field) conflicts with multiple DETAILED, mutually-consistent technical numbers describing an EV or PHEV (battery capacity in kWh, electric driving range in km, charging port type/speed, electric motor power) -- trust the detailed, internally-consistent numbers. A cluster of specific figures that all agree with each other is much harder to end up on a page by accident than one stale category label is. If you do encounter and resolve a genuine contradiction like this, say so plainly in the summary field so the buyer knows to double check with the dealer, the same way you would for any other page inconsistency. Note also that the frontend independently cross-checks year/make/model against a separately-verified EV rebate list, so a wrong read here isn't the only safeguard -- but getting this field right still matters for the report's own accuracy.
  "vehicleCondition": "new" | "used" | null,
  "dealerName": string | null,    // the dealership's business name as it would appear on Google (e.g. "Macleod Trail Toyota", "Calgary Honda") -- usually near the top of the page or in an "Available at..." line. Do NOT include the city/location as part of this field; that's a separate concern.
  "dealerCity": string | null,    // the city (and province if visible, e.g. "Calgary, AB") the dealership operates in. Needed to disambiguate common dealer names -- there are many "Toyota" or "Honda" dealers across Canada, and the name alone isn't enough to look up the right one.
  "msrp": number | null,          // the manufacturer's suggested retail price, before any options, fees, or discounts. Often NOT shown as a standalone price tag -- many dealer sites, especially "payment-first" listings with no separate sticker price displayed anywhere, only state it inside a dense lease/finance legal disclosure paragraph, in a pattern like "Lease payments include: MSRP ($32,300.00), [paint/option] ($550.00), Freight and PDI ($1,830.00), ...". Read fine-print/legal disclosure text carefully for this pattern -- do not restrict your search to prominent, large-font prices.
  "quotedPrice": number | null,   // the actual all-in selling price being charged before tax, whichever direction it moves relative to MSRP. This is usually one of: (a) a discounted advertised price below MSRP (sometimes labeled "Market Value" or similar), OR (b) on a payment-first listing with no advertised discount, the full selling price/net cap cost AFTER dealer-installed options and fees are added ON TOP of MSRP -- sometimes labeled "Lease Price", "Selling Price", "Cap Cost", or similar in fine print. Do NOT leave this null just because there's no discount -- if the page discloses a total price for the deal at all, even one higher than MSRP because of added fees, that IS the quotedPrice.
  "standardWarranty": {           // the FREE manufacturer warranty that comes with a new vehicle -- NOT a purchased add-on. Only fill this in for a "new" vehicleCondition; null for used. Listing pages rarely state this explicitly -- use the manufacturer's actual known standard coverage for this make if it isn't shown on the page.
    "coverage": string | null,    // e.g. "5-year/100,000 km comprehensive, 5-year/100,000 km powertrain"
    "note": string | null         // one reassuring sentence, e.g. "Included at no extra cost with every new [make]."
  },
  "addOns": [                     // notable pricing line items disclosed for this listing -- can be FEES (genuine costs added on top of MSRP: freight/PDI, dealer-installed accessories, protection packages, excise taxes, registration-type fees) or DISCOUNTS/CONDITIONS (a promotion, rebate, or advertised price cut, especially one with restrictions). Both are common on real dealer listings -- including "payment-first" new-vehicle pages that show no discount at all but do stack several fees on top of MSRP. Extract whichever is actually present; don't assume it's always one or the other.
    {
      "name": string,             // e.g. "Honda Safe & Secure" or "Clearance Discount -- Finance Only"
      "price": number,            // the dollar amount of that fee or discount
      "kind": "fee" | "discount", // "fee" = a genuine cost added to the price; "discount" = a price reduction, rebate, or promotion
      "verdict": "good" | "flagged" | "standard",  // for a discount: "good" = a genuine, unconditional benefit; "flagged" = a common bait tactic worth double-checking (financing-only restrictions, tight expiry, vague eligibility). For a fee: "flagged" = commonly overpriced or a non-removable bundled product worth questioning (theft-deterrent/etching packages, paint/fabric protection); "standard" = an ordinary, fairly-priced pass-through (freight/PDI, floor mats, block heater, excise tax, registration-type fees) -- neither a win nor a problem. "good" rarely applies to a fee.
      "reason": string            // MUST reference a concrete baseline, e.g. what's typical for this type of fee or discount and how this one compares
    }
  ],
  "totalFlaggedCost": number,     // sum of price for every addOn where verdict is "flagged", regardless of kind
  "warranty": {                   // usually null on a listing page -- only fill in if an EXTENDED/PURCHASED warranty or protection product is genuinely advertised
    "offered": string | null,
    "price": number | null,
    "assessment": string | null
  },
  "financing": {                  // the payment plan terms disclosed on the page, if any (lease or finance estimate). Often stated in the SAME dense legal disclosure paragraph as msrp above -- read it for these numbers too, don't treat that paragraph as only relevant to msrp. Leave the whole object null if no financing/lease terms are disclosed at all.
    "type": "lease" | "finance" | null,
    "termMonths": number | null,
    "rate": number | null,            // interest rate / APR as a plain percentage number, e.g. 3.39 (not 0.0339)
    "paymentAmount": number | null,   // the periodic payment amount shown, BEFORE tax if both before/after-tax amounts are disclosed
    "paymentFrequency": "weekly" | "biweekly" | "monthly" | null,
    "totalObligation": number | null,        // total of all payments over the full term, as literally disclosed
    "totalObligationTaxIncluded": boolean | null,  // true if totalObligation includes GST/tax, false if not, null if unclear
    "totalCostOfCredit": number | null,      // total interest / lease finance charge over the term, as literally disclosed -- prefer capturing this on a BEFORE-tax basis (the typical Canadian dealer disclosure convention) so it's on a consistent basis with totalObligation where possible
    "residualValue": number | null           // lease residual/buyback value, if this is a lease
  } | null,
  "summary": string                // 2-3 plain-language sentences: the bottom line -- what's genuinely good about this listing, what conditions (if any) to watch for, and what to ask the dealer before showing up
}

Guidelines:
- Only extract what's actually in the page content. Use null for anything not shown -- never guess or invent a number.
- Every "reason" (across all three verdicts) should give the buyer a concrete point of comparison, not just an assertion -- state what's typical and how this compares.
- A discount is "flagged" if it's restricted in a way that isn't obvious at a glance (financing-only, requires trade-in, very short expiry window designed to create urgency). A plain, unconditional discount is "good", not merely unflagged.
- "standard" applies to ordinary, unremarkable listing conditions -- e.g. a standard delivery timeline or a routine dealer disclaimer -- that are neither a benefit nor a concern.
- "vehicleCondition" should be "used" if the page shows meaningful mileage, a model year clearly older than current, or explicitly says used/pre-owned/certified pre-owned. A "new" vehicle showing only delivery mileage (under ~100 km) is still new.
- LotCheck separately calculates and displays federal/provincial EV rebate eligibility as its own dedicated section, based on the vehicle's fuel type and condition -- this happens independently of what you extract. If the listing ALSO advertises an EV/EVAP rebate as a pricing condition (e.g. "Potential EVAP Rebate"), do not present it as a standalone, contradictory finding. Instead, write the "reason" to connect the two explicitly -- acknowledge that base eligibility likely exists, and explain specifically what the dealer's own wording (e.g. "Potential", conditional phrasing) suggests about whether THIS dealer will actually honor it at sale. For example: "You likely qualify for the federal EVAP program shown above -- but this dealer's own listing hedges the number as 'Potential,' meaning they may apply additional conditions before confirming it at sale. Get this in writing before assuming it applies." Never phrase it as if the eligibility itself is in doubt when the vehicle plainly qualifies.
- Financing/lease disclosure text is often a single dense paragraph packed with numbers, e.g.: "Lease payments include: MSRP ($32,300.00)... Lease offer is based on a 60 months term and 3.39% interest rate. 260 weekly payments of $102.39 ($107.51 GST included)... Lease total obligation is $27,952.60 (GST included). Lease total cost of credit is $4,190.25. Annual Percentage Rate (APR) is 3.41%." Read this fine print carefully and populate BOTH msrp and financing from it -- don't stop scanning after finding the first number.
- The "X payments include: ..." sentence is one COMPLETE comma-separated list -- process it left to right and don't skip any entry, including ones at the very start or end that don't look like discretionary accessories. A real example: "Lease payments include: MSRP ($32,300.00), Meteoroid Grey Metallic ($550.00), Freight and PDI ($1,830.00), Honda Safe & Secure ($749.00), Engine Block Heater - 2.0L ($481.40), Floor Mats - All-Season ($259.10), Splash Guards - Rear ($170.40), Wheel Locks - Black ($132.20), Air conditioning excise tax ($100.00), Tire Duty ($25.00), PPSA ($19.43), AMVIC Fee ($10.00)." From that single sentence: the FIRST figure ($32,300.00) goes in msrp -- and EVERY remaining figure becomes its own addOns entry, including the paint/color charge, Freight and PDI, and the small statutory fees at the end (excise tax, tire duty, PPSA, registration-type fees) with verdict "standard". Do not silently drop an item just because it reads as a routine baseline component rather than an optional accessory -- a buyer comparing this report to the dealer's own disclosure will notice if a line item is simply missing.
- If the page shows more than one financing/lease scenario (e.g. different terms or km allowances via URL parameters), extract the one that matches the payment actually displayed as the primary/selected option on the page, not an alternate scenario buried elsewhere in the disclosure text.
- Respond with ONLY the JSON object above. No markdown formatting, no code fences, no preamble or explanation outside the JSON.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (!ANTHROPIC_API_KEY || !NIMBLE_API_KEY) {
    console.error("ANTHROPIC_API_KEY or NIMBLE_API_KEY is not set on this function.");
    return new Response(
      JSON.stringify({ error: "Listing analysis isn't configured yet." }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }

  try {
    const { url } = await req.json();
    if (!url || typeof url !== "string") {
      return new Response(
        JSON.stringify({ error: "No listing URL received." }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    // Cache fast-path: a recent analysis of this exact URL is returned
    // immediately -- no Nimble scrape, no Claude call, near-instant. Best-
    // effort: any cache error just falls through to a fresh scan.
    try {
      const { data: cached } = await supabase
        .from("listing_analysis_cache")
        .select("analysis, created_at")
        .eq("url", url)
        .maybeSingle();
      if (cached?.analysis && (Date.now() - new Date(cached.created_at).getTime()) < CACHE_TTL_MS) {
        const ageS = Math.round((Date.now() - new Date(cached.created_at).getTime()) / 1000);
        console.log(`Cache HIT for ${url} (age ${ageS}s) -- returning cached analysis, no scrape.`);
        return new Response(
          JSON.stringify({ analysis: cached.analysis, cached: true }),
          { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
        );
      }
    } catch (err) {
      console.warn("Cache read failed (continuing with fresh scan):", err);
    }

    const nimbleResult = await fetchListingContent(url);
    if (!("data" in nimbleResult)) {
      console.error("Nimble extract failed after all attempts:", nimbleResult.errBody);
      await logUsage({ success: false, errorMessage: `Nimble failed: ${nimbleResult.errBody}` });
      return new Response(
        JSON.stringify({ error: "Couldn't load that page after a few tries. This dealer site may be blocking automated access right now -- try again in a moment, or use the upload/screenshot option instead." }),
        { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const nimbleData = nimbleResult.data;
    // Nimble's response field name for extracted text may be `content` or
    // `text` depending on API version -- check both rather than assume.
    // Confirmed against Nimble's actual API reference: content lives at
    // data.markdown when formats includes "markdown" (data.html is the
    // fallback if markdown wasn't requested or came back empty for some
    // reason -- belt and suspenders, not the primary path).
    const rawMarkdown = nimbleData?.data?.markdown;
    const rawHtml = nimbleData?.data?.html;
    let pageContent = rawMarkdown || rawHtml;

    // Decisive diagnostic, logged unconditionally (before any early
    // return) so we get real signal whether content came back empty or
    // not -- printing ACTUAL VALUES, not just field names, since the
    // previous version of this log only showed Object.keys() and that's
    // exactly why the 2026-07-21 Toyota failure (markdown key present,
    // but apparently empty) told us nothing new. Nimble's own docs example
    // for a synchronous /v1/extract call shows no top-level task_id at
    // all -- if status/status_code below turn out to indicate an
    // in-progress job rather than a finished one, that points at needing
    // to poll a task_id-based endpoint instead of trusting this response
    // as final. Until we see these real values, that's a hypothesis, not
    // a confirmed fix.
    console.log(
      `Nimble response for ${url}: driver=${nimbleResult.driver}, status=${JSON.stringify(nimbleData?.status)}, status_code=${JSON.stringify(nimbleData?.status_code)}, task_id=${JSON.stringify(nimbleData?.task_id)}, metadata=${JSON.stringify(nimbleData?.metadata)}, markdown.length=${rawMarkdown?.length ?? "undefined"}, html.length=${rawHtml?.length ?? "undefined"}`,
    );

    if (!pageContent) {
      console.error("No usable content in Nimble response. Top-level keys:", Object.keys(nimbleData||{}), "data keys:", Object.keys(nimbleData?.data||{}));
      await logUsage({ success: false, errorMessage: `No content in Nimble response (status=${nimbleData?.status}, status_code=${nimbleData?.status_code})` });
      return new Response(
        JSON.stringify({ error: "Couldn't read that page's content. Try a different listing." }),
        { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }
    // Safety cap -- protects against an unexpectedly huge page (especially
    // if it ever falls back to raw HTML) driving up Claude's token cost.
    // 100,000 characters is generously more than any real listing page's
    // useful content needs.
    if (pageContent.length > 100000) pageContent = pageContent.slice(0, 100000);

    // Decisive diagnostic, not a guess: after two rounds of prompt-only
    // fixes produced the identical MSRP/financing gap, the open question
    // is whether Claude ever actually receives that text at all. If
    // containsMSRP is false here, the fix belongs in the Nimble fetch
    // (the driver tier or format request), not the prompt -- no more
    // prompt iteration until this comes back true.
    console.log(
      `Listing content fetched via driver=${nimbleResult.driver}, pageContent.length=${pageContent.length}, containsMSRP=${pageContent.toUpperCase().includes("MSRP")}, containsLeasePaymentsInclude=${/payments include/i.test(pageContent)}`,
    );

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        // Bumped from 4000 to 8000 on 2026-07-22: the earlier logging
        // added below (length/stop_reason on parse failure) did its job
        // -- a real listing (Toyota bZ XLE AWD, Macleod Trail Toyota)
        // hit stop_reason=max_tokens with output_tokens=4000, JSON cut
        // off mid-string in the summary field, no dealerName/dealerCity
        // reached yet. Confirmed root cause this time, not a guess: the
        // schema (financing object, kind field, longer per-addOn
        // reasoning, dealerName/dealerCity) has grown enough that 4000
        // is genuinely insufficient for a detailed listing. Doubling
        // costs nothing in the normal case -- max_tokens is a ceiling,
        // not a target, so a listing that finishes in 1200 tokens still
        // only uses 1200 regardless of this number.
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Here is the extracted content of a dealer listing page (URL: ${url}):\n\n${pageContent}\n\nAnalyze this listing and return the JSON object described in your instructions.`,
          },
        ],
      }),
    });

    if (!claudeRes.ok) {
      const errBody = await claudeRes.text();
      console.error("Claude API call failed:", claudeRes.status, errBody);
      await logUsage({ success: false, errorMessage: `Claude HTTP ${claudeRes.status}` });
      return new Response(
        JSON.stringify({ error: "Couldn't analyze that listing. Please try again in a moment." }),
        { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const claudeData = await claudeRes.json();
    const usage = claudeData?.usage;
    const stopReason = claudeData?.stop_reason;
    const textBlock = Array.isArray(claudeData?.content)
      ? claudeData.content.find((b: any) => b?.type === "text")
      : null;
    const rawText = textBlock?.text;
    if (!rawText) {
      console.error("Unexpected Claude response shape:", JSON.stringify(claudeData));
      await logUsage({
        success: false,
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
        errorMessage: "No text block in response",
      });
      return new Response(
        JSON.stringify({ error: "Couldn't read a response from the analysis. Please try again." }),
        { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    let analysis;
    try {
      const cleaned = rawText.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");
      analysis = JSON.parse(cleaned);
    } catch (parseErr) {
      // stop_reason and length logged explicitly (not just rawText) so a
      // future failure is diagnosable even if the dashboard's log viewer
      // clips a long single log line -- "max_tokens" here means Claude
      // itself was cut off mid-generation (raise max_tokens further or
      // shrink the schema); "end_turn" means Claude's own output really
      // was complete valid-looking JSON and this is a different bug
      // entirely (e.g. a stray unescaped character), not a length issue.
      console.error(
        `Failed to parse Claude's JSON output. stop_reason=${stopReason}, output_tokens=${usage?.output_tokens}, rawText.length=${rawText.length}:`,
        rawText,
      );
      await logUsage({
        success: false,
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
        errorMessage: `JSON parse failure (stop_reason=${stopReason}, output_tokens=${usage?.output_tokens})`,
      });
      return new Response(
        JSON.stringify({ error: "Couldn't read that listing clearly. Try a different page." }),
        { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    await applyVerifiedWarranty(analysis);
    await applyVerifiedFuelType(analysis);
    analysis.vinCheck = validateVin(analysis.vin);
    if (analysis.year && analysis.make && analysis.model) {
      analysis.recalls = await lookupRecalls(analysis.year, analysis.make, analysis.model);
    }

    // Manufacturer-site MSRP fallback -- only spend the extra search+
    // extraction cost when the dealer's own page genuinely didn't show
    // an MSRP at all (real case: Calgary Honda Civic, "MSRP: Not shown
    // on quote"). If this also comes up empty (manufacturer not yet in
    // MANUFACTURER_DOMAINS, or genuinely not found), analysis.msrp just
    // stays null -- the report still shows the dealer's quoted price on
    // its own, without a false "verified" claim, exactly as before.
    if (!analysis.msrp && analysis.year && analysis.make && analysis.model) {
      // 1) Fast, authoritative catalog lookup first -- a DB read, no scrape.
      //    When it hits, the ~30s manufacturer-site scrape is skipped
      //    entirely.
      const catMsrp = await lookupCatalogMsrp(analysis.year, analysis.make, analysis.model, analysis.trim ?? null);
      if (catMsrp) {
        analysis.msrp = catMsrp;
        analysis.msrpSource = "catalog";
      } else {
        // 2) Only if the catalog doesn't have it, pay for the manufacturer-
        //    site scrape.
        const mfrMsrp = await lookupManufacturerMsrp(analysis.year, analysis.make, analysis.model, analysis.trim ?? null);
        if (mfrMsrp) {
          analysis.msrp = mfrMsrp;
          analysis.msrpSource = "manufacturer_site";
        }
      }
    }

    // Derived verification checks -- run last, after price/recalls are all
    // populated, since the leverage score is computed from them.
    computeFinancingCheck(analysis);
    computeOdometerCheck(analysis);
    computeLeverageScore(analysis);

    // Populate the cache with the finished, enriched analysis so the next
    // scan of this URL within the TTL is instant. Best-effort -- a cache
    // write failure must never fail the request.
    try {
      await supabase
        .from("listing_analysis_cache")
        .upsert({ url, analysis, created_at: new Date().toISOString() }, { onConflict: "url" });
    } catch (err) {
      console.warn("Cache write failed:", err);
    }

    await logUsage({
      success: true,
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
    });

    return new Response(
      JSON.stringify({ analysis }),
      { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("analyze-listing-url error:", err);
    await logUsage({ success: false, errorMessage: String(err) });
    return new Response(
      JSON.stringify({ error: "Something went wrong analyzing that listing." }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
});
