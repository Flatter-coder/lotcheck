# BMW scraper — SHIPPED (via SM360 dealer feed)

**Solved 2026-07-27.** bmw.ca gates all prices (below), but BMW dealers on the
SM360 platform (Dilawri) expose a public inventory JSON feed with the real MSRP
AND advertised finance/lease APR. `scrape-bmw.mjs` reads Calgary BMW:
  GET https://www.calgarybmw.ca/en/new-inventory/api/listing?page=N
  -> vehicles[].{ year, make.name, model.name, trim.name, listPrice (=MSRP),
                  paymentOptions.finance.term.{term,apr}, paymentOptions.lease.term.{term,apr,kmPerYearPlan} }
listPrice == salePrice for BMW (no discounting) = clean MSRP. We keep the LOWEST
listPrice per (year,model,trim) as the starting MSRP; rates are the default-term
advertised APR. Verified: 51 MSRP / 25 finance / 27 lease across 25 models
(X1-X7, 2/3/4/5/7/8-Series, M-cars, i4/i5/iX, X5 PHEV, Alpina XB7). Add more
SM360 BMW dealers to DEALERS[] for wider trim coverage.

---
## (historical) bmw.ca UCP recon — config open, prices identity-gated
# BMW scraper — API cracked, but prices are auth-gated

Major progress this session: the UCP API, key, model tree, and all pricing
endpoint templates are cracked. The wall is that BMW **gates the actual prices**
(base MSRP + finance/lease) behind an authorized calculation the public config
key can't reach. Config structure is open; prices are not.

## Verified WORKING (Node fetch; key `OmFpaEFpV0VUaUlrWTJ2Tnp0ZGdiUTd1NDhxR3JOcHRacXg1UWQK`)
- Effect date: `GET /pricing/metadata/price-lists/pcaso,con/brands/bmwCar/countries/ca` → `pcasoVersion.date` (e.g. 2026-07-23).
- **Full model tree**: `GET /model-matrices/vehicle-trees/connext-bmw/sources/pcaso/brands/bmwCar/countries/ca/effect-dates/{date}/order-dates/{date}`
  → series (2/3/4/5/7/M/X) → modelRanges (`code` = G20/G70/…) → `models:{ "{typeCode}": {…} }`.
  **53 type codes** enumerated (e.g. 2620/G42, 2622/G87). typeCode is the `modelCode` for pricing.
- Package option prices: `GET /pricing/calculation/public-calculation/price-lists/pcaso,con/brands/bmwCar/countries/ca/models/{modelCode}/tax-dates/{date}/package-pricing` → `packagePricingList` (0 for a base config).
- Accessory prices: `GET /pricing/price-lists/pcaso,con/brands/bmwCar/countries/ca/effect-dates/{date}/models/{modelCode}/available-accessories`.

Settings source: `configure.bmw.ca/en_CA/settings.6a60a85a.json` (host `prod.ucp.bmw.cloud`,
`source=pcaso`, `channel=con`, `brand=bmwCar`, `country=ca`, `priceTree=default-fsm-2`,
`vehicleTree=connext-bmw`). Path templates live in `configure.bmw.ca/js/index.{hash}.js`.

## The WALL — prices are gated
- **Base vehicle MSRP** is NOT a plain field. The config app composes it; the plain
  `/models/{modelCode}` and `…/options`, `…/prices` paths all return 403
  **"Missing Authentication Token"** (wrong route). available-accessories/package-pricing
  carry only option/accessory prices, not the base vehicle price.
- **Finance/lease + total price** = `POST /pricing/calculation/retail-calculation/price-lists/pcaso,con/brands/bmwCar/countries/ca`
  with body `{settings:{priceTree,ignoreInvalidOptionCodes,ignoreOptionsWithUndefinedPrices},
  validityDates:{effectDate}, configuration:{model, selectedOptions:[], availableOptions:[]},
  selectedAccessories:[], roundingScale}`. With the config key → **403 "User is not authorized
  to access this resource"**. Other keys in settings → 401. So the base price AND the payments
  both live behind retail-calculation, which needs a pricing/financing scope the public key lacks.

## To finish (dedicated)
Capture the real base-price/retail-calculation request from the running config app
(it displays prices, so it reaches them) — likely a bearer token or an authorized
key beyond the static settings. The app's pricing runs in a context that didn't
surface to browser network tools (cross-origin/iframe); a deeper in-frame hook or a
different capture is needed. Everything up to the price call is solved and replayable via Node.
