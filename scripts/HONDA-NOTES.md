# Honda Canada scraper — reconnaissance (not built yet)

Honda.ca is **not** the Toyota/Lexus AEM stack — it's a Sitecore-based React SPA
(axios), so it needs its own scraper. This is what's mapped so far; a dedicated
pass should finish it before wiring `make='Honda'` into the catalog tables.

## Entry point
- Build & Price: `https://www.honda.ca/en/buildyourhonda`
- Model landing links use a `model_key` scheme, e.g.
  `/en/buildyourhonda/trims?model_key=civic_sedan&model_year=2026&payment_method=finance&term_and_rate=60&payment_frequency=monthly&down_payment=0`
- Model keys seen: `civic_sedan`, `civic_sedan_si`, `civic_hatchback`, `prelude`, …

## Known API (Sitecore DMM)
- Trims: `GET https://www.honda.ca/dmmapi/trimswithtransmissions/model/{MODEL_GUID}/{year}?sc_apikey={KEY}&sc_site=Honda&sc_lang=en`
  - `sc_apikey` is public, embedded in the SPA JS: `B96772C4-CDA7-4E6F-BD37-7F9A36FF3E18` (re-scrape from the page in case it rotates).
  - Civic Sedan GUID: `EB3EA79BE74C42079D45B0D6636C81D3`.
  - Returns a deep Sitecore content tree (~546 KB) with `trimName.value` ("LX"),
    `financeBonusOffers` / `leaseBonusOffers`, `defaultLeasePaymentTerm`, etc.
  - **Does NOT contain MSRP or APR numbers** — zero price-like values in the payload.

## Pricing endpoint — FOUND (in the JS bundle, needs a captured POST body)
The trims payload has NO prices; Honda computes them via a payment-calculator
API. Endpoint templates pulled from `npm.honda-canada.*.js`:
- `POST /mcpe-payment-calculator` — the payment/price calculator engine.
- `/buildandprice/calculator/summary` and `/hydrateFromCalculator`.
Response field names present in the bundle: `msrp`, `msrpPrice`, `sellingPrice`
(incl. Freight/PDI/levies/dealer fees), `sellingPriceWithDiscount`, `msrpMarkup`.
Next step: in the browser, complete a build to the Summary step (with a province/
postal set) and capture the `/mcpe-payment-calculator` POST — record its request
body shape, then replay it per trim+province. That body is the last unknown.

## Still to find
1. **`model_key` → `MODEL_GUID` map** — a `/dmmapi/...` models list (the build
   landing `/en/buildyourhonda` references it). Other dmmapi endpoints seen:
   `/dmmapi/trimandcolors/transmission/{id}`, `/dmmapi/inventory/recommendedvehicles`.
2. **The `/mcpe-payment-calculator` POST body** (see above).
3. Sitecore field parsing: every value is wrapped as `{ "value": ... }`.

## Target output (same as Toyota/Lexus, see scripts/lib/tci-stack.mjs)
- `msrp_catalog`: {year, make:"Honda", model, trim, msrp, fuel_type, fetched_at}
- `finance_rate_catalog`: {make, model, apr, term_months, promo, effective_date}
- `lease_rate_catalog`: {make, model, apr, term_months, annual_km, effective_date}

Note Honda's default Selling Price bundles Freight/PDI + fees; capture the
**MSRP-only** figure (the page exposes an "MSRP-only Price" toggle) so the
catalog stores true MSRP, not the all-in selling price.
