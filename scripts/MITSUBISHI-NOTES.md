# Mitsubishi Canada scraper — GraphQL cracked, one param short

Mitsubishi has an **open, introspectable Apollo GraphQL** with no auth and no
bot-wall — the data is all there, but landing a populated per-trim payload needs
one more param (valid vehicle code + selection.url). Close to buildable.

## Endpoint
`POST https://www-graphql.prod.mipulse.co/prod/graphql` (introspection ON;
`{"query":"{__typename}"}` → 200). Content path used by the app:
`/content/mitsubishi-motors/ca/en/buy/configure-your-mitsubishi/ngc-configurator`.
market `ca`, language/lang `en`.

## Queries (introspected, args confirmed)
- `getPaymentVehicleSelectorByModelYear(market:String!, lang:String!, path:String!, year:[String], ctas:String)`
  → `PaymentVehicleSelectorFiltered.vehicles[]` = `PaymentVehicleInfo{ vehicleName, vehicleCode, vehicleYear, MSRP, price, isActive, configuratorURL }`.
  **Returns 0 vehicles** with the ngc-configurator path — the payment selector likely wants a different (payments) `path`. Finding that path unlocks clean enumeration + MSRP.
- `getModelSelection(market!, language!, path!, selection:SelectionInput!)` → `{ title, trims[]{ name, code, price{value,displayValue} } }`.
  Runs, but: with only `selection.vehicle` it throws `updateQueryStringParameter … indexOf` (needs `selection.url`); with `selection.url` set it returns **"Vehicle not found"** for codes tried (DG, DGE, ZC, RV, OU, GM2WXTXCZL3M-NA). Needs the correct `vehicleCode` (get it from the selector query above once its path is right).
- `getOfferListByFilter(market!, lang!, path!, vehicle, offerType, year, zipCode, stateCode, datasetName)` → advertised APR/lease: `offers[]{ trimName, offerType, rate, financing, exampleTermLength, exampleDownPayment }`. This is the **rate source** (finance + lease).

`SelectionInput` fields: vehicle, year, years, code, model, url, trim, trimLine, driveType, fuelType, transmissionType, totalPrice, … (`vehicle` is required).

## Real MSRP (captured by recon, for sanity-checking a future build)
2026 RVR $24,998 · Eclipse Cross $29,798 · Outlander $36,398 · Outlander PHEV $49,998.

## To finish
1. Find the `path` that makes `getPaymentVehicleSelectorByModelYear` return vehicles (try the payments/tools content path). That gives `vehicleCode` + `configuratorURL` + MSRP for every model.
2. Feed those into `getModelSelection` (vehicle=code, url=configuratorURL) for per-trim MSRP, and `getOfferListByFilter` for finance/lease APR.
Then Mitsubishi is a full MSRP+finance+lease make.
