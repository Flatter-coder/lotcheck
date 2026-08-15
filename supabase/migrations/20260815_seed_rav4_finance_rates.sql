-- ============================================================================
-- 2026 RAV4 finance & lease rates — the SECOND half of the reference-point model.
--
-- Vic, 2026-08-15: "if we can read the price that will be our reference point —
-- dealer price, dealer's APR vs LotCheck MSRP and official Toyota Canada APR."
--
-- Two comparisons make the product: dealer price against the manufacturer's
-- all-in, and dealer APR against the manufacturer's published rate. The price
-- half now has real data behind it. The APR half was reading whatever
-- finance_rate_catalog happened to hold — the Okotoks report showed a 5.59% OEM
-- reference with no date and no term stated, which is a number the buyer cannot
-- check and we cannot defend.
--
-- Toyota publishes the rate WITH AN EXPIRY, right in the Build & Price summary:
--
--   "Toyota Financial Services interest rate shown is applicable until
--    Aug 30, 2026, 6:00 PM, MDT"
--
-- That expiry is the part worth having. A finance rate with no date is the same
-- class of problem as an MSRP with no basis: it looks authoritative and cannot
-- be defended once it goes stale. Captured per model line, dated, from the
-- manufacturer's own document.
--
-- SOURCE: Toyota Canada Build & Price summaries, Alberta, captured 2026-08-15
--   RAV4 Plug-in Hybrid GR SPORT AWD — finance 5.69% / 72 months
--   RAV4 Plug-in Hybrid trim cards  — lease   6.89% / 60 months
--
-- Both are STANDARD rates (promo = false). Toyota's disclaimer calls them the
-- Toyota Financial Services rate, not a limited-time incentive, so labelling
-- them promo would overstate what they are.
-- ============================================================================

insert into public.finance_rate_catalog
  (make, model, apr, term_months, promo, effective_date, source_url)
values
  ('Toyota', 'RAV4 Plug-in Hybrid', 5.69, 72, false, date '2026-08-30',
   'https://www.toyota.ca/en/build-price/rav4-plug-in-hybrid/'),
  ('Toyota', 'RAV4 Plug-in Hybrid', 6.89, 60, false, date '2026-08-30',
   'https://www.toyota.ca/en/build-price/rav4-plug-in-hybrid/')
on conflict do nothing;

-- What the report can now say, with both sides sourced:
--   "This dealer advertises X%. Toyota Financial Services publishes 5.69% over
--    72 months, applicable until Aug 30 2026 — here is their page."
--
-- And when the dealer advertises NO rate (the Okotoks case), the manufacturer's
-- published rate is the reference the buyer walks in with, rather than a blank
-- ([[manufacturer-apr-reference]], report-never-empty).

select make, model, apr, term_months, promo, effective_date
from public.finance_rate_catalog
where make ilike 'Toyota'
order by model nulls first, term_months;
