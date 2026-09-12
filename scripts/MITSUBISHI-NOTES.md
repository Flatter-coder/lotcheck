# Mitsubishi Canada scraper — BUILT AND SHIPPED 2026-09-11

**Status: SHIPPED.** `scripts/scrape-mitsubishi.mjs` +
`scripts/lib/mitsubishi-stack.mjs`. 30 per-trim MSRP rows across 4 nameplates /
5 model-years. Plain fetch, no auth, no Scrapfly, no key.

The notes below were written when this was "one param short". They were right
that the GraphQL is open and unwalled, and **wrong about why it returned
nothing** — which is recorded here rather than deleted, because the wrong
diagnosis is the more useful half.

**What the missing param actually was: `path`.** Not a vehicle code.
`/content/mitsubishi-motors/ca/en/buy/configure-your-mitsubishi/ngc-configurator`
returns `vehicles: []` — **zero results, HTTP 200, no error**. The payments path
`/ca/en/buy/payment-calculator` returns all five vehicles with MSRP. A query
that answers "zero, successfully" is the most expensive kind of wrong: it reads
as a completed investigation, and it got recorded in `scripts/COVERAGE.md` three
times as a "backend CMS mapping dead-end" that nobody re-tested for a year.

Two failure modes worth telling apart when this breaks again:
- **A loud JSON error** means `ctas`. It must be PRESENT and JSON `null`. Omit
  it and the resolver does `JSON.parse(undefined)`; pass `""` and it reports
  "Unexpected end of JSON input".
- **Zero vehicles, no error** means the `path` is wrong. Nothing else produces
  that shape.

Other corrections to what is below:
- Per-trim prices come from `getModelsSelector` (**plural**), not
  `getModelSelection`, at the `.../configurator` path with no `ngc-` prefix.
- `selection.vehicle` is the selector's `vehicleCode` GUID, never the AEM code
  (`DG`, `DGE`, `ZC`) — which is why every code tried below returned "Vehicle
  not found". The GUIDs are AEM-generated and rotate; harvest them per run.
- `year` is inert as a filter. Filter client-side on `vehicleYear`.
- **Key on GUID + year.** 2026 and 2027 RVR share one GUID with different
  ladders ($24,998 vs $25,278); GUID-only keying silently collapses two model
  years into one.
- **`fuelType` reads "Unleaded" on all seven Outlander PHEV trims.** Never
  discriminate powertrain from it. The stack infers from nameplate +
  `engineType` + the model-code prefix (`GM2W…` gas vs `GN0W…` PHEV). The two
  ladders are $13,600 apart at base, so getting this wrong is a
  [[powertrain-identity-rule]] breach with a five-figure error in it.
- `price.displayValue` is the literal mask `"From ###,###.##"`. Only
  `price.value` is usable.

Scope, stated honestly: Mitsubishi Canada publishes exactly five vehicle-years
today — 2026 Outlander, Outlander PHEV, Eclipse Cross, RVR, and 2027 RVR.
Mirage survives only as stale 2024 offer pages in the CMS route tree; it is
discontinued and must not be priced.

Rates are NOT built. `getOfferListByFilter` works but needs an explicit
`stateCode` (with none, it returns zero offers), and its offers carry empty
`modelName`/`trimName` — model-level and province-specific, so every stored row
would have to be labelled with its province. That is a separate build.

Permission: `mitsubishi-motors.ca/robots.txt` is `User-agent: *` with an empty
`Disallow:`, which permits everything. Read 2026-09-11.

## ORIGINAL RECON NOTES (2026-07-26) — kept for the record, corrected above

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
