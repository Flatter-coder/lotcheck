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
// The Transport Canada recall lookup. This file used to carry its own copy —
// so did analyze-listing-url and search-recalls, four in all, and they had
// already drifted apart. See _shared/recalls.ts for what the drift cost.
import { lookupRecalls } from "../_shared/recalls.ts";
import { rescueListingViaScrapfly, mergeRescued, scrapflyEnabled, attachSealedScreenshot, captureListingScreenshot, scrapflyRender, lastScrapflyError, type RenderResult } from "../_shared/scrapfly.ts";
import { resolvePageSource } from "../_shared/page-source.js";
import { matchTradeInWidget } from "../_shared/tradein-detect.js";
import { matchLicensee, classifyStatus, normName as amvicNorm } from "../_shared/amvic-match.js";
import { extractJsonLdVehicle } from "../_shared/jsonld-vehicle.js";
import { extractConvertusVmsVehicle } from "../_shared/convertus-vms.js";
import { extractD2cVdpVehicle } from "../_shared/d2c-vdp.js";
import { extractAdvertisedApr } from "../_shared/apr-extract.js";
import { detectFinanceContingent } from "../_shared/finance-contingent.js";
import { extractCashIncentives, incentivesToAddOns } from "../_shared/incentive-extract.js";
import { resolveMsrpAuthority } from "../_shared/msrp-authority.js";
import { qualifyMsrpClaim, qualifyCeilingClaim } from "../_shared/msrp-claim.ts";
import { buildFeeObservations } from "../_shared/fee-vocab.ts";
import { canonicalMake } from "../_shared/makes.ts";
import { computeRemainingWarranty } from "../_shared/warranty.ts";
import { fetchMarketValue } from "../_shared/marketvalue.ts";
import { computeReconciliation, computeFinancingTrap, buildCounterScript, hasTrustedFinanceRate } from "../_shared/deal.ts";
import { assessDocFee, resolveAllInAuthority } from "../_shared/docfee.ts";
import { deriveSaleCondition } from "../_shared/condition.ts";
import { isAllInJurisdiction } from "../_shared/jurisdiction.ts";
import { computeReferenceFinancing } from "../_shared/reference-financing.ts";
import { resolveCity, resolveJurisdiction } from "../_shared/jurisdiction.ts";
import { stripSettledContradictions } from "../_shared/settled-claims.ts";
import { assessDisclaimer } from "../_shared/disclaimer.ts";
import { pickTrimMsrp } from "../_shared/trim-match.js";
import { validateVin, assertInvariants } from "../_shared/invariants.ts";
import { recordCheckpoints } from "../_shared/verification-checkpoints.ts";
import { gateRequest } from "../_shared/region-gate.js";
import { powertrainCompatible, stripPowertrain } from "../_shared/model-identity.js";

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
// Bump on ANY logic change that affects report content. Cached rows written
// by an older version are treated as misses and re-scanned -- this replaces
// the manual "DELETE FROM listing_analysis_cache" step after every deploy.
// BUMP THIS WHENEVER ANALYSIS OUTPUT CHANGES. Cached reports are keyed by it,
// so a logic fix that ships without a bump is a fix nobody sees — the stored
// report is replayed instead, with the SAME report id, which makes it look like
// the deploy failed. That happened on 2026-08-15: the all-in comparison, the
// ceiling claim, priceVerified and the powertrain guard all shipped against a
// stale key and a re-run returned the identical LC-DD3D-16F.
const CACHE_VER = "2026-08-27i";  // + trim rows name which nameplate they belong to, one cap on every surface, and the "sits above N of M" count is taken over the FULL ladder

// The one and only "we couldn't build you a report" message. Both the cached
// and the fresh-scrape paths return it, so the buyer never sees two different
// apologies for the same outcome — and a future edit can't fix one and miss
// the other. Every element here is load-bearing:
//   apology  — we failed, not them
//   refund   — stated as already done, not as something they must request
//   two ways forward — upload the paperwork, OR price the same vehicle at
//                      another dealer (an unreadable listing is often a
//                      price-gated one, and another dealer may publish it)
const UNREADABLE_LISTING_MESSAGE =
  "Sorry — we couldn't read the price on this dealer listing, so there's no report to give you. " +
  "Your credit has already been refunded automatically; you haven't been charged. " +
  "Two ways forward: upload a screenshot or PDF of the quote or window sticker and we'll read it reliably, " +
  "or run the same vehicle at another dealer — a listing we can't read is often one where the price is deliberately withheld.";

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

// ── Multi-vehicle-page detection (URL path) ─────────────────────────────────
// analyze-quote (uploads) already rejects a multi-vehicle image without
// charging. This is the URL-scan equivalent -- a pasted link to an inventory
// or search-results page, not one vehicle's own page, had NO detection at
// all until now (Vic, 2026-08-20: "reject with kind message ... some
// professional"). Deterministic and cheap on purpose, run BEFORE the
// expensive Claude extraction call: a single-vehicle detail page states
// exactly one VIN; an inventory grid states several. Counting VINs rather
// than re-running a vision classifier avoids a second paid model call just
// to detect the same thing apr-extract.js's regex backstop already proves
// works well for this class of signal -- deterministic, evidence-carrying,
// never guesses. Checksum-VALID VINs only (validateVin), so a stray
// 17-character stock/tracking number can't false-positive a real single-
// vehicle page into a rejection.
function countDistinctValidVins(text: string): string[] {
  const seen = new Set<string>();
  const re = /\b[A-HJ-NPR-Z0-9]{17}\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const check = validateVin(m[0]);
    if (check.valid) seen.add(check.vin!);
  }
  return [...seen];
}

// ── Repeat multi-vehicle attempt throttle (shared with analyze-quote) ──────
// Same table/RPCs as analyze-quote's (20260820_scan_attempt_throttle.sql) --
// a signed-in caller re-pasting the SAME URL that's already been rejected as
// multi-vehicle had no ceiling on how many times they could trigger that
// (cheap, but non-zero) vendor spend again. Checked BEFORE the Claude call;
// a blocked repeat costs nothing. Only a genuine multi-vehicle rejection
// bumps the counter. 2nd hit on the same (identity, url) pair -> 2h
// cooldown; 3rd+ -> 24h.
async function sha256Hex(bytes: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function repeatIdentityKey(userId: string | null, req: Request): string {
  return userId ? `user:${userId}` : `ip:${clientIp(req) ?? "unknown"}`;
}
async function checkRepeatCooldown(identityKey: string, inputHash: string): Promise<{ blocked: boolean; cooldownUntil?: string }> {
  try {
    const { data, error } = await supabase.rpc("fn_check_repeat_cooldown", { p_identity: identityKey, p_input_hash: inputHash });
    if (error) { console.error("fn_check_repeat_cooldown failed (failing open):", error.message); return { blocked: false }; }
    return data?.blocked ? { blocked: true, cooldownUntil: data.cooldownUntil } : { blocked: false };
  } catch (e) {
    console.error("fn_check_repeat_cooldown threw (failing open):", e);
    return { blocked: false };
  }
}
async function recordMultiVehicleHit(identityKey: string, inputHash: string): Promise<void> {
  try {
    await supabase.rpc("fn_record_multivehicle_hit", { p_identity: identityKey, p_input_hash: inputHash });
  } catch (e) {
    console.warn("fn_record_multivehicle_hit threw (non-fatal):", e);
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

// ── Per-provider call log (20260814_provider_call_log.sql) ──────────────────
// api_usage_log records one row per RUN, so a Nimble extract that fails and is
// then rescued by Scrapfly is logged as `success: true` with no trace of the
// failure — which is exactly why Nimble's real failure rate and cost share are
// unmeasurable today. This records one row per PROVIDER CALL.
//
// Fail-open and never awaited on the hot path where it would add latency:
// instrumentation must not be able to break or slow a buyer's report.
function hostOf(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
}

async function logProviderCall(f: {
  provider: "anthropic" | "scrapfly" | "nimble";
  operation: "listing_extract" | "search" | "manufacturer_extract" | "render" | "screenshot" | "vision_rescue" | "analysis";
  ok: boolean;
  driver?: string | null;
  listingHost?: string | null;
  attempts?: number;
  durationMs?: number | null;
  errorCode?: string | null;
  costUsd?: number | null;
  credits?: number | null;
}) {
  try {
    const { error } = await supabase.rpc("fn_log_provider_call", {
      p_provider: f.provider,
      p_operation: f.operation,
      p_ok: f.ok,
      p_driver: f.driver ?? null,
      p_listing_host: f.listingHost ?? null,
      p_attempts: f.attempts ?? 1,
      p_duration_ms: f.durationMs ?? null,
      p_error_code: f.errorCode ? String(f.errorCode).slice(0, 200) : null,
      p_cost_usd: f.costUsd ?? null,
      p_credits: f.credits ?? null,
    });
    if (error) console.warn("provider_call log failed:", error.message);
  } catch (e) {
    console.warn("provider_call log threw (run continues):", e);
  }
}

// THE SINGLE DELIVERY BOUNDARY. Every branch that hands a buyer a report and
// captures their credit must pass through here.
//
// It did not used to. This function has SIX return points that deliver an
// `analysis` and call captureCredit -- the 6-hour cache fast-path, the SM360
// feed fallback, the JSON-LD fallback, the Convertus vmsData fallback, the
// Scrapfly render-only rescue, and the main success path -- and only the LAST
// one wrote telemetry. The other five charged the buyer and wrote no
// api_usage_log row and no verification_check rows at all, so:
//   - a cached delivery was invisible to the admin ledger entirely, making
//     "URL scans" a count of cache MISSES rather than of reports delivered;
//   - the four page-load fallbacks each put their own text in error_message
//     ("page-load failed, served SM360 feed fallback"), overwriting the
//     `degraded: missing …` token the ledger matches on, so a hollow delivery
//     could never register as hollow;
//   - five of six delivered reports contributed zero of their 13 checkpoints,
//     which is a code-level reason the per-check failure rate this panel is
//     built to measure ([[failure-rate-under-one-percent]]) reads low.
//
// Adding five more call sites would have left the same trap for the next
// fallback branch, so the fix is this one helper: a new delivery path is
// instrumented by construction, or it does not compile past review.
//
// `note` is the branch's own trace text. The degraded token is PREPENDED so it
// stays the leading token the ledger matches, and the branch's provenance is
// preserved after it rather than replaced.
async function instrumentDelivery(
  analysis: any,
  note: string | null,
  usage?: { input_tokens?: number; output_tokens?: number } | null,
): Promise<void> {
  try {
    const gaps: string[] = [];
    if (!(Number(analysis?.quotedPrice) > 0)) gaps.push("price");
    if (!(Number(analysis?.msrp) > 0)) gaps.push("msrp");
    if (!analysis?.vin) gaps.push("vin");
    if (!analysis?.recalls) gaps.push("recalls");
    if (!(Number(analysis?.financing?.rate) > 0)) gaps.push("apr");
    const parts = [
      gaps.length ? `degraded: missing ${gaps.join(",")}` : null,
      note,
    ].filter(Boolean);
    await logUsage({
      success: true,
      inputTokens: usage?.input_tokens ?? null,
      outputTokens: usage?.output_tokens ?? null,
      errorMessage: parts.length ? parts.join(" | ") : null,
    });
    // One row per checkpoint, so the ledger can report a real per-check
    // failure rate instead of a single boolean that calls 12-of-13 a success.
    // Host only, never the full URL. Fail-open.
    let host: string | null = null;
    try { host = new URL(String(analysis?.sourceUrl || "")).hostname.replace(/^www\./, ""); } catch { /* not parseable */ }
    await recordCheckpoints(supabase, {
      reportId: analysis?.reportId ?? null,
      feature: "listing_url",
      analysis,
      listingHost: host,
    });
  } catch (e) {
    // Telemetry must never take down a delivery the buyer already paid for.
    console.warn("instrumentDelivery failed (ignored):", (e as Error)?.message);
  }
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
// table -- one catalog backfill populates both. Matches on
// year+make+model only (not trim) since fuel type is a model-level fact,
// not a trim-level one, for the overwhelming majority of vehicles.
//
// Falls back to whatever the page extraction said when there's no
// catalog match, so a make whose fuel_type column hasn't been backfilled
// yet degrades quietly. Never throws, never blocks the report either way.
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

// VIN pattern validity check now lives in _shared/invariants.ts, alongside the
// invariant that keeps analysis.vinCheck in sync with analysis.vin. It used to
// be a byte-identical copy in this file AND in analyze-quote.

// Resolve the extracted model to its CANONICAL base model via our own
// msrp_catalog ("Palisade Ultimate Calligraphy" -> "PALISADE"). Feeds both the
// recall and MSRP lookups so trim in the model field can't break the exact
// match either one needs. Null when we can't confidently resolve. Never throws.
async function resolveBaseModel(year: number, make: string, model: string): Promise<string | null> {
  if (!year || !make || !model) return null;
  try {
    // Year-tolerant (±1) like lookupCatalogMsrp: catalog rows lag/lead the
    // listing's model year, and a year miss here blanked the whole MSRP chain
    // (2026 BMW listing vs 2025-MY catalog rows).
    const { data } = await supabase
      .from("msrp_catalog").select("model")
      .in("year", [year - 1, year, year + 1]).ilike("make", make).not("model", "is", null).limit(400);
    if (!data?.length) return null;
    // Match on the name with powertrain MODIFIERS removed, because dealers put
    // the word wherever they like: "RAV4 Hybrid XLE", "RAV4 HEV XLE",
    // "RAV4 XLE HYBRID" and "RAV4 XLE HEV" are one car, and a prefix test only
    // ever matched the first of them. The powertrain decision itself is made by
    // powertrainCompatible on the ORIGINAL strings, below — stripping here is
    // about finding the base name, never about what powertrain it is.
    const em = stripPowertrain(model).toUpperCase(); let best: string | null = null;
    for (const row of data) {
      const cm = String(row.model || "").trim(); if (!cm) continue;
      // Prefix-stripping is for TRIM noise, never for a powertrain suffix: an
      // "Equinox EV" must not collapse onto the gasoline "Equinox" and inherit
      // its sticker (measured 2026-08-12 — a BEV was reported at the gas RS's
      // $44,942). Losing the match is the correct outcome when the catalog has
      // no row for the actual vehicle. Dealers also write HEV and PHEV, and
      // "Plug-in Hybrid" contains "Hybrid", so the marker set treats a plug-in
      // as a plug-in and never reduces it to a conventional hybrid — on the
      // 2026 RAV4 that distinction is $5,500.
      if (!powertrainCompatible(model, cm)) continue;
      const cmU = stripPowertrain(cm).toUpperCase();
      if (em === cmU || em.startsWith(cmU + " ")) { if (!best || cm.length > best.length) best = cm; }
    }
    return best;
  } catch { return null; }
}
// Tri-state: {checked:false}=unreachable; {count>0}=found; {count:0,confirmed:true}=
// CONFIRMED clean; {count:0,confirmed:false}=zero but model never matched. A
// negative safety claim is ONLY safe when confirmed=true. See make-recalls-fail-safe.

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
      note = `${km.toLocaleString()} km is unusually low for a ${age}-year-old vehicle (typical is around ${typical.toLocaleString()} km). Low mileage is usually a genuine selling point — a VIN history report will confirm it, which is worth doing for any low-mileage used vehicle regardless.`;
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

  const quoted = Number(analysis.quotedPrice) || null;
  // The reference figure, not raw analysis.msrp: an AMVIC all-in advertised
  // price (quoted) must be measured against the manufacturer's ALL-IN
  // figure, never the ex-freight MSRP -- that mismatch invents roughly
  // $3,000 of markup that isn't there, the exact class of error
  // msrp-claim.ts's own docstring names (Charlesglen, $11,173; Okotoks,
  // $85,995 vs a $57,500 ex-freight figure when the honest reference is
  // $60,578 all-in). This function used to run BEFORE analysis.allInPricing
  // was even resolved (moved below, see the call-site comment), so it always
  // compared against the wrong number when applicable -- not just for the
  // starting_at branch added below, but for every "exact" report too.
  const claim = qualifyMsrpClaim(analysis);
  const msrp = Number(claim.reference) || null;
  // Only an EXACT trim MSRP can support an over/under-MSRP claim. A
  // "starting_at" floor (base trim / adjacent MY) says nothing about THIS
  // unit's sticker — an option-loaded car above the base floor isn't "over
  // MSRP", so it must not add leverage or a basis line.
  // NAME THE BASIS THE FIGURE IS ON. 63fa164 correctly switched this function
  // to compare against claim.reference (the all-in figure when the asking
  // price is an AMVIC all-in advertised price), but kept calling it "MSRP" --
  // while every on-screen card still prints its own delta against the
  // ex-freight MSRP. One report, two different "over MSRP" dollar figures,
  // neither labelled with which basis it used. The number here is right; the
  // word for it was not.
  const refLabel = claim.comparedAgainst === "all_in" ? "all-in MSRP" : "MSRP";
  if (msrp && quoted && analysis.msrpBasis === "exact") {
    const deltaPct = (quoted - msrp) / msrp;
    if (deltaPct > 0.005) {
      score += Math.min(2.5, deltaPct * 100 * 0.3);
      basis.push(`priced $${Math.round(quoted - msrp).toLocaleString()} above the $${Math.round(msrp).toLocaleString()} ${refLabel}`);
    } else if (deltaPct < -0.02) {
      score -= 1.0;
      basis.push(`already priced below ${refLabel}`);
    }
  } else if (msrp && quoted && analysis.msrpBasis === "starting_at") {
    // trim-match.js's priceImplausible() already downgraded this from "exact"
    // specifically because a SINGLE row can't tell "real markup" from "the
    // catalog is missing a higher trim" (the IONIQ 9 false accusation this
    // whole gate exists to prevent), and that stays true here. But hiding the
    // gap entirely is its own failure: confirmed live 2026-08-21, Okotoks
    // Toyota RAV4 PHEV GR Sport AWD -- $85,995 asking against a hand-verified
    // trim MSRP reported "no pricing red flags" on a real gap.
    //
    // Two tiers, strongest evidence first. qualifyCeilingClaim asks a
    // DIFFERENT, stronger question than a single-row match: is the asking
    // price above the ENTIRE lineup's most expensive real trim (>=2 trims
    // considered)? That question has no "missing higher trim" escape hatch --
    // there is no trim above the top of the ladder we already hold, by
    // definition -- so it can support a real claim, not just a hedge. Already
    // built, tested (msrp-claim.test.ts) and wired into the on-screen report;
    // simply never consulted here before.
    const ceilingClaim = qualifyCeilingClaim(analysis);
    if (ceilingClaim.exceeds && Number(ceilingClaim.over) > 0) {
      score += Math.min(2.5, (Number(ceilingClaim.over) / Number(ceilingClaim.ceiling)) * 100 * 0.3);
      basis.push(`priced $${Math.round(Number(ceilingClaim.over)).toLocaleString()} above the top of the ${ceilingClaim.trimsConsidered}-trim ${analysis.make || ""} lineup ($${Math.round(Number(ceilingClaim.ceiling)).toLocaleString()}, ${ceilingClaim.trim || "the priciest trim"}, all-in) — no combination of real trims in our catalog reaches this price`);
    } else {
      // Fallback: no usable ceiling data. Same threshold as
      // priceImplausible() (>20% AND >$6,000) -- below that, "options sit
      // above the floor" genuinely covers it and this must stay silent, same
      // as before. At or above it, the gap is worth a buyer's question
      // regardless of which explanation is true, so it's surfaced as a
      // number to ask about, never as a stated fact about why it's there.
      // Capped lower than either claim above: the underlying number is real,
      // but which of two explanations applies is not.
      const gap = quoted - msrp;
      if (gap > msrp * 0.20 && gap > 6000) {
        score += Math.min(1.5, (gap / msrp) * 100 * 0.15);
        const refNote = claim.comparedAgainst === "all_in" ? "all-in MSRP" : "base MSRP";
        basis.push(`asking price sits $${Math.round(gap).toLocaleString()} above this trim's $${Math.round(msrp).toLocaleString()} ${refNote} (not confirmed as markup — could be options/packages atop the base trim, or a catalog gap; ask the dealer to itemize what's added)`);
      }
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
  // Days on lot — the "motivated seller" signal (dealer-platform data, capped
  // at +2.5 per days-on-lot-scope.md). Absolute-day buckets; no data → 0 and
  // NO basis line (a miss must never read as "fresh listing").
  const dol = Number(analysis.daysOnLot?.days) || 0;
  if (dol >= 30) {
    score += dol >= 90 ? 2.5 : dol >= 60 ? 1.5 : 0.75;
    basis.push(`on the lot ${dol} days (dealer inventory data)`);
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
// Dealer reputation from get-dealer-sentiment, server-side. Never throws, and
// carefully separates "we asked and found none" from "we never asked": only a
// COMPLETED lookup sets checked:true. See _shared/point-state.ts.
async function resolveDealerReputation(analysis: any): Promise<void> {
  const name = String(analysis?.dealerName || "").trim();
  if (!name) return;                              // nothing to look up -> unchecked
  if (analysis.dealerSentiment?.rating) return;   // already resolved upstream
  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key) return;
  try {
    const res = await fetch(`${base}/functions/v1/get-dealer-sentiment`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
      // The city comes from the same signals as the province and was arriving
      // null; Places disambiguates far better with one.
      body: JSON.stringify({ dealerName: name, dealerCity: resolveCity(analysis) }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      console.warn(`dealer reputation: HTTP ${res.status} -- leaving UNCHECKED rather than implying none exist.`);
      return;
    }
    const data: any = await res.json();
    // A 200 IS a completed check, whether or not it found a rating.
    analysis.dealerSentiment = { ...(data?.dealerSentiment ?? {}), checked: true };
    console.log(`dealer reputation: ${name} -> ${data?.dealerSentiment?.rating ?? "none found"} (${data?.dealerSentiment?.reviewCount ?? 0} reviews)`);
  } catch (e) {
    // A failed call is NOT evidence about the dealer. Leave it unchecked.
    console.warn("dealer reputation lookup failed (leaving UNCHECKED):", (e as Error)?.message);
  }
}

// Attaches analysis.financeRates { dealer, manufacturer }. Never throws.
async function resolveFinanceRates(analysis: any): Promise<void> {
  const out: any = { dealer: null, manufacturer: null };
  const pageRate = Number(analysis?.financing?.rate);
  if (pageRate && pageRate > 0 && pageRate < 30) {
    // source travels with the rate so the frontend can tell "the page/feed
    // genuinely says this" (sm360_feed, convertus_vms, page_text -- all three
    // require real evidence, see apr-extract.js) from "the model's own read of
    // the page, no cross-check" (llm -- the extraction prompt says never
    // guess, but nothing downstream enforced that until this field existed).
    // Only the former may power an accusatory HIGH/dollar-gap claim -- see
    // App.jsx TRUSTED_APR_SOURCES. Confirmed live 2026-08-19 (easytermauto.ca
    // Bronco Sport): a report accused a dealer of a 25% rate and quoted a
    // $23,275 markup for a page that discloses no APR anywhere.
    out.dealer = { apr: pageRate, source: analysis.financing?.source || "llm" };
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
          // termMonths MUST travel with the rate. This line used to drop it,
          // and an APR with no term cannot amortize -- so the Financing-math
          // point printed "NO TERMS QUOTED" while both halves of the
          // calculation sat in our own tables. See reference-financing.ts.
          out.manufacturer = { apr: Number(pick.apr), termMonths: Number(pick.term_months) || null, promo: !!pick.promo, effectiveDate: pick.effective_date };
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
// Matching is the shared trim-fingerprinting scorer (_shared/trim-match.js):
// drivetrain + order-independent trim tokens + distinctive features + price
// proximity, with a fuel partition. Regression-locked by
// scripts/test-trim-match.mjs — run it after ANY change to the matcher.
// Returns { msrp, trim, basis } where basis is "exact" (trim pinned) or
// "starting_at" (honest floor, never a guess dressed as exact).
interface CatalogMsrp { msrp: number; trim: string | null; basis: "exact" | "starting_at"; year?: number; sourceUrl?: string | null; priceBasis?: string | null;
  /** The manufacturer's OWN all-in for the matched trim. Compare an AMVIC all-in advertised price against THIS, never against msrp. */
  allIn?: number | null;
  /** The model's highest all-in, across the whole trim ladder — the ceiling claim. */
  ceiling?: { allIn: number; trim: string | null; trimsConsidered: number } | null; }
async function lookupCatalogMsrp(
  year: number,
  make: string,
  model: string,
  trim: string | null,
  opts?: { rawModel?: string | null; fuelType?: string | null; quotedPrice?: number | null; drivetrain?: string | null; vinDrive?: string | null },
): Promise<CatalogMsrp | null> {
  try {
    // Year-tolerant: catalog rows lag/lead the listing's model year (a 2026
    // listing vs 2025-MY catalog rows was a hard miss — the BMW 5 Series case).
    // Query the exact year ± 1, PREFER exact-year rows, and when only an
    // adjacent year exists use it as an honest "starting_at" reference with the
    // catalog year attached — a labelled prior-year MSRP beats a blank.
    const years = [year, year - 1, year + 1];
    let data: any[] | null = null;
    const full = await supabase
      .from("msrp_catalog")
      .select("year, trim, msrp, fuel_type, drivetrain, attrs, source_url, price_basis, all_in_price")
      .in("year", years)
      .ilike("make", make)
      .ilike("model", model)
      .not("msrp", "is", null);
    if (full.error) {
      const base = await supabase
        .from("msrp_catalog")
        .select("year, trim, msrp, fuel_type")
        .in("year", years)
        .ilike("make", make)
        .ilike("model", model)
        .not("msrp", "is", null);
      if (base.error) {
        console.warn("⚠️ msrp_catalog MSRP lookup failed:", base.error.message);
        return null;
      }
      data = base.data;
    } else {
      data = full.data;
    }
    const all = (data ?? []).filter((r: any) => r.msrp != null && !isNaN(Number(r.msrp)));
    if (all.length === 0) return null;
    const exactYear = all.filter((r: any) => Number(r.year) === year);
    // Nearest year wins among the adjacents (prefer the older row on a tie —
    // last year's real price over next year's early figure).
    const rows = exactYear.length ? exactYear
      : all.filter((r: any) => Number(r.year) === year - 1).length ? all.filter((r: any) => Number(r.year) === year - 1)
      : all.filter((r: any) => Number(r.year) === year + 1);
    const rowYear = Number(rows[0]?.year);

    // The hybrid/PHEV signal can live in the raw model or trim text even after
    // the base-model resolve stripped it — recover it for the fuel partition.
    const textFuel = /phev|plug/i.test(String(opts?.rawModel || "") + " " + String(trim || "")) ? "PHEV"
      : /hybrid/i.test(String(opts?.rawModel || "") + " " + String(trim || "")) ? "Hybrid" : null;

    const picked = pickTrimMsrp(rows, {
      trim,
      // normDrive() inside the matcher parses AWD/FWD words out of whatever
      // string it gets, so the trim text doubles as a drivetrain source.
      drivetrain: opts?.drivetrain || trim || null,
      vinDrive: opts?.vinDrive || null,
      fuelType: opts?.fuelType || textFuel,
      quotedPrice: opts?.quotedPrice ?? null,
    });
    if (!picked) return null;
    // Provenance: the manufacturer page/release the figure came from (when the
    // row carries it) -- lets the report link the MSRP to its source.
    const srcRow = rows.find((r: any) => r.trim === (picked as any).trim && r.source_url) || rows.find((r: any) => r.source_url);
    const pbRow = rows.find((r: any) => r.trim === (picked as any).trim && r.price_basis) || rows.find((r: any) => r.price_basis);
    const aiRow = rows.find((r: any) => r.trim === (picked as any).trim && r.all_in_price);
    // THE CEILING: the model's most expensive trim, priced all-in. A listing
    // above it is marked up whichever trim it is — there is no higher grade to
    // name, so a missing catalog row cannot explain it. Taken across the rows
    // of THIS model year only; a ceiling from one row is not a ladder and
    // qualifyCeilingClaim refuses it.
    const ladder = rows.filter((r: any) => Number(r.all_in_price) > 0);
    const topRow = ladder.reduce((best: any, r: any) =>
      (!best || Number(r.all_in_price) > Number(best.all_in_price)) ? r : best, null);
    const out: CatalogMsrp = { ...(picked as CatalogMsrp), year: rowYear, sourceUrl: srcRow?.source_url || null, priceBasis: pbRow?.price_basis || null,
      allIn: aiRow ? Number(aiRow.all_in_price) : null,
      ceiling: topRow ? { allIn: Number(topRow.all_in_price), trim: topRow.trim || null, trimsConsidered: ladder.length,
        floorAllIn: Math.min(...ladder.map((r: any) => Number(r.all_in_price))) } : null };
    // An adjacent-year figure is a reference, never an exact sticker for THIS
    // model year — force the honest "starting_at" basis.
    if (rowYear !== year) out.basis = "starting_at";
    console.log(`Catalog MSRP: ${year} ${make} ${model} "${trim ?? ""}" -> ${out.msrp} (${out.basis}${out.trim ? `, trim ${out.trim}` : ""}${rowYear !== year ? `, ${rowYear} MY reference` : ""})`);
    return out;
  } catch (err) {
    console.warn("lookupCatalogMsrp threw:", err);
    return null;
  }
}

// Free, authoritative drivetrain from the VIN (NHTSA vPIC). The VIN is the
// strongest trim signal a listing carries — it can't be mistyped marketing
// copy. Best-effort: 6s budget, null on any failure, never throws.
async function decodeVinDrive(vin: string | null | undefined): Promise<string | null> {
  const v = String(vin || "").trim();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/i.test(v)) return null;
  try {
    const res = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(v)}?format=json`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const j: any = await res.json();
    const d = String(j?.Results?.[0]?.DriveType || "");
    if (/awd|all.?wheel|4wd|4x4/i.test(d)) return "AWD";
    if (/front/i.test(d)) return "FWD";
    if (/rear/i.test(d)) return "RWD";
    return null;
  } catch { return null; }
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

  // The entry gate above only checks that ~40s existed when this function
  // STARTED -- it never re-checked before each of the three sequential steps
  // below, which each independently spent up to their own full fixed budget
  // (20s search + 30s extract + 30s Claude = 80s worst case, double the 40s
  // the gate guaranteed). Same bug class just fixed in scrapfly.ts's
  // rescueListingViaScrapfly, confirmed live 2026-08-14: a caller computes a
  // budget from ITS remaining deadline, hands it down, and each downstream
  // step re-spending that same full value independently can blow the total
  // request past Supabase's 150s platform ceiling with no graceful error.
  // stepBudget shrinks each step to what's ACTUALLY left of `deadline` (never
  // above its own cap, never below a floor short enough to still be a real
  // attempt) -- and falls back to the fixed cap when no deadline was passed,
  // matching this function's existing "unlimited budget" behavior for that case.
  const stepBudget = (floorMs: number, capMs: number): number =>
    deadline != null ? Math.max(floorMs, Math.min(capMs, deadline - Date.now())) : capMs;

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
    const searchT0 = Date.now();
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
    }, { timeoutMs: 15_000, maxAttempts: 2, budgetMs: stepBudget(5_000, 20_000), label: "nimble-search" });

    // Nimble's SEARCH job, logged separately from its extract job — they have
    // different failure profiles and only one of them has a replacement, so a
    // keep-or-drop decision needs them apart, not averaged together.
    logProviderCall({
      provider: "nimble",
      operation: "search",
      ok: searchRes.ok,
      driver: "search",
      listingHost: domain,
      durationMs: Date.now() - searchT0,
      errorCode: searchRes.ok ? null : `http_${searchRes.status}`,
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
    const extractResult = await nimbleExtract(targetUrl, "vx10", stepBudget(10_000, MFR_TIMEOUT_MS), MFR_VX10_WAIT_MS);
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
    }, { timeoutMs: 20_000, maxAttempts: 2, budgetMs: stepBudget(5_000, 30_000), label: "anthropic-mfr-msrp" });

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
// Instrumented wrapper. Every Nimble extract in this function goes through
// nimbleExtract, so wrapping it here is the single point that captures the
// driver, the outcome and the wall-clock for all of them — including the vx6/
// vx8 race, where BOTH drivers get a row and the loser's failure stops being
// invisible. The inner function is untouched.
async function nimbleExtract(
  url: string,
  driver: string,
  timeoutMs: number,
  waitMs?: number,
  externalSignal?: AbortSignal,
): Promise<NimbleResult> {
  const t0 = Date.now();
  const r = await nimbleExtractInner(url, driver, timeoutMs, waitMs, externalSignal);
  // Not awaited: this is on the hot path and the log must never add latency.
  logProviderCall({
    provider: "nimble",
    operation: driver === "vx10" ? "manufacturer_extract" : "listing_extract",
    ok: r.ok,
    driver,
    listingHost: hostOf(url),
    durationMs: Date.now() - t0,
    errorCode: r.ok ? null : (r.timedOut ? "timeout" : r.errBody?.slice(0, 120)),
  });
  return r;
}

async function nimbleExtractInner(
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
function parseSm360Listing(url: string): { origin: string; locale: string; vehicleId: number; section: string } | null {
  try {
    const u = new URL(url);
    // Both lots ride the same feed shape: {origin}/{locale}/{section}/api/listing.
    // A USED listing (/used-inventory/) previously fell through entirely -- the
    // Calgary BMW 2024 X5 case: price/odometer/days-on-lot all present in the
    // used feed but never read.
    const sec = u.pathname.match(/\/(new|used)-inventory\//i);
    if (!sec) return null;
    const section = sec[1].toLowerCase() + "-inventory";
    // The id token is the unit's vehicleId, as an `id<digits>` slug segment.
    const m = u.pathname.match(/id(\d{4,})(?![0-9])/i);
    if (!m) return null;
    const localeSeg = u.pathname.match(/^\/(en|fr)\//i);
    const locale = localeSeg ? localeSeg[1].toLowerCase() : "en";
    return { origin: u.origin, locale, vehicleId: Number(m[1]), section };
  } catch {
    return null;
  }
}

async function fetchSm360Page(
  origin: string,
  locale: string,
  page: number,
  timeoutMs: number,
  section = "new-inventory",
): Promise<{ vehicles: any[]; numberOfPages: number } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${origin}/${locale}/${section}/api/listing?page=${page}`, {
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

// Days-on-lot from the SM360 feed's OWN inventory fields (daysInInventory /
// dateEntry) — the dealer platform's authoritative count, not an estimate.
// This is the zero-vendor days-on-lot source: read per-request from the same
// public feed that already resolves the price. Conservative: only records a
// positive integer day count; dateEntry (epoch ms) is attached when sane.
// Source-labelled so the report card stays dispute-proof.
function captureSm360DaysOnLot(v: any, analysis: any): void {
  const days = Number(v?.daysInInventory);
  if (!Number.isFinite(days) || days <= 0) return;
  const entryMs = Number(v?.dateEntry);
  const since = Number.isFinite(entryMs) && entryMs > 946684800000 && entryMs < 4102444800000
    ? new Date(entryMs).toISOString().slice(0, 10) : null;
  analysis.daysOnLot = {
    days: Math.round(days),
    since,
    source: "dealer_platform_feed",
    sourceLabel: "the dealer's own inventory feed",
  };
  console.log(`SM360 days-on-lot: ${Math.round(days)} days (since ${since ?? "?"}).`);
}

// Convertus/"vehicles"-platform days-on-lot: those VDPs (kramermazda,
// fishcreeknissancalgary, toyotanorthwestedmonton, ...) embed the dealer's own
// inventory record in the page JSON, including "date_on_lot" (verified live:
// exactly ONE occurrence per VDP = the subject vehicle; Kramer CX-90
// 2026-03-25, Fish Creek Rogue 2025-11-01). Reads it with the hardened direct
// fetch — one extra free HTTP call, only for the /vehicles/ URL shape, and only
// when no daysOnLot was captured yet (the SM360 feed path wins when present).
// S36 -- trade-in instant-offer widget detection (dealer-tactics-safeguards.md).
// Deterministic marker match on page text/HTML: AccuTrade (Cox/Manheim),
// TradePending, KBB ICO, CBB, or a generic "value your trade" tool. Purely
// factual ("this listing embeds X") so the report's coach copy is dispute-proof.
// Check #11 -- AMVIC dealer-licence verification (Alberta). Reads our weekly
// snapshot of the regulator's public licensee registry (amvic_licensees) and
// attaches the VERBATIM status when -- and only when -- the match is confident.
//
// In a live sample of the registry only ~54% of listings were "Issued": the
// value here is catching the expired/suspended/cancelled ones whose websites
// are still up. Fail-safe in BOTH directions: a lookup miss is never an
// all-clear, and a non-match is never an accusation (it renders as "couldn't
// confirm -- verify at AMVIC yourself").
async function checkDealerLicence(analysis: any): Promise<void> {
  try {
    if (!analysis || analysis.dealerLicence) return;
    const name = String(analysis.dealerName || "").trim();
    if (!name) return;
    // CA-AB provider (locale-abstraction-rule: other provinces plug their own
    // registry in behind this same dealerLicence field -- OMVIC, VSA, etc.).
    const city = String(analysis.dealerCity || "");

    // Candidate fetch: the most distinctive token of the dealer name, so a
    // single indexed query returns a small set for the matcher to judge.
    const toks = amvicNorm(name).split(" ").filter((t: string) => t.length > 2);
    if (!toks.length) return;
    const probe = toks.sort((a: string, b: string) => b.length - a.length)[0];
    const { data, error } = await supabase
      .from("amvic_licensees")
      .select("name, trade_name, city, facility_status, registration_number, expiry_date, website")
      // PostgREST wildcard is `*`, not `%`: a raw % inside an or() filter is a
      // URL escape character and the request is rejected outright (HTTP 1101),
      // so every licence lookup silently found nothing. Verified 2026-08-11.
      .or(`name_key.ilike.*${probe}*,trade_key.ilike.*${probe}*`)
      .limit(60);
    if (error) { console.warn("AMVIC lookup failed:", error.message); return; }
    if (!data || !data.length) return;

    const hit = matchLicensee(data, { dealerName: name, dealerCity: city, website: analysis.sourceUrl || "" });
    if (!hit) { console.log(`AMVIC: no confident match for "${name}" -- reporting unverified.`); return; }
    analysis.dealerLicence = {
      status: hit.row.facility_status || null,      // regulator's own wording, verbatim
      state: classifyStatus(hit.row.facility_status),
      legalName: hit.row.name || null,
      licenceNumber: hit.row.registration_number || null,
      expiryDate: hit.row.expiry_date || null,
      confidence: hit.confidence,
      basis: hit.basis,                            // e.g. "current licence (supersedes older records)"
      tradeName: hit.row.trade_name && hit.row.trade_name !== "N/A" ? hit.row.trade_name : null,
      source: "AMVIC public registry",
      checkedAt: new Date().toISOString(),
    };
    console.log(`AMVIC: ${name} -> ${hit.row.facility_status} (${hit.row.registration_number || "no reg#"}, conf ${hit.confidence}).`);
  } catch (e) { console.warn("checkDealerLicence threw (ignored):", (e as Error)?.message); }
}

// `sharedHtml` is the scan's ONE page read. Passing it is not an optimisation:
// a scan used to fire up to five separate un-shared GETs at the same dealer URL
// (three from the retry loop, one here, one from captureConvertusDaysOnLot) on
// top of Nimble and Scrapfly, and on a Cloudflare-protected origin that volume
// is what PROVOKES the rate limiting that then empties the whole report.
// Falls back to its own fetch only when no shared read was supplied.
async function detectTradeInWidget(url: string, analysis: any, textHint?: string | null, sharedHtml?: Promise<string | null>): Promise<void> {
  try {
    if (!analysis || analysis.tradeInWidget) return;
    let hit = matchTradeInWidget(textHint || "");
    if (!hit) {
      const html = sharedHtml ? await sharedHtml.catch(() => null) : await fetchDirectHtml(url, 8_000);
      if (html) hit = matchTradeInWidget(html);
    }
    if (hit) { analysis.tradeInWidget = hit; console.log(`Trade-in widget detected (${hit.vendor || "generic"}).`); }
  } catch { /* best-effort, never sinks the scan */ }
}

// Days-on-lot, third path: OUR OWN first-seen tracker.
//
// The two paths above only fire on SM360 and Convertus. Every other dealer
// platform — a Volkswagen store among them — produced no days-on-lot at all,
// and the report simply omitted the section. Meanwhile the daily Alberta crawl
// has been recording vehicle_listing.first_seen_on per VIN the whole time and
// nothing ever read it. This is the vendor-free engine the feature was supposed
// to be built on; it just was not connected.
//
// HONEST BY CONSTRUCTION. first_seen_on is when WE first saw the car, which is
// a LOWER BOUND — it may have sat there before our crawl noticed it, or before
// the crawl covered that dealer. So this reports "at least N days" and says so
// on the card. Claiming a hard 90 days off a lower bound is exactly the kind of
// number a dealer would take apart, and they would be right.
async function captureOwnDaysOnLot(analysis: any): Promise<void> {
  try {
    if (analysis?.daysOnLot) return;                    // platform data wins: it is exact
    const vin = String(analysis?.vin || "").toUpperCase();
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return;     // no VIN, nothing to join on

    // Two own sources, best first. vehicle_listing carries the dealer's own
    // inventory date from the SM360 crawl — exact, but only for SM360 dealers.
    // listing_seen carries the first time WE saw the VIN on any platform: less
    // precise, but it cannot have a coverage gap, because it is written by the
    // very scan that would otherwise find nothing.
    let firstSeen: string | null = null;

    const { data, error } = await supabase
      .from("vehicle_listing")
      .select("first_seen_on")
      .eq("vin", vin)
      .order("first_seen_on", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) console.warn("vehicle_listing days-on-lot lookup failed:", error.message);
    if (data?.first_seen_on) firstSeen = String(data.first_seen_on) + "T00:00:00Z";

    if (!firstSeen) {
      const { data: seen, error: seenErr } = await supabase.rpc("fn_listing_first_seen", { p_vin: vin });
      if (seenErr) console.warn("listing_seen lookup failed:", seenErr.message);
      if (seen) firstSeen = String(seen);
    }
    if (!firstSeen) return;

    const t = Date.parse(firstSeen);
    if (!Number.isFinite(t)) return;
    const days = Math.floor((Date.now() - t) / 86_400_000);
    if (days <= 0 || days > 3650) return;

    analysis.daysOnLot = {
      days,
      since: String(data.first_seen_on),
      atLeast: true,                                     // renderers must not state this as exact
      source: "lotcheck_first_seen",
      sourceLabel: "LotCheck's own daily inventory tracking",
    };
    console.log(`Own days-on-lot: at least ${days} days (first seen ${data.first_seen_on}).`);
  } catch (e) {
    console.warn("own days-on-lot threw (non-fatal):", e);
  }
}

// Reads date_on_lot out of the Convertus vmsData blob. It used to re-download
// the ENTIRE page (a 1.1 MB fetch on the Lexus listing that exposed this) to
// regex one field out of the very blob the main reader had already parsed --
// a wholly redundant origin request on the hosts most likely to rate-limit us.
// Now it uses the scan's shared read.
async function captureConvertusDaysOnLot(url: string, analysis: any, sharedHtml?: Promise<string | null>): Promise<void> {
  try {
    if (analysis?.daysOnLot) return;
    let u: URL; try { u = new URL(url); } catch { return; }
    if (!/\/vehicles\/\d{4}\//i.test(u.pathname)) return;
    const html = sharedHtml ? await sharedHtml.catch(() => null) : await fetchDirectHtml(url, 12_000);
    if (!html) return;
    const m = html.match(/"date_on_lot":"(\d{4}-\d{2}-\d{2})[^"]*"/) || html.match(/"date_added":"(\d{4}-\d{2}-\d{2})[^"]*"/);
    const since = m ? m[1] : null;
    const t = since ? Date.parse(since + "T00:00:00Z") : NaN;
    const days = Number.isFinite(t) ? Math.floor((Date.now() - t) / 86_400_000) : 0;
    if (days > 0 && days <= 3650) {
      analysis.daysOnLot = { days, since, source: "dealer_platform_page", sourceLabel: "the dealer's own inventory data" };
      console.log(`Convertus days-on-lot: ${days} days (date_on_lot ${since}).`);
    }
    // Gating backstop: the raw page HTML is ground truth for a price-gated
    // listing even when the LLM's markdown view missed the CTA text.
    if (!(Number(analysis.quotedPrice) > 0)
        && (!analysis.priceDisclosure || analysis.priceDisclosure === "not_shown")
        && (html.match(/\$\s?\d{2,3},\d{3}/g) || []).length === 0
        && /contact\s+us\s+for\s+price|call\s+for\s+price|get\s+e-?price|unlock\s+(the|this|your)\s+price|get\s+today'?s\s+price/i.test(html)) {
      analysis.priceDisclosure = "contact_for_price";
      console.log("Convertus gating backstop: page text shows a contact-for-price CTA.");
    }
  } catch { /* best-effort — never sink the scan */ }
}

// Dealer financing from the SM360 feed's paymentOptions.finance.term — the
// dealer's own advertised APR/term/payment for THIS unit (page scrapes often
// miss it; the feed always carries it when the dealer publishes payments).
// Fills analysis.financing only when the page didn't already disclose a rate,
// so a page-stated rate always wins. Feeds financeRates.dealer + the
// financing-math check downstream. Never fabricates: no apr -> no-op.
function captureSm360Financing(v: any, analysis: any): void {
  if (analysis?.financing?.rate != null) return;
  const t = v?.paymentOptions?.finance?.term;
  const apr = Number(t?.apr);
  if (!Number.isFinite(apr) || apr <= 0 || apr > 30) return;
  const term = Number(t?.term);
  const payment = Number(t?.payment);
  const totalObl = Number(t?.aprDetails?.totalObligation);
  // Field names match computeFinancingCheck's contract (paymentAmount/
  // paymentFrequency/termMonths/totalObligation) so the math check runs.
  analysis.financing = {
    ...(analysis.financing || {}),
    rate: apr,
    termMonths: Number.isFinite(term) && term > 0 ? Math.round(term) : null,
    paymentAmount: Number.isFinite(payment) && payment > 0 ? Math.round(payment * 100) / 100 : null,
    paymentFrequency: "monthly",
    totalObligation: Number.isFinite(totalObl) && totalObl > 0 ? Math.round(totalObl * 100) / 100 : null,
    source: "sm360_feed",
  };
  console.log(`SM360 financing: ${apr}% APR / ${term ?? "?"}mo / $${payment ?? "?"}/mo (dealer feed).`);
}

// Identity + add-ons from the feed the page scrape misses: VIN (serialNo),
// odometer, and — the big one — the dealer's own itemized accessories/options
// (paymentOptions.addedItems.items: "Demo Winter Tire Set $6,919", "Premium
// Essential Package $5,400"...) plus the dealer rebate as a discount line.
// These feed the add-ons audit + reconciliation, which otherwise read
// "NONE LISTED" while thousands in extras sit on the cash worksheet.
// Fill-only: never overwrites page-extracted values.
function captureSm360Extras(v: any, analysis: any): void {
  const vin = String(v?.serialNo || "").trim().toUpperCase();
  if (!analysis.vin && /^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) analysis.vin = vin;
  const odo = Number(v?.odometer);
  if ((analysis.odometerKm == null || Number(analysis.odometerKm) === 0) && Number.isFinite(odo) && odo > 0) analysis.odometerKm = odo;
  if (!Array.isArray(analysis.addOns) || analysis.addOns.length === 0) {
    const items = v?.paymentOptions?.addedItems?.items;
    const out: any[] = [];
    if (Array.isArray(items)) {
      for (const it of items) {
        const price = Number(it?.retail);
        const name = String(it?.description || "").trim();
        if (name && Number.isFinite(price) && price > 0) out.push({ name, price, verdict: null, reason: null });
      }
    }
    const rebate = Number(v?.paymentOptions?.bestIncentives?.dealerRebates);
    if (Number.isFinite(rebate) && rebate > 0) out.push({ name: "Dealer discount", price: -rebate, verdict: "good", reason: null });
    if (out.length) {
      analysis.addOns = out;
      console.log(`SM360 extras: ${out.length} itemized add-on/discount line(s) from the feed.`);
    }
  }
}

async function resolveSm360QuotedPrice(url: string, analysis: any): Promise<void> {
  const parsed = parseSm360Listing(url);
  if (!parsed) return;
  const { origin, locale, vehicleId, section } = parsed;
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
      const res = await fetchSm360Page(origin, locale, page, PAGE_TIMEOUT_MS, section);
      if (!res) {
        console.warn(`SM360 resolver: page ${page} fetch failed for ${origin}; aborting resolver.`);
        return;
      }
      pages = Math.min(res.numberOfPages, MAX_PAGES);
      for (const v of res.vehicles) {
        // Primary path: exact vehicleId match -- the id from the URL slug.
        if (Number(v?.vehicleId) === vehicleId) {
          captureSm360DaysOnLot(v, analysis);
          captureSm360Financing(v, analysis);
          captureSm360Extras(v, analysis);
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
      captureSm360DaysOnLot(priced[0], analysis);
      captureSm360Financing(priced[0], analysis);
      captureSm360Extras(priced[0], analysis);
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
  const { origin, locale, vehicleId, section } = parsed;
  const PAGE_TIMEOUT_MS = 8_000;
  const MAX_PAGES = 25;

  try {
    let pages = 1;
    let match: any = null;
    for (let page = 1; page <= pages && page <= MAX_PAGES; page++) {
      const res = await fetchSm360Page(origin, locale, page, PAGE_TIMEOUT_MS, section);
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
      // NEVER STATE THAT THE DEALER BLOCKED US. We do not know that, and on
      // 2026-08-16 a Stampede Toyota listing returned HTTP 200 with the full
      // 903 KB page and clean JSON-LD to a plain curl AFTER the scan told the
      // buyer that dealer "may be blocking automated access". The read can fail
      // for our reasons -- a vendor outage, our egress IP, a timeout -- and
      // asserting a motive we have not established is a claim about a named
      // business in a document that business may read.
      sourceNote: "We couldn't read the dealer's listing page on this attempt, so this report was built from the dealer's own inventory feed instead. Core vehicle details and the advertised price come straight from that feed. Itemized fees and the financing terms shown on the page aren't included here.",
      summary: `${vehicleStr ?? "This vehicle"}${price != null ? ` is listed at $${price.toLocaleString()}` : ""}. The dealer's listing page couldn't be loaded, so this report is based on the dealer's inventory feed rather than the full page -- itemized fees and the page's financing terms aren't included. Confirm the out-the-door price, any add-on fees, and financing details directly with the dealer.`,
    };

    captureSm360DaysOnLot(match, analysis);
    captureSm360Financing(match, analysis);
    captureSm360Extras(match, analysis);
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
// Why a direct read failed, so the retry loop can tell "this origin is pushing
// back" apart from "there is nothing here". They need opposite responses: a
// 404/parse miss will never succeed on a retry, while a 429 or a Cloudflare
// challenge is a TIMING signal -- and hammering it converts a transient block
// into a sustained one.
type DirectOutcome = { status: "ok" | "rate_limited" | "challenged" | "http_error" | "empty" | "network"; code?: number };

async function fetchDirectHtml(url: string, timeoutMs: number, outcome?: DirectOutcome): Promise<string | null> {
  const note = (status: DirectOutcome["status"], code?: number) => { if (outcome) { outcome.status = status; outcome.code = code; } };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Full browser header set. Cloudflare's bot-fight mode challenges requests
    // that claim a Chrome UA but omit the client-hint / fetch-metadata headers
    // real Chrome sends -- a thin UA-only fetch gets walled while a complete
    // one sails through (verified live: fishcreeknissancalgary.ca returned the
    // full 1MB page to this header set after walling the thin version).
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-CA,en;q=0.9",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) { note(res.status === 429 || res.status === 503 ? "rate_limited" : "http_error", res.status); return null; }
    const html = await res.text();
    if (!html || html.length < 500) { note("empty", res.status); return null; }
    // A Cloudflare/queue interstitial returns 200 with a small challenge shell
    // (no real content) -- treat it as a failed load so we never parse it.
    if (html.length < 60000 && /Just a moment\.\.\.|cf-challenge|Attention Required!|Checking your browser|__cf_chl/i.test(html)) { note("challenged", res.status); return null; }
    note("ok", res.status);
    return html;
  } catch {
    note("network");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Retrying wrapper for the shared direct read. A single attempt is exactly how
// three reports in two days lost price/VIN/financing on Convertus pages:
// Cloudflare's bot scoring intermittently rejects the FIRST request from a
// datacenter IP while passing a retry moments later (the same page fetched
// clean from a residential IP every single time we checked). One failed
// attempt used to null out earlyConvertusVms / earlyJsonLd / the incentive
// reader / structuredFactsBlock all at once -- everything downstream of
// directHtml -- and the whole scan then leaned on the late, time-starved
// Scrapfly rescue. These retries run in PARALLEL with Nimble's own 30-100s
// extraction, so the added attempts cost zero wall-clock in practice.
//
// THE SPACING WAS THE BUG. The old loop retried at 1.5s and 3s, described
// in-comment as "a fresh connection, not a hammer". Against a per-IP rate
// limiter three requests inside 4.5 seconds IS a hammer: measured live
// 2026-08-27 against lexussouthpointe.com, 57 of 67 requests came back as a
// 5,927-byte "Just a moment..." challenge shell and every request after that
// returned HTTP 429. Real backoff with jitter gives the limiter's window time
// to roll over, and costs no wall-clock in practice because these attempts run
// in parallel with Nimble's own 30-100s extraction. A retry that cannot help
// (404, unparseable) is not retried at all.
async function fetchDirectHtmlRetry(url: string, timeoutMs: number, attempts = 3): Promise<string | null> {
  // 2s, 8s -- plus up to 1s of jitter, so concurrent scans of the same host do
  // not line their retries up on the same tick.
  const BACKOFF_MS = [2_000, 8_000];
  const outcome: DirectOutcome = { status: "network" };
  for (let i = 1; i <= attempts; i++) {
    const html = await fetchDirectHtml(url, timeoutMs, outcome);
    if (html) { if (i > 1) console.log(`Direct fetch succeeded on attempt ${i}/${attempts}.`); return html; }
    // A hard HTTP error or an unparseably small body is a fact about the page,
    // not about timing: retrying spends requests on an origin for no gain.
    if (outcome.status === "http_error" && outcome.code !== 429 && outcome.code !== 503) {
      console.warn(`Direct fetch: HTTP ${outcome.code} for ${url} -- not retrying.`);
      lastDirectOutcome = outcome.status;
      return null;
    }
    if (i < attempts) await sleep(BACKOFF_MS[i - 1] + Math.floor(Math.random() * 1_000));
  }
  lastDirectOutcome = outcome.status;
  console.warn(`Direct fetch failed after ${attempts} attempt(s) for ${url} (last outcome: ${outcome.status}${outcome.code ? " " + outcome.code : ""}).`);
  return null;
}

// The last direct-read outcome for this isolate, read only for logging and for
// the "page not read" disclosure. Deliberately not used for any buyer-facing
// claim about the DEALER -- an origin blocking our IP says nothing about them.
let lastDirectOutcome: DirectOutcome["status"] = "ok";

// Pull the first schema.org Vehicle/Car/Product node that carries an Offer with
// a price out of a page's <script type="application/ld+json"> blocks. Handles
// @graph arrays and a top-level array of nodes. Returns normalized fields, or
// null if no usable vehicle node is present. Never throws.
async function buildJsonLdFallbackAnalysis(url: string, sharedHtml?: Promise<string | null>): Promise<any | null> {
  try {
    // Reuse the caller's in-flight fetch when it supplied one, so the direct
    // read of the page happens ONCE per scan and can serve several consumers
    // (schema.org facts, embedded incentives) instead of one fetch each.
    const html = sharedHtml ? await sharedHtml : await fetchDirectHtml(url, 15_000);
    if (!html) { console.log(`JSON-LD fallback: direct fetch returned nothing for ${url}.`); return null; }
    const v = extractJsonLdVehicle(html);
    const tiwHit = matchTradeInWidget(html);
    if (!v || (v.price == null && !v.year && !v.model)) {
      console.log(`JSON-LD fallback: no usable schema.org Vehicle/Offer in ${url}.`);
      return null;
    }
    const vehicleStr = [v.year, v.make, v.model, v.trim].filter(Boolean).join(" ") || null;
    // Convertus days-on-lot straight from the html we already hold.
    let dol: any = null;
    try {
      const dm = html.match(/"date_on_lot":"(\d{4}-\d{2}-\d{2})[^"]*"/) || html.match(/"date_added":"(\d{4}-\d{2}-\d{2})[^"]*"/);
      if (dm) {
        const dt = Date.parse(dm[1] + "T00:00:00Z");
        const dd = Math.floor((Date.now() - dt) / 86_400_000);
        if (Number.isFinite(dt) && dd > 0 && dd <= 3650) dol = { days: dd, since: dm[1], source: "dealer_platform_page", sourceLabel: "the dealer's own inventory data" };
      }
    } catch { /* best-effort */ }
    // Deterministic price-gating detection: the page's own CTA text, read
    // straight from the HTML -- no LLM involved on this path. Only claimed when
    // no price was found (a priced page merely offering e-price forms isn't gated).
    // "Hidden by the dealer" requires the CTA to REPLACE the price. If the page
    // code also carries plausible price figures, WE failed to read it — that is
    // "not_shown", never a gating accusation (truthfulness > drama).
    const pageHasPriceFigures = (html.match(/\$\s?\d{2,3},\d{3}/g) || []).length > 0;
    const gated = v.price == null && !pageHasPriceFigures && /contact\s+us\s+for\s+price|call\s+for\s+price|get\s+e-?price|unlock\s+(the|this|your)\s+price|get\s+today'?s\s+price/i.test(html);
    const analysis: any = {
      vehicle: vehicleStr,
      year: v.year, make: v.make, model: v.model, trim: v.trim,
      vin: v.vin, odometerKm: v.odometerKm, fuelType: null,
      vehicleCondition: v.condition,
      dealerName: v.dealerName, dealerCity: v.dealerCity,
      msrp: null,
      quotedPrice: v.price,
      quotedPriceSource: v.price != null ? "structured_data" : null,
      priceDisclosure: v.price != null ? "advertised" : (gated ? "contact_for_price" : "not_shown"),
      daysOnLot: dol,
      // Both of these were read off the same html above. tradeInWidget used to
      // be computed here and then dropped on the floor, so the S36 flag went
      // missing on every fallback-path report.
      tradeInWidget: tiwHit,
      financeContingent: detectFinanceContingent(html),
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

// Convertus vmsData fallback -- same role as buildJsonLdFallbackAnalysis, for
// Convertus platform sites that carry NO schema.org JSON-LD at all (confirmed
// live, 2026-08-13: southtrailkia.com's "Platinum Kia" theme has zero
// <script type="application/ld+json"> blocks anywhere on the VDP, so the
// JSON-LD tier above always returns null for this whole platform family).
// Only reached here after BOTH the page scrape and the JSON-LD tier have
// already failed, so pages that load normally are unaffected. Unlike the
// JSON-LD fallback, this carries a real msrp (Convertus's vmsData always
// separates msrp from asking_price; schema.org listings essentially never do).
async function buildConvertusVmsFallbackAnalysis(url: string, sharedHtml?: Promise<string | null>): Promise<any | null> {
  try {
    const html = sharedHtml ? await sharedHtml : await fetchDirectHtml(url, 15_000);
    if (!html) { console.log(`Convertus fallback: direct fetch returned nothing for ${url}.`); return null; }
    const v = extractConvertusVmsVehicle(html);
    if (!v || (v.quotedPrice == null && v.msrp == null && !v.year && !v.model)) {
      console.log(`Convertus fallback: no usable vmsData.vehicle in ${url}.`);
      return null;
    }
    const tiwHit = matchTradeInWidget(html);
    const vehicleStr = [v.year, v.make, v.model, v.trim].filter(Boolean).join(" ") || null;
    const analysis: any = {
      vehicle: vehicleStr,
      year: v.year, make: v.make, model: v.model, trim: v.trim,
      vin: v.vin, odometerKm: v.odometerKm, fuelType: null,
      vehicleCondition: v.condition,
      dealerName: v.dealerName, dealerCity: v.dealerCity,
      // Left unset deliberately (not "listing"/"dealer_stated" here) -- the
      // shared enrichAnalysis pipeline's own provenance + catalog cross-check
      // (resolveMsrpAuthority) labels and verifies it, same as the primary path.
      msrp: v.msrp,
      quotedPrice: v.quotedPrice,
      quotedPriceSource: v.quotedPrice != null ? "structured_data" : null,
      priceDisclosure: v.quotedPrice != null ? "advertised" : "not_shown",
      daysOnLot: null,
      tradeInWidget: tiwHit,
      financeContingent: detectFinanceContingent(html),
      standardWarranty: null,
      addOns: [], totalFlaggedCost: 0, warranty: null,
      // The dealer's own advertised finance rate lives in the SAME vmsData
      // blob as price/VIN -- captured here too, not just the itemized fee
      // breakdown (which genuinely isn't in this data source, hence the note
      // below still calling that out specifically).
      financing: v.financeApr != null ? { rate: v.financeApr, termMonths: v.financeTermMonths, source: "convertus_vms" } : null,
      pricingDisclaimer: v.finePrint,
      source: "structured_data_fallback",
      sourceNote: "The dealer's listing page couldn't be read the usual way, so this report was built from the page's own vehicle-data platform (not the rendered page). Core vehicle details, the dealer's stated price/MSRP, and the advertised financing rate come straight from that data. Itemized add-on fees couldn't be read this way and aren't included -- upload a screenshot for the full breakdown.",
      summary: `${vehicleStr ?? "This vehicle"}${v.quotedPrice != null ? ` is listed at $${v.quotedPrice.toLocaleString()}` : ""}. This report was built from the dealer platform's own vehicle data rather than the full page, so itemized add-on fees aren't included -- confirm the out-the-door price and any add-on fees directly with the dealer.`,
    };
    try {
      const m = html.match(/"date_on_lot":"(\d{4}-\d{2}-\d{2})[^"]*"/) || html.match(/"date_added":"(\d{4}-\d{2}-\d{2})[^"]*"/);
      if (m) {
        const dt = Date.parse(m[1] + "T00:00:00Z");
        const dd = Math.floor((Date.now() - dt) / 86_400_000);
        if (Number.isFinite(dt) && dd > 0 && dd <= 3650) analysis.daysOnLot = { days: dd, since: m[1], source: "dealer_platform_page", sourceLabel: "the dealer's own inventory data" };
      }
    } catch { /* best-effort */ }
    console.log(`Convertus fallback: built analysis for ${url} (${vehicleStr ?? "unknown"}), price=${v.quotedPrice ?? "none"}, msrp=${v.msrp ?? "none"}, vin=${v.vin ? "present" : "none"}, condition=${v.condition ?? "unknown"}.`);
    return analysis;
  } catch (err) {
    console.warn("buildConvertusVmsFallbackAnalysis threw:", err);
    return null;
  }
}

// Hand the page's OWN structured data to Claude alongside the scraped text.
//
// WHY. These same facts are already gap-filled into the analysis AFTER Claude
// runs, so the numbers on the report were right — but the narrative wasn't.
// Claude only ever saw the scraped text, so when a dealer page rendered its
// price into schema.org markup but not into readable prose, Claude correctly
// reported that it found no price and told the buyer to go ask the dealer,
// while the gap-fill quietly populated quotedPrice underneath. The buyer got a
// report showing $39,890 next to a summary saying no price was disclosed.
// Measured 2026-08-11 on a live Kramer Mazda listing (schema.org Offer said
// $39,890; the summary said "no price ... present to extract").
//
// Fixing the class means Claude must not be able to claim a fact is absent
// when we can already see it. The fetch is a plain browser-shaped GET started
// in parallel far upstream, so by this point it has almost always resolved;
// the race below caps the wait so a slow dealer can never stall the scan on a
// safety net. Facts are labelled as authoritative, not as a hint — they are
// read from the page's machine-readable markup, which is stronger evidence
// than prose, and they are exactly what the gap-fill would apply anyway.
async function structuredFactsBlock(early: Promise<any | null>): Promise<string> {
  let d: any = null;
  try {
    d = await Promise.race([
      early,
      new Promise((r) => setTimeout(() => r(null), 1_500)),
    ]);
  } catch { d = null; }
  if (!d) return "";

  const facts: string[] = [];
  const price = Number(d.quotedPrice);
  if (price > 0) facts.push(`- Advertised price: $${price.toLocaleString("en-CA")}`);
  // The dealer's OWN stated MSRP for this exact unit (e.g. Convertus vmsData) --
  // not necessarily the verified manufacturer figure, which the enrichment
  // pipeline resolves separately. Still worth Claude seeing so it never claims
  // "no MSRP shown" when the page's own data plainly states one.
  const msrp = Number(d.msrp);
  if (msrp > 0) facts.push(`- MSRP (as stated on this page): $${msrp.toLocaleString("en-CA")}`);
  if (d.vin) facts.push(`- VIN: ${d.vin}`);
  if (d.vehicle) facts.push(`- Vehicle: ${d.vehicle}`);
  const odo = Number(d.odometerKm);
  if (Number.isFinite(odo) && odo >= 0) facts.push(`- Odometer: ${odo.toLocaleString("en-CA")} km`);
  if (d.vehicleCondition) facts.push(`- Condition: ${d.vehicleCondition}`);
  if (d.dealerName) facts.push(`- Dealer: ${d.dealerName}`);
  if (!facts.length) return "";

  console.log(`Structured facts passed to Claude: ${facts.length} field(s).`);
  return (
    `\n\n---\nVERIFIED FROM THIS PAGE'S OWN STRUCTURED DATA (schema.org markup or the platform's own embedded vehicle-data JSON).\n` +
    `These values are machine-read directly from the page and are authoritative. Some dealer platforms put ` +
    `them ONLY in markup or script-embedded JSON, so they may not appear in the extracted text above — that ` +
    `does NOT mean the page withheld them.\n\n${facts.join("\n")}\n\n` +
    `Use these values in your output, and never state or imply that one of them is missing, undisclosed, or ` +
    `not shown on the page. If the extracted text disagrees with a value here, say so plainly in the summary ` +
    `so the buyer can check it — do not silently pick one.\n---`
  );
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
// ENRICHMENT IS BY DEFINITION OPTIONAL. By the time this runs the report
// already has the price, the VIN, the trim and the recalls -- everything that
// makes it worth sending. Every step inside adds a POINT, and a point that
// cannot be computed is a hollow point, not a failed report.
//
// It was called bare from six places. A Lethbridge Toyota scan died with
// "Something went wrong analyzing that listing" because lookupManufacturerMsrp's
// internal fetchWithRetry threw an AbortError on a slow manufacturer page --
// one optional lookup, and the buyer lost a report that was otherwise complete.
// Guarding each enricher individually would leave the next one added unguarded
// by default; guarding the boundary covers every one of them, including the
// ones nobody has written yet.
async function enrichAnalysis(a: any, deadline: number): Promise<void> {
  try {
    await enrichAnalysisInner(a, deadline);
  } catch (e) {
    // Loud in the logs, invisible to the buyer beyond the points that stayed
    // hollow -- which already say so honestly on their own.
    console.warn("enrichAnalysis threw (report continues with whatever landed):", (e as Error)?.message);
    a.enrichmentIncomplete = true;
  }
}

async function enrichAnalysisInner(analysis: any, deadline?: number): Promise<void> {
  await applyVerifiedWarranty(analysis);
  await applyRemainingWarranty(analysis);
  await applyVerifiedFuelType(analysis);
  // Sale-condition granularity (new/demo/certified/used), derived here so both the
  // market-value CPO premium below and the certified counter-script move can use it.
  analysis.saleCondition = deriveSaleCondition({ vehicleCondition: analysis.vehicleCondition, saleCondition: analysis.saleCondition ?? analysis.saleConditionHint ?? null });
  // Auto market value (best-effort) from our OWN crawl (lotcheck provider, the
  // default): needs the VIN plus ymm + condition to build the comparable set,
  // and returns null on thin coverage so the report omits the module.
  if (analysis.vin) {
    const mv = await fetchMarketValue(
      analysis.vin,
      analysis.odometerKm != null ? Number(analysis.odometerKm) : null,
      { year: analysis.year, make: analysis.make, model: analysis.model, trim: analysis.trim, condition: analysis.vehicleCondition,
        saleCondition: analysis.saleCondition, asking: analysis.quotedPrice != null ? Number(analysis.quotedPrice) : null,
        province: resolveJurisdiction(analysis).code },
    );
    if (mv) analysis.marketValue = mv;
  }
  analysis.vinCheck = validateVin(analysis.vin);
  // Canonical base model resolved once (e.g. "Palisade Ultimate Calligraphy" ->
  // "PALISADE"), feeding BOTH the recall and MSRP lookups so trim in the model
  // field can't produce a false "no recalls"/"MSRP not found". See make-recalls-fail-safe.
  // Resolve against model + trim COMBINED: the scraper often splits a compound
  // model name into model + trim ("bZ Woodland" -> model "bZ", trim "Woodland";
  // "Grand Cherokee L" -> "Grand Cherokee" + "L"). resolveBaseModel returns the
  // LONGEST catalog model that prefixes the combined string, so the split name
  // reunites to the right row while ordinary trims ("XLE Premium") never over-merge.
  const baseModel = await resolveBaseModel(analysis.year, analysis.make, [analysis.model, analysis.trim].filter(Boolean).join(" "));
  if (analysis.year && analysis.make && analysis.model) {
    analysis.recalls = await lookupRecalls(analysis.year, analysis.make, analysis.model, baseModel);
  }

  // Manufacturer-site MSRP fallback -- only spend the extra search+extraction
  // cost when the vehicle doesn't already carry an MSRP. Catalog (a fast DB
  // read) is tried first; only on a miss does the ~30s manufacturer scrape run.
  // The request deadline is threaded through so this expensive step self-skips
  // when there isn't enough budget left to finish before the platform ceiling.
  // ASSERT (mid-pipeline). No render-check context is passed, so the price-
  // gating accusation gate deliberately stays dormant here -- a later Scrapfly
  // rescue may still recover the price. See invariants.ts.
  assertInvariants(analysis);

  if (!analysis.msrp && analysis.year && analysis.make && analysis.model) {
    // VIN -> drivetrain (free, NHTSA): the strongest trim-disambiguation signal.
    const vinDrive = await decodeVinDrive(analysis.vin);
    const catMsrp = await lookupCatalogMsrp(analysis.year, analysis.make, baseModel || analysis.model, analysis.trim ?? null, {
      rawModel: analysis.model, fuelType: analysis.fuelType,
      quotedPrice: Number(analysis.quotedPrice) > 0 ? Number(analysis.quotedPrice) : null,
      drivetrain: analysis.drivetrain ?? null, vinDrive,
    });
    if (catMsrp) {
      analysis.msrp = catMsrp.msrp;
      analysis.msrpSource = "catalog";
      // "exact" = trim pinned; "starting_at" = honest floor. The UI label flips
      // on this so a floor is never presented as the exact trim MSRP.
      analysis.msrpBasis = catMsrp.basis;
      if (catMsrp.trim) analysis.msrpTrim = catMsrp.trim;
      if (catMsrp.year && catMsrp.year !== analysis.year) analysis.msrpYear = catMsrp.year; // adjacent-MY reference, surfaced honestly
      if (catMsrp.sourceUrl) analysis.msrpSourceUrl = catMsrp.sourceUrl; // provenance link for the report
      if (catMsrp.priceBasis) analysis.msrpPriceBasis = catMsrp.priceBasis;   // incl_freight | excl_freight
      // The manufacturer's own all-in for this trim, and the model ceiling.
      // Without these the report compares an AMVIC all-in advertised price
      // against an ex-freight MSRP and counts ~$3,000 of freight as markup.
      if (catMsrp.allIn) analysis.msrpAllIn = catMsrp.allIn;
      if (catMsrp.ceiling) analysis.msrpCeiling = catMsrp.ceiling;
      // A USED car's catalog match is the price when it was NEW. That is useful
      // context ("this cost $X new") but it is NOT a sticker to measure today's
      // asking price against -- a 2014 truck is not "$35,000 under MSRP". Mark
      // it so every over/under claim stays switched off.
      const isUsed = String(analysis.vehicleCondition || "").toLowerCase() === "used"
        || (Number(analysis.odometerKm) > 5000 && String(analysis.vehicleCondition || "").toLowerCase() !== "new");
      if (isUsed) {
        analysis.originalMsrp = { msrp: catMsrp.msrp, trim: catMsrp.trim || null, year: catMsrp.year || analysis.year, sourceUrl: catMsrp.sourceUrl || null };
        analysis.msrpBasis = "original_when_new";
      }
    } else {
      // AN OPTIONAL ENRICHMENT MUST NEVER TAKE THE SCAN DOWN. lookupManufacturerMsrp
      // returns null on every failure it anticipates, but its internal
      // fetchWithRetry THROWS when attempts or budget run out -- and that
      // AbortError propagated through enrichAnalysis to the top-level handler,
      // so a Lethbridge Toyota scan that already had the price, the VIN and the
      // recalls died with "Something went wrong analyzing that listing."
      // A missing manufacturer MSRP is one hollow point; it is not a failed
      // report ([[report-never-empty]]).
      const mfrMsrp = await lookupManufacturerMsrp(analysis.year, analysis.make, analysis.model, analysis.trim ?? null, deadline)
        .catch((e: unknown) => { console.warn("lookupManufacturerMsrp threw (continuing without it):", (e as Error)?.message); return null; });
      if (mfrMsrp) {
        analysis.msrp = mfrMsrp;
        analysis.msrpSource = "manufacturer_site";
        // This path set a figure and NO basis, so every surface that keyed off
        // `msrpBasis` saw undefined and each one guessed differently.
        // `starting_at` is the honest label: the live site lookup is a real
        // manufacturer figure -- so it may be attributed to them by name -- but
        // it is not proof we matched THIS trim, drivetrain and options, so it
        // must not support an over/under claim. If the lookup ever proves an
        // exact configuration match, it can upgrade this itself.
        const isUsedUnit = String(analysis.vehicleCondition || "").toLowerCase() === "used"
          || (Number(analysis.odometerKm) > 5000 && String(analysis.vehicleCondition || "").toLowerCase() !== "new");
        analysis.msrpBasis = isUsedUnit ? "original_when_new" : "starting_at";
      }
    }
  }

  // Used vehicles with no catalog row for their model year: the honest answer
  // is that we don't hold original MSRPs that far back, plus the ask that gets
  // the buyer the real number. Never leave the point blank (report-never-empty).
  {
    const used = String(analysis.vehicleCondition || "").toLowerCase() === "used"
      || (Number(analysis.odometerKm) > 5000 && String(analysis.vehicleCondition || "").toLowerCase() !== "new");
    if (used && !(Number(analysis.msrp) > 0)) {
      analysis.msrpUnavailable = {
        reason: "used_original_msrp_not_held",
        note: `We don't hold the original ${analysis.year || ""} MSRP for this model, so no new-price comparison is made. Ask the seller for the original window sticker or build sheet — it lists the MSRP and the options actually fitted.`,
      };
    }
  }

  // Provenance for an MSRP that came from the LISTING itself. Until this label
  // existed, a dealer's own sticker figure was rendered exactly like a verified
  // manufacturer MSRP -- Advantage Ford stated $66,015 on a Mach-E Premium that
  // Ford Canada advertises from $47,638, and the report turned that into
  // "$5,023 UNDER MSRP", amplifying the dealer's discount claim for them
  // (2026-08-11). An unverified number must never read as a verified one.
  if (analysis.msrp && !analysis.msrpSource) {
    analysis.msrpSource = "listing";
    analysis.msrpBasis = "dealer_stated";
  }

  // The listing stated an MSRP: cross-check it against the manufacturer catalog.
  // An EXACT trim match outranks the dealer's claim in BOTH directions -- their
  // number is unverifiable, ours links to the manufacturer's own page. A padded
  // sticker is additionally named as a tactic. A "starting at" floor never
  // displaces their figure; it rides alongside as a reference.
  if (analysis.msrp && analysis.msrpSource !== "catalog" && analysis.msrpSource !== "manufacturer_site"
      && analysis.year && analysis.make && analysis.model) {
    const vinDrive = await decodeVinDrive(analysis.vin);
    const ref = await lookupCatalogMsrp(analysis.year, analysis.make, baseModel || analysis.model, analysis.trim ?? null, {
      rawModel: analysis.model, fuelType: analysis.fuelType,
      quotedPrice: Number(analysis.quotedPrice) > 0 ? Number(analysis.quotedPrice) : null,
      drivetrain: analysis.drivetrain ?? null, vinDrive,
    });
    // Who wins is decided in one place now (see _shared/msrp-authority.js):
    // an EXACT trim match from the manufacturer catalog is the MSRP, whichever
    // direction the dealer's number points. It used to override only when the
    // dealer inflated, so a dealer-stated figure silently became the report's
    // MSRP in every other case.
    const decided = resolveMsrpAuthority({ statedMsrp: Number(analysis.msrp), ref, make: analysis.make || null });
    analysis.msrp = decided.msrp;
    analysis.msrpBasis = decided.basis;
    analysis.msrpSource = decided.source;
    if (decided.trim) analysis.msrpTrim = decided.trim; else if (decided.basis !== "dealer_stated") delete analysis.msrpTrim;
    if (decided.sourceUrl) analysis.msrpSourceUrl = decided.sourceUrl;
    if (decided.priceBasis) analysis.msrpPriceBasis = decided.priceBasis;
    if (decided.dealerStatedMsrp) analysis.dealerStatedMsrp = decided.dealerStatedMsrp;
    if (decided.inflation) analysis.msrpInflation = decided.inflation;
    if (decided.reference) analysis.msrpReference = decided.reference;

  }

  computeFinancingCheck(analysis);
  computeOdometerCheck(analysis);
  await resolveFinanceRates(analysis);
  await resolveLeaseRates(analysis);
  // Deal Decoder — run AFTER msrp + finance rates are resolved.
  { const rec = computeReconciliation(analysis); if (rec) analysis.reconciliation = rec; }   // S3
  { const ft = computeFinancingTrap(analysis); if (ft) analysis.financingTrap = ft; }         // S11
  { const df = assessDocFee(analysis); if (df) analysis.docFeeCheck = df; }                   // S12
  // S25. The city is ONE signal and it silently failed on Charlesglen, leaving
  // allInPricing null -- and null meant "not all-in", printing Toyota's own
  // $3,078 of freight as dealer markup. Ask every other province signal on the
  // page, and leave it UNDEFINED rather than false when nothing answers, so
  // qualifyMsrpClaim refuses instead of guessing a basis.
  {
    const ai = resolveAllInAuthority(analysis.dealerCity);
    if (ai) analysis.allInPricing = ai;
    else {
      const { allIn, jurisdiction } = isAllInJurisdiction(analysis);
      if (allIn === true) {
        analysis.allInPricing = { code: jurisdiction.code, body: jurisdiction.code === "AB" ? "AMVIC" : "provincial regulator", source: `resolved from ${jurisdiction.source}` };
      } else if (allIn === false) {
        analysis.allInPricing = null;
        analysis.allInResolved = jurisdiction;
      }
      else {
        // We LOOKED and could not tell. Record that as a finding so the claim
        // refuses; leaving it merely absent is what caused $11,173.
        analysis.basisUnknown = true;
        analysis.allInResolved = jurisdiction;
      }
    }
  }
  // Moved here (was right after resolveLeaseRates, before allInPricing above
  // was even resolved) -- computeLeverageScore's over-MSRP delta needs
  // analysis.allInPricing/msrpAllIn to compare an AMVIC all-in advertised
  // price against the correct all-in reference, not the ex-freight MSRP
  // (qualifyMsrpClaim's own "$3,078 of freight printed as dealer markup"
  // lesson, msrp-claim.ts) -- it was silently running before either field
  // existed, every single time, for every report.
  computeLeverageScore(analysis);
  { const dc = assessDisclaimer(analysis); if (dc) analysis.disclaimerCheck = dc; }             // S35 (fine print = our evidence)
  await checkDealerLicence(analysis);                                                          // #11 AMVIC licence (Alberta)
  // LAST WORD GOES TO THE STRUCTURED VERDICTS. A RAV4 PHEV report shipped
  // saying "NOT ELIGIBLE" in the rebate panel and, two pages later, "treat it
  // as a PHEV for rebate-eligibility purposes -- worth confirming with the
  // dealer". The prompt itself asked for that second sentence, so a prompt
  // cannot be the fix; this runs after generation and is deterministic.
  if (typeof analysis.summary === "string" && analysis.summary) {
    const s = stripSettledContradictions(analysis.summary, analysis);
    if (s.removed.length) {
      analysis.summary = s.text;
      analysis.summaryRedactions = s.removed;
      console.log(`summary: removed ${s.removed.length} sentence(s) reopening settled topics: ${s.removed.map((r) => r.topic).join(", ")}`);
    }
  }

  // DEALER REPUTATION, RESOLVED HERE rather than left to the frontend.
  //
  // get-dealer-sentiment is called by the BROWSER after the report renders, and
  // its result is merged into React state. Three things follow: the EMAILED
  // report races that call and usually loses, a failed call returns silently so
  // nothing records that we tried, and the panel then reads absence as
  // absence-of-reviews. That is how Stampede Toyota -- 4.5 stars from 3,369
  // Google reviews -- reached a buyer as "NOT CHECKED", and Charlesglen (5,930
  // reviews) reached one as "No public reviews were found".
  //
  // Resolving it in the pipeline puts it on the analysis object before ANY
  // surface is built, so screen, email and PDF agree.
  await resolveDealerReputation(analysis);

  // VIC'S RULE: no dealer terms -> use the manufacturer's APR and price and do
  // the math. Runs after the rates and the MSRP are resolved, and only when the
  // dealer disclosed nothing of their own -- a real quoted payment always wins.
  if (!analysis.financingCheck?.checked) {
    const ref = computeReferenceFinancing(analysis);
    if (ref) {
      analysis.referenceFinancing = ref;
      console.log(`reference financing: ${ref.apr}% / ${ref.termMonths}mo -> asking $${ref.atAsking?.monthly ?? "?"}/mo, delta ${ref.monthlyDelta ?? "n/a"}`);
    }
  }

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
  "saleCondition": "new" | "demo" | "certified" | "used" | null,  // finer than vehicleCondition. "certified" only if the page shows a manufacturer/OEM certified pre-owned badge (e.g. "Toyota Certified", "H-Promise", "Certified Pre-Owned"); "demo" if it says demo/demonstrator/dealer-demo; else mirror vehicleCondition (new->"new", used->"used").
  "dealerName": string | null,    // the dealership's business name as it would appear on Google (e.g. "Macleod Trail Toyota", "Calgary Honda") -- usually near the top of the page or in an "Available at..." line. Do NOT include the city/location as part of this field; that's a separate concern.
  "dealerCity": string | null,    // the city (and province if visible, e.g. "Calgary, AB") the dealership operates in. Needed to disambiguate common dealer names -- there are many "Toyota" or "Honda" dealers across Canada, and the name alone isn't enough to look up the right one.
  "msrp": number | null,          // the manufacturer's suggested retail price, before any options, fees, or discounts. Often NOT shown as a standalone price tag -- many dealer sites, especially "payment-first" listings with no separate sticker price displayed anywhere, only state it inside a dense lease/finance legal disclosure paragraph, in a pattern like "Lease payments include: MSRP ($32,300.00), [paint/option] ($550.00), Freight and PDI ($1,830.00), ...". Read fine-print/legal disclosure text carefully for this pattern -- do not restrict your search to prominent, large-font prices.
  "quotedPrice": number | null,   // the actual all-in selling price being charged before tax, whichever direction it moves relative to MSRP. This is usually one of: (a) a discounted advertised price below MSRP (sometimes labeled "Market Value" or similar), OR (b) on a payment-first listing with no advertised discount, the full selling price/net cap cost AFTER dealer-installed options and fees are added ON TOP of MSRP -- sometimes labeled "Lease Price", "Selling Price", "Cap Cost", or similar in fine print. Do NOT leave this null just because there's no discount -- if the page discloses a total price for the deal at all, even one higher than MSRP because of added fees, that IS the quotedPrice. PRECEDENCE WHEN A PAGE SHOWS MORE THAN ONE PRICE (this is common and it decides the whole report, so apply it strictly): rule (b) is a FALLBACK for pages that show no standalone cash price at all -- it is NOT a choice between two numbers. If the page states a standalone advertised cash/asking price anywhere (a headline price, a "Cash Price", a "Price" field, the browser tab title, or the page's own structured data), THAT is the quotedPrice, even when a Finance or Lease tab elsewhere on the same page shows a HIGHER figure for the same car. A finance/lease-tab number is a capitalized cost for a specific financing structure, not the cash asking price, so it must never displace a standalone cash price. Confirmed real: a listing advertised a "Cash Price" of $50,308 while its Finance tab showed a "Carter Cash Price" of $53,745 -- $50,308 is the quotedPrice, and the $53,745 belongs in addOns/summary as an unexplained finance-only markup for the buyer to challenge. When you do see two such figures, always name BOTH in the summary and say which one you treated as the asking price, so the buyer can check you.
  "priceDisclosure": "advertised" | "contact_for_price" | "not_shown",
  "pricingDisclaimer": string | null,  // VERBATIM excerpt (max 600 characters) of the page's pricing fine-print/disclaimer text, when present -- the small print about pricing accuracy, e.g. "cannot guarantee the accuracy", "prices subject to change without notice", "does not constitute an offer", "errors and omissions", all-in/fee-inclusion statements. Copy the actual words from the page; never compose or summarize. null when the page carries no such text.  // HOW the page handles price: "advertised" = a real number is published; "contact_for_price" = the page DELIBERATELY withholds the price and asks the shopper to call/email/submit a form instead (text like "Contact Us For Price", "Call for Price", "Get E-Price", "Unlock This Price", "Get Today's Price" IN PLACE of a number); "not_shown" = no price appears and no such call-to-action replaces it. Only use "contact_for_price" when the page genuinely gates the price behind contact -- this powers a transparency note shown to the buyer, so it must be literally true from the page text.
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

// Third-party listing aggregators whose Terms of Service prohibit automated
// access / scraping / commercial reuse of their data. LotCheck must never
// server-side fetch these: the fetch (not the buyer viewing the page) is what
// breaches their ToS, and our anti-bot headers arguably circumvent their
// access controls. A buyer's right to VERIFY is preserved via the screenshot-
// upload path — the buyer captures their own image, LotCheck reads that image
// and never touches the aggregator's servers. Dealer-owned domains are NOT
// here: those are the dealer's own listing and keep the URL path. This is a
// compliance gate pending lawyer sign-off (see always-check-legally-clear).
const AGGREGATOR_HOSTS = [
  "autotrader.ca",
  "autotrader.com",
  "cargurus.ca",
  "cargurus.com",
  "kijijiautos.ca",
  "kijiji.ca",
  "carfax.ca",
  "carfax.com",
  "clutch.ca",
  "carpages.ca",
  "autotrader.co.uk",
  "cars.com",
  "truecar.com",
  "carvana.com",
];

// Returns the matched aggregator host if `raw` is a URL on one of them, else
// null. Matches the registrable domain and any subdomain (www., m., etc.).
function aggregatorHost(raw: string): string | null {
  let host: string;
  try {
    host = new URL(raw.trim()).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  return (
    AGGREGATOR_HOSTS.find((d) => host === d || host.endsWith("." + d)) ?? null
  );
}

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
    const { url, regionToken, regionSelfDeclared } = await req.json();
    if (!url || typeof url !== "string") {
      return new Response(
        JSON.stringify({ error: "No listing URL received." }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    // Alberta-only. Runs BEFORE the credit hold and before any vendor call, so
    // an out-of-province visitor costs nothing. The region is proven by an HMAC
    // token minted by Vercel (which actually sees the IP) — never claimed by
    // the browser. Fails OPEN when we cannot establish a location, because
    // IP geolocation routinely misplaces Albertans and refusing one paying
    // customer is worse than serving a few visitors we should not have.
    {
      const gate = await gateRequest({
        token: regionToken,
        secret: Deno.env.get("REGION_TOKEN_SECRET") ?? "",
        selfDeclared: regionSelfDeclared === true,
      });
      if (!gate.allow) {
        return new Response(JSON.stringify({
          error: "outside_service_area",
          region: gate.region ?? null,
          regionLabel: gate.regionLabel ?? null,
        }), { status: 403, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }
    }

    // Aggregator ToS gate. Runs before the credit hold and any scrape, so a
    // blocked link costs the user nothing. We do NOT auto-fetch AutoTrader/
    // CarGurus/etc.; instead we tell the buyer how to verify without LotCheck
    // touching those servers (paste the dealer's own link, or upload a
    // screenshot). Structured error so the client can render the two options.
    const blockedHost = aggregatorHost(url);
    if (blockedHost) {
      return new Response(
        JSON.stringify({
          error: "aggregator_not_supported",
          host: blockedHost,
          message:
            `${blockedHost} is a listing marketplace whose terms don't allow other ` +
            `services to pull pages from it automatically. You can still verify this ` +
            `deal two ways: paste the dealer's own website link for the same vehicle, ` +
            `or upload a screenshot of the listing — LotCheck reads your screenshot ` +
            `directly and never touches ${blockedHost}.`,
        }),
        { status: 422, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
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
      if (cached?.analysis && cached.analysis._cacheVer !== CACHE_VER) {
        console.log(`Cache entry for ${url} is from an older code version (${cached.analysis._cacheVer || "untagged"}) -- rescanning.`);
      } else if (cached?.analysis && (Date.now() - new Date(cached.created_at).getTime()) < CACHE_TTL_MS) {
        const ageS = Math.round((Date.now() - new Date(cached.created_at).getTime()) / 1000);
        console.log(`Cache HIT for ${url} (age ${ageS}s) -- returning cached analysis, no scrape.`);
        // Guardrail: an empty cached entry (no price/MSRP) is not a report --
        // don't charge, steer to upload (same as the fresh-scrape path).
        const cachedHasPricing = (Number(cached.analysis.quotedPrice) > 0) || (Number(cached.analysis.msrp) > 0);
        if (!cachedHasPricing) {
          await releaseCredit(holdId);
          holdId = null;
          return new Response(
            JSON.stringify({ error: "unreadable_listing", message: UNREADABLE_LISTING_MESSAGE, refunded: true, vehicle: cached.analysis.vehicle || null, dealerName: cached.analysis.dealerName || null }),
            { status: 422, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
          );
        }
        await finalizeServerSide(cached.analysis); // finalizes entries cached before this change
        // A cached delivery is a DELIVERED, CHARGED report and must be counted
        // as one. This branch sits above every logUsage call site in the file
        // and wrote nothing at all, so "URL scans" in the admin ledger was
        // really a count of cache MISSES, and a cached report contributed zero
        // of its 13 checkpoints. Two consequences worth naming: the panel
        // undercounted real deliveries, and the per-check failure rate was
        // computed over a biased sample (fresh scans only).
        await instrumentDelivery(cached.analysis, "cache hit");
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

    // Start the sealed-screenshot capture NOW, in parallel with the whole scan,
    // so it gets the full request duration instead of the seconds left after
    // extraction. Fire-and-forget until the attach point; errors resolve null.
    // Instrumented so Scrapfly's screenshot job is directly comparable with
    // Nimble's extract job on the same listing — same host, same run, both
    // logged. 60 credits/shot on the Discovery plan (~$0.009).
    const SCRAPFLY_SHOT_CREDITS = 60, SCRAPFLY_SHOT_USD = 0.009;
    const shotPromise: Promise<{ b64: string; mime: string } | null> = scrapflyEnabled()
      ? (() => {
          const t0 = Date.now();
          return captureListingScreenshot(url, 90_000)
            .then((r) => {
              logProviderCall({
                provider: "scrapfly", operation: "screenshot", ok: !!r,
                driver: "capture", listingHost: hostOf(url),
                durationMs: Date.now() - t0,
                errorCode: r ? null : (lastScrapflyError ?? "empty"),
                credits: r ? SCRAPFLY_SHOT_CREDITS : null,
                costUsd: r ? SCRAPFLY_SHOT_USD : null,
              });
              return r;
            })
            .catch((e) => {
              logProviderCall({
                provider: "scrapfly", operation: "screenshot", ok: false,
                driver: "capture", listingHost: hostOf(url),
                durationMs: Date.now() - t0, errorCode: String(e).slice(0, 120),
              });
              return null;
            });
        })()
      : Promise.resolve(null);

    // Structured-data safety net, started NOW instead of only after the scrape
    // fails. Many dealer platforms (EDealer, Convertus, ...) serve a complete
    // schema.org Vehicle/Offer node -- price, VIN, odometer, dealer -- to a
    // plain browser-shaped GET in well under a second. Racing it alongside the
    // scrape costs one cheap request and means a slow or failing scrape can
    // never starve the fallback of budget (advantageford.ca, 2026-08-11: the
    // scrape burned the clock and the buyer got a dead end while the page was
    // handing out the price the whole time). Errors resolve to null.
    // ONE direct read of the page source, shared by every consumer that needs
    // raw HTML. Nimble is asked for `formats: ["markdown"]` only, so
    // nimbleData.data.html is ALWAYS undefined — an earlier version of the
    // stacked-incentive reader hung off that field and therefore never
    // executed even once in production, despite passing 18/18 against a saved
    // copy of the very page it was written for. Anything needing real HTML
    // must come through here.
    const directHtml: Promise<string | null> = fetchDirectHtmlRetry(url, 15_000).catch(() => null);
    // Pre-warm the Scrapfly render the MOMENT the direct fetch conclusively
    // fails (all retries exhausted) -- the strongest early signal the rescue
    // will be needed. Started here, ~20-50s into the request, it runs in
    // parallel with Nimble+Claude and is finished (or nearly) by the time any
    // rescue call site wants it; started there instead, the honestly-bounded
    // remaining budget is often too short for a cold ASP render of a
    // bot-protected page and the rescue dies empty-handed (albertahonda.com,
    // 2026-08-14: a paid report shipped with no price/VIN/APR while every one
    // of those figures was on the page). Cost: one ASP render (~a few cents)
    // spent ONLY on scans whose direct fetch failed -- exactly the scans that
    // were otherwise losing data outright. Resolves null when the direct
    // fetch succeeded (rescue then renders fresh only if it actually fires).
    const earlyRender: Promise<RenderResult | null> = scrapflyEnabled()
      ? directHtml.then((html) => (html ? null : (console.log("Direct fetch failed -- pre-warming Scrapfly render for a possible rescue."), scrapflyRender(url, 70_000)))).catch(() => null)
      : Promise.resolve(null);
    // THE PAGE SOURCE EVERY READER USES -- direct fetch first, the render second.
    //
    // Until now every structured reader hung off `directHtml` alone, so ONE
    // blocked GET emptied price, MSRP, VIN, trim, APR and days-on-lot in a
    // single stroke. Confirmed live 2026-08-27 on a real paid report
    // (LC-46A4-66F, a 2026 Lexus NX 350h at lexussouthpointe.com): the page's
    // own vmsData carried asking_price 62005, VIN 2T2GKCEZ8TC072832, msrp
    // 58675, 8.99% APR and date_on_lot 2026-05-04 the entire time, and the
    // buyer was shown "ASKING PRICE: Not shown" and "VIN: NOT ON QUOTE".
    // Nothing was wrong with the extractors -- they were simply never handed
    // any HTML, because Cloudflare served a challenge shell to the datacenter
    // IP and fetchDirectHtml correctly returned null.
    //
    // The rescue render was ALREADY being paid for on exactly these scans
    // (earlyRender above fires the moment the direct fetch conclusively
    // fails), and scrapfly.ts had been running its own private copy of
    // extractConvertusVmsVehicle on that HTML in a second, later pipeline.
    // This promotes that same HTML into the ONE reader chain, so a blocked
    // origin costs coverage of nothing we already hold. [[no-single-point-of-failure]]
    // The resolution itself lives in _shared/page-source.js so the regression
    // gate exercises the REAL function rather than a copy of its logic that
    // can drift away from it.
    const pageHtml: Promise<string | null> = directHtml.then(async (html) => {
      const r = await earlyRender.catch(() => null);
      const picked = resolvePageSource(html, r, (m) => console.log(m));
      if (picked.source === "none") console.warn(`No page source: direct read ${lastDirectOutcome}, render produced no usable HTML.`);
      return picked.html;
    }).catch(() => null);

    const earlyJsonLd: Promise<any | null> = buildJsonLdFallbackAnalysis(url, pageHtml).catch(() => null);
    // Convertus platform sites (southtrailkia.com and its "/vehicles/YYYY/"
    // siblings) embed a `var vmsData = {...}` blob with price/VIN/identity
    // that Nimble's markdown AND this same direct-fetch text view both miss
    // entirely (both drop <script> content) -- confirmed live 2026-08-13:
    // a real, correctly-scraped page still reported "price not shown" while
    // this exact unit's real msrp/asking_price sat unread in that blob. Reuses
    // the SAME directHtml fetch above; costs nothing extra. See convertus-vms.js.
    const earlyConvertusVms: Promise<any | null> = pageHtml.then((html) => (html ? extractConvertusVmsVehicle(html) : null)).catch(() => null);
    // D2C Media platform sites embed a `window.__vdpJSON = {...}` blob --
    // D2C's analogue of Convertus's vmsData, same directHtml fetch, costs
    // nothing extra. Specified 2026-08-15, never actually wired in until now
    // -- confirmed live TWICE on the identical listing (Okotoks Toyota RAV4
    // PHEV GR Sport, VIN JTM7ERAV1TD018440): the page templates "Call for
    // pricing" over the real fields it renders, but priceWithoutCustomFees
    // keeps the true $85,995 ask the whole time. See d2c-vdp.js and the
    // [[gated-price-recovery]] memory for the full mechanism.
    const earlyD2cVdp: Promise<any | null> = pageHtml.then((html) => (html ? extractD2cVdpVehicle(html) : null)).catch(() => null);
    // Combined structured-data view for structuredFactsBlock + the post-Claude
    // gap-fill below: JSON-LD's fields stay authoritative where present (an
    // established, tested source); Convertus fills whatever JSON-LD didn't
    // have -- notably msrp, which buildJsonLdFallbackAnalysis never sets
    // (schema.org listings essentially never carry MSRP, only the asking
    // price). A page with neither source resolves this to null, same as today.
    const earlyStructuredFacts: Promise<any | null> = Promise.all([earlyJsonLd, earlyConvertusVms, earlyD2cVdp]).then(([jl, cv, dv]) => {
      // A page only ever matches ONE platform's declaration (Convertus's
      // vmsData vs. D2C's __vdpJSON are mutually exclusive in practice), so
      // picking whichever blob resolved non-null is fill-only, never a real
      // conflict between the two.
      const blob = cv || dv;
      if (!jl && !blob) return null;
      const blobFacts = blob ? {
        quotedPrice: blob.quotedPrice, msrp: blob.msrp ?? null, vin: blob.vin,
        vehicle: [blob.year, blob.make, blob.model, blob.trim].filter(Boolean).join(" ") || null,
        odometerKm: blob.odometerKm, vehicleCondition: blob.condition,
        dealerName: blob.dealerName, dealerCity: blob.dealerCity ?? null,
        // WHICH platform's blob this price came from. Without it the gap-fill
        // below could copy the NUMBER but not its provenance, leaving
        // quotedPriceSource unset -> priceVerified false -> every surface
        // printing "PRICE UNVERIFIED" beside a price we read from the dealer's
        // own machine-readable data. That is exactly the bug the Convertus
        // fix closed earlier the same day; the D2C wiring reintroduced it by
        // never calling fillFromD2cVdp on this path at all.
        quotedPriceSource: Number(blob.quotedPrice) > 0 ? (cv ? "convertus_vms" : "d2c_vdp") : null,
        // Only D2C's extractor sets these (a real "the page says X but the
        // page's own data says Y" tell, not a guess -- see d2c-vdp.js).
        priceGatedButRecovered: blob.priceGated || null, priceGateMessage: blob.priceGateMessage || null,
        priceGateGoogleAdsBacked: blob.googleAdsCorroborated || null,
      } : null;
      if (!blobFacts) return jl ? { ...jl, quotedPriceSource: Number(jl.quotedPrice) > 0 ? "structured_data" : null } : jl;
      if (!jl) return blobFacts;
      const jlPriceWins = Number(jl.quotedPrice) > 0;
      return {
        ...jl,
        quotedPrice: jlPriceWins ? jl.quotedPrice : blobFacts.quotedPrice,
        // The source must follow whichever price actually won above.
        quotedPriceSource: jlPriceWins ? "structured_data" : blobFacts.quotedPriceSource,
        msrp: Number(jl.msrp) > 0 ? jl.msrp : blobFacts.msrp,
        vin: jl.vin || blobFacts.vin,
        odometerKm: jl.odometerKm ?? blobFacts.odometerKm,
        vehicleCondition: jl.vehicleCondition || blobFacts.vehicleCondition,
        dealerName: jl.dealerName || blobFacts.dealerName,
        dealerCity: jl.dealerCity || blobFacts.dealerCity,
        // Only meaningful when the BLOB's price is the one that won -- a
        // JSON-LD price was never gated, so the tell would be a false claim.
        priceGatedButRecovered: jlPriceWins ? null : blobFacts.priceGatedButRecovered,
        priceGateMessage: jlPriceWins ? null : blobFacts.priceGateMessage,
        priceGateGoogleAdsBacked: jlPriceWins ? null : blobFacts.priceGateGoogleAdsBacked,
      };
    }).catch(() => null);

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
        await attachSealedScreenshot(url, fallback, Math.min(25_000, Math.max(2_000, REQUEST_DEADLINE - Date.now())), shotPromise);
        await finalizeServerSide(fallback);
        try {
          await supabase
            .from("listing_analysis_cache")
            .upsert({ url, analysis: { ...fallback, _cacheVer: CACHE_VER }, created_at: new Date().toISOString() }, { onConflict: "url" });
        } catch (err) {
          console.warn("Cache write failed (SM360 fallback):", err);
        }
        // Logged as a success: we returned a usable report, just via the feed.
        await instrumentDelivery(fallback, "page-load failed, served SM360 feed fallback");
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
      // Prefer the copy we started at t=0; only re-fetch if it came back empty.
      const jsonLdFallback = (await earlyJsonLd) || (await buildJsonLdFallbackAnalysis(url));
      if (jsonLdFallback) {
        await detectTradeInWidget(url, jsonLdFallback, null, pageHtml); // S36 -- shares the scan's one page read
        // The structured data often lacks the price the RENDERED page displays.
        // With Scrapfly armed, run the vision rescue here too (this path used
        // to return early and skip it — the Okotoks $112,995 vanished that way).
        let jlRenderConfirmedGated = false;
        if (!(Number(jsonLdFallback.quotedPrice) > 0) && scrapflyEnabled()) {
          try {
            const rescued = await rescueListingViaScrapfly(url, {
              systemPrompt: SYSTEM_PROMPT, anthropicKey: ANTHROPIC_API_KEY, model: CLAUDE_MODEL, preRendered: earlyRender, fallbackShot: shotPromise,
              budgetMs: Math.max(1_000, Math.min(70_000, REQUEST_DEADLINE - Date.now())),
            });
            jlRenderConfirmedGated = !!rescued && !(Number((rescued as any)?.quotedPrice) > 0)
              && ((rescued as any)?.priceDisclosure === "contact_for_price" || (rescued as any)?.renderGateCtaDetected === true);
            if (rescued) {
              mergeRescued(jsonLdFallback, rescued);
              if (jlRenderConfirmedGated && !(Number(jsonLdFallback.quotedPrice) > 0)) jsonLdFallback.priceDisclosure = "contact_for_price";
            }
          } catch (e) { console.warn("JSON-LD-path rescue threw (ignored):", (e as Error)?.message); }
        }
        // ASSERT (render check done). Same gates as the main path, from the
        // same definitions -- this branch used to carry its own copies.
        assertInvariants(jsonLdFallback, { priceRenderChecked: true, renderConfirmed: jlRenderConfirmedGated });
        await enrichAnalysis(jsonLdFallback, REQUEST_DEADLINE);
        await attachSealedScreenshot(url, jsonLdFallback, Math.min(25_000, Math.max(2_000, REQUEST_DEADLINE - Date.now())), shotPromise);
        await finalizeServerSide(jsonLdFallback);
        try {
          await supabase
            .from("listing_analysis_cache")
            .upsert({ url, analysis: { ...jsonLdFallback, _cacheVer: CACHE_VER }, created_at: new Date().toISOString() }, { onConflict: "url" });
        } catch (err) {
          console.warn("Cache write failed (JSON-LD fallback):", err);
        }
        await instrumentDelivery(jsonLdFallback, "page-load failed, served structured-data (JSON-LD) fallback");
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

      // Third fallback: Convertus platform sites (no JSON-LD at all on many of
      // their themes -- see buildConvertusVmsFallbackAnalysis) still embed a
      // `var vmsData = {...}` vehicle-data blob to a plain browser-UA fetch.
      // Only reached after BOTH the page scrape and the JSON-LD tier failed.
      const convertusFallback = (await earlyConvertusVms)
        ? await buildConvertusVmsFallbackAnalysis(url, directHtml)
        : null;
      if (convertusFallback) {
        await detectTradeInWidget(url, convertusFallback, null, pageHtml);
        let cvRenderConfirmedGated = false;
        if (!(Number(convertusFallback.quotedPrice) > 0) && scrapflyEnabled()) {
          try {
            const rescued = await rescueListingViaScrapfly(url, {
              systemPrompt: SYSTEM_PROMPT, anthropicKey: ANTHROPIC_API_KEY, model: CLAUDE_MODEL, preRendered: earlyRender, fallbackShot: shotPromise,
              budgetMs: Math.max(1_000, Math.min(70_000, REQUEST_DEADLINE - Date.now())),
            });
            cvRenderConfirmedGated = !!rescued && !(Number((rescued as any)?.quotedPrice) > 0)
              && ((rescued as any)?.priceDisclosure === "contact_for_price" || (rescued as any)?.renderGateCtaDetected === true);
            if (rescued) {
              mergeRescued(convertusFallback, rescued);
              if (cvRenderConfirmedGated && !(Number(convertusFallback.quotedPrice) > 0)) convertusFallback.priceDisclosure = "contact_for_price";
            }
          } catch (e) { console.warn("Convertus-path rescue threw (ignored):", (e as Error)?.message); }
        }
        assertInvariants(convertusFallback, { priceRenderChecked: true, renderConfirmed: cvRenderConfirmedGated });
        await enrichAnalysis(convertusFallback, REQUEST_DEADLINE);
        await attachSealedScreenshot(url, convertusFallback, Math.min(25_000, Math.max(2_000, REQUEST_DEADLINE - Date.now())), shotPromise);
        await finalizeServerSide(convertusFallback);
        try {
          await supabase
            .from("listing_analysis_cache")
            .upsert({ url, analysis: { ...convertusFallback, _cacheVer: CACHE_VER }, created_at: new Date().toISOString() }, { onConflict: "url" });
        } catch (err) {
          console.warn("Cache write failed (Convertus fallback):", err);
        }
        await instrumentDelivery(convertusFallback, "page-load failed, served Convertus vmsData fallback");
        console.log(`Served Convertus vmsData fallback for ${url} after page-load failure (${nimbleResult.errBody}).`);
        const cvCredits = await captureCredit(holdId);
        holdId = null;
        return new Response(
          JSON.stringify(cvCredits
            ? { analysis: convertusFallback, source: "structured_data_fallback", credits: cvCredits }
            : { analysis: convertusFallback, source: "structured_data_fallback" }),
          { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
        );
      }

      // Last resort: full Scrapfly render + vision. The page blocked every
      // text path (scrape, platform feed, JSON-LD) -- exactly the case the
      // residential-proxy render exists for. Only fires here, after all three
      // cheaper paths failed, so normal scans never pay for it.
      let rescueTrace = "rescue not attempted";
      if (scrapflyEnabled()) {
        try {
          const renderOnly: any = { sourceUrl: url };
          const rescued = await rescueListingViaScrapfly(url, {
            systemPrompt: SYSTEM_PROMPT, anthropicKey: ANTHROPIC_API_KEY, model: CLAUDE_MODEL, preRendered: earlyRender, fallbackShot: shotPromise,
            budgetMs: Math.max(1_000, Math.min(80_000, REQUEST_DEADLINE - Date.now())),
          });
          rescueTrace = rescued ? `rescued keys=${Object.keys(rescued).length}, price=${rescued.quotedPrice ?? "none"}` : "rescue returned null";
          const gateCtaDetected = !!rescued && !(Number((rescued as any)?.quotedPrice) > 0)
            && ((rescued as any)?.priceDisclosure === "contact_for_price" || (rescued as any)?.renderGateCtaDetected === true);
          if (rescued) {
            mergeRescued(renderOnly, rescued);
            // A confirmed price gate is usable data even with nothing else --
            // shipping "we couldn't read that page" over a page that plainly
            // says "contact us for price" is the same class of bug this fix
            // closes on the other three rescue paths.
            if (gateCtaDetected) renderOnly.priceDisclosure = "contact_for_price";
          }
          if (Number(renderOnly.quotedPrice) > 0 || Number(renderOnly.msrp) > 0 || renderOnly.vehicle || gateCtaDetected) {
            await enrichAnalysis(renderOnly, REQUEST_DEADLINE);
            await attachSealedScreenshot(url, renderOnly, Math.min(25_000, Math.max(2_000, REQUEST_DEADLINE - Date.now())), shotPromise);
            await finalizeServerSide(renderOnly);
            try {
              await supabase
                .from("listing_analysis_cache")
                .upsert({ url, analysis: { ...renderOnly, _cacheVer: CACHE_VER }, created_at: new Date().toISOString() }, { onConflict: "url" });
            } catch (err) {
              console.warn("Cache write failed (render fallback):", err);
            }
            await instrumentDelivery(renderOnly, "page-load failed, served Scrapfly render fallback");
            console.log(`Served Scrapfly render fallback for ${url} after full page-load failure (${nimbleResult.errBody}).`);
            const credits = await captureCredit(holdId);
            holdId = null;
            return new Response(
              JSON.stringify(credits
                ? { analysis: renderOnly, source: "scrapfly_render_fallback", credits }
                : { analysis: renderOnly, source: "scrapfly_render_fallback" }),
              { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
            );
          }
          console.warn(`Scrapfly render fallback produced no usable data for ${url}.`);
        } catch (e) { rescueTrace = `rescue threw: ${(e as Error)?.message?.slice(0, 100)}`; console.warn("Scrapfly render fallback threw (ignored):", (e as Error)?.message); }
      }

      // Not an SM360 listing (or its feed was also unreachable / the unit isn't
      // in the feed): keep today's behaviour exactly. The breadcrumbs ride in
      // the log row because a hollow/failed PAID scan must be diagnosable from
      // SQL alone -- edge console logs live only in the dashboard, and three
      // hollow reports in two days each burned a round-trip through Vic just
      // to learn WHICH layer died. direct= is the shared page fetch,
      // preRender= what the pre-warmed Scrapfly render delivered, sfErr= why
      // Scrapfly's LAST render call failed (see lastScrapflyError).
      const dHtmlTrace = await directHtml.then((h) => (h ? `ok:${h.length}` : "fail")).catch(() => "fail");
      const preRenderTrace = await earlyRender.then((r) => (r ? `html:${r.html?.length ?? 0},shot:${r.screenshotB64?.length ?? 0}` : "null")).catch(() => "null");
      await logUsage({ success: false, errorMessage: `Nimble failed: ${nimbleResult.errBody} | direct=${dHtmlTrace} | preRender=${preRenderTrace} | ${rescueTrace} | sfErr=${lastScrapflyError ?? "none"}` });
      await releaseCredit(holdId);
      holdId = null;
      return new Response(
        // Describes OUR failure, not the dealer's conduct. See the note above.
        JSON.stringify({ error: "We couldn't read that page on this attempt -- that's on our end, not the dealer's. Try again in a moment, or upload a screenshot of the same page, which doesn't depend on the page loading for us at all." }),
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

    // Multi-vehicle-page rejection + its repeat-attempt throttle. Checked
    // right here: pageContent is already in hand, and this must run BEFORE
    // the expensive Claude call below, or the whole point (never pay to read
    // a page we can't build a single-vehicle report from) is lost.
    {
      const repeatIdentity = repeatIdentityKey(creditUser?.id ?? null, req);
      const repeatInputHash = await sha256Hex(url);
      const cooldown = await checkRepeatCooldown(repeatIdentity, repeatInputHash);
      if (cooldown.blocked) {
        await releaseCredit(holdId);
        holdId = null;
        await logUsage({ success: false, errorMessage: `repeat multi-vehicle URL, cooldown active (not charged)` });
        return new Response(JSON.stringify({
          error: "repeat_multivehicle_cooldown",
          message: "Sorry, we can't process a page with multiple vehicles. You've already tried this link — try a different listing, or paste the link to the ONE vehicle you want checked.",
          cooldownUntil: cooldown.cooldownUntil,
        }), { status: 429, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }
      const vins = countDistinctValidVins(pageContent);
      if (vins.length > 1) {
        await releaseCredit(holdId);
        holdId = null;
        await recordMultiVehicleHit(repeatIdentity, repeatInputHash);
        await logUsage({ success: false, errorMessage: `multi-vehicle page: ${vins.length} distinct VINs found (not charged)` });
        console.log(`Multi-vehicle page detected via VIN count: ${vins.length} distinct VINs; rejecting, no credit charged.`);
        return new Response(JSON.stringify({
          error: "multi_vehicle_page",
          message: "Sorry, we can't process a page with multiple vehicles. This looks like a search-results or inventory page — paste the link to the ONE vehicle you want checked instead.",
        }), { status: 422, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }
    }

    // Tighter per-attempt timeout than analyze-quote's (~45s) because the Nimble
    // chain above may already have consumed time; the budget is clamped to the
    // request deadline so on the slow-Nimble path this makes a single bounded
    // attempt instead of two. On timeout/network exhaustion fetchWithRetry
    // throws → the outer catch logs + releases the credit hold (no strand); a
    // spent-budget 5xx returns non-ok → the !ok branch below releases.
    const claudeBudget = Math.max(1_000, REQUEST_DEADLINE - Date.now());
    const claudeT0 = Date.now();
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
            content: `Here is the extracted content of a dealer listing page (URL: ${url}):\n\n${pageContent}${await structuredFactsBlock(earlyStructuredFacts)}\n\nAnalyze this listing and return the JSON object described in your instructions.`,
          },
        ],
      }),
    }, { timeoutMs: 45_000, maxAttempts: 2, budgetMs: claudeBudget, label: "anthropic-listing" });

    if (!claudeRes.ok) {
      const errBody = await claudeRes.text();
      console.error("Claude API call failed:", claudeRes.status, errBody);
      logProviderCall({
        provider: "anthropic", operation: "analysis", ok: false,
        driver: CLAUDE_MODEL, listingHost: hostOf(url),
        durationMs: Date.now() - claudeT0, errorCode: `http_${claudeRes.status}`,
      });
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
    // Anthropic is the one provider whose per-call cost is exactly computable,
    // so it carries real dollars while Nimble carries call counts.
    logProviderCall({
      provider: "anthropic", operation: "analysis", ok: true,
      driver: CLAUDE_MODEL, listingHost: hostOf(url),
      durationMs: Date.now() - claudeT0,
      costUsd: (usage?.input_tokens != null && usage?.output_tokens != null)
        ? computeCost(usage.input_tokens, usage.output_tokens) : null,
    });
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

    // Days-on-lot for the Convertus "/vehicles/" platform family (no-op when
    // the SM360 feed already provided it, or the URL isn't that shape).
    await captureConvertusDaysOnLot(url, analysis, pageHtml);

    // Note the VIN BEFORE reading it back, so the very first scan of a car
    // starts its clock even though it can report nothing yet. This is what
    // makes coverage platform-agnostic: no crawler to extend, no per-platform
    // reader to maintain, and a brand-new dealer platform is covered the first
    // time anyone runs a check on it.
    try {
      const vin = String(analysis?.vin || "").toUpperCase();
      if (/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
        await supabase.rpc("fn_note_listing_seen", { p_vin: vin, p_host: hostOf(url) });
      }
    } catch (e) { console.warn("listing_seen note failed (non-fatal):", e); }

    // Last resort, and the only one that works on ANY dealer platform: our own
    // first-seen date for this VIN. No-op when either path above already
    // produced an exact figure.
    await captureOwnDaysOnLot(analysis);

    // Advertised-APR backstop. The dealer's own rate was missing from 4 of 10
    // reports in the benchmark even where the page printed it, because only the
    // SM360 feed and the LLM pass supplied it. Deterministic, finance-context
    // only, and it never overwrites a rate we already have -- from a TRUSTED
    // source. The guard used to be "skip if ANY rate is already set", which
    // meant an LLM guess (analysis.financing.rate set with no evidenced
    // source) permanently blocked this from ever running, even when it would
    // have found the exact same number with real evidence behind it. Confirmed
    // live 2026-08-20 (legacyautogroup.ca 2026 Explorer): the page plainly
    // states "5.49% financing for 84 months ... @ 5.49% APR O.A.C." in its own
    // visible description text -- extractAdvertisedApr finds it correctly when
    // given that exact text -- but the LLM pass had already populated
    // analysis.financing.rate first, so this never ran, financeRates.dealer
    // stayed source:"llm", and the trust gate correctly (but needlessly) hid a
    // real, correct, page-stated rate as "Not shown".
    if (!hasTrustedFinanceRate(analysis.financing) && typeof pageContent === "string") {
      const hit = extractAdvertisedApr(pageContent);
      if (hit) {
        analysis.financing = { ...(analysis.financing || {}), rate: hit.apr, source: "page_text" };
        console.log(`Advertised APR read from page text: ${hit.apr}%`);
      }
    }

    // S37: is the advertised price conditional on financing WITH the dealer?
    // Reads the page text first, then the raw html (the clause usually lives in
    // the fine print, which the text pass sometimes drops). The buyer paying
    // cash or bringing their own bank approval is the one this costs, and today
    // nothing on the report tells them. Deterministic and evidence-carrying —
    // see finance-contingent.js. Never sinks the scan.
    try {
      const fc = detectFinanceContingent(typeof pageContent === "string" ? pageContent : "")
        || (typeof rawHtml === "string" ? detectFinanceContingent(rawHtml) : null);
      if (fc) {
        analysis.financeContingent = fc;
        console.log(`Finance-contingent price: ${fc.reasons.join("; ")}`);
      }
    } catch (err) { console.warn("Finance-contingent read failed (non-fatal):", err); }

    // Stacked-incentive backstop. EDealer-family pages carry their advertised
    // offers in an embedded JSON blob rather than in prose, so the LLM pass
    // reads the sticker and reports "no discount" while the page's own title
    // advertises the post-incentive price. Measured 2026-08-11: a Jack Carter
    // Bolt listing hid $7,062 across a $2,300 dealer-payee delivery allowance
    // and a $4,762 eligibility-gated federal EVAP rebate. That spread is the
    // buyer's leverage, so a miss here is the costliest kind of miss we make.
    // Additive and deduped by name: never displaces a line the page stated
    // plainly and the LLM already read.
    try {
      // Reads the SHARED direct fetch, not Nimble's payload — see the note at
      // directHtml. `rawHtml` is a mirage: Nimble only ever returns markdown.
      const incHtml = await directHtml;
      const inc = typeof incHtml === "string" ? extractCashIncentives(incHtml) : null;
      if (inc) {
        const existing = Array.isArray(analysis.addOns) ? analysis.addOns : [];
        const seen = new Set(existing.map((r: any) => String(r?.name || "").trim().toLowerCase()));
        const fresh = incentivesToAddOns(inc).filter((r) => !seen.has(r.name.trim().toLowerCase()));
        if (fresh.length) {
          analysis.addOns = [...existing, ...fresh];
          console.log(`Stacked incentives: +${fresh.length} discount line(s), $${inc.totalIncentives} total.`);
        }
        // NOT recorded here: the page's advertised-after-incentives figure
        // ($43,246 on the listing above). It belongs on the report — it is the
        // number the dealer markets and the buyer arrives believing — but a new
        // field has to ship to EVERY view in the same change (scroll + deck /
        // heatmap / sidebar + PDF + email), and adding one that only the JSON
        // carries is the exact defect this pass is fixing. The offers
        // themselves flow through addOns, which every view already renders, so
        // the $7,062 reaches the buyer today; the headline figure is a
        // deliberate follow-up, not an oversight.
      }
    } catch (err) { console.warn("Stacked-incentive read failed (non-fatal):", err); }

    // S36: flag embedded trade-in instant-offer widgets (checks the scraped
    // text first; falls back to one direct fetch), then refresh the script.
    await detectTradeInWidget(url, analysis, typeof pageContent === "string" ? pageContent : null, pageHtml);
    if (analysis.tradeInWidget || analysis.financeContingent) analysis.counterScript = buildCounterScript(analysis);

    // Independent evidence: ask the Internet Archive to preserve the listing.
    // Server-side + fire-and-forget (the client's no-cors attempt can fail
    // silently; this one runs from the edge reliably). Never awaited on the
    // request path, never fails the scan.
    try {
      const saveReq = fetch("https://web.archive.org/save/" + url, { headers: { "User-Agent": "LotCheck evidence archiver (lotcheck.ca)" } }).then(() => {}).catch(() => {});
      const rt: any = (globalThis as any).EdgeRuntime;
      if (rt?.waitUntil) rt.waitUntil(saveReq);
    } catch { /* best-effort */ }

    // Identity + MSRP gap-fill from Convertus vmsData, BEFORE enrichAnalysis --
    // deliberately ahead of the catalog MSRP lookup inside it, not after.
    //
    // Identity (year/make/model/trim/...): that lookup only runs
    // `if (!analysis.msrp && year && make && model)` and picks the catalog row
    // using analysis.trim; if the scrape missed trim/year/make/model (this
    // platform's real identity lives in a <script>-embedded JSON blob the
    // markdown/text passes never see), the lookup either misses entirely or
    // matches the wrong/generic trim -- confirmed live 2026-08-13
    // (southtrailkia.com): a real, correctly-scraped page showed a base-trim
    // "$28,495 starting at" MSRP for what was actually a $43,780 X-Line
    // Limited AWD. Filling identity first lets that lookup find the CORRECT
    // trim row.
    //
    // msrp: seeding it here does NOT skip verification -- it hands the
    // dealer's own stated figure to the EXISTING listing-vs-catalog
    // cross-check a few lines down (`analysis.msrpSource !== "catalog" &&
    // analysis.msrpSource !== "manufacturer_site"` -> resolveMsrpAuthority),
    // which already exists precisely to arbitrate a dealer-stated number
    // against the manufacturer's own catalog (and flag inflation either way).
    // Leaving analysis.msrpSource unset here is deliberate: the "Provenance
    // for an MSRP that came from the LISTING itself" step right after labels
    // it "listing"/"dealer_stated" on its own, and only THAT unverified label
    // makes the cross-check run at all -- setting msrpSource ourselves would
    // skip it. Fill-only throughout: never overwrites what the scrape/Claude
    // already found.
    try {
      const cv = await earlyConvertusVms;
      if (cv) {
        for (const k of ["year", "make", "model", "trim", "vin", "odometerKm", "dealerName", "dealerCity", "msrp"] as const) {
          const cur = (analysis as any)[k];
          const alt = (cv as any)[k];
          const missing = cur == null || cur === "" || (typeof cur === "number" && !(cur > 0));
          if (missing && alt != null && alt !== "") { (analysis as any)[k] = alt; console.log(`Convertus identity gap-fill: ${k}.`); }
        }
        // The one field this whole extractor exists for, and the one field its
        // OWN gap-fill loop above never filled: `quotedPrice` isn't in that
        // loop's key list, so a Convertus-sourced asking price sat correctly
        // extracted in `cv` and was never written to `analysis` -- confirmed
        // live 2026-08-21 (albertahonda.com, 2026 Civic Sedan LX CVT): the
        // report shipped "No asking price could be read from this listing"
        // while cv.quotedPrice held the page's own real $31,595 the whole
        // time. `quotedPriceSource: "convertus_vms"` is not cosmetic -- the
        // priceVerified gate a few hundred lines down already recognizes this
        // exact string as an evidenced source; without it, even a correctly
        // filled quotedPrice would report as unverified.
        if (!(Number(analysis.quotedPrice) > 0) && Number(cv.quotedPrice) > 0) {
          analysis.quotedPrice = cv.quotedPrice;
          analysis.quotedPriceSource = "convertus_vms";
          console.log("Convertus identity gap-fill: quotedPrice.");
        }
        if (!analysis.vehicleCondition && cv.condition) analysis.vehicleCondition = cv.condition;
        // Same gap this whole extractor exists for -- the dealer's own
        // advertised finance rate and pricing fine print live in the SAME
        // script-embedded blob as price/VIN, invisible to the scrape/Claude
        // pass the same way. Confirmed live 2026-08-14 (albertahonda.com):
        // "Financing APR: Not shown" and a missing disclaimer, while the page
        // headlined "6.69% for 96 Months" and carried a full Alberta Winter
        // Package fine-print paragraph vmsData had the whole time.
        //
        // Same "any rate blocks this" guard bug as the page-text backstop
        // below, fixed the same way: only a rate from an already-TRUSTED
        // source should block the deterministic VMS read, not an unproven
        // LLM guess sitting in the same field first.
        if (!hasTrustedFinanceRate(analysis.financing) && cv.financeApr != null) {
          analysis.financing = { ...(analysis.financing || {}), rate: cv.financeApr, termMonths: cv.financeTermMonths ?? (analysis.financing as any)?.termMonths ?? null, source: "convertus_vms" };
          console.log("Convertus identity gap-fill: financing.rate.");
        }
        if (!analysis.pricingDisclaimer && cv.finePrint) {
          analysis.pricingDisclaimer = cv.finePrint;
          console.log("Convertus identity gap-fill: pricingDisclaimer.");
        }
      }
    } catch { /* the safety net must never sink the scan */ }

    // Re-sync financeRates.dealer from analysis.financing NOW that both the
    // page-text APR backstop (above) and the Convertus gap-fill (just above)
    // have had their turn. resolveFinanceRates() ran much earlier and built
    // financeRates.dealer from whatever the LLM's own read happened to be at
    // that point -- so a rate either backstop found afterward could never
    // reach the report at all, and the evidenced source tag they attach
    // (page_text / convertus_vms) never overrode an untrusted LLM guess that
    // arrived first. This makes the two deterministic, evidence-carrying
    // sources actually able to inform what ships, with source preserved.
    if (Number(analysis.financing?.rate) > 0) {
      analysis.financeRates = analysis.financeRates || { dealer: null, manufacturer: null };
      analysis.financeRates.dealer = { apr: Number(analysis.financing.rate), source: analysis.financing.source || "llm" };
    }

    // Shared downstream enrichment (verified warranty/fuel, VIN check, recalls,
    // catalog->manufacturer MSRP fallback, financing/odometer checks, finance +
    // lease rates, leverage score) -- the SAME sequence the SM360 feed fallback
    // runs, so the two paths never drift apart.
    //
    // If the vision rescue below is already known to be needed (its own guard
    // is the same "is quotedPrice still missing" check, which nothing in
    // enrichAnalysis sets), reserve it a working minimum budget BEFORE
    // enrichment spends the rest. enrichAnalysis is already deadline-aware --
    // "the expensive step self-skips when there isn't enough budget left"
    // (see its own comment above) -- so handing it a shorter deadline here is
    // the SAME graceful degradation it already does for itself, just decided
    // earlier and on purpose instead of by whatever happens to be left over.
    // Without this, enrichment (recalls, catalog MSRP, dealer reputation,
    // financing/lease-rate lookups) could spend the entire REQUEST_DEADLINE,
    // leaving vision rescue's own budget clamped to a 1-second floor by the
    // time its turn comes -- nowhere near enough for a real render + Claude
    // vision read. Confirmed live 2026-08-20 (legacyautogroup.ca 2026
    // Explorer): the report claimed its own extraction returned nothing but
    // boilerplate while its OWN sealed screenshot -- captured moments later
    // by a separate, much less expensive step -- clearly showed a real
    // price, MSRP, 5.49% financing rate and 508 km odometer reading.
    const VISION_RESCUE_RESERVE_MS = 40_000;
    const willNeedVisionRescue = !(Number(analysis.quotedPrice) > 0) && scrapflyEnabled();
    const enrichDeadline = willNeedVisionRescue
      ? Math.min(REQUEST_DEADLINE, Math.max(Date.now() + 5_000, REQUEST_DEADLINE - VISION_RESCUE_RESERVE_MS))
      : REQUEST_DEADLINE;
    if (willNeedVisionRescue && enrichDeadline < REQUEST_DEADLINE) {
      console.log(`Reserving ${VISION_RESCUE_RESERVE_MS}ms for vision rescue -- enrichAnalysis gets until ${new Date(enrichDeadline).toISOString()} instead of ${new Date(REQUEST_DEADLINE).toISOString()}.`);
    }
    await enrichAnalysis(analysis, enrichDeadline);

    // GUARDRAIL: many dealer sites are JS-rendered and/or bot-protected, so the
    // scrape can come back with no usable pricing. A report with no asking price
    // AND no MSRP is not a Quote Check -- it's an empty page. Do NOT charge for
    // it and do NOT deliver it as a report; tell the client to steer the buyer
    // to the photo/PDF upload (which reads the real quote reliably). Also skip
    // the cache so a later upload/readable retry isn't blocked by an empty hit.
    let gotPricing = (Number(analysis.quotedPrice) > 0) || (Number(analysis.msrp) > 0);

    // RESCUE (inert unless SCRAPFLY_API_KEY is set): render the page through
    // Scrapfly's anti-bot engine and read the full-page screenshot with Claude
    // vision -- the "render the page, then read what a human sees" flow -- then
    // re-enrich. Fires whenever the asking PRICE is missing: the price is the
    // field a text scrape drops on JS/Cloudflare pages, and a catalog-filled MSRP
    // must NOT suppress it (else the report shows an MSRP but no deal). Fully
    // fail-safe: any failure returns null and we fall through as before.
    let renderConfirmedGated = false; // vision saw the rendered page and found NO price
    if (!(Number(analysis.quotedPrice) > 0) && scrapflyEnabled()) {
      try {
        // Logged because "vision rescue found nothing" is indistinguishable
        // from "vision rescue got starved of budget by everything upstream"
        // without this number. Confirmed live 2026-08-20 (legacyautogroup.ca
        // 2026 Explorer): the report's own summary said the captured page
        // content was empty boilerplate and every price/APR/km point fell
        // back to a wrong catalog/reference figure, while the SEALED
        // SCREENSHOT attached to the SAME report clearly shows a real price,
        // MSRP, 5.49% financing and 508 km -- the data was there, findable,
        // and even successfully screenshotted, but apparently never reached
        // by a vision pass with enough budget to read it. This clamps to a
        // 1000ms floor when REQUEST_DEADLINE has already passed, which is not
        // enough time for a real render + Claude vision read to complete --
        // this line turns that suspicion into a number the next occurrence
        // can confirm from logs instead of reconstructing from a PDF.
        const rescueBudgetMs = Math.max(1_000, REQUEST_DEADLINE - Date.now());
        if (rescueBudgetMs <= 5_000) {
          console.warn(`Vision rescue starting with only ${rescueBudgetMs}ms left (REQUEST_DEADLINE already ${Date.now() > REQUEST_DEADLINE ? "passed" : "nearly reached"}) -- likely to fail from starvation, not a genuine "nothing on the page" read.`);
        }
        const rescued = await rescueListingViaScrapfly(url, {
          systemPrompt: SYSTEM_PROMPT, anthropicKey: ANTHROPIC_API_KEY, model: CLAUDE_MODEL, preRendered: earlyRender, fallbackShot: shotPromise,
          budgetMs: rescueBudgetMs,
        });
        // Confirmation means the vision pass READ the rendered page and itself
        // reported the gating -- an empty/failed read is not confirmation. A
        // ground-truth CTA match against the raw rendered DOM counts too: a
        // broken/incomplete screenshot can make vision miss the sidebar (Rock
        // Creek, 2026-08-13), but a plain text match against the actual
        // rendered HTML can't be fooled by a bad capture the same way.
        renderConfirmedGated = !!rescued && !(Number((rescued as any)?.quotedPrice) > 0)
          && ((rescued as any)?.priceDisclosure === "contact_for_price" || (rescued as any)?.renderGateCtaDetected === true);
        if (rescued) {
          const rescuedMsrp = Number(rescued.msrp) > 0 ? Number(rescued.msrp) : null;
          const hadTrim = !!analysis.trim;
          mergeRescued(analysis, rescued);
          if (renderConfirmedGated && !(Number(analysis.quotedPrice) > 0)) analysis.priceDisclosure = "contact_for_price";
          // The rescue can recover identity the text pass missed (trim, VIN).
          // A catalog "starting_at" floor picked WITHOUT that identity is stale
          // -- drop it so enrich re-resolves with the full signals (fixes the
          // Rock Creek case: base-S floor survived even after the rescue
          // learned the real trim, because the !msrp guard skipped the lookup).
          if (!hadTrim && analysis.trim && analysis.msrpSource === "catalog" && analysis.msrpBasis === "starting_at") {
            delete analysis.msrp; delete analysis.msrpSource; delete analysis.msrpBasis; delete analysis.msrpTrim; delete analysis.msrpYear; delete analysis.msrpSourceUrl;
          }
          await enrichAnalysis(analysis, REQUEST_DEADLINE);
          // Screenshot showed a dealer MSRP above the manufacturer catalog figure ->
          // inflated-sticker tactic. Anchor stays the TRUE catalog MSRP; record the
          // gap and refresh the counter-script so the "Inflated MSRP" move appears.
          if (rescuedMsrp && Number(analysis.msrp) > 0 && analysis.msrpSource === "catalog" && analysis.msrpBasis === "exact"
              && rescuedMsrp > Number(analysis.msrp) * 1.03 && rescuedMsrp - Number(analysis.msrp) > 800 && !analysis.msrpInflation) {
            analysis.dealerStatedMsrp = rescuedMsrp;
            analysis.msrpInflation = { dealerStated: rescuedMsrp, manufacturer: Number(analysis.msrp), overBy: Math.round(rescuedMsrp - Number(analysis.msrp)) };
            analysis.counterScript = buildCounterScript(analysis);
          }
          gotPricing = (Number(analysis.quotedPrice) > 0) || (Number(analysis.msrp) > 0);
          console.log(`Scrapfly rescue for ${url}: gotPricing=${gotPricing}, price=${analysis.quotedPrice}, msrp=${analysis.msrp}, dealerMsrp=${analysis.dealerStatedMsrp}`);
        }
      } catch (e) { console.warn("Scrapfly rescue threw (ignored):", (e as Error)?.message); }
    }

    // Gap-fill from the structured-data read: the scrape sometimes lands the
    // vehicle but misses the price or VIN that schema.org (or a platform's own
    // embedded vehicle-data JSON, e.g. Convertus vmsData / D2C __vdpJSON)
    // states outright. Never overwrites a value the scrape already found.
    //
    // MUST RUN BEFORE priceVerified AND before the leverage recompute below.
    // It used to sit ~40 lines further down, AFTER both -- so a price that
    // only this gap-fill could recover (the entire point of the D2C work)
    // arrived too late to be counted: priceVerified had already been computed
    // off an empty quotedPriceSource and stuck at false, and the leverage
    // score had already been computed with no price at all, printing "No
    // pricing red flags" on a report that then displayed a large over-MSRP
    // gap. Same ordering-vs-derived-value class as the computeLeverageScore /
    // allInPricing bug fixed in 63fa164 -- moving the producer above its
    // consumers is the structural fix, not re-deriving after the fact.
    let structuredGapFilledPrice = false;
    try {
      const early = await earlyStructuredFacts;
      if (early) {
        for (const k of ["quotedPrice", "vin", "odometerKm", "dealerName", "dealerCity", "vehicleCondition"] as const) {
          const cur = (analysis as any)[k];
          const alt = (early as any)[k];
          const missing = cur == null || cur === "" || (typeof cur === "number" && !(cur > 0));
          if (missing && alt != null && alt !== "") {
            (analysis as any)[k] = alt;
            if (k === "quotedPrice") structuredGapFilledPrice = true;
            console.log(`Gap-filled ${k} from structured data.`);
          }
        }
        // The price's PROVENANCE rides with the price itself. Only stamped
        // when this gap-fill is what actually supplied it -- a price the
        // scrape/Claude already had keeps whatever source it already carried
        // (usually none, i.e. correctly unverified).
        if (structuredGapFilledPrice && early.quotedPriceSource) {
          analysis.quotedPriceSource = early.quotedPriceSource;
          console.log(`Gap-filled quotedPriceSource=${early.quotedPriceSource} from structured data.`);
        }
        if (Number(analysis.quotedPrice) > 0 && analysis.priceDisclosure === "contact_for_price") analysis.priceDisclosure = "advertised";
        // Carry the D2C "page says Call for pricing, blob says $X" tell
        // through -- only when THIS gap-fill is what actually supplied the
        // price (never claim a gate was recovered for a price that was on the
        // page/Claude's own read the whole time).
        if (early.priceGatedButRecovered && structuredGapFilledPrice) {
          analysis.priceGatedButRecovered = true;
          analysis.priceGateMessage = early.priceGateMessage;
          analysis.priceGateGoogleAdsBacked = !!early.priceGateGoogleAdsBacked;
        }
        gotPricing = (Number(analysis.quotedPrice) > 0) || (Number(analysis.msrp) > 0);
      }
    } catch { /* the safety net must never sink the scan */ }

    // A price that arrived only just now (above) was not available when
    // enrichAnalysis ran computeLeverageScore, so every price-dependent
    // finding it produced was computed against no price at all. Recompute
    // them here rather than shipping a leverage panel that contradicts the
    // figures printed beside it.
    if (structuredGapFilledPrice) {
      computeFinancingCheck(analysis);
      computeLeverageScore(analysis);
      analysis.counterScript = buildCounterScript(analysis);
      console.log("Recomputed leverage/financing/counter-script after a structured-data price gap-fill.");
    }

    // WHAT "PRICE VERIFIED" ACTUALLY MEANS. Until 2026-08-15 it meant nothing:
    // `priceVerified` was READ in eight places across the app, the email and the
    // PDF — where it escalated to "STATUS - VERIFIED QUOTE" — and ASSIGNED by
    // nothing, so every reader fell through to `quotedPrice > 0`. A number we
    // had merely read was being published as a number we had checked. That is a
    // hollow claim on the most consequential card (claims-must-stay-backed).
    //
    // It now means one specific, defensible thing: the price came from the
    // page's OWN machine-readable data — schema.org/JSON-LD, the platform's
    // vehicle blob, or the dealer platform's inventory feed — rather than from
    // reading rendered text. That is a real distinction a buyer benefits from,
    // and one a dealer cannot dispute, because it is their own published data.
    //
    // Anything read out of page text is priceVerified: false. The surfaces
    // already render "price not verified" for that case; it just never fired.
    {
      const src = String(analysis.quotedPriceSource || "");
      analysis.priceVerified = Number(analysis.quotedPrice) > 0
        && (src === "structured_data" || src === "sm360_feed" || src === "sm360_feed_fallback"
            || src === "convertus_vms" || src === "d2c_vdp");
    }

    // ASSERT (render check done). The accusation gate lives in invariants.ts
    // now: "contact for price" may stand ONLY when the rendered page was
    // actually inspected and confirmed price-less, because a garbled text
    // scrape and a genuinely hidden price are indistinguishable without that
    // look -- and we never accuse on ambiguity.
    {
      const inv = assertInvariants(analysis, { priceRenderChecked: true, renderConfirmed: renderConfirmedGated });
      // A downgraded claim invalidates the price-gating move in the script that
      // enrichAnalysis already built, so rebuild it.
      if (inv.repaired.includes("PRICE_NOT_ACCUSED_UNCONFIRMED")) {
        analysis.counterScript = buildCounterScript(analysis);
      }
    }

    // (The structured-data gap-fill that used to live here now runs ABOVE, so
    // priceVerified and the leverage score can actually see the price it
    // recovers -- see the comment on it for why the order matters.)
    // Re-assert AFTER the last gap-fill: a price that arrived here (structured
    // data recovered what the prose pass never saw) can newly contradict the
    // summary written earlier -- verify the text against the final figures
    // before anything ships (SUMMARY_MATCHES_PRICE). Ctx-less on purpose: the
    // render-check gate already ran above with its real context.
    assertInvariants(analysis);

    if (!gotPricing) {
      await logUsage({ success: false, errorMessage: "unreadable_listing (no price/MSRP extracted)" });
      await releaseCredit(holdId);
      holdId = null;
      return new Response(
        JSON.stringify({
          error: "unreadable_listing",
          message: UNREADABLE_LISTING_MESSAGE,
          refunded: true,
          vehicle: analysis.vehicle || null,
          dealerName: analysis.dealerName || null,
        }),
        { status: 422, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    // #14 on every scan: sealed screenshot before signing (hash rides in the canonical).

    await attachSealedScreenshot(url, analysis, Math.min(25_000, Math.max(2_000, REQUEST_DEADLINE - Date.now())), shotPromise);

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
        .upsert({ url, analysis: { ...analysis, _cacheVer: CACHE_VER }, created_at: new Date().toISOString() }, { onConflict: "url" });
    } catch (err) {
      console.warn("Cache write failed:", err);
    }

    await instrumentDelivery(analysis, null, usage);

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
