# Used-market fee tracking — scope + findings

How LotCheck handles fees on **certified / CPO, demo, and used** vehicles. This is
a different problem from the new-car dealer-fee ceilings (`fee-schedule.ts`):
a used-car fee has **no manufacturer ceiling** to measure against.

## What the research found (2026-08-26)

**1. There is no certification FEE.** Across 7 OEM CPO programs (Toyota, Honda,
Hyundai, Ford, GM/Chevrolet, Mazda, BMW), none charges a separate line-item
certification fee. CPO is a **price premium** baked into the asking price —
~$1,500–$2,000 mass-market, up to ~$5,000 luxury (APA). So "how much is the
certified fee" has no published answer; the fee IS the premium, which is a
**market comparison** (CPO vs comparable non-CPO), not a line item.

**2. No province caps a used-car admin/doc fee.** Not AMVIC, OMVIC, VSA, or OPC.
The fee's level is lawfully the dealer's (mirrors our "MSRP is only a suggestion"
posture). The only backed reference is the **all-in advertised-pricing rule** —
the fee must already be INSIDE the advertised price. `docfee.ts`'s "allin"
finding already enforces this for **any** condition, so there is nothing new to
build for the used admin fee itself.

**3. The real buyer-side value is verifying the "certified" badge.** A badge can
mean a genuine OEM CPO program (factory warranty extension + mandated inspection
+ recall repairs) or a dealer's own "in-house certified" (no factory warranty).
Only the former justifies the premium.

**4. Demo = registration, not mileage.** Once a dealer registers a demo it must be
sold as **used** (OMVIC/VSA explicit; AMVIC in practice), and the manufacturer
warranty clock started at its in-service date, not at purchase. All-in pricing
applies. The km-discount fairness is a market question, not a regulated one.

**5. Competitor gap.** No Canadian buyer-side tool (CarCostCanada, Unhaggle,
CARFAX) benchmarks used-car fees or verifies CPO. Open lane for LotCheck.

## What's built

- **`cpo.ts`** — CPO program catalog (7 makes, official terms) + `assessCertifiedClaim()`.
  Defamation-safe: an uncataloged make returns null (never a false "in-house"
  cry); eligibility concerns fire only on an official threshold clearly exceeded.
- **`condition.ts`** — `deriveSaleCondition()`: new / demo / certified / used,
  alongside the untouched binary `vehicleCondition`. Fed by the LLM `saleCondition`
  field and the platform extractors' `saleConditionHint` (d2c / convertus).
- **Wiring** — `analysis.saleCondition` is set in both analyze functions; when it
  is `"certified"`, the counter-script gains a CPO verification move (email + PDF +
  on-screen) naming the OEM program and what the premium buys.

## Open / next

- **CPO premium as market data** — quantify the premium (CPO listing vs non-CPO
  comps) via `marketvalue.ts`. Needs comps tagged by `saleCondition`.
- **In-house vs OEM detection** — today we surface the OEM program to verify
  against; detecting a *fake* "certified" needs the listing's stated certifier.
- **Flywheel condition-awareness** — `fee_observation` isn't tagged by condition,
  so it can't yet benchmark used fees separately (and capture is legal-blocked).
- **On-screen CPO card** — the counter-script move covers all output surfaces; a
  dedicated report card (like the doc-fee card) is a follow-up.
- **Decision for Vic/legal:** how far to push the CPO-premium comparison (naming a
  dollar premium vs a named car) given defamation posture.
