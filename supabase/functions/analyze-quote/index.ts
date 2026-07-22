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
//             from VinAudit manufacturer data). This is the verification
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

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
// Keeps whatever model you already have configured as a secret; falls back
// to a sensible default only if that secret isn't set.
const ANTHROPIC_MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-4-5";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const EXTRACTION_PROMPT = `You are reading a car dealership quote (a PDF or a photo of a paper quote). Read it carefully and return ONLY this JSON object -- no other text, no markdown code fences.

{
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

  try {
    const { fileBase64, mediaType } = await req.json();

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

    const isPdf = mediaType === "application/pdf";
    const docBlock = isPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: fileBase64 } }
      : { type: "image", source: { type: "base64", media_type: mediaType, data: fileBase64 } };

    // ---- Step 1: Claude reads the document ----
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
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
          { role: "user", content: [docBlock, { type: "text", text: EXTRACTION_PROMPT }] },
        ],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error("Anthropic API error:", anthropicRes.status, errText);
      return new Response(
        JSON.stringify({ error: "The analysis service returned an error. Please try again." }),
        { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const data = await anthropicRes.json();
    const textBlock = data.content?.find((b: any) => b.type === "text");
    const rawText = textBlock?.text ?? "";
    const cleaned = rawText.replace(/```json|```/g, "").trim();

    let extracted: any;
    try {
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
      return new Response(
        JSON.stringify({ error: "Couldn't read that quote clearly. Try a clearer scan or a different file." }),
        { status: 422, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    // ---- Step 2: Verification -- look up the REAL MSRP in our own catalog ----
    const msrpLookup = await lookupVerifiedMsrp(extracted);
    await applyVerifiedFuelType(extracted);

    // ---- Step 3: Assemble the analysis in the exact shape App.jsx renders ----
    const analysis = buildAnalysis(extracted, msrpLookup);
    await applyVerifiedWarranty(analysis);
    analysis.vinCheck = validateVin(analysis.vin);
    if (analysis.year && analysis.make && analysis.model) {
      analysis.recalls = await lookupRecalls(analysis.year, analysis.make, analysis.model);
    }
    computeFinancingCheck(analysis);
    computeOdometerCheck(analysis);
    computeLeverageScore(analysis);

    return new Response(JSON.stringify({ analysis }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("analyze-quote error:", err);
    return new Response(JSON.stringify({ error: "Something went wrong processing that file." }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});

// Looks up msrp_catalog for the exact year/make/model/trim, relaxing the
// match step by step. Never throws -- if the table is empty or missing
// (e.g. before the VinAudit backfill has run), every quote just falls back
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
// below, extended with a fuel_type column) -- one VinAudit/Black Book
// backfill populates both. Matches on year+make+model only (not trim),
// since fuel type is a model-level fact for the overwhelming majority of
// vehicles, not a trim-level one.
//
// Mutates extracted.fuelType in place and sets fuelTypeVerified -- falls
// back to whatever Claude read off the document when there's no catalog
// match, which is every case right now since the catalog has no rows
// until the VinAudit backfill runs (pending, September). Never throws,
// never blocks the report.
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

async function lookupVerifiedMsrp(extracted: any) {
  const { year, make, model, trim } = extracted || {};
  if (!year || !make || !model) {
    return { value: null, matchType: "insufficient_data" };
  }

  try {
    if (trim) {
      const { data: exact } = await supabase
        .from("msrp_catalog")
        .select("msrp, trim, fetched_at")
        .eq("year", year)
        .ilike("make", make)
        .ilike("model", model)
        .ilike("trim", trim)
        .not("msrp", "is", null)
        .limit(1)
        .maybeSingle();

      if (exact?.msrp) {
        return { value: exact.msrp, matchType: "exact", trim: exact.trim, fetchedAt: exact.fetched_at };
      }

      const { data: fuzzy } = await supabase
        .from("msrp_catalog")
        .select("msrp, trim, fetched_at")
        .eq("year", year)
        .ilike("make", make)
        .ilike("model", model)
        .ilike("trim", `%${trim}%`)
        .not("msrp", "is", null)
        .limit(1)
        .maybeSingle();

      if (fuzzy?.msrp) {
        return { value: fuzzy.msrp, matchType: "fuzzy_trim", trim: fuzzy.trim, fetchedAt: fuzzy.fetched_at };
      }
    }

    // Same year/make/model, any trim -- lowest MSRP as an approximate floor
    const { data: modelOnly } = await supabase
      .from("msrp_catalog")
      .select("msrp, trim, fetched_at")
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

// ── Verification checks, shared byte-for-byte with the listing path so an
// uploaded quote gets the same 10-point treatment as a pasted URL. Each is
// self-contained and unit-tested on the listing side. ──────────────────────

// VIN pattern validity (ISO 3779 check digit + format rules). Deterministic.
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
    present: true, valid, vin,
    reason: valid
      ? "VIN check digit validates -- the number is internally consistent."
      : `VIN check digit doesn't validate (position 9 is "${actual}", should be "${expected}") -- likely a typo or transposed character. Worth confirming the exact VIN with the dealer.`,
  };
}

// HTTP (not HTTPS) on purpose: the Supabase edge runtime (Deno) does not
// trust data.tc.gc.ca's Government-of-Canada TLS certificate ("invalid peer
// certificate: UnknownIssuer"), so an https fetch fails at connect time. The
// endpoint serves the same JSON over plain http with no redirect, which
// avoids the cert problem. Confirmed 2026-07-22.
const TC_VRDB_BASE = "http://data.tc.gc.ca/v1.3/api/eng/vehicle-recall-database";
const TC_RECALLS_PAGE = "https://tc.canada.ca/en/road-transportation/defects-recalls-vehicles-tires-child-car-seats";
function tcRecordToObj(record: any[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (const f of record || []) { if (f?.Name) o[f.Name] = f?.Value?.Literal ?? ""; }
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
  } finally { clearTimeout(timer); }
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
    if (byNumber.size === 0) return { checked: true, count: 0, items: [], source: "Transport Canada VRDB", sourceUrl: TC_RECALLS_PAGE };
    const nums = Array.from(byNumber.keys()).slice(0, 8);
    const items = await Promise.all(nums.map(async (num) => {
      const detRes = await tcFetchJson(`${TC_VRDB_BASE}/recall-summary/recall-number/${encodeURIComponent(num)}?format=json`, 12000);
      const o = detRes.ok && detRes.data?.ResultSet?.[0] ? tcRecordToObj(detRes.data.ResultSet[0]) : {};
      const comment = (o["COMMENT_ETXT"] || "").replace(/\s+/g, " ").trim();
      return {
        recallNumber: num, date: byNumber.get(num)!.date,
        system: o["SYSTEM_TYPE_ETXT"] || null,
        unitsAffected: o["UNIT_AFFECTED_NBR"] ? Number(o["UNIT_AFFECTED_NBR"]) : null,
        summary: comment ? comment.slice(0, 400) : null,
      };
    }));
    return { checked: true, count: byNumber.size, items, source: "Transport Canada VRDB", sourceUrl: TC_RECALLS_PAGE };
  } catch (err) { console.warn("lookupRecalls threw:", err); return { checked: false }; }
}

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

function computeLeverageScore(analysis: any): void {
  const basis: string[] = [];
  let score = 2.0;
  const msrp = Number(analysis.msrp) || null;
  const quoted = Number(analysis.quotedPrice) || null;
  if (msrp && quoted) {
    const deltaPct = (quoted - msrp) / msrp;
    if (deltaPct > 0.005) { score += Math.min(2.5, deltaPct * 100 * 0.3); basis.push(`priced $${Math.round(quoted - msrp).toLocaleString()} over MSRP`); }
    else if (deltaPct < -0.02) { score -= 1.0; basis.push(`already priced below MSRP`); }
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

  const verifiedMsrp = msrpLookup.value ?? null;
  const msrp = verifiedMsrp ?? statedMsrpOnDocument ?? null;

  const msrpSource = verifiedMsrp
    ? (msrpLookup.matchType === "exact" ? "verified" : "verified_approximate")
    : (statedMsrpOnDocument ? "dealer_stated" : "unavailable");

  const mismatch =
    verifiedMsrp != null &&
    statedMsrpOnDocument != null &&
    Math.abs(statedMsrpOnDocument - verifiedMsrp) / verifiedMsrp > 0.02;

  let summary = extracted.summary || "";
  if (mismatch) {
    const direction = statedMsrpOnDocument > verifiedMsrp ? "higher" : "lower";
    summary +=
      (summary ? " " : "") +
      `Also worth flagging: this quote lists MSRP as $${statedMsrpOnDocument.toLocaleString()}, but the verified manufacturer MSRP for this trim is $${verifiedMsrp.toLocaleString()} -- ${direction} than what's shown.`;
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
      source: msrpSource, // "verified" | "verified_approximate" | "dealer_stated" | "unavailable"
      verifiedValue: verifiedMsrp,
      statedOnDocument: statedMsrpOnDocument ?? null,
      mismatch,
      matchedTrim: msrpLookup.trim ?? null,
      verifiedAsOf: msrpLookup.fetchedAt ?? null,
    },
  };
}