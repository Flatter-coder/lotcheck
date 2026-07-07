// Vercel Edge Function: /api/track-visit
//
// Records a page view, same as the old direct client-side Supabase insert
// did -- but this version also captures real visitor geolocation (city,
// country, lat/long), which the browser itself has no way to see. Vercel's
// Edge Network sets this as request headers automatically on every
// deployment, for free, as a standard platform feature -- no third-party
// geolocation service needed.
//
// Reads the raw x-vercel-ip-* headers directly rather than importing the
// @vercel/functions package's geolocation() helper -- that package isn't a
// listed dependency in this project (only @vercel/analytics is), and adding
// it caused the very first deploy of this function to fail the build with
// an unresolved-import error. Reading the headers directly needs zero new
// dependencies; confirmed these exact header names directly against
// Vercel's own open-source code for the geolocation() helper, which does
// exactly this internally: x-vercel-ip-city, x-vercel-ip-country,
// x-vercel-ip-latitude, x-vercel-ip-longitude.
//
// The browser still computes visitor_id, path, and referrer_source (since
// those genuinely are only knowable client-side) and sends them here; this
// function adds the location data server-side and does the actual database
// write, so the Supabase write moves from client-side to server-side too.

export const config = { runtime: "edge" };

const SUPABASE_URL = "https://debigtyjhjamipooajhk.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlYmlndHlqaGphbWlwb29hamhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NjQ4OTEsImV4cCI6MjA5ODQ0MDg5MX0.PujrRSJA_CWQKEtzGLtbAwk2Uq6VZAJDKEyS56exP9A";

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  try {
    const body = await req.json();
    const city = req.headers.get("x-vercel-ip-city");
    const country = req.headers.get("x-vercel-ip-country");
    const lat = req.headers.get("x-vercel-ip-latitude");
    const lon = req.headers.get("x-vercel-ip-longitude");

    const row = {
      visitor_id: body.visitor_id || "unknown",
      path: body.path || "/",
      referrer_source: body.referrer_source || "Direct",
      // City names are sent URI-encoded to support multi-byte characters
      // (accented city names, etc.) -- decode before storing.
      city: city ? decodeURIComponent(city) : null,
      country: country || null,
      latitude: lat ? parseFloat(lat) : null,
      longitude: lon ? parseFloat(lon) : null,
    };

    const res = await fetch(`${SUPABASE_URL}/rest/v1/page_views`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        "Prefer": "return=minimal",
      },
      body: JSON.stringify(row),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("page_views insert failed:", res.status, errText);
      // Still respond 200 -- this is fire-and-forget tracking from the
      // visitor's perspective, matching the old client-side behavior where
      // a failed insert never affected the actual site experience.
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("track-visit error:", err);
    return new Response(JSON.stringify({ ok: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}
