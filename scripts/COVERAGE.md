# Manufacturer catalog coverage (Canada)

Status of the MSRP + finance/lease-rate scrapers that populate `msrp_catalog`,
`finance_rate_catalog`, and `lease_rate_catalog`. "Shipped" = a verified scraper
in this repo, wired into `.github/workflows/catalog-refresh.yml`. All endpoints
below were confirmed against live responses (2026-07-25).

## ✅ Shipped & verified (full MSRP + finance + lease)

| Make(s) | Script | Platform |
|---|---|---|
| Toyota | `scrape-toyota.mjs` | Adobe AEM (tcidigital) — `prices.json` + `interest_rates.json` |
| Lexus | `scrape-lexus.mjs` | same as Toyota (shared `lib/tci-stack.mjs`) |
| Jeep, Ram, Dodge, Chrysler, Fiat | `scrape-stellantis.mjs` | FCA `/api/buildandprice/trims/prices` (one call = MSRP+finance+lease) |
| Genesis | `scrape-genesis.mjs` | Sitecore `GenesisShowroom` JSON API |
| Hyundai | `scrape-hyundai.mjs` | AEM backend REST `trimallpurchaseOptions` (Imperva WAF — needs browser headers) |
| Mazda | `scrape-mazda.mjs` | AWS API Gateway `/api/Trims/{year}/{carline}/` |

That's **10 makes across 5 platforms.**

## 🟡 MSRP-ready, rates blocked (build MSRP-only next; rates need a browser/session)

| Make(s) | MSRP source (verified) | Why rates are blocked |
|---|---|---|
| Chevrolet, GMC, Buick, Cadillac | `…/byo-vc/api/v3/trim-matrix/{lang}/CA/{brand}/{carline}/{year}/{body}?postalCode=` → `trims[].configurations[].msrp.amount.value` (shared across all 4 GM brands, no auth) | rates via session-gated IPE `AjaxEstimateFinanceLeaseFactors` (403 to curl) |
| Kia | build-and-price page inline JSON `priceDetails.{PROV}.msrp` (HTML-entity decode) | no clean rate API; only disclaimer copy on /special-offers |
| Nissan, Infiniti | SSR `VehiclePrice.retail.value` on `/shopping-tools/build-price` (market `NISSAN_CA` / `INFINITI_CA`) | rates via `getModalPaymentOptions` GraphQL behind Akamai 403 |
| Volvo | SSR `priceSummary.carPriceSummary.totalPrice` on `/en-ca/build/{model}/` | rates via authed GraphQL `/api/graphql` (needs client creds) |

## 🔍 Mapped, build pending

| Make(s) | State |
|---|---|
| Honda, Acura | Sitecore dmmapi + `mcpe-payment-calculator`. Model→GUID map + calculator body documented in `HONDA-NOTES.md`; last step = capture one real calculator POST in a browser. Acura is Honda's identical twin. |
| Ford, Lincoln | Platform + hosts identified (`api.foundational.ford.com`, `/estimate-payment`, shared Ford/Lincoln). Exact API path needs a browser pass — Akamai tarpits curl. |
| Subaru | MSRP from homepage trim JSON (`msrp`); finance/lease APR in the rendered `WebPage.aspx` pricing page as XML `<data id="apr">` nodes. Medium: HTML/XML scrape, no JSON API. |

## ⬜ Blocked / not yet queued

- **Audi** — audi.ca serving a global "not-available" 503 maintenance page; retry later (likely VW OneHub platform).
- **VW** — actually CRACKED (public `globalapi.vwtools.ca/special-offers` + `/finance`), but its `price` is a selling price incl. freight, not pure MSRP; build with that caveat or source MSRP from the auth-gated `/viso/catalogue`. Rates (`financial_values.{PROV}.apr`/`.alr`) are clean.
- Mercedes-Benz, BMW, MINI, Porsche, Jaguar, Land Rover, Mitsubishi, Maserati, Alfa Romeo (shares FCA) — not yet recon'd.

## Notes
- All scrapers dry-run without credentials (write to `scripts/out/`) and delete-then-insert their make's rows when `SUPABASE_SERVICE_ROLE_KEY` is set.
- Rate values from Hyundai/Mazda are decimals in-source (0.0279) → stored as percent (2.79).
- `fuel_type` uses conservative name-based inference (`lib/catalog-io.mjs` `inferFuelFromName`); null when unsure rather than guessing "Gas".
