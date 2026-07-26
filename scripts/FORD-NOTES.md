# Ford / Lincoln scraper — reconnaissance (endpoint found, header-gated)

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
