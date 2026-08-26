// Supabase Edge Function: analyze-quote
//
// Receives a dealer quote (PDF or photo) as base64 from the browser.
//
//   Step 1 -- Claude reads the document: vehicle identity, quoted price,
//             fees/add-ons with a verdict, warranty terms, and a summary.
//             It still uses its own judgment for things like "is this add-on
//             overpriced" -- that's genuine analysis, not a fact lookup.
//             What it NO LONGER does is guess the vehicle's official MSRP
//             from its own training knowledge -- that's a fact, and facts
//             should come from a real source, not a guess.
//   Step 2 -- We look up the REAL MSRP in our own msrp_catalog table (built
//             from official manufacturer data). This is the verification
//             step. If the dealer wrote a different "MSRP" on the quote
//             itself, we flag the mismatch -- real negotiation leverage.
//   Step 3 -- We assemble the final `analysis` object in EXACTLY the shape
//             App.jsx already renders (confirmed against the live file,
//             not guessed):
//               vehicle          -- display string, e.g. "2022 Honda Civic EX"
//               year/make/model  -- flat fields (rebate calc reads these directly)
//               fuelType         -- "BEV" | "PHEV" | "hybrid" | "gas" | null
//               vehicleCondition -- "new" | "used" | null
//               msrp             -- plain number (verified value wins; falls
//                                   back to whatever the dealer wrote on the
//                                   quote if we don't have that trim yet)
//               quotedPrice      -- plain number
//               standardWarranty -- { coverage, note } (included mfr warranty)
//               warranty         -- { offered, price, assessment } (the SOLD
//                                   extended plan, separate from the above)
//               addOns           -- [{ name, price, verdict, reason }]
//               totalFlaggedCost -- number, sum of addOns where verdict==="flagged"
//               summary          -- string
//               msrpVerification -- NEW, not yet rendered anywhere: the raw
//                                   verification detail (source/mismatch), so
//                                   the frontend can add a "Verified" badge
//                                   later without another backend change.
//
// Nothing is stored -- the file is processed in-memory for this one request
// and then discarded. No database write, no Storage bucket. msrp_catalog is
// READ-ONLY from this function.
//
// Request body (confirmed against the live App.jsx fetch call -- unchanged):
//   { "fileBase64": "<base64>", "mediaType": "application/pdf" | "image/jpeg" | ... }
//
// Secrets required (Supabase dashboard -> Edge Functions -> analyze-quote ->
// Secrets) -- set this one manually:
//   ANTHROPIC_API_KEY
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY do NOT need to be added --
// Supabase injects both automatically into every Edge Function at runtime.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { finalizeServerSide } from "../_shared/report-sign.ts";
import { canonicalMake } from "../_shared/makes.ts";
// The Transport Canada recall lookup. This file used to carry its own copy —
// so did analyze-listing-url and search-recalls, four in all, and they had
// already drifted apart. See _shared/recalls.ts for what the drift cost.
import { lookupRecalls } from "../_shared/recalls.ts";
import { computeRemainingWarranty } from "../_shared/warranty.ts";
import { fetchMarketValue } from "../_shared/marketvalue.ts";
import { buildFeeObservations } from "../_shared/fee-vocab.ts";
import { computeReconciliation, computeFinancingTrap, buildCounterScript } from "../_shared/deal.ts";
import { assessDocFee, resolveAllInAuthority } from "../_shared/docfee.ts";
import { deriveSaleCondition } from "../_shared/condition.ts";
import { resolveJurisdiction } from "../_shared/jurisdiction.ts";
import { validateVin, assertInvariants } from "../_shared/invariants.ts";
import { resolveMsrpAuthority } from "../_shared/msrp-authority.js";
import { qualifyMsrpClaim, qualifyCeilingClaim } from "../_shared/msrp-claim.ts";
import { computeReferenceFinancing } from "../_shared/reference-financing.ts";
import { recordCheckpoints } from "../_shared/verification-checkpoints.ts";
import { gateRequest } from "../_shared/region-gate.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
// Single source of truth for the model, shared with analyze-listing-url:
// both functions read ANTHROPIC_MODEL and default to the SAME model so the
// two quote-analysis paths never silently diverge. Override via the
// ANTHROPIC_MODEL secret to pin/rollback without a code change.
const ANTHROPIC_MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ── Usage log ──────────────────────────────────────────────────────────────
// This function had NO logging of any kind -- not on success, not on failure.
// Every photo/PDF upload was invisible in api_usage_log, so when a real upload
// failed in production (2026-08-15, an oversized PNG) there was literally
// nothing to query and the cause had to be found by reading source. The URL
// scanner has logged per-run since day one; the upload path -- the primary
// path under screenshot-first -- never did. Same shape as
// analyze-listing-url's so both features aggregate together, with
// feature:"quote" to tell them apart.
//
// Fail-open by construction: a telemetry failure must never surface to the
// person or cost them their report.
async function logUsage(fields: {
  success: boolean;
  inputTokens?: number | null;
  outputTokens?: number | null;
  errorMessage?: string | null;
}) {
  try {
    const { error } = await supabase.from("api_usage_log").insert({
      feature: "quote",
      success: fields.success,
      input_tokens: fields.inputTokens ?? null,
      output_tokens: fields.outputTokens ?? null,
      error_message: fields.errorMessage ?? null,
    });
    if (error) console.warn("api_usage_log insert failed:", error.message);
  } catch (err) {
    console.warn("api_usage_log insert threw:", err);
  }
}

// ── Quote Check credit lifecycle (Phase 3) ─────────────────────────────────
// A personal credit is deducted ONLY after an accurate result is delivered,
// and ONLY for signed-in requests. Anonymous requests (no/invalid JWT — which
// includes the anon key the frontend sends today) resolve to no user and take
// the existing flow byte-for-byte unchanged: every helper below is a no-op
// when there is no hold. The fn_* RPCs were REVOKED from public, so they are
// called here with the service-role `supabase` client above.

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

// ── Repeat multi-vehicle attempt throttle ───────────────────────────────────
// The triage pass a few hundred lines down already makes each individual
// multi-vehicle rejection cheap (a small-frame classify instead of a full
// read) -- but nothing capped how many TIMES the SAME upload could be
// resubmitted, so a signed-in caller (who never touches tryFreeCheck's
// anonymous breaker above) had no ceiling at all on repeat attempts. Vic,
// 2026-08-20: "it going to cost us money." Checked BEFORE any vendor spend,
// including the cheap triage -- a blocked repeat costs nothing, not even
// the reduced cost. Only a genuine multi-vehicle REJECTION bumps the
// counter (see the two call sites below); a normal scan of a different
// vehicle never touches this. 2nd hit on the same (identity, input) pair ->
// 2h cooldown; 3rd+ -> 24h. See 20260820_scan_attempt_throttle.sql.
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
// cap AND a total time budget keep the whole sequence comfortably under
// Supabase's ~150s function ceiling — the budget stops a retry that couldn't
// finish in time rather than risk a platform kill (which would strand the
// reserved credit by skipping the release path).
//
// Behaviour contract used by callers below:
//   • Returns the final Response — including a non-ok one after the retry
//     budget is spent on a retryable status — so existing `if (!res.ok)`
//     branches (which release the credit) still fire.
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

// focusVehicle: set when the person has already picked one car out of a
// multi-vehicle image (see vehiclesOnPage below). It pins the extraction to
// that car so the second pass can't drift to a neighbouring listing.
function buildExtractionPrompt(focusVehicle?: string | null): string {
  const focus = (focusVehicle ?? "").trim().slice(0, 200);
  const focusBlock = focus
    ? `\n\nIMPORTANT -- THIS IMAGE CONTAINS SEVERAL VEHICLES AND THE PERSON HAS ALREADY CHOSEN ONE:\nExtract ONLY this vehicle: "${focus}".\nIgnore every other vehicle in the image completely -- do not blend their prices, trims, fees or specs into your answer. Set "vehiclesOnPage" to null. If you genuinely cannot find that vehicle in the image, return nulls rather than substituting a different one.`
    : "";
  return EXTRACTION_PROMPT_BASE + focusBlock;
}

const EXTRACTION_PROMPT_BASE = `You are reading a car dealership quote, listing, or a screenshot of one. Read it carefully and return ONLY this JSON object -- no other text, no markdown code fences.

{
  "pageKind": "single_vehicle"|"several_vehicles"|"inventory_results",
  "vehiclesOnPage": null | [ { "label": string, "year": number|null, "make": string|null, "model": string|null, "trim": string|null, "price": number|null, "stockNumber": string|null, "dealerName": string|null } ],
  "year": number|null,
  "make": string|null,
  "model": string|null,
  "trim": string|null,
  "vin": string|null,
  "odometerKm": number|null,
  "vehicleCondition": "new"|"used"|null,
  "fuelType": "BEV"|"PHEV"|"hybrid"|"gas"|null,
  "dealerName": string|null,
  "dealerCity": string|null,
  "quotedPrice": number|null,
  "statedMsrpOnDocument": number|null,
  "standardWarranty": { "coverage": string|null, "note": string|null },
  "addOns": [
    {
      "name": string,
      "price": number,
      "verdict": "good"|"flagged"|"standard",
      "reason": string
    }
  ],
  "warranty": { "offered": string|null, "price": number|null, "assessment": string|null },
  "financing": {
    "type": "lease"|"finance"|null,
    "termMonths": number|null,
    "rate": number|null,
    "paymentAmount": number|null,
    "paymentFrequency": "weekly"|"biweekly"|"monthly"|null,
    "totalObligation": number|null,
    "totalObligationTaxIncluded": boolean|null,
    "totalCostOfCredit": number|null,
    "residualValue": number|null
  },
  "summary": string
}

Field notes:
- "pageKind" and "vehiclesOnPage": THE FIRST THING TO DECIDE, before reading any number. How many DIFFERENT vehicles for sale does this image show?
  * "single_vehicle" -- one car: a dealer quote, a window sticker, one listing/detail page. Several photos OF THE SAME car, or one car shown with several finance/lease term options, is still ONE vehicle. Set "vehiclesOnPage" to null and fill in every other field normally.
  * "several_vehicles" -- a handful (roughly 2 to 8) of DIFFERENT cars shown side by side, e.g. a Google "Sponsored Vehicles" ad carousel or a small comparison row. List each one in "vehiclesOnPage" and set every other field to null.
  * "inventory_results" -- a dealer's search-results / inventory grid: many vehicle cards in a grid, often with a result counter ("200 Items Matching"), pagination, filter controls, "Compare" checkboxes, or many near-identical cars of the same trim at the same price differing only by stock number. List what you can read in "vehiclesOnPage" and set every other field to null.
  In BOTH multi-vehicle cases: do NOT pick one, do not merge them, do not average them. "label" is how a person would recognise the car on screen, e.g. "2026 Toyota RAV4 Plug-In Hybrid GR Sport AWD - $85,995 - Okotoks Toyota". Include "stockNumber" whenever a stock/inventory number is visible -- on an inventory grid it is often the ONLY thing distinguishing two otherwise identical cards, so it matters.
- "dealerName": the dealership's business name, if shown anywhere on the quote (letterhead, header/footer, contact block). Do not include the city as part of this field -- that's separate.
- "dealerCity": the city (and province if visible, e.g. "Calgary, AB") of the dealership, if shown. Needed to tell apart dealers that share a common brand name -- there are many different "Toyota" or "Honda" dealers across Canada, and the name alone isn't enough to look up the right one.
- "statedMsrpOnDocument": the MSRP AS WRITTEN on the quote itself, if any is shown. Do not calculate or estimate this from your own knowledge -- only report what's literally printed. Use null if no MSRP appears on the document.
- "vin": the full 17-character VIN if it appears anywhere on the quote. Copy it EXACTLY as printed, no spaces. null if not shown.
- "odometerKm": the odometer reading / mileage in kilometres if shown (e.g. "41,220 km" -> 41220). Numbers only, no units or commas. null if not shown.
- "financing": the lease/finance terms if the quote discloses a payment plan (often in a dense fine-print paragraph). "paymentAmount" is the periodic payment BEFORE tax if both are shown; "totalObligation" is the total of all payments as literally disclosed, with "totalObligationTaxIncluded" true if that total includes tax. Use null for the whole object if no financing is disclosed.
- "standardWarranty": the vehicle's INCLUDED manufacturer warranty (what already comes free) -- separate from any extended plan being sold.
- "warranty": an extended warranty or protection plan being OFFERED/SOLD on this quote, if any. Use nulls throughout if none is being sold.
- "addOns": every fee, add-on, or line item beyond the base price -- documentation fees, admin fees, nitrogen tires, fabric protection, etc. "verdict" is your judgment: "good" (a genuine fair-priced benefit), "flagged" (commonly overpriced or questionable, worth negotiating), or "standard" (a mandatory, unremarkable pass-through like tax or registration -- neither good nor bad). "reason" is a one-sentence explanation.
- "summary": a short, plain-language bottom-line assessment of this quote based on the fees, add-ons, and warranty terms you found. Do not mention MSRP in this summary -- that comparison is added separately after your response.
- Numbers only -- no currency symbols, no commas.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  // Anonymous by default: null user → existing flow, no credit logic at all.
  const creditUser = await resolveCreditUser(req);
  let holdId: string | null = null;

  try {
    const body = await req.json();
    const { fileBase64, mediaType } = body;

    // Alberta-only. Runs BEFORE the credit hold and before any vision call, so
    // an out-of-province upload costs nothing. Region proven by an HMAC token
    // minted by Vercel, never claimed by the browser. Fails OPEN when we cannot
    // establish a location — see _shared/region-gate.js.
    {
      const gate = await gateRequest({
        token: body?.regionToken,
        secret: Deno.env.get("REGION_TOKEN_SECRET") ?? "",
        selfDeclared: body?.regionSelfDeclared === true,
      });
      if (!gate.allow) {
        return new Response(JSON.stringify({
          error: "outside_service_area",
          region: gate.region ?? null,
          regionLabel: gate.regionLabel ?? null,
        }), { status: 403, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }
    }
    // Set on the SECOND pass, after the person picked one car out of a
    // multi-vehicle screenshot (see the vehiclesOnPage branch below).
    const focusVehicle: string | null = typeof body?.focusVehicle === "string" && body.focusVehicle.trim()
      ? body.focusVehicle.trim().slice(0, 200)
      : null;

    // Repeat-attempt throttle. Only applies to a blind resubmit of the SAME
    // raw upload -- once the caller has picked a vehicle (focusVehicle set),
    // this is a resolved, legitimate scan and must proceed normally. Checked
    // before ANY vendor spend, including the cheap triage below, so a
    // blocked repeat costs nothing at all.
    const repeatIdentity = repeatIdentityKey(creditUser?.id ?? null, req);
    const repeatInputHash = typeof fileBase64 === "string" ? await sha256Hex(fileBase64) : null;
    if (!focusVehicle && repeatInputHash) {
      const cooldown = await checkRepeatCooldown(repeatIdentity, repeatInputHash);
      if (cooldown.blocked) {
        return new Response(JSON.stringify({
          error: "repeat_multivehicle_cooldown",
          message: "You've already tried this upload and it's a multi-vehicle page LotCheck can't build a report from. Try a different listing, or upload the ONE vehicle you want checked.",
          cooldownUntil: cooldown.cooldownUntil,
        }), { status: 429, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }
    }
    // `images` (new): the client normalizes/slices photos to stay inside
    // Claude's vision limits and sends the tiles here, top-to-bottom. A tall
    // screenshot arrives as several slices of ONE page, not several pages.
    // `fileBase64` stays the only path for PDFs and the fallback for an older
    // cached client, so this is additive.
    const rawImages: any[] = Array.isArray(body?.images) ? body.images : [];

    if (!fileBase64 || !mediaType) {
      return new Response(JSON.stringify({ error: "Missing file data." }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // Rough size guard -- base64 is ~33% larger than the raw file, so this
    // caps the actual file at roughly 15MB, comfortably above any real quote.
    if (fileBase64.length > 20_000_000) {
      return new Response(JSON.stringify({ error: "That file is larger than expected for a quote." }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // Claude rejects any single image over ~5MB outright. This guard used to
    // not exist, so an oversized upload sailed past the 20M-char check above,
    // came back a 400 from Anthropic, and surfaced as the generic "analysis
    // service returned an error" card with nothing logged (2026-08-15, a PNG
    // screenshot of a Google results page). The client now slices images so
    // this should be unreachable -- it stays as the belt-and-braces backstop
    // that names the real problem instead of a mystery 502.
    // Anthropic applies its per-image size limit to the BASE64 string, not the
    // raw bytes, and separately hard-rejects anything over 8000px on a side.
    // The exact byte cap is genuinely ambiguous: the docs say 10MB for the
    // direct API, but the only rejection threshold anyone has actually
    // OBSERVED in an error string is 5242880 (5 MiB), which is also still the
    // live Bedrock/Vertex value. Rather than guess between them, this sits at
    // the documented 10MB so we never falsely refuse an image Anthropic would
    // have accepted -- and the logUsage call below now records the real
    // Anthropic status, error text and payload size on every rejection, so if
    // the true ceiling is 5MB the evidence will show up in api_usage_log and
    // this can be tightened against data instead of assumption.
    //
    // Largely academic in practice: the client slices images into ~1568px
    // tiles a few hundred KB each, so this only guards the fallback path where
    // normalization failed and the original bytes went out.
    const VISION_B64_CAP = 10_000_000;
    const images = rawImages
      .filter((im) => im && typeof im.b64 === "string" && im.b64.length > 0)
      .slice(0, 8)
      .map((im) => ({ b64: im.b64 as string, mediaType: typeof im.mediaType === "string" ? im.mediaType : "image/jpeg" }));
    const oversized = images.find((im) => im.b64.length > VISION_B64_CAP)
      || (!images.length && mediaType !== "application/pdf" && fileBase64.length > VISION_B64_CAP ? { b64: fileBase64 } : null);
    if (oversized) {
      console.error(`Image exceeds vision cap: ${oversized.b64.length} b64 chars (cap ${VISION_B64_CAP}).`);
      await logUsage({ success: false, errorMessage: `image over vision cap (${oversized.b64.length} b64 chars)` });
      return new Response(
        JSON.stringify({ error: "That image is too large to analyze. Try a screenshot of just the pricing section, or save it as a JPG first." }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    // Authorize a credit hold before any expensive work (signed-in only).
    // Anonymous callers skip this entirely. The 400s above run before this,
    // so a rejected request never places a hold.
    if (creditUser) {
      const authz = await authorizeCredit(creditUser.id);
      if (!authz.ok) {
        if (authz.kind === "out_of_credits") {
          return new Response(JSON.stringify({ error: "out_of_credits" }), {
            status: 402,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ error: "Something went wrong processing that file." }), {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
      holdId = authz.holdId;
    } else {
      // Anonymous request: enforce the global free-check breaker BEFORE any
      // expensive Claude work, so a blocked check costs nothing. Signed-in
      // callers took the credit-authorize branch above and are unaffected.
      const allowed = await tryFreeCheck(req);
      if (!allowed) {
        return new Response(JSON.stringify({ error: "free_limit_reached" }), {
          status: 429,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
    }

    const isPdf = mediaType === "application/pdf";
    // Multi-slice uploads carry a note so the model reads them as ONE tall page
    // rather than several unrelated photos -- without it, a quote split across
    // a seam reads as two partial documents and the totals stop reconciling.
    const sliceNote = images.length > 1
      ? [{ type: "text", text: `The ${images.length} images above are vertical slices of ONE tall page, in order from top to bottom, with a small overlap between consecutive slices. Read them together as a single continuous document -- do not treat them as separate vehicles, quotes, or pages, and do not double-count a line that appears in the overlap.` }]
      : [];
    const docBlocks = isPdf
      ? [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: fileBase64 } }]
      : images.length
        ? images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.mediaType, data: im.b64 } }))
        : [{ type: "image", source: { type: "base64", media_type: mediaType, data: fileBase64 } }];

    // Set by the triage pass below when it proves this image can't produce a
    // single-vehicle report; short-circuits the expensive read entirely.
    let extractedFromTriage: any = null;

    // ---- Step 0: cheap triage -- how many vehicles, before we pay to read ----
    // A dealer inventory grid (House of Cars: 1198 results, ~16 different makes
    // on one screen) used to cost a full multi-tile vision read and then return
    // a picker we deliberately don't charge for. Since fn_release_quote DELETES
    // the hold, the credit is never consumed -- so ONE credit could fund
    // unlimited paid reads. This classifies first on a small frame at roughly a
    // tenth of the tokens, so the abusive path costs cents-per-hundred instead
    // of dollars, WITHOUT rate-limiting a real buyer (cost-exploit-guards).
    //
    // The client only sends triageImage for multi-tile uploads, so an ordinary
    // phone photo of a quote pays neither the latency nor the tokens. Any
    // failure here falls through to the full read -- a screening optimization
    // must never be able to block a legitimate report.
    const triageImage = body?.triageImage;
    if (!focusVehicle && triageImage && typeof triageImage.b64 === "string" && triageImage.b64.length < VISION_B64_CAP) {
      try {
        const tRes = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: ANTHROPIC_MODEL,
            max_tokens: 700,
            messages: [{ role: "user", content: [
              { type: "image", source: { type: "base64", media_type: typeof triageImage.mediaType === "string" ? triageImage.mediaType : "image/jpeg", data: triageImage.b64 } },
              { type: "text", text: `Look at this image of a car dealership page or document. Answer ONLY with this JSON, no prose, no code fences:\n{"pageKind":"single_vehicle"|"several_vehicles"|"inventory_results","vehiclesOnPage":null|[{"label":string,"year":number|null,"make":string|null,"model":string|null,"trim":string|null,"price":number|null,"stockNumber":string|null}]}\n\n"single_vehicle" = one car: a quote, a window sticker, one listing/detail page. Several photos of the SAME car, or one car with several finance/lease options, is still ONE vehicle -> set vehiclesOnPage to null.\n"several_vehicles" = roughly 2-8 DIFFERENT cars side by side, e.g. an ad carousel.\n"inventory_results" = a search-results / inventory grid: many vehicle cards, often a result counter ("1198 Results"), filters, pagination, or many near-identical cars differing only by stock number.\nFor the two multi-vehicle kinds, list what you can read. Ignore promotional banners and tiles that advertise offers rather than a specific car.` },
            ] }],
          }),
        }, { timeoutMs: 25_000, maxAttempts: 1, budgetMs: 28_000, label: "anthropic-quote-triage" });
        if (tRes.ok) {
          const tData = await tRes.json();
          const tText = (tData?.content?.find((b: any) => b?.type === "text")?.text ?? "").replace(/```json|```/g, "").trim();
          const tParsed = JSON.parse(tText);
          const tKind = typeof tParsed?.pageKind === "string" ? tParsed.pageKind : null;
          const tList = Array.isArray(tParsed?.vehiclesOnPage) ? tParsed.vehiclesOnPage : [];
          if (tKind === "several_vehicles" || tKind === "inventory_results" || tList.length > 1) {
            // Stop here -- never pay for the full read on a page we can't report
            // on anyway. extracted is synthesized so the existing multi-vehicle
            // branch below handles the response in exactly one place.
            extractedFromTriage = { pageKind: tKind ?? "several_vehicles", vehiclesOnPage: tList };
            console.log(`Triage stopped an expensive read: ${tKind}, ${tList.length} vehicles (input_tokens=${tData?.usage?.input_tokens}).`);
            await logUsage({ success: false, inputTokens: tData?.usage?.input_tokens ?? null, outputTokens: tData?.usage?.output_tokens ?? null, errorMessage: `triage: ${tKind}, ${tList.length} vehicles -- full read skipped (not charged)` });
          }
        }
      } catch (e) {
        console.warn("Triage pass failed (ignored, proceeding to full read):", (e as Error)?.message);
      }
    }

    // ---- Step 1: Claude reads the document ----
    // A big PDF can make this the slow part, so allow a generous per-attempt
    // timeout with one retry. Budget math: 2 × 60s + backoff ≈ 122s worst case,
    // comfortably under Supabase's ~150s ceiling. On timeout/network exhaustion
    // fetchWithRetry throws → the outer catch releases the credit hold (no
    // strand); a spent-budget 5xx returns non-ok → the !ok branch below releases.
    const anthropicRes = extractedFromTriage ? null : await fetchWithRetry("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        // Bumped from 2000 to 4000 on 2026-07-22, alongside adding
        // dealerName/dealerCity. Not a confirmed failure here the way
        // analyze-listing-url's was -- this is a proactive safety margin,
        // since we just directly confirmed (on the sibling function) that
        // this schema class of response can hit a token ceiling and get
        // cut off mid-string with no warning. Costs nothing in the normal
        // case; max_tokens is a ceiling, not a target.
        max_tokens: 4000,
        messages: [
          { role: "user", content: [...docBlocks, ...sliceNote, { type: "text", text: buildExtractionPrompt(focusVehicle) }] },
        ],
      }),
    }, { timeoutMs: 60_000, maxAttempts: 2, budgetMs: 125_000, label: "anthropic-quote" });

    if (anthropicRes && !anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error("Anthropic API error:", anthropicRes.status, errText);
      // This path shipped a user-visible failure and logged NOTHING, so the
      // 2026-08-15 PNG failure left zero rows in api_usage_log and had to be
      // diagnosed by reading source instead of querying. A failure the user
      // can see must always be a failure we can query.
      await logUsage({
        success: false,
        errorMessage: `Anthropic HTTP ${anthropicRes.status}: ${errText.slice(0, 300)} | slices=${images.length || 1} | b64=${(images[0]?.b64 ?? fileBase64).length}`,
      });
      await releaseCredit(holdId);
      holdId = null;
      return new Response(
        JSON.stringify({ error: "The analysis service returned an error. Please try again." }),
        { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const data = anthropicRes ? await anthropicRes.json() : null;
    const textBlock = data?.content?.find((b: any) => b.type === "text");
    const rawText = textBlock?.text ?? "";
    const cleaned = rawText.replace(/```json|```/g, "").trim();

    let extracted: any;
    if (extractedFromTriage) {
      // Triage already proved this is a multi-vehicle page; the branch below
      // turns it into the picker response. No expensive read was made.
      extracted = extractedFromTriage;
    } else try {
      extracted = JSON.parse(cleaned);
    } catch {
      // Same diagnostic shape added to analyze-listing-url after that
      // function hit a real, confirmed max_tokens truncation -- this is
      // what actually let us tell "cut off mid-response" apart from "bad
      // formatting" there instead of guessing. No incident here yet, but
      // if one happens, this tells us which failure it is immediately.
      console.error(
        `Failed to parse Claude's JSON output. stop_reason=${data.stop_reason}, output_tokens=${data.usage?.output_tokens}, rawText.length=${rawText.length}:`,
        rawText,
      );
      await releaseCredit(holdId);
      holdId = null;
      return new Response(
        JSON.stringify({ error: "Couldn't read that quote clearly. Try a clearer scan or a different file." }),
        { status: 422, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    // ---- Step 1b: several cars in one image -> ask, never guess ----
    // A screenshot of a Google "Sponsored Vehicles" carousel or a dealer
    // search-results page shows five cars at once. Silently reporting on
    // whichever one the model happened to latch onto would put a real price
    // against the wrong vehicle -- the exact class of misleading output the
    // invariants exist to stop. So we return the list and let the person pick.
    //
    // CRITICALLY: no credit is charged here. The hold is released and the
    // person pays only when they come back with a choice and get a real
    // report (never-charge-for-a-report-we-couldn't-build).
    const rawVehicles = Array.isArray(extracted?.vehiclesOnPage)
      ? extracted.vehiclesOnPage
          .filter((v: any) => v && typeof v === "object")
          .slice(0, 40)
          .map((v: any) => ({
            label: typeof v.label === "string" ? v.label.slice(0, 160) : null,
            year: Number.isFinite(Number(v.year)) ? Number(v.year) : null,
            make: typeof v.make === "string" ? v.make : null,
            model: typeof v.model === "string" ? v.model : null,
            trim: typeof v.trim === "string" ? v.trim : null,
            price: Number(v.price) > 0 ? Number(v.price) : null,
            stockNumber: typeof v.stockNumber === "string" ? v.stockNumber.slice(0, 40) : null,
            dealerName: typeof v.dealerName === "string" ? v.dealerName : null,
          }))
          .filter((v: any) => v.label || v.model)
      : [];
    // Collapse identical configurations. An inventory grid routinely shows the
    // same trim at the same price five times over, differing only by stock
    // number -- listing those as five separate choices is noise the person
    // can't act on, and looks careless (dealers-are-adversaries). One row per
    // distinct year+make+model+trim+price, carrying how many there were.
    const byConfig = new Map<string, any>();
    for (const v of rawVehicles) {
      const key = [v.year, v.make, v.model, v.trim, v.price].map((x) => String(x ?? "")).join("|").toLowerCase();
      const seen = byConfig.get(key);
      if (seen) { seen.duplicateCount = (seen.duplicateCount ?? 1) + 1; continue; }
      byConfig.set(key, { ...v, duplicateCount: 1 });
    }
    const vehiclesOnPage = [...byConfig.values()].slice(0, 12);
    const pageKind = typeof extracted?.pageKind === "string" ? extracted.pageKind : null;
    // An inventory grid can't produce a VIN-accurate report: the cards carry no
    // VIN, and several identical cars share a price. Say so and point at the
    // single-vehicle page rather than inviting a pick that would be a guess.
    const isInventoryGrid = pageKind === "inventory_results"
      || rawVehicles.length > 8
      || rawVehicles.length > vehiclesOnPage.length; // duplicates present == a grid
    if (!focusVehicle && (vehiclesOnPage.length > 1 || isInventoryGrid)) {
      await releaseCredit(holdId);
      holdId = null;
      // Bump the repeat-attempt throttle -- a genuine multi-vehicle rejection,
      // the only kind of hit this counts. Covers both this full-read detection
      // and the cheap-triage stop above, which funnels into this same response.
      if (repeatInputHash) await recordMultiVehicleHit(repeatIdentity, repeatInputHash);
      await logUsage({ success: false, errorMessage: `multi-vehicle image (${pageKind ?? "unknown"}): ${rawVehicles.length} seen / ${vehiclesOnPage.length} distinct, awaiting choice (not charged)` });
      console.log(`Multi-vehicle image [${pageKind}]: ${rawVehicles.length} seen, ${vehiclesOnPage.length} distinct; returning picker, no credit charged.`);
      return new Response(
        JSON.stringify({
          needsVehicleChoice: true,
          pageKind: isInventoryGrid ? "inventory_results" : (pageKind ?? "several_vehicles"),
          totalSeen: rawVehicles.length,
          vehicles: vehiclesOnPage,
        }),
        { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }
    // A single-vehicle read must never carry the multi-vehicle scaffolding forward.
    delete extracted.vehiclesOnPage;
    delete extracted.pageKind;

    // ---- Step 2: Verification -- look up the REAL MSRP in our own catalog ----
    // Resolve the vehicle's CANONICAL base model first (e.g. "Palisade Ultimate
    // Calligraphy" -> "PALISADE"). Both the MSRP catalog and Transport Canada's
    // recall API key on the base model with an EXACT match, so trim leaking into
    // the model field silently breaks BOTH -- the Palisade seatbelt-recall miss
    // (2026-08). One resolver feeds both lookups. See make-recalls-fail-safe.
    const baseModel = await resolveBaseModel(extracted.year, extracted.make, extracted.model);
    const msrpLookup = await lookupVerifiedMsrp(extracted, baseModel);
    await applyVerifiedFuelType(extracted);

    // ---- Step 3: Assemble the analysis in the exact shape App.jsx renders ----
    const analysis = buildAnalysis(extracted, msrpLookup);
    await applyVerifiedWarranty(analysis);
    await applyRemainingWarranty(analysis);
    // Auto market value (best-effort). Gives used cars a real value anchor
    // instead of the synthetic estimate, from our OWN crawl (lotcheck provider,
    // the default). Needs the VIN (to exclude the subject) plus ymm + condition
    // to build the comparable set; returns null on thin coverage and the report
    // omits the module.
    analysis.saleCondition = deriveSaleCondition({ vehicleCondition: analysis.vehicleCondition, saleCondition: analysis.saleCondition ?? analysis.saleConditionHint ?? null });
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
    if (analysis.year && analysis.make && analysis.model) {
      analysis.recalls = await lookupRecalls(analysis.year, analysis.make, analysis.model, baseModel);
    }
    computeFinancingCheck(analysis);
    computeOdometerCheck(analysis);
    await resolveFinanceRates(analysis);
    await resolveLeaseRates(analysis);
    // S3 — deal reconciliation: split fees vs negotiable dealer add-ons so the
    // report shows the real out-the-door + how much markup is removable.
    { const rec = computeReconciliation(analysis); if (rec) analysis.reconciliation = rec; }
    // S11 — financing-contingent-discount trap (runs after reconciliation + finance rates).
    { const ft = computeFinancingTrap(analysis); if (ft) analysis.financingTrap = ft; }
    // S12 — doc-fee vs jurisdiction benchmark (fail-safe: only flags with a backed benchmark).
    { const df = assessDocFee(analysis); if (df) analysis.docFeeCheck = df; }
    // S25 — all-in label + safeguard: fires on any all-in-province listing, even a
    // clean one, so the report labels the price all-in and the script states the anchor.
    { const ai = resolveAllInAuthority(analysis.dealerCity); if (ai) analysis.allInPricing = ai; }
    // Moved here (was right after resolveLeaseRates, before allInPricing
    // above was even resolved) -- same fix as analyze-listing-url:
    // computeLeverageScore's over-MSRP delta needs allInPricing/msrpAllIn
    // to compare an AMVIC all-in advertised price against the correct
    // all-in reference, not the ex-freight MSRP (qualifyMsrpClaim's own
    // "$3,078 of freight printed as dealer markup" lesson, msrp-claim.ts).
    computeLeverageScore(analysis);
    // VIC'S RULE, on the QUOTE path too: no dealer terms -> use the
    // manufacturer's APR and price and do the math. A pasted quote that shows a
    // price but no financing is the same situation as a listing that shows
    // none, and the buyer needs the same number to beat.
    if (!analysis.financingCheck?.checked) {
      const ref = computeReferenceFinancing(analysis);
      if (ref) analysis.referenceFinancing = ref;
    }

    // Counter-script — aggregate every safeguard's "say this" (runs LAST).
    analysis.counterScript = buildCounterScript(analysis);

    // ASSERT — deterministic gates, immediately before signing. This path had
    // NO invariant coverage at all until now: the checks existed only as inline
    // `if` blocks on the listing path, so an uploaded quote never got them.
    // No render check happens here (there's no page to render), so the
    // price-gating accusation gate stays out of scope. See invariants.ts.
    assertInvariants(analysis);

    // Server-authoritative identity: stamps issuedAt from the trusted server
    // clock (so a device-clock change can't alter the date), computes the
    // report ID + verify payload, and SIGNS them (ECDSA P-256) when the signing
    // key is configured. Best-effort — never fails the report. See
    // report-signing-scope + make-it-dispute-proof.
    await finalizeServerSide(analysis);

    // Flywheel Phase 1 — LOG ONLY, stores nothing (see fee-vocab.ts). De-
    // identified fee projection to validate the normalizer; gated on FLYWHEEL_LOG.
    if (Deno.env.get("FLYWHEEL_LOG") === "on") {
      try { const obs = buildFeeObservations(analysis); if (obs.length) console.log(`flywheel: ${obs.length} fee obs ${JSON.stringify(obs)}`); } catch (e) { console.warn("flywheel log skipped:", (e as Error)?.message); }
    }

    // Delivered an accurate result -> capture the hold (signed-in only) and
    // include the new balance. Null holdId out first so a later throw can't
    // release a hold we've decided to charge. `analysis` is unchanged either way.
    const credits = await captureCredit(holdId);
    holdId = null;
    // "success" has meant "we returned HTTP 200", which is NOT the same as "the
    // buyer got a report worth paying for". A read that recovers no price, no
    // MSRP and no VIN still logged as a clean success, so the admin panel
    // counted a hollow report exactly like a complete one (Vic, 2026-08-15:
    // "that will 100% wrong and misleading"). Record WHAT was missing so a
    // degraded delivery is visible as degraded. Note is written even on
    // success -- error_message is the only free-text column this table has.
    const missing: string[] = [];
    if (!(Number(analysis.quotedPrice) > 0)) missing.push("price");
    if (!(Number(analysis.msrp) > 0)) missing.push("msrp");
    if (!analysis.vin) missing.push("vin");
    if (!analysis.recalls) missing.push("recalls");
    if (!(Number(analysis.financing?.rate) > 0)) missing.push("apr");
    await logUsage({
      success: true,
      inputTokens: data?.usage?.input_tokens ?? null,
      outputTokens: data?.usage?.output_tokens ?? null,
      errorMessage: missing.length ? `degraded: missing ${missing.join(",")}` : null,
    });
    // One row per checkpoint, so the ledger can report a real per-check failure
    // rate instead of a single boolean that calls 12-of-13 a success. Fail-open.
    await recordCheckpoints(supabase, {
      reportId: analysis.reportId ?? null,
      feature: "quote",
      analysis,
    });
    return new Response(JSON.stringify(credits ? { analysis, credits } : { analysis }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("analyze-quote error:", err);
    await logUsage({ success: false, errorMessage: String(err).slice(0, 400) });
    // Any throw after a hold was placed must not charge the user.
    await releaseCredit(holdId);
    holdId = null;
    return new Response(JSON.stringify({ error: "Something went wrong processing that file." }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});

// Looks up msrp_catalog for the exact year/make/model/trim, relaxing the
// match step by step. Never throws -- if the table is empty or missing
// (e.g. before the catalog backfill has run), every quote just falls back
// to "not_found" instead of breaking the whole feature. The moment real
// rows land in msrp_catalog, this starts returning verified hits
// automatically, no code changes needed.
// Fuel type is a fixed fact about a specific year/make/model -- not
// something that should ever need interpreting from a dealer document,
// exactly the same reasoning that already applies to MSRP just below.
// Direct motivation: the Gateway Toyota C-HR case (2026-07-22, found via
// analyze-listing-url), where a dealer's own "Fuel Type: Gasoline" label
// was flat wrong -- Toyota's own official spec pages confirm the 2026
// C-HR is a genuine 77-kWh BEV. Matching fix applied here too, since a
// scanned/uploaded quote could contain the exact same kind of dealer
// paperwork error.
//
// Piggybacks on msrp_catalog (same table used by lookupVerifiedMsrp
// below, extended with a fuel_type column) -- one catalog backfill
// populates both. Matches on year+make+model only (not trim),
// since fuel type is a model-level fact for the overwhelming majority of
// vehicles, not a trim-level one.
//
// Mutates extracted.fuelType in place and sets fuelTypeVerified -- falls
// back to whatever Claude read off the document when there's no catalog
// match, so a make whose fuel_type column hasn't been backfilled yet
// degrades quietly. Never throws, never blocks the report.
async function applyVerifiedFuelType(extracted: any): Promise<void> {
  if (!extracted || !extracted.year || !extracted.make || !extracted.model) return;
  try {
    const { data, error } = await supabase
      .from("msrp_catalog")
      .select("fuel_type")
      .eq("year", extracted.year)
      .ilike("make", extracted.make)
      .ilike("model", extracted.model)
      .not("fuel_type", "is", null)
      .limit(1)
      .maybeSingle();
    if (error) {
      console.warn("\u26a0\ufe0f msrp_catalog fuel_type lookup failed:", error.message);
      extracted.fuelTypeVerified = false;
      return;
    }
    if (!data?.fuel_type) {
      extracted.fuelTypeVerified = false;
      return;
    }
    extracted.fuelType = data.fuel_type;
    extracted.fuelTypeVerified = true;
  } catch (err) {
    console.warn("\u26a0\ufe0f applyVerifiedFuelType threw:", err);
    extracted.fuelTypeVerified = false;
  }
}

// Resolve the extracted model to its CANONICAL base model using our own
// msrp_catalog (authoritative for covered makes). "Palisade Ultimate
// Calligraphy" -> "PALISADE". Returns null when we can't confidently resolve,
// so callers fall back to best-effort matching + the confirmed-match gate in
// lookupRecalls. Never throws.
async function resolveBaseModel(year: number, make: string, model: string): Promise<string | null> {
  if (!year || !make || !model) return null;
  try {
    const { data } = await supabase
      .from("msrp_catalog")
      .select("model")
      .eq("year", year)
      .ilike("make", make)
      .not("model", "is", null)
      .limit(400);
    if (!data?.length) return null;
    const em = String(model).trim().toUpperCase();
    let best: string | null = null;
    for (const row of data) {
      const cm = String(row.model || "").trim();
      if (!cm) continue;
      const cmU = cm.toUpperCase();
      if (em === cmU || em.startsWith(cmU + " ")) {
        if (!best || cm.length > best.length) best = cm; // longest (most specific) canonical match wins
      }
    }
    return best;
  } catch { return null; }
}

async function lookupVerifiedMsrp(extracted: any, baseModel?: string | null) {
  let { year, make, model, trim } = extracted || {};
  if (!year || !make || !model) {
    return { value: null, matchType: "insufficient_data" };
  }
  // Prefer the canonical base model. If the extractor merged the trim into the
  // model field, recover the trim from the leftover words so we still hit the
  // right catalog row instead of falling through to "not found".
  if (baseModel) {
    const bm = String(baseModel).trim(), emU = String(model).trim().toUpperCase(), bmU = bm.toUpperCase();
    if (bmU !== emU && emU.startsWith(bmU + " ")) {
      const residual = String(model).trim().slice(bm.length).trim();
      if (residual && !trim) trim = residual;
    }
    model = bm;
  }

  try {
    if (trim) {
      const { data: exact } = await supabase
        .from("msrp_catalog")
        .select("msrp, trim, fetched_at, source_url, all_in_price, price_basis")
        .eq("year", year)
        .ilike("make", make)
        .ilike("model", model)
        .ilike("trim", trim)
        .not("msrp", "is", null)
        .limit(1)
        .maybeSingle();

      if (exact?.msrp) {
        return { value: exact.msrp, matchType: "exact", trim: exact.trim, fetchedAt: exact.fetched_at, sourceUrl: exact.source_url ?? null, allInPrice: exact.all_in_price ?? null, priceBasis: exact.price_basis ?? null };
      }

      const { data: fuzzy } = await supabase
        .from("msrp_catalog")
        .select("msrp, trim, fetched_at, source_url, all_in_price, price_basis")
        .eq("year", year)
        .ilike("make", make)
        .ilike("model", model)
        .ilike("trim", `%${trim}%`)
        .not("msrp", "is", null)
        .limit(1)
        .maybeSingle();

      if (fuzzy?.msrp) {
        return { value: fuzzy.msrp, matchType: "fuzzy_trim", trim: fuzzy.trim, fetchedAt: fuzzy.fetched_at, sourceUrl: fuzzy.source_url ?? null, allInPrice: fuzzy.all_in_price ?? null, priceBasis: fuzzy.price_basis ?? null };
      }
    }

    // Same year/make/model, any trim -- lowest MSRP as an approximate floor
    const { data: modelOnly } = await supabase
      .from("msrp_catalog")
      .select("msrp, trim, fetched_at, source_url, all_in_price, price_basis")
      .eq("year", year)
      .ilike("make", make)
      .ilike("model", model)
      .not("msrp", "is", null)
      .order("msrp", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (modelOnly?.msrp) {
      return {
        value: modelOnly.msrp,
        matchType: "model_only_approximate",
        trim: modelOnly.trim,
        fetchedAt: modelOnly.fetched_at,
        sourceUrl: modelOnly.source_url ?? null,
        allInPrice: modelOnly.all_in_price ?? null,
        priceBasis: modelOnly.price_basis ?? null,
      };
    }
  } catch (err) {
    // Table missing, RLS issue, transient network error -- never let this
    // break the whole analysis.
    console.error("msrp_catalog lookup failed:", err);
  }

  return { value: null, matchType: "not_found" };
}

// Warranty validity: replace Claude's read of the included manufacturer
// warranty with LotCheck's own verified coverage from the
// manufacturer_warranties table whenever the make is on file and the vehicle
// is new -- the same authoritative-source-over-guess step already live on the
// listing path. Sets standardWarranty.verified so the report can badge it.
// Never throws.
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
// analysis.remainingWarranty. Never throws. (New vehicles get the full-coverage
// treatment via applyVerifiedWarranty instead.)
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

// ── Verification checks, shared byte-for-byte with the listing path so an
// uploaded quote gets the same 10-point treatment as a pasted URL. Each is
// self-contained and unit-tested on the listing side. ──────────────────────

// VIN pattern validity (ISO 3779 check digit + format rules) now lives in
// _shared/invariants.ts. It used to be a byte-identical copy in this file AND
// in analyze-listing-url, so a correction to one silently missed the other.

// Candidate model strings, most-authoritative first. TC's model-name match is
// EXACT, so "Palisade Ultimate Calligraphy" returns zero while "Palisade"
// returns the real recalls. We try the catalog-canonical base model first, then
// the full string, then progressively drop trailing (trim) words -- stopping at
// the first candidate that TC recognises. Multi-word base models ("Santa Fe",
// "Grand Cherokee", "Cross Sport") survive because we stop at the first hit.
// Does TC recognise this make/model at all? Distinguishes a CONFIRMED clean bill
// from a lookup miss. Queries a PAST window (year-10..year-1) to dodge the TC
// quirk where a range ending in the newest model year silently drops that year.
// Returns a tri-state:
//   { checked:false }                       -> registry unreachable ("couldn't verify")
//   { checked:true, count:N>0, items }       -> recalls found
//   { checked:true, count:0, confirmed:true} -> CONFIRMED clean (model matched TC)
//   { checked:true, count:0, confirmed:false}-> zero, but model never matched -> "couldn't confirm"
// A negative safety claim ("no open recalls") is ONLY safe when confirmed=true.

function computeFinancingCheck(analysis: any): void {
  const f = analysis?.financing;
  if (!f || typeof f !== "object") return;
  const pay = Number(f.paymentAmount);
  const term = Number(f.termMonths);
  const total = Number(f.totalObligation);
  const freq = f.paymentFrequency;
  const perYear = freq === "weekly" ? 52 : freq === "biweekly" ? 26 : freq === "monthly" ? 12 : null;
  if (!pay || !term || !total || !perYear) return;
  const nPayments = Math.round((term / 12) * perYear);
  const expected = pay * nPayments;
  if (expected <= 0) return;
  const ratio = total / expected;
  let consistent: boolean; let note: string;
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
  analysis.financingCheck = { checked: true, consistent, disclosedTotalObligation: total, computedFromPayments: Math.round(expected), paymentsCounted: nPayments, note };
}

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

// Resolve BOTH finance rates (dealer's disclosed rate + manufacturer catalog
// rate) for the side-by-side comparison. See the twin in analyze-listing-url
// for the new-vs-used rationale. Attaches analysis.financeRates. Never throws.
async function resolveFinanceRates(analysis: any): Promise<void> {
  const out: any = { dealer: null, manufacturer: null };
  const pageRate = Number(analysis?.financing?.rate);
  if (pageRate && pageRate > 0 && pageRate < 30) {
    // Uploaded-quote path has no page-text/feed backstop to cross-check
    // against -- every rate here is the LLM's own read of the photo/PDF, so
    // it is always untrusted for the accusatory HIGH/dollar-gap claim. See
    // the identical tag in analyze-listing-url/index.ts resolveFinanceRates.
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
          // termMonths MUST travel with the rate. analyze-listing-url had the
          // identical line and dropping the term made the payment impossible to
          // compute; fixing it there and not here is exactly the one-call-site
          // fix that report-features-all-views exists to prevent.
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
// scrapers). Mirrors resolveFinanceRates: match on make, prefer the exact
// model, pick a representative term (48mo, the common lease length, else the
// shortest available). Attaches analysis.leaseRates.manufacturer. Never throws
// -- if the table doesn't exist yet the lookup just yields null.
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

function computeLeverageScore(analysis: any): void {
  const basis: string[] = [];
  let score = 2.0;
  const quoted = Number(analysis.quotedPrice) || null;
  // The reference figure, not raw analysis.msrp: an AMVIC all-in advertised
  // price (quoted) must be measured against the manufacturer's ALL-IN
  // figure, never the ex-freight MSRP -- see msrp-claim.ts's own docstring
  // for why (Charlesglen, $11,173 invented markup). This function used to
  // run BEFORE analysis.allInPricing was even resolved (moved above, see the
  // call-site comment), so it always compared against the wrong number when
  // applicable.
  const claim = qualifyMsrpClaim(analysis);
  const msrp = Number(claim.reference) || null;
  // An over/under-MSRP claim requires an EXACT trim match, same rule the report
  // surfaces enforce via msrpBasis. Without this the score narrated "priced
  // $23,900 over MSRP" off a base-trim FLOOR -- and did it inside a note that
  // says "computed only from the verified findings above, not an opinion", so
  // the report made the same false accusation twice, the second time branded
  // as verified. A floor tells you nothing about how this unit is priced.
  if (msrp && quoted && analysis.msrpBasis === "exact") {
    const deltaPct = (quoted - msrp) / msrp;
    if (deltaPct > 0.005) { score += Math.min(2.5, deltaPct * 100 * 0.3); basis.push(`priced $${Math.round(quoted - msrp).toLocaleString()} over MSRP`); }
    else if (deltaPct < -0.02) { score -= 1.0; basis.push(`already priced below MSRP`); }
  } else if (msrp && quoted && analysis.msrpBasis === "starting_at") {
    // Mirrors analyze-listing-url's same fix, confirmed live 2026-08-21
    // (Okotoks Toyota RAV4 PHEV GR Sport AWD) -- a real gap against a
    // catalog-complete, hand-verified trim MSRP reported "no pricing red
    // flags" because trim-match.js's priceImplausible() downgrades "exact" to
    // "starting_at" whenever it can't rule out a missing catalog trim (the
    // IONIQ 9 false-accusation case). That downgrade must stand -- this
    // doesn't touch it -- but staying completely silent on a gap this large
    // is its own failure.
    //
    // qualifyCeilingClaim first (a stronger, no-hedge-needed claim: is the
    // asking price above the WHOLE lineup's top trim, which has no "missing
    // higher trim" escape hatch) -- NOTE this path (analyze-quote) never
    // populates analysis.msrpCeiling today, unlike analyze-listing-url, so
    // this branch is a no-op here until that gap is closed; kept for parity
    // so it activates automatically once it is, rather than needing a second
    // fix later.
    const ceilingClaim = qualifyCeilingClaim(analysis);
    if (ceilingClaim.exceeds && Number(ceilingClaim.over) > 0) {
      score += Math.min(2.5, (Number(ceilingClaim.over) / Number(ceilingClaim.ceiling)) * 100 * 0.3);
      basis.push(`priced $${Math.round(Number(ceilingClaim.over)).toLocaleString()} above the top of the ${ceilingClaim.trimsConsidered}-trim ${analysis.make || ""} lineup ($${Math.round(Number(ceilingClaim.ceiling)).toLocaleString()}, ${ceilingClaim.trim || "the priciest trim"}, all-in) — no combination of real trims in our catalog reaches this price`);
    } else {
      // Fallback: no usable ceiling data. Same threshold as priceImplausible()
      // (>20% AND >$6,000) -- below that, "options sit above the floor"
      // genuinely covers it. At or above it, surfaced as a number to ask
      // about, never as a claim about why it's there -- capped lower than
      // either claim above because which of the two explanations applies is
      // not confirmed.
      const gap = quoted - msrp;
      if (gap > msrp * 0.20 && gap > 6000) {
        score += Math.min(1.5, (gap / msrp) * 100 * 0.15);
        const refNote = claim.comparedAgainst === "all_in" ? "all-in MSRP" : "base MSRP";
        basis.push(`asking price sits $${Math.round(gap).toLocaleString()} above this trim's $${Math.round(msrp).toLocaleString()} ${refNote} (not confirmed as markup — could be options/packages atop the base trim, or a catalog gap; ask the dealer to itemize what's added)`);
      }
    }
  }
  const flagged = Number(analysis.totalFlaggedCost) || 0;
  if (flagged > 0) { score += Math.min(2.0, flagged / 1000); basis.push(`$${flagged.toLocaleString()} in flagged fees`); }
  const rc = analysis.recalls;
  if (rc?.checked && rc.count > 0) { score += Math.min(2.0, rc.count * 0.7); basis.push(`${rc.count} open Transport Canada recall${rc.count > 1 ? "s" : ""}`); }
  if (analysis.financingCheck?.checked && analysis.financingCheck.consistent === false) { score += 1.0; basis.push(`financing numbers that don't reconcile`); }
  score = Math.max(0, Math.min(10, Math.round(score * 10) / 10));
  analysis.leverageScore = {
    score, computed: true, basis,
    note: basis.length
      ? `Computed only from the verified findings above (${basis.join("; ")}) — not an opinion.`
      : `No pricing red flags, flagged fees, or open recalls surfaced, so this report alone gives limited documented leverage.`,
  };
}

// Combines Claude's read with the verified MSRP into EXACTLY the shape
// App.jsx's report card renders today, plus one new (currently unrendered,
// harmless) field for the future verified/estimated badge.
function buildAnalysis(extracted: any, msrpLookup: any) {
  const { year, make, model, trim, vehicleCondition, fuelType, fuelTypeVerified, dealerName, dealerCity, quotedPrice, statedMsrpOnDocument } = extracted;

  const vehicle = [year, make, model, trim].filter(Boolean).join(" ") || null;

  // ONE rule for who wins between a dealer-stated MSRP and our catalog, shared
  // with the listing path (_shared/msrp-authority.js). This path used to have
  // its own unguarded copy, and it was the IONIQ 9 defamation bug still live:
  // `verifiedMsrp ?? statedMsrpOnDocument` let ANY catalog hit win regardless
  // of match quality, so a trim missing from the catalog fell through to
  // "model_only_approximate" -- which returns the CHEAPEST row for the model --
  // and then wrote, verbatim and signed, that a named dealer's $81,499 window
  // sticker should have been $59,999. The 2026-08-13 fix only ever landed on
  // analyze-listing-url; this path never imported the shared resolver at all.
  //
  // basis is the whole safeguard: only a genuine "exact" trim match may
  // displace the dealer's number or support an inflation callout. A fuzzy
  // substring match (ilike '%trim%', limit 1, no ordering) and a model-level
  // floor are both "starting_at" -- honest references, never accusations.
  const verifiedMsrp = msrpLookup.value ?? null;
  const catalogBasis = msrpLookup.matchType === "exact" ? "exact" : "starting_at";
  const decided = resolveMsrpAuthority({
    statedMsrp: Number(statedMsrpOnDocument) || 0,
    ref: verifiedMsrp != null
      // sourceUrl was hardcoded null, so an uploaded quote could never cite the
      // manufacturer's own page for its MSRP even when the catalog row held the
      // link. The URL path has always carried it; every report feature ships to
      // every surface, and "here is where to check it yourself" is the feature.
      ? { msrp: Number(verifiedMsrp), trim: msrpLookup.trim ?? null, basis: catalogBasis, sourceUrl: msrpLookup.sourceUrl ?? null }
      : null,
    make: make ?? null,
  });
  const msrp = decided.msrp || null;
  const msrpSource = decided.source;
  const msrpBasis = decided.basis;

  // The accusation now comes only from the resolver, which requires an EXACT
  // trim match AND its own materiality floor (>3% and >$800) -- not the bare
  // 2%-off-a-possibly-wrong-number test this used to run.
  let summary = extracted.summary || "";
  if (decided.inflation) {
    summary +=
      (summary ? " " : "") +
      `Also worth flagging: this quote lists MSRP as $${Number(decided.inflation.dealerStated).toLocaleString()}, but ${make || "the manufacturer"}'s published MSRP for this exact trim is $${Number(decided.inflation.manufacturer).toLocaleString()} -- $${Number(decided.inflation.overBy).toLocaleString()} higher than the published figure.`;
  } else if (decided.reference && Number(decided.reference.msrp) > 0) {
    // A floor is context, not a claim: state it as the model's starting price
    // and never call it "the verified MSRP for this trim".
    summary +=
      (summary ? " " : "") +
      `For reference, ${decided.reference.make || make || "the manufacturer"} publishes this model${decided.reference.trim ? ` (${decided.reference.trim})` : ""} from $${Number(decided.reference.msrp).toLocaleString()} -- trim, options and drivetrain sit above that, so this isn't a like-for-like comparison with the quoted figure.`;
  }

  const addOns = Array.isArray(extracted.addOns) ? extracted.addOns : [];
  const totalFlaggedCost = addOns
    .filter((a: any) => a?.verdict === "flagged")
    .reduce((sum: number, a: any) => sum + (Number(a.price) || 0), 0);

  return {
    vehicle,
    year: year ?? null,
    make: make ?? null,
    model: model ?? null,
    fuelType: fuelType ?? null,
    fuelTypeVerified: fuelTypeVerified ?? false,
    vehicleCondition: vehicleCondition ?? null,
    dealerName: dealerName ?? null,
    dealerCity: dealerCity ?? null,
    msrp,
    // Top-level provenance, so the shared invariants actually APPLY to this
    // path. They were written to catch exactly this bug but gated on
    // msrpSource/msrpBasis/msrpInflation, which the quote path never set --
    // it buried them in msrpVerification below, which nothing reads. That is
    // why MSRP_HAS_PROVENANCE could fail on every quote report and still ship.
    msrpSource,
    msrpBasis,
    ...(decided.trim ? { msrpTrim: decided.trim } : {}),
    ...(decided.dealerStatedMsrp ? { dealerStatedMsrp: decided.dealerStatedMsrp } : {}),
    ...(decided.inflation ? { msrpInflation: decided.inflation } : {}),
    ...(decided.reference ? { msrpReference: decided.reference } : {}),
    quotedPrice: quotedPrice ?? null,
    vin: extracted.vin ?? null,
    odometerKm: extracted.odometerKm ?? null,
    financing: extracted.financing ?? null,
    standardWarranty: extracted.standardWarranty ?? null,
    warranty: extracted.warranty ?? null,
    addOns,
    totalFlaggedCost,
    summary,
    // Not rendered yet -- available for the "Verified"/"Estimated" badge
    // whenever you're ready to build it. Harmless to include now.
    msrpVerification: {
      source: msrpSource,
      basis: msrpBasis,
      catalogMatchType: msrpLookup.matchType ?? null,
      verifiedValue: verifiedMsrp,
      statedOnDocument: statedMsrpOnDocument ?? null,
      mismatch: !!decided.inflation,
      matchedTrim: msrpLookup.trim ?? null,
      verifiedAsOf: msrpLookup.fetchedAt ?? null,
    },
    // The buyer's own way to check us. A claim the buyer cannot re-verify is a
    // claim they have to take on trust, which is the opposite of the product.
    msrpSourceUrl: decided.sourceUrl ?? msrpLookup.sourceUrl ?? null,
    // The manufacturer's OWN all-in figure, when we hold it. An all-in
    // advertised price must be compared against this, never against the
    // ex-freight MSRP -- that comparison invents roughly $3,000 of markup.
    msrpAllIn: msrpLookup.allInPrice ?? null,
    msrpPriceBasis: msrpLookup.priceBasis ?? null,
  };
}