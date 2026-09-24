-- ============================================================================
-- EVERY AGGREGATE COUNTS A CAR ONCE.
--
-- 20260924_comps_attribution.sql taught the two comps RPCs that one car listed
-- by two dealers is one car. Nothing else learned it. On 2026-09-24, 1,082 live
-- VINs (2,213 rows) sat at more than one dealer_source row, and every
-- aggregate still counted rows. Before -> after, both migrations trial-applied
-- in a rolled-back transaction against the live data:
--
--   inventory_daily_counts     listings_live 11,588 -> 7,720; listings_total
--                              12,636 -> 8,752; dealers_live 35 -> 34
--   fn_crawl_coverage (public) totalUsed 4,428 -> 2,688; dealers 34 -> 33;
--                              modelsGauge 104 -> 75; Calgary used 1,909 -> 949
--   fn_alberta_msrp_deviation  n 4,476 -> 1,624; over_share 3.9% -> 8.9%
--   top_days_on_lot            Edmonton's top 5 were group-feed Konas
--   fn_admin_lot_leverage_summary  same row counting, per city/bucket
--
-- Most of each drop is the jpautogroup group feed (2,800 rows) leaving; the
-- rest is 1,068 duplicate rows of cars listed twice, and 843 cars whose
-- dealers disagree on new vs used (842 of them Okotoks 'new' / Shaw 'used')
-- leaving both the new and the used counts.
--
-- WHAT THE CLUSTERS ARE (read-only, 2026-09-24):
--   * okotoksgm.com (29) + shawgmc.com (68): 967 shared VINs, 958 with the SAME
--     stock number. Both feeds carry the same three stock-number codes (OG, SG,
--     CG) across Chevrolet, Buick and GMC alike, so the codes are rooftops, not
--     makes: each host publishes one shared multi-rooftop GM pool. Neither is
--     "the" rooftop for a shared car. Shaw's jsonld_itemlist rows are all
--     labelled 'used' although 964 of 1,248 read under 200 km; 842 of the
--     shared cars are 'new' at Okotoks and 'used' at Shaw.
--   * lakewoodchev.com (9) + sherwoodbuickgmc.com (32) + sherwoodparkchev.com
--     (33): 49 used cars, same stock numbers, on all three sites; 32 and 33
--     list nothing else. A shared used pool. Last observed 2026-08-18.
--   * jpautogroup.com (22) + canyoncreektoyota.com (6): 22 is the Pattison
--     group feed (15 new-car makes; AMVIC lists the site for two licensees).
--     6 is the true rooftop (Toyota only; AMVIC lists its own site for it).
--   first_seen_on order decides none of them: it follows the date each host
--   was added to dealer_source, not which dealer holds the car.
--
-- THIS MIGRATION (nothing is deleted, no flag is changed):
--   1. fn_listing_once(p_day) -- the ONE definition of "a car on sale":
--        * group feeds excluded (dealer_source.group_feed);
--        * one row per VIN;
--        * dealer_id only when exactly one dealer lists the car; dealer_ids
--          always carries every dealer that does, so dealer COUNTS stay right;
--        * city / province only when every listing dealer agrees;
--        * condition only when every listing dealer agrees -- a car one dealer
--          calls new and another calls used is in neither bucket, not in both;
--        * damaged if ANY listing says damaged;
--        * first_seen_on / last_seen_on span every listing of the car.
--      p_day null = listed now (delisted_on is null); p_day = a date = observed
--      on that date (listing_observation), for the daily inventory report.
--   2. fn_comp_pool reads it, so the comps and the counters share one rule.
--      Its used-car year+trim+price+km fingerprint stays on top.
--   3. The five aggregates above read it. inventory_daily_counts' change
--      counts (first seen, delisted, price moves) count distinct VINs outside
--      group feeds, and "first seen" means first seen ANYWHERE.
--   scripts/build-city-price-index.mjs and build-alberta-inventory-daily.mjs
--   read it through PostgREST with the service key.
--
-- Depends on 20260924_comps_attribution.sql (dealer_source.group_feed).
-- ============================================================================

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'dealer_source'
                    and column_name = 'group_feed') then
    raise exception 'dealer_source.group_feed does not exist: apply 20260924_comps_attribution.sql first';
  end if;
end $$;

create or replace function public.fn_listing_once(p_day date default null)
returns table (
  vin               text,
  dealer_id         bigint,
  dealer_ids        bigint[],
  city              text,
  province          text,
  year              integer,
  make              text,
  model             text,
  trim_name         text,
  condition         text,
  odometer_km       integer,
  msrp              numeric,
  list_price        numeric,
  sale_price        numeric,
  days_in_inventory integer,
  certified         boolean,
  demo              boolean,
  damaged           boolean,
  updated_at        timestamptz,
  first_seen_on     date,
  last_seen_on      date
)
-- No SET search_path and not SECURITY DEFINER, on purpose: that keeps it
-- inlinable, so a caller reading four columns does not materialise twenty-one
-- (80 ms -> 30 ms measured). Every relation is schema-qualified instead.
language sql stable as $$
  with listed as (
    select vl.vin, vl.dealer_id, ds.city, ds.province, ds.active,
           vl.year, vl.make, vl.model, vl.trim, vl.condition, vl.odometer_km, vl.msrp,
           vl.list_price, vl.sale_price, vl.days_in_inventory, vl.certified, vl.demo,
           coalesce(vl.damaged, false) as damaged, vl.updated_at,
           vl.first_seen_on, vl.last_seen_on
      from public.vehicle_listing vl
      join public.dealer_source ds on ds.id = vl.dealer_id
     where not ds.group_feed
       and case when p_day is null then vl.delisted_on is null
                else exists (select 1 from public.listing_observation o
                              where o.listing_id = vl.id and o.observed_on = p_day) end
  ),
  -- (dealer_id, vin) is unique, so n > 1 means more than one dealer. One
  -- window, one sort: the frame is the whole VIN, the order only picks which
  -- listing supplies the car's price and trim (same order as fn_comp_pool).
  per_car as (
    select l.*,
           row_number() over w as pick,
           count(*) over f as n,
           array_agg(dealer_id) over f as all_ids,
           count(city) over f = count(*) over f
             and min(lower(btrim(city))) over f = max(lower(btrim(city))) over f as one_city,
           count(province) over f = count(*) over f
             and min(province) over f = max(province) over f as one_province,
           min(condition) over f = max(condition) over f as one_condition,
           bool_or(damaged) over f as any_damaged,
           min(first_seen_on) over f as first_seen,
           max(last_seen_on) over f as last_seen
      from listed l
    window w as (partition by vin order by active desc, last_seen_on desc, dealer_id),
           f as (w rows between unbounded preceding and unbounded following)
  )
  select vin,
         case when n = 1 then dealer_id end,
         all_ids,
         case when one_city then city end,
         case when one_province then province end,
         year, make, model, trim,
         case when one_condition then condition end,
         odometer_km, msrp, list_price, sale_price, days_in_inventory, certified, demo,
         any_damaged, updated_at, first_seen, last_seen
    from per_car
   where pick = 1
$$;

comment on function public.fn_listing_once(date) is
  'One row per car on sale (p_day null) or observed on p_day, group feeds excluded. dealer_id/city/province/condition are null unless every listing dealer agrees; dealer_ids lists them all. Internal: returns VINs, never granted to anon.';

-- Returns VINs. Read by the definer RPCs below and by service-role scripts only.
revoke all on function public.fn_listing_once(date) from public, anon, authenticated;
grant execute on function public.fn_listing_once(date) to service_role;

-- fn_comp_pool: same signature and output as 20260924_comps_attribution.sql.
-- The per-VIN step now comes from fn_listing_once, which dedupes across ALL
-- live listings before filtering. Deduping inside the make/model/condition
-- filter missed a car one dealer lists as new and another as used: it landed
-- in the new pool under one dealer's name AND the used pool under the other's.
create or replace function public.fn_comp_pool(
  p_make        text,
  p_model       text,
  p_condition   text,
  p_province    text,
  p_year_from   integer,
  p_year_to     integer,
  p_exclude_vin text default null
)
returns table (
  dealer_key    bigint,
  vin           text,
  price         numeric,
  odometer_km   integer,
  trim_name     text,
  year          integer,
  make          text,
  model         text,
  condition     text,
  first_seen_on date,
  last_seen_on  date,
  certified     boolean,
  dealer_name   text,
  city          text
)
language sql stable security definer set search_path = public as $$
  with live as (
    select c.dealer_id, c.vin, coalesce(c.sale_price, c.list_price)::numeric as price,
           c.odometer_km, c.trim_name, c.year, c.make, c.model, c.condition,
           c.first_seen_on, c.last_seen_on, coalesce(c.certified, false) as certified,
           ds.name, c.city, ds.active
      from public.fn_listing_once() c
      left join public.dealer_source ds on ds.id = c.dealer_id
     where lower(c.make)  = lower(p_make)
       and lower(c.model) = lower(p_model)
       and c.condition    = p_condition
       and not c.damaged
       and coalesce(c.sale_price, c.list_price) > 0
       and c.province = p_province
       and c.year between p_year_from and p_year_to
       and (p_exclude_vin is null or c.vin <> p_exclude_vin)
  ),
  keyed as (
    select *, case when p_condition = 'used' and odometer_km >= 1000
                   then concat_ws('|', year, lower(coalesce(trim_name, '')), price, odometer_km)
                   else vin end as car_key
      from live
  ),
  -- dealer_id is null when fn_listing_once found the VIN at more than one dealer.
  one_per_car as (
    select distinct on (car_key) *,
           bool_or(dealer_id is null) over w or min(dealer_id) over w <> max(dealer_id) over w as contested
      from keyed
    window w as (partition by car_key)
     order by car_key, active desc nulls last, last_seen_on desc, dealer_id
  )
  select case when contested then null else dealer_id end,
         vin, price, odometer_km, trim_name, year, make, model, condition,
         first_seen_on, last_seen_on, certified,
         case when contested or name ~* '^\s*n/?a\s*$' then null else name end,
         case when contested then null else city end
    from one_per_car
$$;

revoke all on function public.fn_comp_pool(text, text, text, text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.fn_comp_pool(text, text, text, text, integer, integer, text) to service_role;

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
  -- Counts CARS, not rows: a car on two dealers' sites is one car, and a
  -- group feed is not a dealer. Still counts only -- nothing identifies a car.
  with creditable as (
    select vl.id, vl.vin, vl.first_seen_on, vl.delisted_on
      from vehicle_listing vl
      join dealer_source ds on ds.id = vl.dealer_id
     where not ds.group_feed
  )
  select
    (select count(distinct vin) from creditable),
    (select count(*) from fn_listing_once()),
    (select count(distinct d) from fn_listing_once() c cross join lateral unnest(c.dealer_ids) d),
    -- first seen ANYWHERE: a car appearing on a second dealer's site is not new.
    (select count(*) from (select vin from creditable group by vin
                            having min(first_seen_on) >= current_date - 1) x),
    -- observed to have stopped appearing. NOT sold. A delisting is not a sale:
    -- a car leaves a website because it sold, moved rooftop, or the feed broke.
    (select count(distinct vin) from creditable where delisted_on >= current_date - 1),
    -- listing_price_history only gets a row when a price actually MOVED; a car
    -- whose price moved on two sites moved once.
    (select count(distinct c.vin) from listing_price_history h
       join creditable c on c.id = h.listing_id
      where h.observed_on >= current_date - 1),
    -- The newest thing we personally observed. When this is not today, the
    -- crawl did not run and every count above is a count of stale state.
    (select max(last_seen_on) from vehicle_listing);
$$;

comment on function public.inventory_daily_counts() is
  'Aggregate counts for the daily report, one per car (fn_listing_once), group feeds excluded. Counts only, no row data. delisted_24h means observed to have stopped appearing, never sold.';

revoke all on function public.inventory_daily_counts() from public;
grant execute on function public.inventory_daily_counts() to anon, authenticated, service_role;

-- top_days_on_lot: a car listed in two cities has no city, so it tops neither
-- list; its span runs from the first listing we saw to the last.
create or replace function public.top_days_on_lot(
  p_city  text,
  p_limit integer default 5
)
returns table (
  city           text,
  year           integer,
  make           text,
  model          text,
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
  select c.city,
         c.year, c.make, c.model, c.trim_name,
         (c.last_seen_on - c.first_seen_on)::integer as days_observed,
         c.first_seen_on,
         c.last_seen_on,
         coalesce(c.sale_price, c.list_price) as asking
  from public.fn_listing_once() c
  where c.province = 'AB'
    and lower(c.city) = lower(p_city)
    and not c.damaged
    -- A single observation is a span of zero and proves nothing about how long
    -- a car has sat. Excluded rather than ranked.
    and c.last_seen_on > c.first_seen_on
  order by (c.last_seen_on - c.first_seen_on) desc, c.year desc
  limit greatest(1, least(coalesce(p_limit, 5), 50));
$$;

comment on function public.top_days_on_lot(text, integer) is
  'Longest-observed cars for one Alberta city, one row per car (fn_listing_once). days_observed is OUR observation span, not the dealer''s date_entry and not a claim the car is still there. No dealer is named.';

revoke all on function public.top_days_on_lot(text, integer) from public;
grant execute on function public.top_days_on_lot(text, integer) to anon, authenticated, service_role;

-- fn_crawl_coverage: unchanged except the source set. dealers counts every
-- dealer listing a counted car, so a shared car does not hide either dealer.
create or replace function public.fn_crawl_coverage(p_province text default 'AB')
returns jsonb language sql stable security definer set search_path = public as $$
  with used as (
    select c.make, c.model, c.year,
           coalesce(c.sale_price, c.list_price)::numeric as price,
           c.last_seen_on, c.dealer_ids, c.city
    from public.fn_listing_once() c
    where c.condition = 'used'
      and not c.damaged
      and coalesce(c.sale_price, c.list_price) > 0
      and c.province = p_province
  ),
  -- the gauge window: the same 2020–2024 the /crawl gauge fetches (2022 ±2yr).
  recent as (
    select make, model, price from used where year between 2020 and 2024
  ),
  model_med as (
    select make, model, percentile_cont(0.5) within group (order by price) as med
    from recent group by make, model having count(*) >= 5
  ),
  -- per model: outlier-trim to 0.4x–2.0x the median, then count / range on the
  -- survivors — mirrors computeBand and the /crawl gauge reducer so the RANGE and
  -- the "N comps" agree with the gauge exactly. Kept-count floor of 5.
  model_band as (
    select r.make, r.model, mm.med,
           count(*) filter (where r.price >= mm.med * 0.4 and r.price <= mm.med * 2.0) as n,
           min(r.price) filter (where r.price >= mm.med * 0.4 and r.price <= mm.med * 2.0) as lo,
           max(r.price) filter (where r.price >= mm.med * 0.4 and r.price <= mm.med * 2.0) as hi
    from recent r
    join model_med mm on mm.make = r.make and mm.model = r.model
    group by r.make, r.model, mm.med
    having count(*) filter (where r.price >= mm.med * 0.4 and r.price <= mm.med * 2.0) >= 5
  ),
  models as (
    select make, model, n, med, lo, hi from model_band order by n desc limit 40
  ),
  cities as (
    select city, count(*) as n from used where city is not null group by city order by count(*) desc
  )
  select jsonb_build_object(
    'province',       p_province,
    'totalUsed',      (select count(*) from used),
    'dealers',        (select count(distinct d) from used cross join lateral unnest(used.dealer_ids) d),
    'cities',         (select coalesce(jsonb_agg(jsonb_build_object('city', city, 'n', n) order by n desc), '[]'::jsonb) from cities),
    'models',         (select coalesce(jsonb_agg(jsonb_build_object('make', make, 'model', model, 'n', n, 'lo', round(lo), 'med', round(med), 'hi', round(hi)) order by n desc), '[]'::jsonb) from models),
    'modelsWithData', (select count(*) from (select 1 from used group by make, model) x),
    'modelsGauge',    (select count(*) from model_band),
    'freshest',       (select to_char(max(last_seen_on), 'YYYY-MM-DD') from used)
  )
$$;

revoke all on function public.fn_crawl_coverage(text) from public;
grant execute on function public.fn_crawl_coverage(text) to anon, authenticated;

-- fn_admin_lot_leverage_summary: a car listed in two cities reports under a
-- null city; a car whose dealers disagree on new vs used is bucketed 'unknown'
-- rather than silently 'used'.
create or replace function public.fn_admin_lot_leverage_summary()
returns table (
  city                    text,
  bucket                  text,
  n_units                 integer,
  n_missing_days_stated   integer,
  avg_days_dealer_stated  numeric,
  max_days_dealer_stated  integer,
  avg_days_observed       numeric,
  max_days_observed       integer,
  avg_cut_to_date_dollars numeric
)
language plpgsql security definer set search_path = public as $$
begin
  if not public.fn_can_read_costs() then raise exception 'not authorized' using errcode = '42501'; end if;
  return query
    select
      l.city,
      case when l.demo then 'demo' when l.certified then 'certified'
           when l.condition = 'new' then 'new' when l.condition = 'used' then 'used'
           else 'unknown' end as bucket,
      count(*)::int as n_units,
      count(*) filter (where l.days_in_inventory is null)::int as n_missing_days_stated,
      round(avg(l.days_in_inventory) filter (where l.days_in_inventory is not null), 1) as avg_days_dealer_stated,
      max(l.days_in_inventory) as max_days_dealer_stated,
      round(avg(current_date - l.first_seen_on), 1) as avg_days_observed,
      max(current_date - l.first_seen_on) as max_days_observed,
      round(avg(l.list_price - l.sale_price) filter (where l.list_price is not null and l.sale_price is not null), 0) as avg_cut_to_date_dollars
    from public.fn_listing_once() l
    group by l.city, bucket
    order by l.city, n_units desc;
end $$;

revoke all on function public.fn_admin_lot_leverage_summary() from public, anon;
grant execute on function public.fn_admin_lot_leverage_summary() to authenticated;

-- fn_alberta_msrp_deviation: body as live (20260812_deviation_counts.sql),
-- reading one row per car instead of every live row.
create or replace function public.fn_alberta_msrp_deviation(p_min_n int default 25)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_min   int := greatest(coalesce(p_min_n, 25), 25);
  v_n     int; v_med numeric; v_p25 numeric; v_p75 numeric;
  v_over  int; v_under int; v_at int; v_deal int;
  v_curve numeric[];
  v_med_disc numeric;
begin
  with d as (
    select ((l.sale_price - l.msrp) / l.msrp) * 100.0 as pct
      from public.fn_listing_once() l
     where l.msrp > 0 and l.sale_price > 0
       and l.condition = 'new'
  )
  select count(*),
         percentile_cont(0.5)  within group (order by pct),
         percentile_cont(0.25) within group (order by pct),
         percentile_cont(0.75) within group (order by pct),
         count(*) filter (where pct >  0.05),      -- a shade of tolerance for
         count(*) filter (where pct < -0.05),      -- rounding either side of 0
         count(*) filter (where pct between -0.05 and 0.05),
         percentile_cont(array[0,0.05,0.10,0.15,0.20,0.25,0.30,0.35,0.40,0.45,0.50,
                               0.55,0.60,0.65,0.70,0.75,0.80,0.85,0.90,0.95,1.0])
           within group (order by pct)
    into v_n, v_med, v_p25, v_p75, v_over, v_under, v_at, v_curve
    from d;

  -- The typical discount AMONG DISCOUNTED CARS. With half the market at
  -- sticker the overall median is 0, which is true but useless to a buyer
  -- asking "if they do move, how far do they move?"
  select percentile_cont(0.5) within group (order by pct) into v_med_disc
    from (select ((l.sale_price - l.msrp) / l.msrp) * 100.0 as pct
            from public.fn_listing_once() l
           where l.msrp > 0 and l.sale_price > 0
             and l.condition = 'new'
             and ((l.sale_price - l.msrp) / l.msrp) * 100.0 < -0.05) x;

  select count(distinct d) into v_deal
    from public.fn_listing_once() l cross join lateral unnest(l.dealer_ids) d
   where l.msrp > 0 and l.sale_price > 0 and l.condition = 'new';

  if coalesce(v_n, 0) < v_min then
    return jsonb_build_object('enough', false, 'n', coalesce(v_n, 0), 'min', v_min);
  end if;

  return jsonb_build_object(
    'enough', true, 'n', v_n, 'dealers', v_deal,
    'median', round(v_med, 2), 'p25', round(v_p25, 2), 'p75', round(v_p75, 2),
    'over_n', v_over, 'under_n', v_under, 'at_n', v_at,
    'over_share',  round((v_over::numeric  / v_n) * 100, 1),
    'under_share', round((v_under::numeric / v_n) * 100, 1),
    'median_discount', round(coalesce(v_med_disc, 0), 2),
    'curve', (select jsonb_agg(round(x, 2) order by ord)
                from unnest(v_curve) with ordinality as t(x, ord))
  );
end; $$;

revoke all on function public.fn_alberta_msrp_deviation(int) from public;
grant execute on function public.fn_alberta_msrp_deviation(int) to anon, authenticated;

-- Each post-condition is computed without fn_listing_once. The first five were
-- evaluated against 20260924_comps_attribution.sql alone and all came back
-- false; the last is that migration's own check, re-run because fn_comp_pool
-- changed.
-- @assert: (select listings_live = (select count(distinct vl.vin) from public.vehicle_listing vl join public.dealer_source ds on ds.id = vl.dealer_id where vl.delisted_on is null and not ds.group_feed) from public.inventory_daily_counts())
-- @assert: (select dealers_live = (select count(distinct vl.dealer_id) from public.vehicle_listing vl join public.dealer_source ds on ds.id = vl.dealer_id where vl.delisted_on is null and not ds.group_feed) from public.inventory_daily_counts())
-- @assert: (select (public.fn_crawl_coverage('AB')->>'totalUsed')::int <= (select count(distinct vl.vin) from public.vehicle_listing vl join public.dealer_source ds on ds.id = vl.dealer_id where vl.delisted_on is null and not ds.group_feed and vl.condition = 'used' and ds.province = 'AB'))
-- @assert: (select (public.fn_alberta_msrp_deviation(25)->>'n')::int <= (select count(distinct vl.vin) from public.vehicle_listing vl join public.dealer_source ds on ds.id = vl.dealer_id where vl.delisted_on is null and not ds.group_feed and vl.condition = 'new' and vl.msrp > 0 and vl.sale_price > 0))
-- @assert: (select not exists (select vin from public.fn_comp_pool('GMC', 'Sierra 1500', 'new', 'AB', 2020, 2027, null) intersect select vin from public.fn_comp_pool('GMC', 'Sierra 1500', 'used', 'AB', 2020, 2027, null)))
-- @assert: (select count(*) = count(distinct vin) from public.fn_comp_pool('Toyota', 'RAV4', 'used', 'AB', 2023, 2025, null))
