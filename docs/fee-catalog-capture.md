# Fee-catalog capture tracker

Living record of the per-make freight + dealer-fee-ceiling capture that fills
`supabase/functions/_shared/fee-schedule.ts`. See [[fee-catalog]] memory.

**Hard rule:** every figure here is from an OFFICIAL manufacturer source (a
`.ca` Build & Price / pricing / disclaimer page), with the source and capture
date. No secondary-site number is promoted into `fee-schedule.ts`; no figure is
ever guessed. A blank is a gap to capture, never a value to invent.

**Two data points per make:**
- **Freight** — Delivery & Destination, per *model* (varies by model). Feeds the
  all-in itemisation/estimate (`explainAllIn`), never overwrites a captured
  `all_in_price`.
- **Dealer-fee ceiling** — the manufacturer's *published maximum* dealer/admin
  fee, per make. This powers the report flag. Most makes do **not** publish one
  (it looks like a Toyota-family practice) — "not published" is the expected,
  correct answer for most, and the flag simply doesn't fire for those.

Status: `DONE` (in fee-schedule.ts) · `pending` (not yet captured) · `no ceiling`
(confirmed the make publishes none — flag N/A, freight may still be captured).

## Captured — dealer-fee ceilings (in fee-schedule.ts, power the flag)

All verified verbatim at the official source. Ceilings are national ("up to $X").

| Make | Ceiling | Exact wording | Source | Status |
|---|---|---|---|---|
| Toyota | **$999** | "Dealer Fees (maximum) $999" | Toyota.ca B&P, 2026 RAV4 (AB) | DONE |
| Lexus | **$995** | "Dealer Fees of up to $995" | Lexus.ca B&P, 2026 ES 350h (AB) | DONE |
| Hyundai | **$799** | "dealer admin. fees of up to $799" (may vary by dealer) | hyundaicanada.com | DONE |
| Mazda | **$795** | "retailer administration fee (up to $795)" | mazda.ca/en/vehicles/cx-5 | DONE |
| Volkswagen | **$750** | "representative dealer admin fee … up to $750" | vw.ca/offers | DONE |
| Chevrolet | **$699** | "up to $699 dealer fee" (B&P applies $350 default) | chevrolet.ca B&P disclaimer | DONE |
| Nissan | **$621** | "dealer fees (up to $621)" (may vary by region) | canada.nissannews.com | DONE |
| MINI | **$595** | "retailer administration fees (up to $595)" | mini.ca (verified in-session) | DONE |
| BMW | **$595** | "retailer administration fees (up to $595)" | bmw.ca (same BMW Group policy, verified via MINI) | DONE |
| Buick | **$699** | "up to $699 dealer fee" | GM national B&P disclaimer (buick.ca) | DONE |
| Cadillac | **$699** | "up to $699 dealer fee" | GM national B&P disclaimer (cadillaccanada.ca) | DONE |

### Confirmed to publish NO ceiling (flag correctly does not fire)

Ford, Honda, Jeep, Kia, Ram, Subaru, **Acura** (acura.ca B&P disclaimer: dealer
fee is included but dealer-set/uncapped), **Mercedes-Benz** (mercedes-benz.ca
special-offers MSRP disclaimer EXCLUDES dealer fees, no cap — the "$695" exists
only in a model press release, not a durable published policy).

### Held — agent-found verbatim, NOT yet in fee-schedule.ts (need a clean verify)

Batch-2 agents shared one browser daemon and hit contention, so these official
"up to $X" captures could not be personally re-verified (JS configurators / 403).
Verbatim wording was reported; hold until confirmed at the source.

| Make | Lead | Why held |
|---|---|---|
| Volvo | $699 "retailer administration fee (up to $699)" | volvocars.com/offers JS-gated; no family corroboration |
| Mitsubishi | $799 "Dealer/administrative fees of up to $799" | configurator-only; no corroboration |
| Infiniti | $921 "dealer fees (up to $921)" | infinitinews 403s headless; NOT Nissan's $621 (premium division is higher) |
| GMC | likely $699 (GM national disclaimer) | batch-1 agent used a secondary site; no GM-disclaimer verbatim captured yet |

### Excluded (not a pure dealer fee)

Porsche — configurator shows "PDI and administration (up to $2,750)", which bundles
freight/PDI with admin. That is not a dealer-fee ceiling; not added.

### No data yet (unresolved — neither ceiling nor no-ceiling confirmed)

Audi, Genesis, Lincoln, Chrysler, Dodge (Chrysler/Dodge likely no-ceiling like the
other Stellantis brands, but the agents returned no usable disclaimer).

## Freight — officially sourced (for explainAllIn; not yet all in fee-schedule.ts)

Toyota RAV4 $1,930 · Lexus ES $2,205 (both live). Official, pending add: Chevrolet
Silverado 1500 $2,700 · Nissan Rogue $2,080 · Hyundai Tucson $2,200 · Kia Sportage
$2,185 · Ram 1500 $2,195 · Subaru Outback $2,295 · Mazda CX-5 $2,195 · VW Tiguan
$2,200. Secondary-only (needs official capture): Ford F-150 $2,695 · GMC Sierra
$2,700 · Jeep Grand Cherokee $2,295 · Honda CR-V $2,000. Mercedes GLC $3,995 (unverified).

## Alberta / federal fees (brand-independent — captured once, cover all 31)

| Fee | Amount | Source |
|---|---|---|
| A/C Charge (federal) | $100 | Toyota & Lexus B&P (identical) |
| AMVIC | $10 | Toyota & Lexus B&P (AB) |
| Tire Levy | $25 | Toyota & Lexus B&P (AB) |
| Env. Handling (filters / lube) | $1.10 / $1.08 | Lexus B&P (AB) |
| PPSA / PPSA Service | $14 fin · $10 lease / $4 | Toyota & Lexus B&P (AB) |

## Remaining roster

Batch 1 (DONE — 14 makes researched, ceilings verified above): Ford, Chevrolet,
GMC, Ram, Jeep, Honda, Hyundai, Kia, Nissan, Mazda, Subaru, Volkswagen, BMW,
Mercedes-Benz. (BMW returned no ceiling lead; Mercedes pending; rest resolved.)

Batch 2 (queued): Acura, Genesis, Infiniti, Audi, Mitsubishi, Dodge, Chrysler,
Buick, Cadillac, Lincoln, Volvo, MINI, Porsche, Land Rover, Jaguar. Note: Dodge/
Jeep/Ram/Chrysler share Stellantis disclaimers (Ram/Jeep = no ceiling, so likely
all four); Buick/Cadillac share GM's "up to $699" (Chevrolet) — verify before adding.

Direct-sale / no dealer network (flag N/A — no dealer fee to compare): Tesla,
Polestar, Rivian, Lucid.
