// supabase/functions/get-dealer-sentiment/index.ts
//
// Standalone function, deliberately decoupled from analyze-quote and
// analyze-listing-url: dealer reputation isn't tied to a specific quote
// or listing, it's a property of the DEALER. The frontend calls this
// separately once analysis.dealerName is known (from EITHER analysis
// path -- a PDF quote or a listing URL), and the result is cached per
// dealer so 50 different buyers checking the same dealer costs one
// Google Places lookup, not 50. The "reviews" field lives in Places API
// (New)'s Enterprise + Atmosphere SKU ($25/1,000 requests, only 1,000
// free/month as of this writing), so this caching is a real cost
// control, not just an optimization.
//
// Per Vic's decision (2026-07-21): this stays entirely free/buyer-facing,
// always. It never becomes a paid dealer product -- a dealer paying
// LotCheck to see or influence their own summary would undercut the
// whole buyer-first positioning the platform is built on.
//
// Requires three secrets on this function:
// - GOOGLE_PLACES_API_KEY (Google Cloud project, Places API (New)
//   enabled, key restricted to that one API)
// - ANTHROPIC_API_KEY (same key already used by the other two functions)
// - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (for the cache table --
//   these are auto-provided in every Supabase edge function, not a
//   separate secret you need to add)
//
// Fails soft everywhere: this is a progressive-enhancement card, not
// core to the report. A buyer should never see an error because reviews
// couldn't be fetched -- worst case, the card just doesn't render, same
// as the Payment Breakdown card when financing data isn't present.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GOOGLE_PLACES_API_KEY = Deno.env.get("GOOGLE_PLACES_API_KEY");
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const CLAUDE_MODEL = "claude-sonnet-5";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// How long a cached dealer lookup stays valid before refreshing from
// Google again. Dealer reputation doesn't meaningfully shift day to day,
// so this is set generously to minimize Enterprise+Atmosphere calls --
// even a dealer checked by buyers every single day costs at most ~12
// Google lookups/year, not one per buyer.
const CACHE_TTL_DAYS = 30;

const SENTIMENT_SYSTEM_PROMPT = `You are reading a sample of public Google reviews for a Canadian car dealership, for a car-buying verification platform (LotCheck) that shows this directly to buyers researching where to shop.

You are typically given around 5 reviews total -- that's a hard ceiling from the Google Places API itself, not something you can ask for more of. Produce 6 to 8 short, specific highlights drawn from that sample. It's fine and expected to draw MORE THAN ONE highlight from the same review if it genuinely contains multiple distinct, quotable observations (e.g. one review might mention both a specific staff member's name AND a specific financing detail -- those can be two separate highlights). Do not force exactly one highlight per review; that's often impossible with only ~5 to work with. Each highlight needs:
- "rating": the star rating (1-5) of the SPECIFIC review this highlight is drawn from -- must be a real rating from that review, not a guess or an average.
- "text": a short (under 140 characters), specific, concrete observation from that review -- a name, a specific situation, a specific complaint or praise. Not generic filler ("great service!", "very happy").

Ground rules:
- Reflect the actual rating distribution of the reviews you were given, honestly. If the sample you received genuinely is all 4-5 star, that IS the honest answer -- do not invent a lower-rated highlight to manufacture the appearance of balance, and do not suppress a real negative one either. You're reporting what's there, not engineering a target mix.
- For anything critical or disputed, attribute it to what the review says rather than stating it as settled fact -- e.g. "a review describes a dispute over..." not "this dealer did X." You are relaying a reviewer's claim, not confirming it happened.
- Do not fabricate details, names, or specifics that aren't in the actual review text provided to you.
- If the review sample is too small to responsibly produce 6-8 distinct highlights without repeating the same observation twice, return fewer rather than pad -- quality over hitting a target count.
- Prioritize highlights that would actually help someone deciding whether to buy from or service with this dealer -- financing/pricing transparency, communication, honesty about vehicle condition, pressure tactics (or lack thereof), service department follow-through -- over generic pleasantries, when a review offers a choice between the two.

Your entire response must be nothing but the JSON array itself. Do not think out loud, show a draft, self-correct visibly, or add any text before or after it -- output only the final array as your first and only content. Do not wrap it in a markdown code fence (no triple backticks, no "json" language tag) -- just the raw array characters, starting with [ and ending with ].

Return ONLY a JSON array, nothing else, in this exact shape:
[{"rating": number, "text": string}, ...]`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (!GOOGLE_PLACES_API_KEY || !ANTHROPIC_API_KEY) {
    console.error("GOOGLE_PLACES_API_KEY or ANTHROPIC_API_KEY is not set on this function.");
    return new Response(
      JSON.stringify({ error: "Dealer sentiment isn't configured yet." }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }

  try {
    const { dealerName, dealerCity } = await req.json();
    if (!dealerName || typeof dealerName !== "string") {
      // Not an error -- plenty of quotes/listings won't have a clean
      // dealer name extracted. Just no card for this one.
      return new Response(
        JSON.stringify({ dealerSentiment: null }),
        { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const cacheKeyName = dealerName.trim().toLowerCase();
    const cacheKeyCity = (dealerCity || "").trim().toLowerCase();

    // 1. Check the cache first -- this is the entire cost-control
    // mechanism. A hit here means zero Google Places calls at all.
    const { data: cached, error: cacheReadErr } = await supabase
      .from("dealer_sentiment_cache")
      .select("*")
      .eq("dealer_name_key", cacheKeyName)
      .eq("dealer_city_key", cacheKeyCity)
      .maybeSingle();

    if (cacheReadErr) {
      // Table might not exist yet, or some other read issue -- log it
      // but don't fail the request over it. Worst case we just always
      // do a fresh lookup (correct, just not cost-optimized) until the
      // table exists.
      console.error("dealer_sentiment_cache read failed:", cacheReadErr.message);
    }

    if (cached) {
      const ageMs = Date.now() - new Date(cached.refreshed_at).getTime();
      const freshEnough = ageMs < CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
      if (freshEnough) {
        return new Response(
          JSON.stringify({
            dealerSentiment: {
              dealerName: cached.display_name || dealerName,
              rating: cached.rating,
              reviewCount: cached.review_count,
              highlights: cached.themes || [],
              sourceUrl: cached.source_url,
            },
          }),
          { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
        );
      }
    }

    // 2. Text Search (New) -- find the actual place. Essentials-tier
    // fields only here (no "reviews"), so this step is cheap no matter
    // what happens next.
    const searchQuery = `${dealerName} ${dealerCity || ""} car dealership`.trim();
    const searchRes = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.rating,places.userRatingCount,places.googleMapsUri",
      },
      body: JSON.stringify({ textQuery: searchQuery }),
    });

    if (!searchRes.ok) {
      console.error("Places Text Search failed:", searchRes.status, await searchRes.text());
      return new Response(
        JSON.stringify({ dealerSentiment: null }),
        { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const searchData = await searchRes.json();
    const place = searchData.places?.[0];
    if (!place?.id) {
      console.log(`No Places match for dealer lookup: "${searchQuery}"`);
      return new Response(
        JSON.stringify({ dealerSentiment: null }),
        { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    // 3. Place Details (New) with the "reviews" field -- this is the
    // request that actually bills at the Enterprise + Atmosphere SKU.
    // Everything above this point in the function is cheap
    // Essentials-tier usage.
    // NOTE (2026-07-22): a `?reviewsSort=NEWEST` query param used to be on
    // this URL, but the Places API (New) rejects it with a hard 400
    // ("Unknown name reviewsSort: Cannot bind query parameter"), which made
    // EVERY dealer lookup fail here and silently return no card. The New API
    // doesn't take review sorting as a query param, so it's removed --
    // reviews come back in Google's default (most-relevant) order.
    const detailsRes = await fetch(
      `https://places.googleapis.com/v1/places/${place.id}`,
      {
        headers: {
          "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
          "X-Goog-FieldMask": "id,displayName,rating,userRatingCount,googleMapsUri,reviews",
        },
      },
    );

    if (!detailsRes.ok) {
      console.error("Places Details failed:", detailsRes.status, await detailsRes.text());
      return new Response(
        JSON.stringify({ dealerSentiment: null }),
        { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const details = await detailsRes.json();

    // Diagnostic: the first real test returned empty themes with rating/
    // reviewCount populated correctly, which means either Google genuinely
    // returned zero reviews for this place, or reviews came back in a
    // shape this code isn't reading. Rather than guess, log the actual
    // shape so the next test run tells us the real answer.
    console.log(
      `Place Details fetched for "${dealerName}": rating=${details.rating}, ` +
        `userRatingCount=${details.userRatingCount}, ` +
        `reviews=${details.reviews ? `array of ${details.reviews.length}` : "MISSING (undefined/null)"}, ` +
        `topLevelKeys=${Object.keys(details).join(",")}`,
    );
    if (details.reviews?.[0]) {
      console.log(`First review raw shape: ${JSON.stringify(details.reviews[0]).slice(0, 500)}`);
    }

    const reviews: Array<{ rating?: number; text?: { text?: string } }> = details.reviews || [];

    let highlights: Array<{ rating: number; text: string }> = [];
    let parseFailed = false;

    if (reviews.length > 0) {
      const reviewBlock = reviews
        .map((r, i) => `Review ${i + 1} (${r.rating ?? "?"}★): ${r.text?.text ?? ""}`)
        .join("\n\n");

      const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 500,
          system: SENTIMENT_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: `Dealership: ${details.displayName?.text || dealerName}\n\n${reviewBlock}`,
            },
          ],
        }),
      });

      if (claudeRes.ok) {
        const claudeData = await claudeRes.json();
        const rawText = claudeData.content?.[0]?.text ?? "[]";

        // Two distinct failure modes confirmed in real testing so far:
        // (1) Claude self-narrates a correction mid-response (a bad
        //     draft, then "Wait, formatting.", then the real array), and
        // (2) Claude wraps the array in a markdown code fence
        //     (```json ... ```) despite being told not to.
        // Rather than chase every future formatting quirk with a prompt
        // tweak alone, this extraction is layered to survive both: strip
        // a code fence if present, then try blank-line-separated chunks
        // (handles self-correction, where the good version comes last),
        // then fall back to the whole remaining text.
        const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        const unfenced = fenceMatch ? fenceMatch[1] : rawText;

        const candidates = unfenced
          .split(/\n\s*\n/)
          .map((c: string) => c.trim())
          .filter(Boolean);
        let parsed: Array<{ rating: number; text: string }> | null = null;
        for (const candidate of candidates) {
          try {
            const attempt = JSON.parse(candidate);
            if (Array.isArray(attempt)) parsed = attempt;
          } catch {
            // Not a valid JSON chunk on its own -- likely narration text
            // like "Wait, formatting." Keep checking later chunks.
          }
        }
        // Fall back to parsing the whole fence-stripped text, for the
        // common case where there were no blank-line breaks at all.
        if (parsed === null) {
          try {
            const attempt = JSON.parse(unfenced);
            if (Array.isArray(attempt)) parsed = attempt;
          } catch {
            // Still nothing -- try the completely untouched original
            // text too, in case the fence regex above did more harm
            // than good for some response shape not yet seen.
            try {
              const attempt = JSON.parse(rawText);
              if (Array.isArray(attempt)) parsed = attempt;
            } catch {
              // Genuinely unparseable -- falls through to parseFailed.
            }
          }
        }

        if (parsed !== null) {
          highlights = parsed;
        } else {
          console.error("Couldn't parse sentiment highlights JSON from any candidate:", rawText);
          parseFailed = true;
        }
      } else {
        console.error("Claude sentiment call failed:", claudeRes.status, await claudeRes.text());
        parseFailed = true;
      }
    }

    const result = {
      dealerName: details.displayName?.text || dealerName,
      rating: details.rating ?? null,
      reviewCount: details.userRatingCount ?? null,
      highlights,
      sourceUrl: details.googleMapsUri ?? null,
    };

    // 4. Refresh the cache so the next buyer who checks this same
    // dealer (name+city) gets an instant, free hit instead of a repeat
    // Google Places call. Deliberately skipped when parseFailed is true
    // -- a transient Claude API or parsing failure shouldn't get baked
    // in as this dealer's "answer" for the next 30 days. Reviews.length
    // === 0 (genuinely no reviews on this listing) is a different,
    // legitimate thing to cache; only an actual failure is excluded.
    if (!parseFailed) {
      const { error: cacheWriteErr } = await supabase.from("dealer_sentiment_cache").upsert(
        {
          dealer_name_key: cacheKeyName,
          dealer_city_key: cacheKeyCity,
          display_name: result.dealerName,
          place_id: place.id,
          rating: result.rating,
          review_count: result.reviewCount,
          themes: result.highlights,
          source_url: result.sourceUrl,
          refreshed_at: new Date().toISOString(),
        },
        { onConflict: "dealer_name_key,dealer_city_key" },
      );
      if (cacheWriteErr) {
        // Non-fatal -- worst case this dealer gets looked up fresh again
        // next time instead of hitting cache. Still return the good
        // result we just fetched.
        console.error("dealer_sentiment_cache write failed:", cacheWriteErr.message);
      }
    } else {
      console.log(`Skipping cache write for "${dealerName}" -- sentiment summarization failed this run.`);
    }

    return new Response(
      JSON.stringify({ dealerSentiment: result }),
      { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("get-dealer-sentiment error:", err);
    return new Response(
      JSON.stringify({ dealerSentiment: null }),
      { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
});