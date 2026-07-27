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
| Honda | `scrape-honda.mjs` | Sitecore dmmapi trims + `api.honda.ca` calculator/payment POST (shared `lib/honda-stack.mjs`) |
| Acura | `scrape-acura.mjs` | same as Honda, `/A/Live/` |

That's **12 makes across 6 platforms** with full MSRP+finance+lease.

### ✅ Shipped, MSRP-only (rates gated at source)
| Make(s) | Script | Notes |
|---|---|---|
| Chevrolet, GMC, Buick, Cadillac | `scrape-gm.mjs` | byo-vc `trim-matrix` (MSRP clean; rates behind GM's session-gated IPE). GMC host may be unreachable from some IPs. |
| Ford, Lincoln | `scrape-ford.mjs` / `scrape-lincoln.mjs` | ModelSlices.json + captured `application-id` header. Node fetch only (Akamai blocks curl); rates in separate estimate-payment app. See `FORD-NOTES.md`. |
| Porsche | `scrape-porsche.mjs` | models.porsche.com SSR (Next.js). Model-group level, no trim names; Porsche exposes no financing. |

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
| Ford, Lincoln | Endpoint found (`www.ford.ca/cxservices/products/ModelSlices.json`, `plantype=MSRP\|Finance\|Lease`); blocked by a required `application-id` header. See `FORD-NOTES.md`. |
| Subaru | MSRP from homepage trim JSON (`msrp`); finance/lease APR in the rendered `WebPage.aspx` pricing page as XML `<data id="apr">` nodes. Medium: HTML/XML scrape, no JSON API. |

## ⬜ Blocked / not yet queued

- **Audi** — audi.ca serving a global "not-available" 503 maintenance page; retry later (likely VW OneHub platform).
- **VW** — actually CRACKED (public `globalapi.vwtools.ca/special-offers` + `/finance`), but its `price` is a selling price incl. freight, not pure MSRP; build with that caveat or source MSRP from the auth-gated `/viso/catalogue`. Rates (`financial_values.{PROV}.apr`/`.alr`) are clean.
- Mercedes-Benz, BMW, MINI, Porsche, Jaguar, Land Rover, Mitsubishi, Maserati, Alfa Romeo (shares FCA) — not yet recon'd.

## Notes
- All scrapers dry-run without credentials (write to `scripts/out/`) and delete-then-insert their make's rows when `SUPABASE_SERVICE_ROLE_KEY` is set.
- Rate values from Hyundai/Mazda are decimals in-source (0.0279) → stored as percent (2.79).
- `fuel_type` uses conservative name-based inference (`lib/catalog-io.mjs` `inferFuelFromName`); null when unsure rather than guessing "Gas".

## Update (2026-07-26 pm)
- **MINI** — `scrape-mini.mjs`, FULL MSRP+finance+lease (mini.ca CalculatorAPI/GetMultipleVehicleData, one POST). Shipped.
- **Mercedes-Benz** — `scrape-mercedes.mjs`, MSRP only (nafta-service.mbusa.com new/models). Rates need the payment-estimator config (browser capture) — see notes.
- **Porsche** — shipped MSRP-only.
- **BMW** — NOT built. Global UCP configurator (`prod.ucp.bmw.cloud`, `x-api-key` in settings.json), Node-fetch only (Akamai walls curl). Multi-step: metadata → model-matrix → price-lists; finance/lease is a POST retail-calculation with a configured-vehicle body. HIGH effort — dedicated follow-up.
- **Audi** — still 503 (down).
- **Subaru** — `scrape-subaru.mjs`, FULL MSRP+finance+lease. MSRP from the homepage `<script id="Cars">` JSON; rates from the WebPage.aspx pricing page XML (`WebSiteID=282`, `<finance>`/`<leasestd>` blocks). 40 trims / 9 models.
- **Alfa Romeo** — added to `scrape-stellantis.mjs` (FCA), full data.
- **Mitsubishi** — GraphQL resolver returns empty (backend CMS mapping dead-end); only 4 model-level base prices reachable. Left unbuilt; see MITSUBISHI-NOTES.md.
- **Kia** — `scrape-kia.mjs`, MSRP only. Parses the build-and-price page's entity-encoded JSON (string-aware bracket-match + JSON.parse of the `models` arrays) so trim↔price association is structural, not regex. 100 rows / 19 models. Rates not exposed as a clean API.
- **Nissan / Infiniti** — `scrape-nissan.mjs` / `scrape-infiniti.mjs` (shared `lib/nissan-stack.mjs`), MSRP only. Parsed from the `#individualVehiclePriceJSON` iframe body on each vehicle page (Node fetch; Akamai blocks curl). Rates need the gated GraphQL — see NISSAN-NOTES.md.
- **Volvo** — `scrape-volvo.mjs`, MSRP only, model-level. Starting MSRP per model from the /en-ca/build/{model} SSR (Node fetch; Akamai). Per-trim (Core/Plus/Ultra) is behind gated GraphQL. 7 models.
- **Volkswagen** — `scrape-vw.mjs`, FULL MSRP+finance+lease. Public globalapi.vwtools.ca (special-offers + finance, Node fetch). MSRP = advertised price − freight_pdi. Finance incl. 0% promos (flagged promo). 8 models.

## Final coverage (2026-07-26) — 28 makes shipped
FULL MSRP+finance+lease (16): Toyota, Lexus, Jeep, Ram, Dodge, Chrysler, Fiat, Alfa Romeo, Genesis, Hyundai, Mazda, Honda, Acura, MINI, Subaru, Volkswagen.
MSRP-only (12): Chevrolet, GMC, Buick, Cadillac, Ford, Lincoln, Porsche, Mercedes-Benz, Kia, Nissan, Infiniti, Volvo.

Remaining (each blocked or a dedicated deep-dig — NOT quick):
- BMW — UCP configurator, multi-step, per-model vehicleTree unknown. API+key verified. See BMW-NOTES.md.
- Jaguar / Land Rover — AEM configurator with a separate pricing service; deep dig, low CA volume.
- Maserati — maserati.com/ca bot-walled (403); not on the FCA modelYears platform; tiny volume.
- Audi — audi.ca serving a maintenance 503 site-wide (unbuildable until back up); VW's vwtools API ignores brand=audi.
- Mitsubishi — open GraphQL but the resolver returns empty (backend CMS mapping dead-end). See MITSUBISHI-NOTES.md.

Open RATE captures to upgrade MSRP-only → full: GM (IPE), Ford (estimate-payment), Mercedes (payment-estimator), Kia, Nissan/Infiniti (gated GraphQL). Each is a browser capture like Honda/Ford.
- **BMW** — `scrape-bmw.mjs`, MSRP + finance/lease via the SM360 dealer inventory feed (bmw.ca prices are identity-gated). Calgary BMW; listPrice=MSRP, deduped to starting-price-per-trim; default-term rates. 25 models. See BMW-NOTES.md.

## CURRENT STATUS (2026-07-27) — continuation anchor
**29 makes: 20 FULL (MSRP+finance+lease), 9 MSRP-only.**
FULL: Toyota, Lexus, Jeep, Ram, Dodge, Chrysler, Fiat, Alfa Romeo, Genesis, Hyundai, Mazda, Honda, Acura, MINI, Subaru, Volkswagen, BMW, Mercedes-Benz, Ford, Nissan.
MSRP-only: Chevrolet, GMC, Buick, Cadillac, Lincoln, Porsche, Kia, Infiniti, Volvo.

DEALER-FEED TECHNIQUE (the key unlock — cracked manufacturer rate gates):
- SM360 dealers → GET {dealer}/en/new-inventory/api/listing?page=N → vehicles[].{listPrice=MSRP, paymentOptions.finance/lease.term.{term,apr}}. Used for BMW (calgarybmw.ca, full) + Mercedes rates (mercedes-benz-countryhills.ca). lib/sm360-stack.mjs.
- Convertus/AutoSync dealers → GET {dealer}/wp-content/plugins/convertus-vms/include/php/ajax-vehicles.php?endpoint={urlenc vms.prod.convertus.rocks/api/filtering/?cp={cp}&...}&action=vms_data → results[].{msrp, finance[].{finance_term,finance_rate}, lease[].{lease_term,lease_rate}}. cp=inventoryId. Used for Ford (denhamford cp1285) + Nissan (fishcreek cp1377) rates. lib/convertus-stack.mjs. Direct API host 403s — must use dealer proxy.
- Rates layered rates-only (writeCatalogs opts.ratesOnly / CATALOG_RATES_ONLY=1) so manufacturer MSRP is untouched.

NEXT STEPS (dealer-feed pattern proven — quick wins):
1. Infiniti rates → an Infiniti Convertus/SM360 dealer (Nissan sister, same feed).
2. Lincoln rates → a Lincoln Convertus/SM360 dealer (Ford sister).
3. GM rates (Chevy/GMC/Buick/Cadillac) → a Convertus/SM360 GM dealer not 403'd (sherwoodbuickgmc cp373 proxy 403'd; capitalchev bot-walled).
4. Kia rates → an EDealer Kia dealer (needs browser capture of its inventory XHR).
5. Volvo per-trim + rates → gated GraphQL (deferred).
Blocked externally: Audi (site 503 down), Mitsubishi (backend dead-end), Jaguar/Land Rover (Algolia keys not in page config), Maserati (bot-walled).

DEPLOY: 33 commits on branch fix/dealer-publish-stale-row-guard, NOT pushed. Go-live = push (Vercel deploys app + GitHub gets workflows) + run supabase/migrations/20260725_lease_rate_catalog.sql + set SUPABASE_SERVICE_ROLE_KEY secret. Two workflows: catalog-refresh.yml (weekly FULL), catalog-rates-daily.yml (daily rates-only).

## UPDATE 2026-07-27b — Infiniti + GM rates via dealer feeds → 24 FULL / 5 MSRP-only
Chased rate-gated makes with the proven dealer-feed technique:
- **Infiniti** → SM360 (infinitinorthcalgary.ca + infinitinorthvancouver.ca + 401dixieinfiniti.ca). scrape-infiniti-rates.mjs, ratesOnly. 5 finance / 3 lease.
- **Chevrolet / GMC / Buick** → ONE SM360 store, City GM (citygm.com), carries all three; scrape-gm-rates.mjs fetches once & buckets by make.name, ratesOnly. Chevrolet 16f/22l, GMC 11f/12l, Buick 4f/4l.
- Reusable dealer-hunting probe: scripts/probe-dealers.mjs (detects SM360 vs Convertus + extracts Convertus cp).
NOW FULL (24): + Infiniti, Chevrolet, GMC, Buick.
STILL MSRP-only (5): Cadillac, Lincoln, Porsche, Kia, Volvo.
Tried & blocked this round: Lincoln — Waterloo Lincoln Convertus proxy is Cloudflare-403; Pine Tree/MGM/Woodridge/Northstar/Metro/Performance Lincoln all on other platforms (EDealer/DealerInspire), no accessible feed. Cadillac — not stocked at City GM; needs its own Cadillac SM360/Convertus dealer.
