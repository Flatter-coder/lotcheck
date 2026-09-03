# Source capture — AIRB 2026 Annual Market and Trends Report

The "Insurance before you sign" report line (`supabase/functions/_shared/report-lines.js`,
`financeCoverageLine`) states what an Alberta regulator reports. Every clause it prints is
quoted below from the report itself, so the claim is checkable against a dated capture
rather than against our own memory. This is the same treatment the Build & Price PDFs get
for MSRP: known basis, pinned source, dated capture, or we do not publish.

- **Publisher:** Alberta Automobile Insurance Rate Board (AIRB), an Alberta government rate board
- **Document:** 2026 Annual Market and Trends Report ("MARKET & TRENDS 2026")
- **Where:** https://www.airbfordrivers.ca/market-and-trends-reports/
- **Read on:** 2026-09-03
- **Document classification printed on page 2 of the PDF:** `CLASSIFICATION: PUBLIC`
- **Page numbering:** the PDF page is 2 higher than the printed page number. The quotes below
  are cited by PRINTED page, which is what the report line names.

Short excerpts are quoted for verification and attributed to the publisher. The report is not
redistributed here; anyone can retrieve it from the link above.

## Printed page 8 (PDF page 10) — "COVERAGE RESTRICTIONS & UNDERWRITING AUTHORITY"

> Starting in early 2024, insurers began to change their underwriting rules to deny Albertans
> optional coverages like collision and comprehensive if they met certain criteria. Commonly,
> this meant drivers with an at-fault claim in the past six years or a serious traffic
> conviction within the past four years were being denied access to these coverages, or at
> least, were forced to choose a deductible such as $2,000 or more.

> Typically, insurers are required, under section 555 of the Insurance Act, to provide a quote
> and write the business for any Albertan, which is colloquially called the "Take All Comers"
> rule. This ensures every Albertan has access to auto insurance, mitigating the risk of
> uninsured drivers. However, this only applies to mandatory coverages.

> Therefore, insurers could deny access to optional coverages, which may be required for a
> leased or financed vehicle.

> [Drivers] would not accept the basic-only policy and look for another insurer.

> As of October 2025, the Automobile Insurance Premiums Regulation was modified by AR 227/2025.
> Among other things, the definition of "rating program" was expanded to include: "The
> underwriting rules which govern the decision by an insurer to accept or decline a risk,
> coverage, or endorsement." This gives the AIRB authority over the underwriting actions
> insurers have taken by restricting coverage.

> [We] issued Bulletin 08-2025, which advises insurers they will not receive any approval to
> increase rates until their underwriting rules are relaxed.

## Printed page 22 (PDF page 24) — where it stands now

> In response, the AIRB told insurers in early 2026 we would not approve further rate increases
> until these restrictions were removed. With the implementation of Care-First in Alberta, many
> insurers are increasing their risk appetite and removing these restrictions.

## What the line must never say

The report describes the consequence for those drivers as **shopping**, not as being
uninsurable: they "would not accept the basic-only policy and look for another insurer."
No surface may state or imply that a buyer could be unable to insure the vehicle.

Both halves always ship together: the 2024 restriction AND the October 2025 correction.
Printing the first alone would describe a 2024 world.

## Gate

`scripts/check-source-citations.mjs` (`npm run check:citations`) fails the build if the report
line prints a citation this capture does not carry.
