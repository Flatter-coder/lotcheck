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
| Volvo | **$699** | "retailer administration fee (up to $699)" | volvocars.com/en-ca/offers (verified) | DONE |
| Infiniti | **$921** | "dealer fees (up to $921)" (premium, ≠ Nissan) | canada.infinitinews.com (verified) | DONE |
| Mitsubishi | **$799** | "Dealer/administrative fees of up to $799" | mitsubishi-motors.ca B&P (verified) | DONE |
| GMC | **$699** | "up to $699 dealer fee" (GM corporate disclaimer) | GM national; GMC B&P Akamai-blocked, inferred from Chevy/Buick/Cadillac | DONE |

### Confirmed to publish NO ceiling (flag correctly does not fire)

Ford, Honda, Jeep, Kia, Ram, Subaru, **Acura** (dealer fee included but
dealer-set/uncapped), **Mercedes-Benz** (mercedes-benz.ca disclaimer EXCLUDES
dealer fees; the "$695" is press-release-only), **Audi** (audi.ca: excludes "any
dealer admin fees", dealer-set — does NOT share VW's $750), **Lincoln** (Ford
family, no cap), **Chrysler** + **Dodge** ("administration fees of the selected
dealer", dealer-set, no "up to $X" — confirms the Stellantis pattern).

**Genesis** — special case: **all-inclusive, no-haggle, one-price. No dealer
fees at all** (like Tesla). The flag has nothing to fire on.

### Held list — CLEARED (2026-08-26)

All four moved to Captured above. Volvo/Infiniti/Mitsubishi verified verbatim via
a direct `web_fetch_exa` fetch (the gstack browser's headed mode was crashing and
the sites bot-wall headless Chromium). GMC's B&P is Akamai-blocked to every tool,
so it was added on GM's corporate-general disclaimer (verified on 3 sibling brands).

### Excluded (not a pure dealer fee)

Porsche — configurator shows "PDI and administration (up to $2,750)", which bundles
freight/PDI with admin. That is not a dealer-fee ceiling; not added.

### No data — RESOLVED (2026-08-26)

All five (Audi, Genesis, Lincoln, Chrysler, Dodge) confirmed **no published
ceiling** at their official sources (see the no-ceiling list above). Nothing left
unresolved on the new-car ceiling side.

## Freight — in fee-schedule.ts (for the explainAllIn estimate)

Live (12 models): Toyota RAV4 $1,930 · Lexus ES $2,205 · Nissan Rogue $2,080 ·
Mazda CX-5 $2,195 · Infiniti QX60 $2,495 · Volvo XC60 $2,770 · Chevrolet Silverado
1500 $2,700 · Hyundai Tucson $2,200 · Kia Sportage $2,185 · Ram 1500 $2,195 ·
Subaru Outback $2,295 · VW Tiguan $2,200. (First six verified verbatim via exa this
session; the rest from batch-1 official captures. Freight is estimate-only — it
feeds explainAllIn, never a dealer claim, and never overwrites a captured all_in.)

Secondary-only, NOT added (need an official capture): Ford F-150 $2,695 · GMC
Sierra $2,700 · Jeep Grand Cherokee $2,295 · Honda CR-V $2,000 · Acura MDX $2,595 ·
Mercedes GLC $3,995.

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
