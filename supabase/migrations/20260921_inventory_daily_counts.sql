-- Aggregate-only window onto the inventory tables, so the daily report can
-- state what moved without anyone holding a service-role key.
--
-- WHY THIS EXISTS. vehicle_listing and listing_price_history have no SELECT
-- grant to anon (42501), by design — they hold dealer inventory row by row and
-- nothing about a specific car should be readable by the public client. The
-- consequence was that every daily report shipped with the same paragraph:
-- "no listing counts, no price changes, no delistings, coverage not seen". An
-- absence reported honestly is still an absence, and it had been reported
-- honestly for weeks. This returns COUNTS ONLY — one row, seven integers, no
-- vin, no dealer, no price, no model. Nothing here identifies a vehicle.
--
-- A DELISTING IS NOT A SALE. delisted_24h counts listings that stopped
-- appearing on the dealer's own site. A car leaves a website because it sold,
-- because it moved to another rooftop, because the feed broke, or because
-- someone edited the stock number. We observed a disappearance and that is all
-- we may ever call it. No column here may be renamed to "sold" and no caller
-- may present it as one; scripts/test-inventory-counts.mjs enforces that.

create or replace function public.inventory_daily_counts()
returns table (
  listings_total   bigint,
  listings_live    bigint,
  dealers_live     bigint,
  first_seen_24h   bigint,
  delisted_24h     bigint,
  price_moves_24h  bigint,
  newest_observation date
)
language sql
security definer
set search_path = public
stable
as $$
  select
    (select count(*) from vehicle_listing),
    (select count(*) from vehicle_listing where delisted_on is null),
    (select count(distinct dealer_id) from vehicle_listing where delisted_on is null),
    (select count(*) from vehicle_listing where first_seen_on >= current_date - 1),
    -- observed to have stopped appearing. NOT sold. See the note above.
    (select count(*) from vehicle_listing where delisted_on >= current_date - 1),
    -- listing_price_history only gets a row when a price actually MOVED, so
    -- this is a count of real changes, not of observations.
    (select count(*) from listing_price_history where observed_on >= current_date - 1),
    -- The newest thing we personally observed. When this is not today, the
    -- crawl did not run and every count above is a count of stale state --
    -- the reader needs that fact next to the numbers, not buried.
    (select max(last_seen_on) from vehicle_listing);
$$;

comment on function public.inventory_daily_counts() is
  'Aggregate counts for the daily report. Counts only, no row data. delisted_24h means observed to have stopped appearing, never sold.';

revoke all on function public.inventory_daily_counts() from public;
grant execute on function public.inventory_daily_counts() to anon, authenticated, service_role;
