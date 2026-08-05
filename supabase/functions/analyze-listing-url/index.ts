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
import { finalizeServerSide } from "../_shared/report-sign.ts";
import { rescueListingViaScrapfly, mergeRescued, scrapflyEnabled } from "../_shared/scrapfly.ts";
import { buildFeeObservations } from "../_shared/fee-vocab.ts";
import { canonicalMake } from "../_shared/makes.ts";
import { computeRemainingWarranty } from "../_shared/warranty.ts";
import { fetchMarketValue } from "../_shared/marketvalue.ts";
import { computeReconciliation, computeFinancingTrap, buildCounterScript } from "../_shared/deal.ts";
import { assessDocFee } from "../_shared/docfee.ts";
import { lookupRecalls } from "../_shared/recalls.ts";
import { canonicalModel } from "../_shared/models.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const NIMBLE_API_KEY = Deno.env.get("NIMBLE_API_KEY");
// Single source of truth for the model, shared with analyze-quote: both
// functions read ANTHROPIC_MODEL and default to the SAME model so the two
// quote-analysis paths never silently diverge. Override via the ANTHROPIC_MODEL
// secret to pin/rollback without a code change.
const CLAUDE_MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5";

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

// ── Quote Check credit lifecycle (Phase 3) ─────────────────────────────────
// A personal credit is deducted ONLY after an accurate result is delivered,
// and ONLY for signed-in requests. Anonymous requests (no/invalid JWT — which
// includes the anon key the frontend sends today) resolve to no user and take
// the existing flow byte-for-byte unchanged: every helper below is a no-op
// when there is no hold. The fn_* RPCs were REVOKED from public, so they are
// called with the service-role `supabase` client above.

// Resolve the signed-in caller from the Authorization: Bearer <jwt> header.
// Returns null for anonymous / unresolvable tokens (the back-compat path).
// Never throws — a transient auth failure falls back to the anonymous path.
async function resolveCreditUser(req: Request): Promise<{ id: string } | null> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return null;
  try {
    const { data, error } = await supabase.auth.getUser(jwt);
    if (error || !data?.user) return null;
    return data.user;
  } catch (_e) {
    return null;
  }
}

// ── Anonymous free-check circuit breaker ────────────────────────────────────
// The global cost guard for ANONYMOUS free checks (signed-in users are covered
// by the personal credit ledger above and never touch this). Calls the
// SECURITY DEFINER RPC fn_try_free_check on the service-role client, which
// ATOMICALLY returns TRUE and increments today's count if under the configured
// daily limit (global AND per-IP), or FALSE once either limit is hit. Returns
// true = allowed, false = blocked. FAILS OPEN on any RPC error: cost protection
// is best-effort, so a DB blip must not hard-block legitimate users — we log it
// and allow the check.
function clientIp(req: Request): string | null {
  // Prefer the first hop in x-forwarded-for (the original client), fall back to
  // x-real-ip. null when neither header is present.
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip");
  return real ? real.trim() : null;
}

async function tryFreeCheck(req: Request): Promise<boolean> {
  try {
    const ip = clientIp(req);
    const { data, error } = await supabase.rpc("fn_try_free_check", { p_ip: ip });
    if (error) {
      console.error("fn_try_free_check failed (failing open):", error.message);
      return true;
    }
    return data === true;
  } catch (e) {
    console.error("fn_try_free_check threw (failing open):", e);
    return true;
  }
}

// Place a credit hold before any expensive work. null result → out of credits.
async function authorizeCredit(
  userId: string,
): Promise<{ ok: true; holdId: string } | { ok: false; kind: "out_of_credits" | "error" }> {
  try {
    const { data, error } = await supabase.rpc("fn_authorize_quote", { p_user: userId });
    if (error) {
      console.error("fn_authorize_quote failed:", error.message);
      return { ok: false, kind: "error" };
    }
    if (!data) return { ok: false, kind: "out_of_credits" };
    return { ok: true, holdId: data as string };
  } catch (e) {
    console.error("fn_authorize_quote threw:", e);
    return { ok: false, kind: "error" };
  }
}

// Finalize a hold as −1 after a delivered accurate result. Returns the new
// personal balance for the response, or null if capture couldn't be recorded
// (in which case the response simply omits `credits` — `analysis` is unchanged).
async function captureCredit(hold: string | null): Promise<{ personal: number } | null> {
  if (!hold) return null;
  try {
    const { data, error } = await supabase.rpc("fn_capture_quote", { p_hold: hold, p_quote: null });
    if (error) {
      console.error("fn_capture_quote failed:", error.message);
      return null;
    }
    if (data == null) return null;
    return { personal: Number(data) };
  } catch (e) {
    console.error("fn_capture_quote threw:", e);
    return null;
  }
}

// Drop an uncaptured hold on any failure after authorize → no charge.
async function releaseCredit(hold: string | null): Promise<void> {
  if (!hold) return;
  try {
    const { error } = await supabase.rpc("fn_release_quote", { p_hold: hold });
    if (error) console.error("fn_release_quote failed:", error.message);
  } catch (e) {
    console.error("fn_release_quote threw:", e);
  }
}

// ── Resilient fetch (P0 hardening) ──────────────────────────────────────────
// Wraps an outbound fetch with a per-attempt AbortController timeout plus
// bounded retries on transient failures (HTTP 429/529/5xx, network errors, and
// abort/timeouts). Real 4xx (400/401/…) are NOT retried. Backoff is exponential
// with jitter and respects a Retry-After header when present. A hard maxAttempts
// cap AND a total time budget keep the whole sequence under Supabase's ~150s
// function ceiling — the budget stops a retry that couldn't finish in time
// rather than risk a platform kill (which would strand the reserved credit by
// skipping the release path).
//
// Behaviour contract used by callers below:
//   • Returns the final Response — including a non-ok one after the retry
//     budget is spent on a retryable status — so existing `if (!res.ok)`
//     branches (which release the credit / log usage) still fire.
//   • Throws only when retries are exhausted on a network/timeout error with no
//     Response to return; the caller's surrounding try/catch releases the hold.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Retry-After may be a delay in seconds or an HTTP date. null when absent/invalid.
function parseRetryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(h);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

// Exponential backoff with full-ish jitter: attempt 1 ≈ base, then ×2 each
// attempt, half fixed + half random so retries don't thundering-herd.
function backoffDelayMs(attempt: number, baseMs = 600): number {
  const exp = baseMs * Math.pow(2, attempt - 1);
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

interface RetryOpts {
  timeoutMs: number; // per-attempt abort timeout
  maxAttempts: number; // hard cap on attempts
  budgetMs: number; // total wall-clock budget for the whole sequence
  baseBackoffMs?: number;
  label?: string;
}

async function fetchWithRetry(input: string, init: RequestInit, opts: RetryOpts): Promise<Response> {
  const deadline = Date.now() + opts.budgetMs;
  const base = opts.baseBackoffMs ?? 600;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const attemptTimeout = Math.min(opts.timeoutMs, remaining);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptTimeout);
    try {
      const res = await fetch(input, { ...init, signal: controller.signal });
      // Success or a real (non-retryable) error like 4xx → return immediately.
      if (res.ok || !RETRYABLE_STATUS.has(res.status)) return res;
      // Retryable status. Out of attempts → hand the non-ok Response back so the
      // caller's !ok branch runs (and releases the credit).
      if (attempt >= opts.maxAttempts) return res;
      const ra = parseRetryAfterMs(res);
      const delay = ra != null ? ra : backoffDelayMs(attempt, base);
      if (Date.now() + delay >= deadline) return res; // no budget left to wait+retry
      try { await res.text(); } catch { /* drain body, ignore */ }
      await sleep(delay);
      continue;
    } catch (err) {
      // Network error or our own abort/timeout — retry if budget/attempts allow.
      lastErr = err;
      if (attempt >= opts.maxAttempts) throw err;
      const delay = backoffDelayMs(attempt, base);
      if (Date.now() + delay >= deadline) throw err;
      await sleep(delay);
      continue;
    } finally {
      clearTimeout(timer);
    }
  }
  if (lastErr) throw lastErr;
  throw new Error(`fetchWithRetry exhausted its time budget (${opts.label ?? input})`);
}

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
    const make = canonicalMake(analysis.make); // normalize "Mercedes"/"VW"/"Range Rover" -> catalog make
    const { data, error } = await supabase
      .from("manufacturer_warranties")
      .select("basic_coverage, powertrain_coverage, corrosion_coverage, roadside_assistance, hybrid_ev_coverage, source_url")
      .ilike("make", make)
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
      note: `Included at no extra cost with every new ${make} -- verified against ${make}'s official Canadian warranty terms, not an AI estimate.`,
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

// For a USED vehicle, estimate how much of the ORIGINAL manufacturer warranty
// is left, from the verified catalog terms + model year + odometer. Sets
// analysis.remainingWarranty. Never throws.
async function applyRemainingWarranty(analysis: any): Promise<void> {
  if (!analysis || analysis.vehicleCondition === "new" || !analysis.make || !analysis.year) return;
  try {
    const make = canonicalMake(analysis.make);
    const { data, error } = await supabase
      .from("manufacturer_warranties")
      .select("basic_coverage, powertrain_coverage, source_url")
      .ilike("make", make)
      .maybeSingle();
    if (error || !data) return;
    const odo = analysis.odometerKm != null ? Number(analysis.odometerKm) : null;
    const rw = computeRemainingWarranty(data, Number(analysis.year), odo, new Date().getUTCFullYear());
    if (rw) { rw.make = make; analysis.remainingWarranty = rw; }
  } catch (err) {
    console.warn("⚠️ applyRemainingWarranty threw:", err);
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
// Resolve the extracted model to its CANONICAL base model. Static map first
// (canonicalModel — works even with an empty msrp_catalog, and fixes naming
// traps like "bZ Woodland" -> "bZ" and "Mustang Mach-E"), then the catalog as a
// secondary source. Feeds both the recall and MSRP lookups so trim in the model
// field can't break the exact match either one needs. Never throws.
async function resolveBaseModel(year: number, make: string, model: string): Promise<string | null> {
  if (!year || !make || !model) return null;
  const canon = canonicalModel(make, model);
  if (canon) return canon;
  try {
    const { data } = await supabase
      .from("msrp_catalog").select("model")
      .eq("year", year).ilike("make", make).not("model", "is", null).limit(400);
    if (!data?.length) return null;
    const em = String(model).trim().toUpperCase(); let best: string | null = null;
    for (const row of data) {
      const cm = String(row.model || "").trim(); if (!cm) continue;
      const cmU = cm.toUpperCase();
      if (em === cmU || em.startsWith(cmU + " ")) { if (!best || cm.length > best.length) best = cm; }
    }
    return best;
  } catch { return null; }
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
  if (isNew) {
    if (km <= 500) {
      note = `${km.toLocaleString()} km — consistent with a new vehicle (delivery distance).`;
    } else {
      flag = true;
      note = `Listed as new but shows ${km.toLocaleString()} km — more than typical delivery distance. Ask whether it was a demo or loaner, which can affect the warranty start date and the price.`;
    }
  } else if (age <= 1) {
    // Used, current or near-current model year -- effectively a demo, loaner,
    // or short lease return. Low mileage here is normal, NOT a rollback signal.
    note = `${km.toLocaleString()} km on a nearly-new used vehicle — low mileage is normal here (often a demo, loaner, or short lease return). Confirm the in-service date, since the manufacturer warranty usually starts then, not when you buy it.`;
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
      basis.push(`priced $${Math.round(quoted - msrp).toLocaleString()} above the $${Math.round(msrp).toLocaleString()} MSRP`);
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

// Resolve a representative finance APR for the payment-examples calculator.
// Priority: the rate the listing itself discloses (it's THIS deal's actual
// rate) wins; otherwise fall back to finance_rate_catalog for the make/model.
// Attaches analysis.financeRate { apr, source, promo, effectiveDate, note }.
// The frontend applies it across terms as a clearly-labelled ESTIMATE, since
// real rates vary by term/credit. Never throws.
// Resolve BOTH finance rates so the report can compare them side by side:
//  - dealer: the rate THIS listing/quote discloses (what you'd actually pay
//    here). Marked-up dealer rates are a common hidden cost.
//  - manufacturer: the OEM's advertised rate from finance_rate_catalog
//    (toyota.ca etc.). NOTE new-vs-used: manufacturer promo financing is a
//    NEW-vehicle offer, so the frontend treats it as applicable only when the
//    vehicle is new, and as a reference (not a real quote) when it's used.
// Attaches analysis.financeRates { dealer, manufacturer }. Never throws.
async function resolveFinanceRates(analysis: any): Promise<void> {
  const out: any = { dealer: null, manufacturer: null };
  const pageRate = Number(analysis?.financing?.rate);
  if (pageRate && pageRate > 0 && pageRate < 30) {
    out.dealer = { apr: pageRate };
  }
  if (analysis.make) {
    try {
      const { data } = await supabase
        .from("finance_rate_catalog")
        .select("apr, term_months, promo, effective_date, model")
        .ilike("make", analysis.make)
        .order("term_months", { ascending: true })
        .limit(50);
      if (data?.length) {
        const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
        const modelNorm = norm(analysis.model || "");
        const byModel = data.filter((r: any) => r.model && norm(r.model) === modelNorm);
        const pool = byModel.length ? byModel : data.filter((r: any) => !r.model);
        if (pool.length) {
          const std = pool.filter((r: any) => !r.promo);
          const pick = std.find((r: any) => r.term_months === 60) || std[0] || pool[0];
          out.manufacturer = { apr: Number(pick.apr), promo: !!pick.promo, effectiveDate: pick.effective_date };
        }
      }
    } catch (err) {
      console.warn("resolveFinanceRates threw:", err);
    }
  }
  analysis.financeRates = out;
}

// Manufacturer LEASE rate from lease_rate_catalog (populated by the catalog
// scrapers). Twin of the analyze-quote resolveLeaseRates: match on make,
// prefer the exact model, pick a representative term (48mo, else the shortest
// available). Like manufacturer finance, a lease promo is a NEW-vehicle offer,
// so the frontend treats it as a reference when the vehicle is used. Attaches
// analysis.leaseRates.manufacturer. Never throws -- a missing table yields null.
//
// Phase 2 (lease payments) is additive: when the catalog row carries payment
// data we surface it two ways, and the UI decides how to render:
//   payment_source='advertised' -> manufacturer.payment (a FIXED advertised
//     example for the scraped dealer's vehicle; shown as a reference, never
//     recomputed for the user).
//   payment_source='computed'   -> manufacturer.lease (residual %, apr, term;
//     the UI computes the payment on the USER's own msrp/price, NOT the
//     catalog's scraped cap_cost/down_payment/selling_price).
// cap_cost/down_payment are deliberately NOT read here: those are the scraped
// dealer's vehicle and must never drive the user's computed payment.
async function resolveLeaseRates(analysis: any): Promise<void> {
  const out: any = { manufacturer: null };
  if (analysis.make) {
    const COLS_FULL = "apr, term_months, annual_km, effective_date, model, residual_pct, advertised_payment, advertised_payment_tax, selling_price, payment_source";
    const COLS_BASE = "apr, term_months, annual_km, effective_date, model";
    try {
      // Prefer the Phase-2 columns; if they're not live in this DB yet the
      // select errors, so fall back to APR-only rather than regress lease.
      let data: any[] | null = null;
      const full = await supabase
        .from("lease_rate_catalog")
        .select(COLS_FULL)
        .ilike("make", analysis.make)
        .order("term_months", { ascending: true })
        .limit(50);
      if (full.error) {
        const base = await supabase
          .from("lease_rate_catalog")
          .select(COLS_BASE)
          .ilike("make", analysis.make)
          .order("term_months", { ascending: true })
          .limit(50);
        data = base.data;
      } else {
        data = full.data;
      }
      if (data?.length) {
        const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
        const modelNorm = norm(analysis.model || "");
        const byModel = data.filter((r: any) => r.model && norm(r.model) === modelNorm);
        const pool = byModel.length ? byModel : data.filter((r: any) => !r.model);
        if (pool.length) {
          const pick = pool.find((r: any) => r.term_months === 48) || pool[0];
          const m: any = {
            apr: Number(pick.apr),
            termMonths: pick.term_months,
            annualKm: pick.annual_km ?? null,
            effectiveDate: pick.effective_date,
          };
          const src = pick.payment_source;
          if (src === "advertised" && pick.advertised_payment != null) {
            m.payment = {
              source: "advertised",
              amount: Number(pick.advertised_payment),
              withTax: pick.advertised_payment_tax != null ? Number(pick.advertised_payment_tax) : null,
              sellingPrice: pick.selling_price != null ? Number(pick.selling_price) : null,
              term: pick.term_months,
              annualKm: pick.annual_km ?? null,
            };
          } else if (src === "computed" && pick.residual_pct != null) {
            m.lease = {
              source: "computed",
              residualPct: Number(pick.residual_pct),
              apr: Number(pick.apr),
              term: pick.term_months,
              annualKm: pick.annual_km ?? null,
            };
          }
          out.manufacturer = m;
        }
      }
    } catch (err) {
      console.warn("resolveLeaseRates threw:", err);
    }
  }
  analysis.leaseRates = out;
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
  opts?: { rawModel?: string | null; fuelType?: string | null },
): Promise<number | null> {
  try {
    const { data, error } = await supabase
      .from("msrp_catalog")
      .select("trim, msrp, fuel_type")
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

    // Partition by fuel so a hybrid trim can't collide with its gas twin
    // (Palisade "Luxury Hybrid 8-Passenger" vs a gas "Luxury 8-Passenger").
    // The base-model resolve strips "Hybrid" from the model, so the hybrid
    // signal is recovered from the raw model / verified fuel type / trim text.
    const rowHybrid = (r: any) => /hybrid|phev/i.test(String(r.trim || "")) || /hybrid|phev/i.test(String(r.fuel_type || ""));
    const isHybrid = /hybrid|phev/i.test(String(opts?.rawModel || "")) || /hybrid|phev/i.test(String(opts?.fuelType || "")) || /hybrid|phev/i.test(String(trim || ""));
    let pool = rows;
    if (isHybrid) { const h = rows.filter(rowHybrid); if (h.length) pool = h; }
    else { const g = rows.filter((r: any) => !rowHybrid(r)); if (g.length) pool = g; }

    // Only one row for this year/make/model(/fuel) and no trim to disambiguate.
    if (pool.length === 1 && !trim) return num(pool[0]);

    // Normalise trims, dropping the "hybrid"/"phev" token (the fuel partition
    // above already separated hybrid from gas) so it never blocks a match.
    const norm = (s: string) => s.toLowerCase().replace(/hybrid|phev/g, "").replace(/[^a-z0-9]+/g, "");
    const want = trim ? norm(trim) : "";

    // 1) exact normalized trim match
    let hits = want ? pool.filter((r: any) => r.trim && norm(r.trim) === want) : [];
    // 2) otherwise containment either direction (dealer "GT Premium" vs
    //    catalog "GT (Premium Package)") -- accepted only if it lands on
    //    exactly one row, never an ambiguous set.
    if (hits.length === 0 && want) {
      hits = pool.filter((r: any) => r.trim && (norm(r.trim).includes(want) || want.includes(norm(r.trim))));
    }
    if (hits.length === 1) {
      const v = num(hits[0]);
      console.log(`Catalog MSRP hit: ${year} ${make} ${model} ${trim ?? ""} (${isHybrid ? "hybrid" : "gas"}) -> ${v}`);
      return v;
    }
    console.log(`Catalog MSRP: ${pool.length}/${rows.length} pooled row(s) for ${year} ${make} ${model} but no unambiguous trim match for "${trim ?? ""}" -- deferring to manufacturer fallback.`);
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
  deadline?: number,
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

  // This best-effort fallback runs AFTER the main Claude call, so on the rare
  // slow-Nimble path the request clock may already be well advanced. It needs a
  // ~40s worst case (search + ~30s vx10 extract + Claude). If the caller's
  // request deadline can't accommodate that, skip rather than risk pushing the
  // whole request past Supabase's ~150s kill (which would strand the credit).
  const MFR_MIN_BUDGET_MS = 40_000;
  if (deadline != null && deadline - Date.now() < MFR_MIN_BUDGET_MS) {
    console.log(`Manufacturer MSRP lookup skipped for ${year} ${make} ${model}: only ${Math.max(0, deadline - Date.now())}ms left in the request budget (needs ~${MFR_MIN_BUDGET_MS}ms).`);
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
    const searchRes = await fetchWithRetry("https://sdk.nimbleway.com/v1/search", {
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
    }, { timeoutMs: 15_000, maxAttempts: 2, budgetMs: 20_000, label: "nimble-search" });

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

    const claudeRes = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
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
    }, { timeoutMs: 20_000, maxAttempts: 2, budgetMs: 30_000, label: "anthropic-mfr-msrp" });

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
  // timeoutMs is treated as a TOTAL wall-clock budget for this driver so the
  // documented worst-case chain math (max(vx6,vx8)+vx10+vx10-retry ≈ 102s) is
  // preserved even with the added 429/5xx/network retry: each attempt uses the
  // REMAINING budget, so the sum of attempts never exceeds the per-driver
  // timeout. A fast transient rejection (429/5xx) leaves budget for one quick
  // backoff+retry; a genuine timeout consumes the budget and is NOT retried
  // here (retrying an abort just waits again — the vx10-retry decision lives in
  // fetchListingContent, which keys off the timedOut flag below).
  const deadline = Date.now() + timeoutMs;
  const MAX_ATTEMPTS = 2;
  let lastErr = "";
  let lastTimedOut = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
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
        // Empty/short content is an app-level miss, not a transient server
        // error -- don't retry it here; let the driver escalation handle it.
        return { ok: false, errBody: `200 response but content too short (markdown.length=${md?.length ?? 0})`, timedOut: false };
      }
      // Non-ok HTTP. Retry a transient 429/5xx once if budget/attempts remain.
      const errBody = await res.text();
      lastErr = errBody;
      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS && !externalSignal?.aborted) {
        const ra = parseRetryAfterMs(res);
        const delay = ra != null ? ra : backoffDelayMs(attempt);
        if (Date.now() + delay < deadline) {
          await sleep(delay);
          continue;
        }
      }
      return { ok: false, errBody, timedOut: false };
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "AbortError";
      lastTimedOut = timedOut;
      lastErr = timedOut ? `timed out after ${timeoutMs}ms` : String(err);
      // Aborted by the race winner (external signal) — stop, don't retry.
      if (externalSignal?.aborted) return { ok: false, errBody: lastErr, timedOut };
      // A timeout used the whole budget; retrying just waits again. Surface it
      // so fetchListingContent can apply its timeout-vs-rejection logic.
      if (timedOut) return { ok: false, errBody: lastErr, timedOut: true };
      // Genuine network error — retry if budget/attempts remain.
      if (attempt < MAX_ATTEMPTS) {
        const delay = backoffDelayMs(attempt);
        if (Date.now() + delay < deadline) {
          await sleep(delay);
          continue;
        }
      }
      return { ok: false, errBody: lastErr, timedOut: false };
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
  return { ok: false, errBody: lastErr || "no attempts made within budget", timedOut: lastTimedOut };
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

// ── SM360 quoted-price resolver ────────────────────────────────────────────
// SM360 (the platform behind Dilawri and many other Canadian dealer groups --
// e.g. tazaparkvw.com) renders its listing price client-side, so the generic
// Nimble-markdown -> Claude extractor can miss it entirely (confirmed real
// case: a 2026 VW Atlas Highline demo came back "Quoted price: Not found",
// which then suppressed the over-MSRP flag AND made the financing card fall
// back to MSRP instead of the real ~$62.7K price).
//
// Every SM360 site exposes the SAME public JSON feed the catalog scrapers
// already use (scripts/lib/sm360-stack.mjs):
//   GET {origin}/{locale}/new-inventory/api/listing?page=N
//   -> { vehicles: [ { vehicleId, year, model:{name}, trim:{name},
//                      salePrice, listPrice, hasPrice, ... } ],
//        pagination: { numberOfPages } }
// The detail-page URL carries the unit's id as an `id<digits>` slug token
// (e.g. .../2026-volkswagen-atlas-id38137169), and that number equals the
// feed's top-level `vehicleId` -- CONFIRMED against the live feed, not a guess.
// That per-VIN match matters: a single trim can have dozens of loaded units at
// one dealer with DIFFERENT prices (24 Atlas Highline units spanning
// $61,545-$63,545 on this one lot), so matching by year+model+trim alone would
// pick an arbitrary, likely-wrong unit. We therefore key on vehicleId and only
// fall back to year+model+trim when that yields EXACTLY ONE unit -- never guess
// among several.
//
// Best-effort and fully defensive: bounded pagination, a hard timeout, and any
// failure leaves analysis.quotedPrice untouched (no fabrication). Generic to
// ANY SM360 host, not hardcoded to tazaparkvw.
function parseSm360Listing(url: string): { origin: string; locale: string; vehicleId: number } | null {
  try {
    const u = new URL(url);
    if (!/\/new-inventory\//i.test(u.pathname)) return null;
    // The id token is the unit's vehicleId, as an `id<digits>` slug segment.
    const m = u.pathname.match(/id(\d{4,})(?![0-9])/i);
    if (!m) return null;
    const localeSeg = u.pathname.match(/^\/(en|fr)\//i);
    const locale = localeSeg ? localeSeg[1].toLowerCase() : "en";
    return { origin: u.origin, locale, vehicleId: Number(m[1]) };
  } catch {
    return null;
  }
}

async function fetchSm360Page(
  origin: string,
  locale: string,
  page: number,
  timeoutMs: number,
): Promise<{ vehicles: any[]; numberOfPages: number } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${origin}/${locale}/new-inventory/api/listing?page=${page}`, {
      headers: {
        // Same header set proven against the SM360 feed in sm360-stack.mjs.
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Accept": "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      vehicles: Array.isArray(data?.vehicles) ? data.vehicles : [],
      numberOfPages: Number(data?.pagination?.numberOfPages) || 1,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Reads salePrice first (the actual advertised selling price), then listPrice,
// honouring hasPrice. Returns null when neither is a usable positive number.
function sm360PriceOf(v: any): number | null {
  if (v?.hasPrice === false) return null;
  const sale = Number(v?.salePrice);
  if (Number.isFinite(sale) && sale > 0) return sale;
  const list = Number(v?.listPrice);
  if (Number.isFinite(list) && list > 0) return list;
  return null;
}

async function resolveSm360QuotedPrice(url: string, analysis: any): Promise<void> {
  const parsed = parseSm360Listing(url);
  if (!parsed) return;
  const { origin, locale, vehicleId } = parsed;
  const PAGE_TIMEOUT_MS = 8_000;
  const MAX_PAGES = 25; // hard ceiling regardless of what pagination claims

  try {
    const norm = (s: any) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    const wantYear = Number(analysis?.year) || null;
    const wantModel = norm(analysis?.model);
    const wantTrim = norm(analysis?.trim);
    const fallbackMatches: any[] = [];

    let pages = 1;
    for (let page = 1; page <= pages && page <= MAX_PAGES; page++) {
      const res = await fetchSm360Page(origin, locale, page, PAGE_TIMEOUT_MS);
      if (!res) {
        console.warn(`SM360 resolver: page ${page} fetch failed for ${origin}; aborting resolver.`);
        return;
      }
      pages = Math.min(res.numberOfPages, MAX_PAGES);
      for (const v of res.vehicles) {
        // Primary path: exact vehicleId match -- the id from the URL slug.
        if (Number(v?.vehicleId) === vehicleId) {
          const price = sm360PriceOf(v);
          if (price != null) {
            analysis.quotedPrice = price;
            analysis.quotedPriceSource = "sm360_feed";
            console.log(`SM360 resolver: matched vehicleId ${vehicleId} on page ${page}, quotedPrice=${price} (salePrice=${v?.salePrice}, listPrice=${v?.listPrice}).`);
            return;
          }
          console.log(`SM360 resolver: matched vehicleId ${vehicleId} but it has no usable price (hasPrice=${v?.hasPrice}).`);
          return;
        }
        // Collect fallback candidates while we scan, in case the id never matches.
        if (wantYear && wantModel && Number(v?.year) === wantYear && norm(v?.model?.name) === wantModel) {
          if (!wantTrim || norm(v?.trim?.name) === wantTrim) fallbackMatches.push(v);
        }
      }
    }

    // Fallback: no id match (e.g. the unit sold and rotated out of the feed, or
    // the slug id scheme differs on some host). Only trust it when it lands on
    // EXACTLY ONE unit -- multiple same-trim units carry different prices, so
    // guessing one would be fabrication. Also require a positive price.
    const priced = fallbackMatches.filter((v) => sm360PriceOf(v) != null);
    if (priced.length === 1) {
      const price = sm360PriceOf(priced[0])!;
      analysis.quotedPrice = price;
      analysis.quotedPriceSource = "sm360_feed_fallback";
      console.log(`SM360 resolver: no vehicleId match for ${vehicleId}; single year+model+trim unit matched, quotedPrice=${price}.`);
    } else {
      console.log(`SM360 resolver: no confident match for vehicleId ${vehicleId} (${priced.length} priced fallback candidate(s)); leaving quotedPrice as-is.`);
    }
  } catch (err) {
    console.warn("resolveSm360QuotedPrice threw:", err);
  }
}

// Maps an SM360 feed vehicle's fuel descriptor to the report's fuelType enum
// ("BEV" | "PHEV" | "Hybrid" | "Gas" | "Diesel" | null). Conservative: only
// returns a value it can defend from the feed's own fields; leaves null on
// anything ambiguous (applyVerifiedFuelType may still override from the
// catalog). Never fabricates -- an unknown fuel stays null.
function sm360FuelType(v: any): string | null {
  const slug = String(v?.fuel?.slug ?? v?.fuel?.name ?? "").toLowerCase();
  const batt = Number(v?.batteryCapacity) || 0;
  const range = Number(v?.batteryRange) || 0;
  if (/plug|phev/.test(slug)) return "PHEV";
  if (/hybrid/.test(slug)) return "Hybrid";
  if (/electric|\bev\b|bev/.test(slug)) return "BEV";
  if (/diesel/.test(slug)) return "Diesel";
  if (/gas|petrol/.test(slug)) return "Gas";
  // No usable fuel slug; only call it a BEV if the feed carries real battery
  // specs, never on a bare zero.
  if (batt > 0 && range > 0) return "BEV";
  return null;
}

// ── SM360 feed FALLBACK builder ─────────────────────────────────────────────
// When the dealer PAGE scrape fails/bot-blocks on an SM360 listing, the price
// and core vehicle data for that exact unit are still available in the SM360
// JSON feed (which does NOT depend on the page rendering). Rather than hard-
// fail, this builds a real (possibly partial) analysis object from the feed's
// own fields for the unit whose vehicleId is in the URL slug, so the report is
// as rich as the feed allows.
//
// Matches on vehicleId only: unlike resolveSm360QuotedPrice's secondary
// year+model+trim path, the page never loaded here, so there is no extracted
// year/model/trim to match against -- vehicleId (from the URL) is the only key.
// If the id isn't in the feed, returns null and the caller falls back to the
// original "couldn't load / try screenshot" error. Never fabricates: any field
// the feed doesn't provide is left unset. Fully defensive: bounded pagination,
// per-page timeout, and any throw yields null.
async function buildSm360FallbackAnalysis(url: string): Promise<any | null> {
  const parsed = parseSm360Listing(url);
  if (!parsed) return null;
  const { origin, locale, vehicleId } = parsed;
  const PAGE_TIMEOUT_MS = 8_000;
  const MAX_PAGES = 25;

  try {
    let pages = 1;
    let match: any = null;
    for (let page = 1; page <= pages && page <= MAX_PAGES; page++) {
      const res = await fetchSm360Page(origin, locale, page, PAGE_TIMEOUT_MS);
      if (!res) {
        console.warn(`SM360 fallback: page ${page} fetch failed for ${origin}; aborting fallback.`);
        return null;
      }
      pages = Math.min(res.numberOfPages, MAX_PAGES);
      match = res.vehicles.find((v: any) => Number(v?.vehicleId) === vehicleId) ?? null;
      if (match) break;
    }
    if (!match) {
      console.log(`SM360 fallback: vehicleId ${vehicleId} not found in feed for ${origin}; cannot build fallback.`);
      return null;
    }

    const price = sm360PriceOf(match);
    const year = Number(match?.year) || null;
    const make = typeof match?.make?.name === "string" ? match.make.name : null;
    const model = typeof match?.model?.name === "string" ? match.model.name : null;
    const trim = typeof match?.trim?.name === "string" ? match.trim.name : null;

    // VIN: the feed exposes it as `serialNo`. Only carry it if it at least
    // looks like a 17-char VIN; validateVin re-checks the check digit
    // downstream. Never invent one.
    const vinRaw = typeof match?.serialNo === "string" ? match.serialNo.trim().toUpperCase() : "";
    const vin = /^[A-HJ-NPR-Z0-9]{17}$/.test(vinRaw) ? vinRaw : null;

    const odoNum = Number(match?.odometer);
    const odometerKm = Number.isFinite(odoNum) && odoNum >= 0 ? odoNum : null;

    const condition = match?.newVehicle === true
      ? "new"
      : match?.newVehicle === false
        ? "used"
        : (typeof match?.paymentOptions?.vehicleCondition === "string" ? match.paymentOptions.vehicleCondition : null);

    const org = match?.primaryOrganizationUnit;
    const dealerName = typeof org?.name === "string" ? org.name : null;
    const dealerCity = typeof org?.city === "string"
      ? (org?.province?.provinceCode ? `${org.city}, ${org.province.provinceCode}` : org.city)
      : null;

    const vehicleStr = [year, make, model, trim].filter(Boolean).join(" ") || null;

    const analysis: any = {
      vehicle: vehicleStr,
      year,
      make,
      model,
      trim,
      vin,
      odometerKm,
      fuelType: sm360FuelType(match),
      vehicleCondition: condition,
      dealerName,
      dealerCity,
      // MSRP is NOT in the feed as a standalone figure (salePrice/listPrice are
      // the selling price). Leave null so the downstream catalog/manufacturer
      // MSRP lookup fills it if it can -- same as the normal path.
      msrp: null,
      quotedPrice: price,
      quotedPriceSource: price != null ? "sm360_feed" : null,
      // The feed carries no itemized fees, no page financing disclosure, and no
      // standalone warranty terms. Leave these empty/null rather than invent
      // them; applyVerifiedWarranty still fills a NEW vehicle's real warranty
      // from LotCheck's own verified table during enrichment.
      standardWarranty: null,
      addOns: [],
      totalFlaggedCost: 0,
      warranty: null,
      financing: null,
      // Honesty flags the UI can surface: the page itself could not be read,
      // and this report was built from the dealer's own inventory feed.
      source: "sm360_feed_fallback",
      sourceNote: "The dealer's listing page couldn't be loaded (its site was blocking automated access), so this report was built from the dealer's own inventory feed instead. Core vehicle details and the advertised price come straight from that feed. Itemized fees and the financing terms shown on the page couldn't be read and aren't included here.",
      summary: `${vehicleStr ?? "This vehicle"}${price != null ? ` is listed at $${price.toLocaleString()}` : ""}. The dealer's listing page couldn't be loaded, so this report is based on the dealer's inventory feed rather than the full page -- itemized fees and the page's financing terms aren't included. Confirm the out-the-door price, any add-on fees, and financing details directly with the dealer.`,
    };

    console.log(`SM360 fallback: built analysis for vehicleId ${vehicleId} (${vehicleStr ?? "unknown vehicle"}), price=${price ?? "none"}, vin=${vin ? "present" : "none"}, odometer=${odometerKm ?? "none"}, condition=${condition ?? "unknown"}, fuelType=${analysis.fuelType ?? "none"}.`);
    return analysis;
  } catch (err) {
    console.warn("buildSm360FallbackAnalysis threw:", err);
    return null;
  }
}

// ── Direct-fetch + schema.org JSON-LD fallback ──────────────────────────────
// When the Nimble page scrape fails AND the SM360 inventory-feed fallback
// doesn't apply -- e.g. a `/new-catalog/` model/brochure page whose slug id is
// a CATALOG id, not a lot unit's vehicleId (so it's absent from the inventory
// feed), or a non-SM360 platform -- many modern dealer platforms STILL serve
// the full HTML, including a clean schema.org Vehicle/Car + Offer JSON-LD block,
// to a plain browser-UA fetch, even from behind Cloudflare where Nimble's
// drivers get walled. Confirmed live (2026-07-30, tazaparkvw.com SM360 catalog
// page): a direct fetch returned HTTP 200 with `"@type":"Car"` carrying
// year/make/model/trim + `offers.price` (CAD), no Cloudflare challenge. This
// builds a real, clearly-labelled, STRUCTURED-ONLY analysis from that data
// (price + core vehicle facts); the shared enrichment then fills
// MSRP/recalls/warranty/leverage. Page fees/financing are NOT read (that needs
// the rendered page), so the sourceNote says so and points to the screenshot
// path. Never throws; returns null when there's no usable priced vehicle node.
async function fetchDirectHtml(url: string, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-CA,en;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const html = await res.text();
    return html && html.length > 0 ? html : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Pull the first schema.org Vehicle/Car/Product node that carries an Offer with
// a price out of a page's <script type="application/ld+json"> blocks. Handles
// @graph arrays and a top-level array of nodes. Returns normalized fields, or
// null if no usable vehicle node is present. Never throws.
function extractJsonLdVehicle(html: string): {
  year: number | null; make: string | null; model: string | null; trim: string | null;
  vin: string | null; odometerKm: number | null; price: number | null; currency: string | null;
  condition: string | null; dealerName: string | null; dealerCity: string | null;
} | null {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1].trim());
  if (blocks.length === 0) return null;

  const nodes: any[] = [];
  for (const b of blocks) {
    try {
      const parsed = JSON.parse(b);
      const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.["@graph"]) ? parsed["@graph"] : [parsed]);
      for (const n of arr) if (n && typeof n === "object") nodes.push(n);
    } catch { /* one malformed block never sinks the rest */ }
  }

  const typeOf = (n: any): string[] => {
    const t = n?.["@type"];
    return Array.isArray(t) ? t.map(String) : (t ? [String(t)] : []);
  };
  const isVehicle = (n: any) => typeOf(n).some((t) => /^(Car|Vehicle|MotorizedVehicle|Product)$/i.test(t));
  const firstOffer = (n: any): any => {
    const o = n?.offers;
    if (!o) return null;
    return Array.isArray(o) ? (o[0] ?? null) : o;
  };
  const priceFrom = (offer: any): number | null => {
    if (!offer) return null;
    const cand = offer.price ?? offer.lowPrice ?? offer?.priceSpecification?.price;
    const num = Number(String(cand ?? "").replace(/[^0-9.]/g, ""));
    return Number.isFinite(num) && num > 0 ? num : null;
  };

  let node: any = null; let offer: any = null; let price: number | null = null;
  for (const n of nodes) {
    if (!isVehicle(n)) continue;
    const o = firstOffer(n);
    const p = priceFrom(o);
    if (p != null) { node = n; offer = o; price = p; break; } // best: a priced vehicle node
    if (!node) { node = n; offer = o; } // weak fallback: a vehicle node with no price
  }
  if (!node) return null;
  if (price == null) price = priceFrom(offer);

  const str = (v: any): string | null =>
    (typeof v === "string" && v.trim()) ? v.trim()
      : (v && typeof v.name === "string" && v.name.trim()) ? v.name.trim() : null;
  const titleCase = (s: string | null) => s ? s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()) : s;

  const yearRaw = node.vehicleModelDate ?? node.modelDate ?? node.productionDate ?? node.releaseDate;
  const ym = String(yearRaw ?? "").match(/\b(19|20)\d{2}\b/);
  const year = ym ? Number(ym[0]) : null;

  const make = titleCase(str(node.brand) || str(node.manufacturer));
  const model = str(node.model) || str(node.name);
  const trim = titleCase(str(node.vehicleConfiguration) || str(node.trim) || str(node.vehicleModelConfiguration));

  const vinRaw = typeof node.vehicleIdentificationNumber === "string" ? node.vehicleIdentificationNumber.trim().toUpperCase() : "";
  const vin = (/^[A-HJ-NPR-Z0-9]{17}$/.test(vinRaw) && !/^(.)\1{16}$/.test(vinRaw)) ? vinRaw : null;

  let odometerKm: number | null = null;
  const odo = node.mileageFromOdometer;
  if (odo != null) {
    const v = Number(typeof odo === "object" ? odo.value : odo);
    if (Number.isFinite(v) && v >= 0) {
      const unit = String(typeof odo === "object" ? (odo.unitCode || odo.unitText || "") : "").toUpperCase();
      odometerKm = /SMI|MILE/.test(unit) ? Math.round(v * 1.60934) : Math.round(v);
    }
  }

  const cond = String(node.itemCondition || offer?.itemCondition || "").toLowerCase();
  let condition: string | null = /new/.test(cond) ? "new" : (/used|refurb/.test(cond) ? "used" : null);
  if (condition == null && odometerKm != null) condition = odometerKm <= 100 ? "new" : "used";

  const currency = str(offer?.priceCurrency);
  const seller = offer?.seller || node?.seller;
  const addr = seller?.address;
  const locality = str(addr?.addressLocality);
  const region = str(addr?.addressRegion);
  const dealerCity = locality ? (region ? `${locality}, ${region}` : locality) : null;

  if (!year && !make && !model && price == null) return null;
  return { year, make, model, trim, vin, odometerKm, price, currency, condition, dealerName: str(seller?.name), dealerCity };
}

async function buildJsonLdFallbackAnalysis(url: string): Promise<any | null> {
  try {
    const html = await fetchDirectHtml(url, 15_000);
    if (!html) { console.log(`JSON-LD fallback: direct fetch returned nothing for ${url}.`); return null; }
    const v = extractJsonLdVehicle(html);
    if (!v || (v.price == null && !v.year && !v.model)) {
      console.log(`JSON-LD fallback: no usable schema.org Vehicle/Offer in ${url}.`);
      return null;
    }
    const vehicleStr = [v.year, v.make, v.model, v.trim].filter(Boolean).join(" ") || null;
    const analysis: any = {
      vehicle: vehicleStr,
      year: v.year, make: v.make, model: v.model, trim: v.trim,
      vin: v.vin, odometerKm: v.odometerKm, fuelType: null,
      vehicleCondition: v.condition,
      dealerName: v.dealerName, dealerCity: v.dealerCity,
      msrp: null,
      quotedPrice: v.price,
      quotedPriceSource: v.price != null ? "structured_data" : null,
      standardWarranty: null,
      addOns: [], totalFlaggedCost: 0, warranty: null, financing: null,
      source: "structured_data_fallback",
      sourceNote: "The dealer's listing page couldn't be read the usual way, so this report was built from the page's own structured product data (schema.org). Core vehicle details and the advertised price come straight from that data. Itemized fees and the page's financing terms couldn't be read this way and aren't included -- upload a screenshot for the full breakdown.",
      summary: `${vehicleStr ?? "This vehicle"}${v.price != null ? ` is listed at $${v.price.toLocaleString()}${v.currency && v.currency !== "CAD" ? " " + v.currency : ""}` : ""}. This report was built from the page's structured data rather than the full page, so itemized fees and financing terms aren't included -- confirm the out-the-door price, any add-on fees, and financing details directly with the dealer.`,
    };
    console.log(`JSON-LD fallback: built analysis for ${url} (${vehicleStr ?? "unknown"}), price=${v.price ?? "none"}, vin=${v.vin ? "present" : "none"}, condition=${v.condition ?? "unknown"}.`);
    return analysis;
  } catch (err) {
    console.warn("buildJsonLdFallbackAnalysis threw:", err);
    return null;
  }
}

// Shared downstream enrichment, run identically by BOTH the normal page-scrape
// path and the SM360 feed fallback so a fallback report is as rich as its
// (partial) data allows: verified warranty + fuel type, VIN pattern/check-digit
// validation, Transport Canada recall lookup, the catalog->manufacturer MSRP
// fallback, the financing/odometer plausibility checks, dealer/manufacturer
// finance + lease rates, and finally the deterministic leverage score (which
// must run last, after msrp/recalls/financing are populated). Every step is
// individually defensive and skips itself when its inputs are absent, so a
// partial fallback analysis (e.g. no financing, no MSRP) simply gets fewer
// checks rather than erroring.
async function enrichAnalysis(analysis: any, deadline?: number): Promise<void> {
  await applyVerifiedWarranty(analysis);
  await applyRemainingWarranty(analysis);
  await applyVerifiedFuelType(analysis);
  // Auto market value (best-effort, live mode only). No-op until VINAUDIT_MODE=live.
  if (analysis.vin) { const mv = await fetchMarketValue(analysis.vin, analysis.odometerKm != null ? Number(analysis.odometerKm) : null); if (mv) analysis.marketValue = mv; }
  analysis.vinCheck = validateVin(analysis.vin);
  // Canonical base model resolved once (e.g. "Palisade Ultimate Calligraphy" ->
  // "PALISADE"), feeding BOTH the recall and MSRP lookups so trim in the model
  // field can't produce a false "no recalls"/"MSRP not found". See make-recalls-fail-safe.
  const baseModel = await resolveBaseModel(analysis.year, analysis.make, analysis.model);
  if (analysis.year && analysis.make && analysis.model) {
    analysis.recalls = await lookupRecalls(analysis.year, analysis.make, analysis.model, baseModel);
  }

  // Manufacturer-site MSRP fallback -- only spend the extra search+extraction
  // cost when the vehicle doesn't already carry an MSRP. Catalog (a fast DB
  // read) is tried first; only on a miss does the ~30s manufacturer scrape run.
  // The request deadline is threaded through so this expensive step self-skips
  // when there isn't enough budget left to finish before the platform ceiling.
  if (!analysis.msrp && analysis.year && analysis.make && analysis.model) {
    const catMsrp = await lookupCatalogMsrp(analysis.year, analysis.make, baseModel || analysis.model, analysis.trim ?? null, { rawModel: analysis.model, fuelType: analysis.fuelType });
    if (catMsrp) {
      analysis.msrp = catMsrp;
      analysis.msrpSource = "catalog";
    } else {
      const mfrMsrp = await lookupManufacturerMsrp(analysis.year, analysis.make, analysis.model, analysis.trim ?? null, deadline);
      if (mfrMsrp) {
        analysis.msrp = mfrMsrp;
        analysis.msrpSource = "manufacturer_site";
      }
    }
  }

  computeFinancingCheck(analysis);
  computeOdometerCheck(analysis);
  await resolveFinanceRates(analysis);
  await resolveLeaseRates(analysis);
  computeLeverageScore(analysis);
  // Deal Decoder — run AFTER msrp + finance rates are resolved.
  { const rec = computeReconciliation(analysis); if (rec) analysis.reconciliation = rec; }   // S3
  { const ft = computeFinancingTrap(analysis); if (ft) analysis.financingTrap = ft; }         // S11
  { const df = assessDocFee(analysis); if (df) analysis.docFeeCheck = df; }                   // S12
  analysis.counterScript = buildCounterScript(analysis);                                       // counter-script (last)
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

  // Request-level time budget. Supabase kills a function at ~150s (a raw 504
  // that skips our credit-release path and strands the hold), so every retry/
  // timeout decision downstream is bounded against a ~140s deadline to leave
  // margin. The Nimble chain can already eat up to ~102s, so the main Claude
  // call and the MSRP fallback both clamp their budgets to whatever remains.
  const REQUEST_DEADLINE = Date.now() + 140_000;

  if (!ANTHROPIC_API_KEY || !NIMBLE_API_KEY) {
    console.error("ANTHROPIC_API_KEY or NIMBLE_API_KEY is not set on this function.");
    return new Response(
      JSON.stringify({ error: "Listing analysis isn't configured yet." }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }

  // Anonymous by default: null user → existing flow, no credit logic at all.
  const creditUser = await resolveCreditUser(req);
  let holdId: string | null = null;

  try {
    const { url } = await req.json();
    if (!url || typeof url !== "string") {
      return new Response(
        JSON.stringify({ error: "No listing URL received." }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    // Authorize a credit hold before any expensive work — and before the cache
    // fast-path, since a cache hit is still a delivered accurate result that
    // must capture. Signed-in only; anonymous callers skip this entirely. The
    // 400 above runs before this, so a rejected request never places a hold.
    if (creditUser) {
      const authz = await authorizeCredit(creditUser.id);
      if (!authz.ok) {
        if (authz.kind === "out_of_credits") {
          return new Response(
            JSON.stringify({ error: "out_of_credits" }),
            { status: 402, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({ error: "Something went wrong analyzing that listing." }),
          { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
        );
      }
      holdId = authz.holdId;
    } else {
      // Anonymous request: enforce the global free-check breaker BEFORE any
      // expensive Nimble/Claude work (and before the cache fast-path), so a
      // blocked check costs nothing. Signed-in callers took the credit-authorize
      // branch above and are unaffected.
      const allowed = await tryFreeCheck(req);
      if (!allowed) {
        return new Response(JSON.stringify({ error: "free_limit_reached" }), {
          status: 429,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
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
        // Guardrail: an empty cached entry (no price/MSRP) is not a report --
        // don't charge, steer to upload (same as the fresh-scrape path).
        const cachedHasPricing = (Number(cached.analysis.quotedPrice) > 0) || (Number(cached.analysis.msrp) > 0);
        if (!cachedHasPricing) {
          await releaseCredit(holdId);
          holdId = null;
          return new Response(
            JSON.stringify({ error: "unreadable_listing", message: "We couldn't read the price on this dealer listing — a lot of dealer sites block automated reading. Upload a screenshot or PDF of the quote or window sticker instead and we'll read it reliably. You haven't been charged.", vehicle: cached.analysis.vehicle || null, dealerName: cached.analysis.dealerName || null }),
            { status: 422, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
          );
        }
        await finalizeServerSide(cached.analysis); // finalizes entries cached before this change
        // A cached delivery is still a delivered accurate result -> capture.
        const credits = await captureCredit(holdId);
        holdId = null;
        return new Response(
          JSON.stringify(credits
            ? { analysis: cached.analysis, cached: true, credits }
            : { analysis: cached.analysis, cached: true }),
          { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
        );
      }
    } catch (err) {
      console.warn("Cache read failed (continuing with fresh scan):", err);
    }

    const nimbleResult = await fetchListingContent(url);
    if (!("data" in nimbleResult)) {
      console.error("Nimble extract failed after all attempts:", nimbleResult.errBody);

      // Page load genuinely failed. Before hard-failing, if this is an SM360
      // dealer listing, fall back to the platform's own JSON feed -- the price
      // and core vehicle data for this exact unit live there and do NOT depend
      // on the page rendering. This turns a "site is blocking us" dead end into
      // a real (clearly-labelled, possibly partial) report. Only fires for
      // SM360 URLs, and only here -- after the normal page path has already
      // failed -- so pages that DO load are completely unaffected.
      const fallback = await buildSm360FallbackAnalysis(url);
      if (fallback) {
        await enrichAnalysis(fallback, REQUEST_DEADLINE);
        await finalizeServerSide(fallback);
        try {
          await supabase
            .from("listing_analysis_cache")
            .upsert({ url, analysis: fallback, created_at: new Date().toISOString() }, { onConflict: "url" });
        } catch (err) {
          console.warn("Cache write failed (SM360 fallback):", err);
        }
        // Logged as a success: we returned a usable report, just via the feed.
        await logUsage({ success: true, errorMessage: `page-load failed, served SM360 feed fallback` });
        console.log(`Served SM360 feed fallback for ${url} after page-load failure (${nimbleResult.errBody}).`);
        // A usable report was delivered (via the feed) -> capture.
        const credits = await captureCredit(holdId);
        holdId = null;
        return new Response(
          JSON.stringify(credits
            ? { analysis: fallback, source: "sm360_feed_fallback", credits }
            : { analysis: fallback, source: "sm360_feed_fallback" }),
          { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
        );
      }

      // Second fallback: many dealer platforms (incl. SM360 `/new-catalog/`
      // model pages, whose slug id isn't an inventory vehicleId, and non-SM360
      // sites) still serve clean schema.org Vehicle/Offer JSON-LD to a plain
      // browser-UA fetch even when Nimble is walled. Build a structured-only
      // report from that. Only runs after BOTH the page scrape and the SM360
      // feed fallback have already failed, so pages that load are unaffected.
      const jsonLdFallback = await buildJsonLdFallbackAnalysis(url);
      if (jsonLdFallback) {
        await enrichAnalysis(jsonLdFallback, REQUEST_DEADLINE);
        await finalizeServerSide(jsonLdFallback);
        try {
          await supabase
            .from("listing_analysis_cache")
            .upsert({ url, analysis: jsonLdFallback, created_at: new Date().toISOString() }, { onConflict: "url" });
        } catch (err) {
          console.warn("Cache write failed (JSON-LD fallback):", err);
        }
        await logUsage({ success: true, errorMessage: `page-load failed, served structured-data (JSON-LD) fallback` });
        console.log(`Served structured-data (JSON-LD) fallback for ${url} after page-load failure (${nimbleResult.errBody}).`);
        const credits = await captureCredit(holdId);
        holdId = null;
        return new Response(
          JSON.stringify(credits
            ? { analysis: jsonLdFallback, source: "structured_data_fallback", credits }
            : { analysis: jsonLdFallback, source: "structured_data_fallback" }),
          { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
        );
      }

      // Not an SM360 listing (or its feed was also unreachable / the unit isn't
      // in the feed): keep today's behaviour exactly.
      await logUsage({ success: false, errorMessage: `Nimble failed: ${nimbleResult.errBody}` });
      await releaseCredit(holdId);
      holdId = null;
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
      await releaseCredit(holdId);
      holdId = null;
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

    // Tighter per-attempt timeout than analyze-quote's (~45s) because the Nimble
    // chain above may already have consumed time; the budget is clamped to the
    // request deadline so on the slow-Nimble path this makes a single bounded
    // attempt instead of two. On timeout/network exhaustion fetchWithRetry
    // throws → the outer catch logs + releases the credit hold (no strand); a
    // spent-budget 5xx returns non-ok → the !ok branch below releases.
    const claudeBudget = Math.max(1_000, REQUEST_DEADLINE - Date.now());
    const claudeRes = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
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
    }, { timeoutMs: 45_000, maxAttempts: 2, budgetMs: claudeBudget, label: "anthropic-listing" });

    if (!claudeRes.ok) {
      const errBody = await claudeRes.text();
      console.error("Claude API call failed:", claudeRes.status, errBody);
      await logUsage({ success: false, errorMessage: `Claude HTTP ${claudeRes.status}` });
      await releaseCredit(holdId);
      holdId = null;
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
      await releaseCredit(holdId);
      holdId = null;
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
      await releaseCredit(holdId);
      holdId = null;
      return new Response(
        JSON.stringify({ error: "Couldn't read that listing clearly. Try a different page." }),
        { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    // SM360 quoted-price resolver: SM360 dealer sites render the price
    // client-side, so the markdown extractor above can miss it. When this is
    // an SM360 listing URL we prefer the platform's own JSON feed as the
    // authoritative price for THIS exact unit (matched by the id in the URL),
    // overriding whatever the generic extractor did or didn't find. Best-
    // effort: on any failure it leaves analysis.quotedPrice untouched.
    await resolveSm360QuotedPrice(url, analysis);

    // Shared downstream enrichment (verified warranty/fuel, VIN check, recalls,
    // catalog->manufacturer MSRP fallback, financing/odometer checks, finance +
    // lease rates, leverage score) -- the SAME sequence the SM360 feed fallback
    // runs, so the two paths never drift apart.
    await enrichAnalysis(analysis, REQUEST_DEADLINE);

    // GUARDRAIL: many dealer sites are JS-rendered and/or bot-protected, so the
    // scrape can come back with no usable pricing. A report with no asking price
    // AND no MSRP is not a Quote Check -- it's an empty page. Do NOT charge for
    // it and do NOT deliver it as a report; tell the client to steer the buyer
    // to the photo/PDF upload (which reads the real quote reliably). Also skip
    // the cache so a later upload/readable retry isn't blocked by an empty hit.
    let gotPricing = (Number(analysis.quotedPrice) > 0) || (Number(analysis.msrp) > 0);

    // RESCUE (inert unless SCRAPFLY_API_KEY is set): the normal Nimble path got
    // no price -> render the page through Scrapfly's anti-bot engine and read the
    // result with Claude vision (the "render the page, then read what a human
    // sees" flow), then re-enrich. Turns a would-be empty report into a real one
    // for JS-rendered / bot-protected dealer sites. Fully fail-safe: any failure
    // returns null and we fall through to the guardrail exactly as before.
    if (!gotPricing && scrapflyEnabled()) {
      try {
        const rescued = await rescueListingViaScrapfly(url, {
          systemPrompt: SYSTEM_PROMPT, anthropicKey: ANTHROPIC_API_KEY, model: CLAUDE_MODEL,
          budgetMs: Math.max(1_000, REQUEST_DEADLINE - Date.now()),
        });
        if (rescued) {
          mergeRescued(analysis, rescued);
          await enrichAnalysis(analysis, REQUEST_DEADLINE);
          gotPricing = (Number(analysis.quotedPrice) > 0) || (Number(analysis.msrp) > 0);
          console.log(`Scrapfly rescue for ${url}: gotPricing=${gotPricing}, price=${analysis.quotedPrice}, msrp=${analysis.msrp}`);
        }
      } catch (e) { console.warn("Scrapfly rescue threw (ignored):", (e as Error)?.message); }
    }

    if (!gotPricing) {
      await logUsage({ success: false, errorMessage: "unreadable_listing (no price/MSRP extracted)" });
      await releaseCredit(holdId);
      holdId = null;
      return new Response(
        JSON.stringify({
          error: "unreadable_listing",
          message: "We couldn't read the price on this dealer listing — a lot of dealer sites block automated reading. Upload a screenshot or PDF of the quote or window sticker instead and we'll read it reliably. You haven't been charged.",
          vehicle: analysis.vehicle || null,
          dealerName: analysis.dealerName || null,
        }),
        { status: 422, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    await finalizeServerSide(analysis);

    // Flywheel Phase 1 — LOG ONLY, stores nothing. Projects the (already
    // extracted) fees into DE-IDENTIFIED observations so we can validate the
    // normalizer against real quotes. No DB write; gated behind FLYWHEEL_LOG.
    // Capture (writing rows) is Phase 3, gated on legal sign-off.
    if (Deno.env.get("FLYWHEEL_LOG") === "on") {
      try { const obs = buildFeeObservations(analysis); if (obs.length) console.log(`flywheel: ${obs.length} fee obs ${JSON.stringify(obs)}`); } catch (e) { console.warn("flywheel log skipped:", (e as Error)?.message); }
    }

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

    // Delivered an accurate result -> capture the hold (signed-in only) and
    // include the new balance. Null holdId out first so a later throw can't
    // release a hold we've decided to charge. `analysis` is unchanged either way.
    const credits = await captureCredit(holdId);
    holdId = null;
    return new Response(
      JSON.stringify(credits ? { analysis, credits } : { analysis }),
      { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("analyze-listing-url error:", err);
    await logUsage({ success: false, errorMessage: String(err) });
    // Any throw after a hold was placed must not charge the user.
    await releaseCredit(holdId);
    holdId = null;
    return new Response(
      JSON.stringify({ error: "Something went wrong analyzing that listing." }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
});
