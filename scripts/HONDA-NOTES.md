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

## Acura = confirmed IDENTICAL platform (build both from one module)
Acura.ca loads the same shared bundle `npm.honda-canada.*.js`. Config:
- Entry: `https://www.acura.ca/en/buildyouracura`
- `sc_apikey` = `4AB8BBA7-4E98-4732-9789-FE5970B415A6`, `sc_site=Acura`, `sc_lang=en`
- Trims: `GET https://www.acura.ca/dmmapi/trimswithtransmissions/model/{GUID}/{year}?sc_apikey=…&sc_site=Acura&sc_lang=en` (verified 200; no prices, same as Honda)
- Acura model→GUID map (from JSS in the BYA page; add dashes to the 32-hex id):
  integra 146B0CEB-9FFD-42C8-B9A7-4A23DC372C18 · rdx 327E342A-31D1-4ED4-8498-02E80E862F08 ·
  tlx 859383CD-04C0-4BD0-A591-FA043ACB2A50 · zdx CD544DF1-A74F-4FE4-951A-C0928318DCBE ·
  mdx E27E93D9-23AA-45B4-9281-598D45EFA514 · adx F0A2EF93-B5C1-4716-B131-E2AA191CBF41

## Model enumeration (no dedicated endpoint) — RESOLVED
There is NO `/dmmapi/...models...` list call. Enumerate models by fetching the
Build&Price page HTML (`/en/buildyourhonda`, `/en/buildyouracura`) and parsing the
embedded Sitecore JSS objects: each `{ id: <32-hex GUID>, detKey: {value: model_key},
modelName: {value} }`. Convert the 32-hex `id` to a dashed GUID for the trims API.

## ✅ SOLVED (browser capture 2026-07-26): the real pricing API is on api.honda.ca

The build flow's Summary step POSTs to **`https://api.honda.ca/financials-worksheets/{H|A}/Live/website/calculator/payment`** (`H`=Honda, `A`=Acura). It returns per-term MSRP + APR for every PaymentOption requested — verified live (Civic Sedan LX: Finance 60mo 4.29%, Lease 60mo 3.39%, **Msrp 28440** = true MSRP, not the $30,915 selling price).

Working request body (PascalCase .NET; validated by iterating on its ModelState 400s):
```json
{ "ProvinceKey":"ON", "ModelYear":2026, "ModelKey":"civic_sedan", "TrimKey":"lx_10908",
  "TransmissionKey":"10956-CVT", "ExteriorColorKey":"nh_932msolar_reflection_silver_metallic",
  "InteriorColorKey":"bkblack_fabric_^2021_civic_sedan", "IncludeFees":true, "IncludeTaxes":false,
  "Accessories":[], "Protections":[], "ProtectionAddOns":[], "OwnerPrograms":[], "OfferKeys":[], "WarrantyKey":"",
  "PaymentOptions":[
    {"ClientRequestId":"1","PaymentMethod":"Finance","PaymentFrequency":"Monthly","Term":60,"DownPaymentAmount":0,"TradeInValueAmount":0,"TradeInOwingAmount":0,"LeaseAnnualKmAllowance":0,"LeaseAdditionalAnnualKm":0},
    {"ClientRequestId":"2","PaymentMethod":"Lease","PaymentFrequency":"Monthly","Term":60,"DownPaymentAmount":0,"TradeInValueAmount":0,"TradeInOwingAmount":0,"LeaseAnnualKmAllowance":20000,"LeaseAdditionalAnnualKm":0}
  ] }
```
Response: `PaymentOptions[].{PaymentMethod, Term, Apr, Msrp, FreightAndPdi, LeviesAndFeesTotal, PreferredPaymentAmount}`. Request one PaymentOption per (method × term) to get the whole ladder in one call. No auth key needed on api.honda.ca.

Config keys all come from the dmmapi trims JSON via `detKey.value`:
- trim → `trims[].detKey.value` ("lx_10908"); transmission → `…transmissions[].detKey.value` ("10956-CVT")
  with `defaultExteriorColor`; colours → `exteriorColors[]/interiorColors[].detKey.value`.
Models enumerated from the Build&Price page JSS (`{id GUID, detKey model_key, modelName}`). Acura: same, `/A/Live/`, apikey `4AB8BBA7-4E98-4732-9789-FE5970B415A6`, site `Acura`.

**Buildable now, no browser needed at runtime.** Remaining work is just writing the tree-parser + POST loop.

## mcpe-payment-calculator — method & body (superseded by the api.honda.ca capture above)
`POST` JSON, header `Accept-Language: en`. URL is built as
`financials-worksheets/{…}/{…}/website/mcpe-payment-calculator?AcceptLanguage=en`
(finance branch; lease/cash use `…/website/calculator/payment`). The two `{…}`
path segments are still runtime-resolved — capture ONE real POST in the browser
(drive a build to Summary) to lock the full URL. Body fields (finance branch):
`{ modelKey, modelYear, trimKey, transmissionKey, exteriorColorKey, accessories,
province, financeTerm, financeDownPayment, paymentType, includeFees, locale:"en",
useHighestTerm, offerKey, loyaltyOfferKey, warrantyKey }`. trimKey/transmissionKey/
colorKey come from the trims response. Response carries `msrp` + `sellingPrice`.
Last step before a Honda/Acura scraper is buildable: confirm the full calculator
URL + a minimal valid body returns a 200 with msrp/sellingPrice.

## Target output (same as Toyota/Lexus, see scripts/lib/tci-stack.mjs)
- `msrp_catalog`: {year, make:"Honda", model, trim, msrp, fuel_type, fetched_at}
- `finance_rate_catalog`: {make, model, apr, term_months, promo, effective_date}
- `lease_rate_catalog`: {make, model, apr, term_months, annual_km, effective_date}

Note Honda's default Selling Price bundles Freight/PDI + fees; capture the
**MSRP-only** figure (the page exposes an "MSRP-only Price" toggle) so the
catalog stores true MSRP, not the all-in selling price.
