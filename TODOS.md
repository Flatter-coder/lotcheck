# TODOS

Deferred work, grouped by component, P0 (urgent) → P4 (someday). Items land here
from /ship pre-landing reviews with enough context to act without the original
conversation. Completed items move to the bottom with the shipping date.

## Sealed listing capture (email-quote-report)

### Extract verifySealedShot to _shared and test every deny path
**Priority:** P1
The forged-evidence chain (SHA-256 recompute → ECDSA verify → canonical.shot
match → reportId binding) lives un-exported inside the Deno handler
(supabase/functions/email-quote-report/index.ts), so no node gate covers it —
a regression that returns the shot on a failed check would ship silently.
Move it (plus b64urlToBytes/maybeGunzip) into supabase/functions/_shared/
capture.ts with the key registry as a parameter, then pin in capture.test.ts:
accept on the full chain; null on bad signature, wrong shot hash, wrong
reportId (cross-report splice), unknown keyId, corrupt gzip, oversize gzip.
Node 20+ has WebCrypto + DecompressionStream, so the tests are pure node.
Noticed on branch design/alberta-previews (ship review, 2026-08-12).

### Dedupe b64urlToBytes (3 copies) and the PDF pagination arithmetic (3 sites)
**Priority:** P2
b64urlToBytes is byte-identical in email-quote-report/index.ts,
_shared/report-sign.ts, and src/App.jsx — a padding-handling divergence would
break signature verification on one path only. The capture page-slice
arithmetic (2 pt tolerance) is mirrored in capturePageCount, the render loop,
and the truncation check. Export one b64 helper from _shared, and one
capturePageSlices(scaledH,u0,uR,max) that both the count and the loop consume.

### Rate-limit + idempotency-key the email endpoint
**Priority:** P1
The endpoint is CORS-*, unauthenticated, no rate limit, no Resend
Idempotency-Key: any script can bulk-send LotCheck-branded DKIM-signed email
(quota + domain-reputation burn), and a mid-send timeout plus client retry
sends duplicates. Add per-IP/per-address limits at the edge and a
deterministic idempotency key (e.g. sha256(email+reportId+day)).

## CI / deploys

### Gate Vercel deploys on the CI gates check
**Priority:** P2
deploy-edge-functions.yml has needs:gates, but Vercel deploys the client half
(App.jsx, public/) regardless of a red gates.yml run — the two halves of the
sealed-capture feature can go live out of sync in exactly the failure case the
gate exists for. Wire Vercel deployment protection / required checks (or an
Ignore Build Step querying the commit's check runs).

### Adopt a VERSION/CHANGELOG scheme
**Priority:** P3
The repo has no VERSION file or CHANGELOG.md; PRs ship unversioned. Adopting
gstack's 4-digit scheme would give release provenance and let /ship pin PR
titles to versions. Decision + backfill, not urgent.

## Price index (/live-price-index)

### Extract the band math to a testable module
**Priority:** P1
shareBetween / apportion / bandCounts (percentile-curve → histogram bands with
largest-remainder fitting) are embedded in public/live-price-index.html where
no node gate can import them — and this exact math class already shipped one
mis-count (327 vs the RPC's exact 298) before being fixed. Move to a small
public/ module the page loads (like _lpi-3d.js), then add a pure-node gate:
apportion sums exactly to total; sum<=0 routes to the at-band; shareBetween
handles n<2 and flat segments; makeMedians drops makes under 5 trims.

## Site-wide

### Nav touch targets under 44px
**Priority:** P3
.theme-toggle (58x29) and .sn-analyze (~32px tall) are under the 44px touch
minimum on every page that shares the sitenav (index, alberta,
live-price-index, app routes). Fix once in the shared nav styling — a
transparent hit-area extension keeps the visual size.

## Completed
