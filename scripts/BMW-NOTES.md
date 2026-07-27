# BMW scraper — reconnaissance (API + key verified; multi-step, vehicleTree gated)

BMW runs the global "UCP" (Unified Configurator Platform). The API host and key
work from Node, but pricing is a multi-step parameterized flow and the per-model
`vehicleTree` lookup is the remaining blocker. This is a dedicated build (~half day).

## Verified working
- Host: `https://prod.ucp.bmw.cloud` (AWS API Gateway).
- Auth header: `x-api-key: OmFpaEFpV0VUaUlrWTJ2Tnp0ZGdiUTd1NDhxR3JOcHRacXg1UWQK` (from configure.bmw.ca settings.6a60a85a.json).
- **Node fetch reaches it; curl is Akamai-walled** on the www/configure hosts.
- Proven call: `GET /pricing/metadata/price-lists/pcaso,con/brands/bmwCar/countries/ca`
  → `{ pcasoVersion:{ version, date:"2026-07-23", exportTo } }`. Use `date` as the effect-date.
- Wrong paths return `403 {"message":"Missing Authentication Token"}` (API-Gateway "no such route"), so paths must be EXACT.

## Model list (captured from bmw.ca/en/configurator.html)
Model codes: G20 G22 G23 G26 G42 G45 G60 G70 G80 G82 G83 G87 G90 G99 G05 G06 G07 G09
F74 F96 I20 U10 U11 NA5 G65. Configure URLs: `configure.bmw.ca/en_CA/configure/{modelCode}/{typeCode}`
(e.g. `/G70/2771`, `/G60/2753`, `/I20/26I0`). typeCode = the specific model variant.

## Endpoint templates (from the configure.bmw.ca/js/index.*.js bundle, per recon)
Standard params: `source=pcaso`, `brand=bmwCar`, `country=ca`, `channel=con`, `application=connext`, `priceTree=default-fsm-2`.
- Model bootstrap: `/model-matrices/vehicle-trees/{10-char-tree}/sources/pcaso/brands/bmwCar/countries/ca/effect-dates/{yyyy-MM-dd}/order-dates/{yyyy-MM-dd}`
- Price list (MSRP): `/pricing/price-lists/pcaso,con/brands/bmwCar/countries/ca/effect-dates/{yyyy-MM-dd}/models/{modelCode}/...`
- Config MSRP breakdown: `/pricing/calculation/public-calculation/price-lists/pcaso,con/brands/bmwCar/countries/ca/models/{modelCode}/tax-dates/{date}/package-pricing`
- Finance/lease: `POST /pricing/calculation/retail-calculation/price-lists/pcaso,con/brands/bmwCar/countries/ca` (body = configured vehicle + priceTree).

## Remaining blocker + next step
1. **The 10-char `vehicleTree` per model** — needed by model-matrices. Not derivable from the modelCode/typeCode I have. It's fetched during config bootstrap.
2. The configurator SPA runs its pricing in a context the browser network tools didn't surface (cross-origin/iframe), and no `ucp.bmw.cloud` call fired within ~20s of load.
3. **Best path:** grep `configure.bmw.ca/js/index.{hash}.js` for how `vehicleTree` is resolved (likely a bootstrap/model-matrix-index call), OR drive the config app to a resolved price and capture the real request from inside its frame. Then loop models → vehicleTree → price-list (MSRP) and POST retail-calculation (finance/lease). Node replays fine.
