// Where is this visitor, and prove it to the server.
//
// Vercel terminates the connection, so it is the only part of the stack that
// actually sees the client IP and can resolve it. It hands the browser a
// verdict plus a short-lived HMAC token; the browser passes that token to the
// analyze functions, which verify it. The browser is never trusted to state its
// own province — the analyze functions spend real vendor money, and a claim
// anyone can type is not a gate.
//
// Reads the raw x-vercel-ip-* headers rather than importing @vercel/functions,
// matching api/track-visit.js, which does the same for the same reason.
//
// NO PII IS RETURNED OR SIGNED. Country and region only — no IP, no city, no
// coordinates. The token payload is "country|region|exp" and nothing else.
export const config = { runtime: "edge" };

import { evaluateRegion, signRegionToken, regionName } from "../supabase/functions/_shared/region-gate.js";

export default async function handler(req) {
  const country = req.headers.get("x-vercel-ip-country");
  const region = req.headers.get("x-vercel-ip-country-region");

  const verdict = evaluateRegion({ country, region });

  // Without a secret the gate cannot be enforced server-side. Say so in the
  // response rather than pretending — a gate that silently does nothing is
  // worse than no gate, because you stop looking at it.
  const secret = process.env.REGION_TOKEN_SECRET || "";
  let token = null;
  if (secret) {
    try {
      token = await signRegionToken({ country, region, secret });
    } catch (e) {
      console.error("region token signing failed:", e?.message);
    }
  }

  return new Response(JSON.stringify({
    country: country || null,
    region: region || null,
    regionLabel: regionName(country, region),
    served: verdict.served,
    reason: verdict.reason,
    enforced: !!token,
    token,
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // Per-visitor and short-lived: a cached verdict would hand one visitor's
      // province to the next.
      "Cache-Control": "private, no-store",
    },
  });
}
