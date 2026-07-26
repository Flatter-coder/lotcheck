# Ford / Lincoln scraper — SOLVED (MSRP), shipped

**Status:** MSRP scrapers live (`scrape-ford.mjs`, `scrape-lincoln.mjs`,
`lib/ford-stack.mjs`). The `application-id` block below is solved.

## The header (solved 2026-07-26 via browser capture)
`application-id: 07152898-698b-456e-be56-d3d83011d0a6` (Ford's public FMA client
id; a second id `4d29eabf-f4dc-4c52-b4c0-fac1f9b33532` also works). Found in the
FMA SDK bundle `www.account.ford.com/etc/fd/fma/bundle.js` (`"Application-Id":t`)
+ the clientIds embedded in the showroom page.

## Reachability: Node fetch YES, curl NO
Akamai blocks `curl` (HTTP 000) even with the header, but **Node's `fetch`**
(different TLS stack) + a real browser UA + the header returns 200. So the
scraper runs under Node. ⚠️ CI on a datacenter IP may still be Akamai-blocked —
verify when it first runs in the Action.

## MSRP (shipped)
`GET https://www.ford.ca/cxservices/products/ModelSlices.json?plantype=MSRP&make={Make}&model={Model}&year={Year}&postalCode=M5V2T6&appContext=T1&…`
→ `Response.Model.ModelSlices.ModelSlice[].{ name (trim), Pricing.MSRP }`. One
call returns all trims. `model` = Ford's marketing name (verified list in
`ford-stack.mjs`; note quirks: "Mach-E" not "Mustang Mach-E", "Super Duty").
Verified: Ford 72 MSRP rows / 11 models, Lincoln 4 models. Lincoln = same, `make=Lincoln`.

## Rates — still open (separate app)
plantype=Finance/Lease on ModelSlices returns the SAME MSRP structure — NO APR.
Finance/lease rates live in the `//shop.ford.ca/estimate-payment` app, a separate
capture. Ford/Lincoln are MSRP-only until that's done.

---
## Original recon (superseded above)

Ford + Lincoln share one platform (`shop.ford.ca/showroom` / `shop.lincolncanada.com`).
Browser capture (2026-07-26) found the real pricing endpoint on **www.ford.ca**:

```
GET https://www.ford.ca/cxservices/products/ModelSlices.json
    ?plantype=MSRP&planType=MSRP        # also Finance / Lease
    &make=Ford&model=Explorer&year=2026&trimId=st
    &paymentFrequency=monthly
    &postalCode=M5V2T6&zipcode=M5V2T6
    &appContext=T1&modelSliceDefiners=modelId&modelSliceAttributes=modelId
```
Observed live (from the showroom's pricing tiles): real calls for Mustang/Explorer/
Bronco/Ranger/F-150, each `plantype=MSRP`, with `trimId` (e.g. `darkhorse`, `st`,
`raptor`). `paymentFrequency` + `plantype=Finance|Lease` strongly imply the rate
ladder comes from the same endpoint with a different plantype.

## The blocker
The endpoint returns **HTTP 401 `'application-id' header is missing`**. The Ford
pricing widget injects an `application-id` request header that I could not extract:
it isn't in the shop.ford.ca shell bundles, and the widget appears to run in a
separate context (likely a www.ford.ca iframe/widget), so a `window.fetch` hook on
shop.ford.ca didn't see its headers. `api.foundational.ford.com/api/guest-user-profile/v1/generate-guest-guid`
also fires (guest session).

## Next step (to finish Ford/Lincoln)
Capture the `application-id` header value from a real ModelSlices request — options:
1. Find the pricing widget's own iframe/bundle on www.ford.ca and read its config.
2. Use a network panel that exposes REQUEST headers (not just response bodies) on a
   live ModelSlices call.
3. Once the header value is known, the scraper is a plain GET loop:
   enumerate models/trims (from the showroom model list) → ModelSlices `plantype=MSRP`
   for MSRP, `plantype=Finance`/`Lease` for the rate ladder, per trim + postalCode.

Lincoln = same endpoints with `make=Lincoln` on the Lincoln host.
