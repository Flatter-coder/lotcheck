-- Longest-sitting vehicles by city, for the admin view.
--
-- WHY. Asked "what is top 5 cars days on lot in Edmonton and Calgary" and the
-- answer was unreachable: vehicle_listing, city_dealer_index and
-- listing_observation all return 42501 to anon, and fn_admin_lot_leverage_summary
-- is granted to authenticated only. The data exists -- 12,636 listings across 35
-- dealers -- with no way to read an aggregate of it.
--
-- WHAT IT COUNTS, AND WHAT IT REFUSES TO CLAIM.
--
-- days_observed is last_seen_on - first_seen_on: the span WE personally watched
-- the car sit, both ends being our own observations. It is NOT "days since it
-- arrived" -- vehicle_listing keeps the dealer's own date_entry separately and
-- deliberately, and mixing ours with theirs is how a days-on-lot figure becomes
-- indefensible. It is also NOT "days it is still sitting": the crawl's last
-- observation is what it is, and a car may have sold the day after. Every row
-- carries last_seen so the reader can see how old the answer is.
--
-- NO DEALER IS NAMED. A list titled "longest sitting" beside a business name is
-- an implication about that business, and this catalogue makes no such claim.
-- City, vehicle and duration only.
--
-- KNOWN DEFECTS NOT FIXED HERE (logged 2026-09-03): cross-dealer attribution,
-- and a duration derived from a single observation. The second is excluded
-- below -- a listing seen exactly once has a span of zero days and tells us
-- nothing, so it is not eligible to top any list.

create or replace function public.top_days_on_lot(
  p_city  text,
  p_limit integer default 5
)
returns table (
  city           text,
  year           integer,
  make           text,
  model          text,
  -- NOT `trim`: it is a reserved word in Postgres (the trim() function) and a
  -- bare RETURNS TABLE column of that name is a syntax error.
  trim_name      text,
  days_observed  integer,
  first_seen     date,
  last_seen      date,
  asking         numeric
)
language sql
security definer
set search_path = public
stable
as $$
  select ds.city,
         vl.year, vl.make, vl.model, vl.trim as trim_name,
         (vl.last_seen_on - vl.first_seen_on)::integer as days_observed,
         vl.first_seen_on,
         vl.last_seen_on,
         coalesce(vl.sale_price, vl.list_price) as asking
  from public.vehicle_listing vl
  join public.dealer_source ds on ds.id = vl.dealer_id
  where ds.province = 'AB'
    and lower(ds.city) = lower(p_city)
    and vl.delisted_on is null
    and coalesce(vl.damaged, false) = false
    -- A single observation is a span of zero and proves nothing about how long
    -- a car has sat. Excluded rather than ranked.
    and vl.last_seen_on > vl.first_seen_on
  order by (vl.last_seen_on - vl.first_seen_on) desc, vl.year desc
  limit greatest(1, least(coalesce(p_limit, 5), 50));
$$;

comment on function public.top_days_on_lot(text, integer) is
  'Longest-observed listings for one Alberta city. days_observed is OUR observation span, not the dealer''s date_entry and not a claim the car is still there. No dealer is named.';

revoke all on function public.top_days_on_lot(text, integer) from public;
grant execute on function public.top_days_on_lot(text, integer) to anon, authenticated, service_role;
