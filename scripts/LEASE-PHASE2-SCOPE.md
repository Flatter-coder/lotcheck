# Lease Phase 2 — payment breakdown scope

Follow-up to the Phase-1 lease work (advertised lease APR only, one-sided; shipped
in `feat/financing-breakdown-ui`). Phase 2 adds a lease **payment** breakdown where
the data honestly supports one. Recon done 2026-07-27; see also `COVERAGE.md`.

## Goal
Show a lease **payment** (monthly / bi-weekly) in `FinancingBreakdown`, sourced from
the best available data per make, always clearly labeled — without fabricating.

## Hard constraint (why there's no two-sided payment compare)
Manufacturer build-&-price data (`tci-stack` etc.) exposes lease **APR + km only** —
no residual, no payment. So a manufacturer lease *payment* cannot be produced, and a
two-sided "dealer payment vs manufacturer payment" comparison is **impossible without
fabrication**. Phase 2 delivers a **one-sided, labeled dealer lease payment**, never a
faked manufacturer payment beside it. Public residual sources (ALG, Canadian Black
Book, OEM lease programs) are all gated — not usable.

## Data sources (verified live 2026-07-27)
| Feed | Makes | Lease payment inputs it carries |
|---|---|---|
| **SM360** | BMW, Mercedes, Infiniti, GM | advertised **payment $** (`paymentOptions.lease.term.payment` pre-tax, `totalPayment` w/ tax), `apr`, `term`, `kmPerYearPlan`, `sellingPrice`, `paymentFrequency`. **No residual.** Payment is for the *loaded per-VIN* `sellingPrice`, not base MSRP. |
| **Convertus** | Ford, Nissan | **residual %** (`lease_residual`, flag `lease_residual_percent`), `lease_rate`, `lease_term`, `lease_km_allowance`, cap-cost (`lease_price`/`lease_initial_price`/`lease_final_price`), down (`lease_amount`), `lease_residual_mileage`. **No pre-computed payment** — but every input to compute one. |
| **Manufacturer** | Toyota/Lexus/etc. | lease **APR + km only**. No residual/payment. |

## Approach — two tracks + honest fallback
- **Track A — Convertus makes → COMPUTE the payment.** Money-factor formula:
  - `residualValue = residual_pct × baseValue`
  - `depreciation = (capCost − residualValue) / term`
  - `rent = (capCost + residualValue) × (APR / 2400)`  (money-factor = APR/2400)
  - `payment = depreciation + rent`
  - **Validate `baseValue`** (MSRP vs selling price) — see Validation below — before shipping.
- **Track B — SM360 makes → SURFACE the advertised payment directly.** No residual math.
  Label it exactly: "dealer's advertised lease example for this specific (loaded)
  vehicle" — not a base-MSRP lease. Use `totalPayment` (w/ tax) or `payment` (pre-tax),
  labeled which.
- **Track C — manufacturer-only makes → APR + km only, NO payment.** The honest default
  anywhere residual/payment inputs are absent.

## Schema — `lease_rate_catalog` additions (nullable, additive migration)
```
residual_pct            numeric   -- Track A
cap_cost                numeric   -- Track A
down_payment            numeric   -- Track A (lease_amount)
advertised_payment      numeric   -- Track B (pre-tax)
advertised_payment_tax  numeric   -- Track B (with tax)
selling_price           numeric   -- Track B labeling
payment_source          text      -- 'computed' | 'advertised' | null
```

## Scraper changes
- `lib/sm360-stack.mjs` — capture `paymentOptions.lease.term.payment`/`totalPayment` +
  `sellingPrice` → `advertised_payment(_tax)`, `selling_price`, `payment_source='advertised'`.
- `lib/convertus-stack.mjs` — capture `lease_residual`/100 → `residual_pct`, `lease_amount`
  → `down_payment`, cap-cost field → `cap_cost`, `payment_source='computed'`.
  (`annual_km` → `lease_km_allowance` already fixed in `d693710`.)
- Manufacturer scrapers unchanged (Track C).

## Edge function (`resolveLeaseRates`, both `analyze-quote` + `analyze-listing-url`)
- Read the new columns. If `advertised_payment` present → attach
  `leaseRates.manufacturer.payment = {amount, withTax, source:'advertised', sellingPrice}`.
  Else if `residual_pct` present → compute via the formula → `source:'computed'`.
  Else → no payment (APR only). Also attach the `term`/`km`/`residual` assumptions used.

## UI (`FinancingBreakdown`)
- When a lease payment exists, render a lease payment line/mini-matrix (by term/km),
  **labeled by source**: "advertised for this vehicle" (Track B) vs "estimated from
  residual" (Track A), with the down / cap-cost / km assumptions shown.
- Keep Phase-1's honest note where only APR is available.
- The two-sided dealer-vs-manufacturer lease view stays gated on a listing-stated lease
  rate (Phase-1 left the forward-compatible path in place).

## Validation — MUST pass before shipping Track A
Compute one payment (e.g. Ford Escape 48-mo, known down/km) and compare to that dealer's
VDP advertised lease payment; they must agree within a small tolerance. If off, the
residual base (MSRP vs selling price) or a cap-cost input is wrong — fix before ship.
Spot-check one SM360 advertised payment renders with the correct label.

## Explicitly out of scope / won't do
- A two-sided dealer-vs-manufacturer lease **payment** comparison (manufacturer has no
  residual/payment; would need a gated residual source). Not attempted.
- Scraping any gated residual source (ALG / Canadian Black Book / OEM programs).

## Effort
Migration + 2 scraper edits + resolver extension + UI = moderate. The gating item is the
Track-A validation cross-check, not the code.
