# Nissan / Infiniti scraper — MSRP SHIPPED; rates gated

**MSRP solved (2026-07-26):** each vehicle page embeds a hidden #individualVehiclePriceJSON
iframe whose body is price JSON — Retail.grades[key].gradePrice is the national MSRP.
`scrape-nissan.mjs` / `scrape-infiniti.mjs` (shared lib/nissan-stack.mjs) parse it via
Node fetch. Nissan 44 rows/11 models, Infiniti 39/6. Rates still need the GraphQL below.

## (rates) original recon

Nissan & Infiniti share one Next.js + Apollo GraphQL platform. Good news: the
endpoint is **reachable from Node** (Akamai passes Node's fetch, blocks curl).
The blocker is getting the exact query text — introspection is disabled and the
pricing queries only fire deep in the build flow.

## Endpoint (verified reachable via Node fetch, HTTP 200)
`POST https://www.nissan.ca/graphql`
- Headers that work: browser UA + `Content-Type: application/json` + `Origin: https://www.nissan.ca`.
- `{"query":"{__typename}"}` → `{"data":{"__typename":"Query"}}`.
- Introspection is OFF: `__schema` and `__type` both return `FieldUndefined`/validation errors.
- Infiniti = same endpoint, `market` set to the Infiniti market object.

## Operations (names + args from recon; exact shapes NOT captured)
- `getActiveModels(market, includePreviousModelYears)` → lineup, `versions[].versionCode`.
- `getDetailedVersion(market, modelCode, versionCode)` → `priceList.retail.value` (MSRP) + `priceList.regional[]`.
- `getModalPaymentOptions(market, versionCode, price, zipCode, eimCode, modelCode)` → `financePaymentOptions[]`, `leasePaymentOptions[]` (APR source).
- **`market` is an INPUT OBJECT, not a string/enum** (`"NISSAN_CA"` as string/enum → "must be an object type"). Its shape is the missing piece — likely `{ brand, country }` or `{ code }`. Capture it from a real request.

## To finish (dedicated session)
1. In a browser, drive the build flow to a trim's pricing step (select model → version),
   hooking `fetch`/XHR **inside the pricing iframe** (top-window hook won't see it) to
   capture one real `/graphql` POST body → gives the exact query text + the `market`
   input-object shape + variables.
2. Replay via Node fetch (works) looping models → versions → getDetailedVersion (MSRP),
   getModalPaymentOptions (finance/lease APR).
Alternatively: MSRP may be in the build-flow SSR as `VehiclePrice.retail.value`
(the individual-vehicle price loads via an `#individualVehiclePriceJSON` iframe —
find that iframe's src, which may return a clean price JSON directly).

## Rate query — structure cracked (2026-07-26 re-check), one enum short
The /graphql endpoint is Node-reachable and I reverse-engineered the arg shapes
by iterating on validation errors:
- `getDetailedVersion(market: <input>, versionQuery: <input>){ priceList{ retail{ value } } }`
- `market` is an input object requiring `{ application: <MarketApplication enum>, lang: <enum> }`.
  The enum VALUES are the only remaining unknown ("NISSAN_CA"/"NISSAN"/"EN" all rejected as
  invalid MarketApplication members; introspection is off).
- `versionQuery` takes `{ versionCode, modelCode, year }` (versionCode e.g. "W6BG16" comes
  from the individualVehiclePriceJSON blob's bestPriceVersionKey; modelCode e.g. "42088").
To finish: grab the MarketApplication enum value from the pricing iframe's bundle (NOT the
build-price page chunks — checked, not there) or a captured request, then `getModalPaymentOptions`
for finance/lease. Everything else is solved.
