-- ============================================================================
-- finance_rate_catalog.source_url — the column two seeds already assumed.
--
-- Both 20260815_seed_rav4_finance_rates.sql and the Crown Signia seed INSERT a
-- source_url into this table. The column does not exist, so both failed with
-- 42703 and NEITHER RATE EVER LANDED. The APR half of the reference-point model
-- has been empty the whole time while the migrations read as if it were done.
--
-- Adding the column rather than dropping it from the seeds, because a rate
-- without its source is the exact defect those seeds were written to fix: the
-- Okotoks report showed "5.59% OEM reference" with no term, no date and no
-- link — a number the buyer cannot check and we cannot defend. Toyota publishes
-- the rate WITH an expiry on its own page; the link is what makes it a
-- reference instead of an assertion.
-- ============================================================================

alter table public.finance_rate_catalog add column if not exists source_url text;
alter table public.lease_rate_catalog   add column if not exists source_url text;

-- The scraper (scripts/lib/tci-stack.mjs) writes make/model/apr/term_months/
-- promo/effective_date and no source_url, so this stays nullable: a scraped row
-- legitimately has none yet. Null means "not recorded", never "no source".

select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name in ('finance_rate_catalog','lease_rate_catalog')
order by table_name, ordinal_position;
