-- ============================================================================
-- ONE CAR, COUNTED ONCE, CREDITED ONLY TO A DEALER WE ARE SURE OF.
--
-- Found 2026-09-24 by calling fn_market_comps with the public anon key:
--
--   2026 Toyota RAV4, new, AB, exact year  -> 10 rows, ALL "AUDI EDMONTON NORTH,
--                                             Edmonton". An Audi store does not
--                                             carry ten new Toyotas.
--   2024 Toyota RAV4, used, AB, +/-1 year  -> 22 rows, 11 "AUDI EDMONTON NORTH";
--                                             two of them the SAME cars Canyon
--                                             Creek Toyota lists (2024 Trail
--                                             $44,888 21,663 km; 2025 XLE $42,900
--                                             20,754 km); 3 more named "N/A".
--
-- WHAT WAS ACTUALLY WRONG. dealer_source id 22 is https://www.jpautogroup.com --
-- the Jim Pattison Auto Group's GROUP site, one Convertus sitemap enumerating
-- every rooftop in the group: 2,800 live units, 30 makes, 17 of them new-car
-- makes. AMVIC lists that website for two different licensees (AUDI EDMONTON
-- NORTH, Edmonton; CANYON CREEK TOYOTA (2018), Calgary), and discover-dealer-
-- feeds kept the FIRST licensee per host by AMVIC id order -- so the whole
-- group was filed as one Audi store in Edmonton. The crawl then credited every
-- VDP in the host's sitemap to that row without reading the unit's own
-- company_data. Canyon Creek's own site listed 61 of the same VINs, hence the
-- duplicates. The "N/A" names are AMVIC's placeholder trade_name, copied
-- verbatim by the same script (build-dealer-catalog already filtered it).
--
-- Not only this host. Live VINs listed at >1 dealer on 2026-09-24: 1,082
-- (2,213 rows) -- Okotoks GM + Shaw GMC share 967, Lakewood Chev + Sherwood
-- Buick GMC + Sherwood Park Chev share 49, jpautogroup + Canyon Creek 61.
--
-- THIS MIGRATION (nothing is deleted; every change is reversible):
--   1. dealer_source.group_feed -- a host whose feed covers more than one
--      rooftop. Its rows cannot be credited to any one dealer, city or even
--      province (the Pattison group spans BC), so they never enter a comp.
--      jpautogroup.com is flagged and deactivated so the crawl stops walking
--      it. Its 2,800 rows stay in vehicle_listing untouched; removing them is
--      a separate decision (see the PR), not something a migration does.
--   2. fn_comp_pool -- the ONE place both named-dealer RPCs read listings from:
--        * group feeds excluded;
--        * one row per VIN (a car cross-listed by two dealers counts once);
--        * one row per used car by year + trim + price + exact km when the
--          odometer reads >= 1,000 km -- an exact reading on a used car is a
--          fingerprint. NOT applied to new cars: ten identical new XLEs at the
--          same price with 8 km are ten cars;
--        * when the surviving car was listed by MORE THAN ONE dealer, it keeps
--          its price and loses its dealer name, city and key. We cannot tell
--          which dealer really has it, and printing the wrong business beside
--          a price is the entity-match error [[ai-defamation-entity-match]];
--        * AMVIC's "N/A" placeholder is never printed as a business name.
--   3. fn_market_comps and fn_comparable_listings read fn_comp_pool. Same
--      signatures, same output keys; fn_market_comps adds dealerKey so the
--      report can count dealers without keying on a display name (two nameless
--      dealers in one city used to count as one).
--      fn_comparable_listings now also drops severely-damaged units, as
--      fn_market_comps always did -- a salvage car is not a comparable.
-- ============================================================================

alter table public.dealer_source
  add column if not exists group_feed boolean not null default false;

comment on column public.dealer_source.group_feed is
  'Host publishes more than one rooftop''s inventory (a dealer-group site). Its listings are never credited to a single dealer, city or province, so fn_comp_pool excludes them.';

update public.dealer_source
   set group_feed = true,
       active     = false,
       last_error = 'group feed: one sitemap for every Jim Pattison Auto Group rooftop (AMVIC lists this site for AUDI EDMONTON NORTH and CANYON CREEK TOYOTA (2018)); not creditable to one dealer'
 where host = 'https://www.jpautogroup.com';

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
    select vl.dealer_id, vl.vin, coalesce(vl.sale_price, vl.list_price)::numeric as price,
           vl.odometer_km, vl.trim, vl.year, vl.make, vl.model, vl.condition,
           vl.first_seen_on, vl.last_seen_on, coalesce(vl.certified, false) as certified,
           ds.name, ds.city, ds.active
      from public.vehicle_listing vl
      join public.dealer_source ds on ds.id = vl.dealer_id
     where lower(vl.make)  = lower(p_make)
       and lower(vl.model) = lower(p_model)
       and vl.condition    = p_condition
       and vl.delisted_on is null
       and coalesce(vl.damaged, false) = false
       and coalesce(vl.sale_price, vl.list_price) > 0
       and ds.province = p_province
       and not ds.group_feed
       and vl.year between p_year_from and p_year_to
       and (p_exclude_vin is null or vl.vin <> p_exclude_vin)
  ),
  -- (dealer_id, vin) is unique, so more than one row per VIN = more than one dealer.
  one_per_vin as (
    select distinct on (vin) *, count(*) over (partition by vin) > 1 as vin_contested
      from live
     order by vin, active desc, last_seen_on desc, dealer_id
  ),
  keyed as (
    select *, case when p_condition = 'used' and odometer_km >= 1000
                   then concat_ws('|', year, lower(coalesce(trim, '')), price, odometer_km)
                   else vin end as car_key
      from one_per_vin
  ),
  one_per_car as (
    select distinct on (car_key) *,
           bool_or(vin_contested) over w or min(dealer_id) over w <> max(dealer_id) over w as contested
      from keyed
    window w as (partition by car_key)
     order by car_key, active desc, last_seen_on desc, dealer_id
  )
  select case when contested then null else dealer_id end,
         vin, price, odometer_km, trim, year, make, model, condition,
         first_seen_on, last_seen_on, certified,
         case when contested or name ~* '^\s*n/?a\s*$' then null else name end,
         case when contested then null else city end
    from one_per_car
$$;

-- Internal: read only through the two RPCs below (SECURITY DEFINER, so they
-- run it as the owner). Never callable with the anon key directly -- it
-- returns VINs.
revoke all on function public.fn_comp_pool(text, text, text, text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.fn_comp_pool(text, text, text, text, integer, integer, text) to service_role;

create or replace function public.fn_market_comps(
  p_year        integer,
  p_make        text,
  p_model       text,
  p_condition   text,
  p_exclude_vin text default null,
  p_province    text default 'AB',
  p_year_span   integer default 1,
  p_limit       integer default 300
)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'price',      price,
               'odometerKm', odometer_km,
               'trim',       trim_name,
               'year',       year,
               'asOf',       to_char(last_seen_on, 'YYYY-MM-DD'),
               'certified',  certified,
               'dealerName', dealer_name,
               'city',       city,
               'dealerKey',  dealer_key
             )
             order by price
           ),
           '[]'::jsonb
         )
  from (
    select *
      from public.fn_comp_pool(p_make, p_model, p_condition, p_province,
                               p_year - greatest(0, coalesce(p_year_span, 1)),
                               p_year + greatest(0, coalesce(p_year_span, 1)),
                               p_exclude_vin)
     order by price
     limit greatest(1, least(coalesce(p_limit, 300), 500))
  ) q
$$;

revoke all on function public.fn_market_comps(integer, text, text, text, text, text, integer, integer) from public;
grant execute on function public.fn_market_comps(integer, text, text, text, text, text, integer, integer) to anon, authenticated;

create or replace function public.fn_comparable_listings(
  p_year integer,
  p_make text,
  p_model text,
  p_condition text,
  p_exclude_vin text default null,
  p_trim text default null,
  p_odometer_km integer default null,
  p_province text default 'AB',
  p_limit integer default 3
)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(row_data order by rn), '[]'::jsonb)
  from (
    select
      jsonb_build_object(
        'dealerName', c.dealer_name,
        'city', c.city,
        'year', c.year,
        'make', c.make,
        'model', c.model,
        'trim', c.trim_name,
        'odometerKm', c.odometer_km,
        'price', c.price,
        'condition', c.condition,
        'firstSeenOn', to_char(c.first_seen_on, 'YYYY-MM-DD')
      ) as row_data,
      row_number() over (
        order by
          -- Same trim first, then closest odometer for a used comparison, then
          -- price (unchanged from 20260820_fn_comparable_listings.sql).
          case when p_trim is not null and lower(c.trim_name) = lower(p_trim) then 0 else 1 end,
          case when p_condition = 'used' and p_odometer_km is not null and c.odometer_km is not null
            then abs(c.odometer_km - p_odometer_km) end asc nulls last,
          c.price asc nulls last
      ) as rn
    from public.fn_comp_pool(p_make, p_model, p_condition, p_province, p_year, p_year, p_exclude_vin) c
  ) ranked
  where rn <= greatest(1, least(coalesce(p_limit, 3), 10))
$$;

revoke all on function public.fn_comparable_listings(integer, text, text, text, text, text, integer, text, integer) from public;
grant execute on function public.fn_comparable_listings(integer, text, text, text, text, text, integer, text, integer) to anon, authenticated;

-- @assert: (select group_feed and not active from public.dealer_source where host = 'https://www.jpautogroup.com')
-- @assert: (select count(*) = count(distinct vin) from public.fn_comp_pool('Toyota', 'RAV4', 'used', 'AB', 2023, 2025, null))
-- @assert: (select count(*) = 0 from jsonb_array_elements(public.fn_market_comps(2026, 'Toyota', 'RAV4', 'new', null, 'AB', 0, 300)) e where e->>'dealerName' = 'AUDI EDMONTON NORTH')
-- @assert: (select count(*) = 1 from jsonb_array_elements(public.fn_market_comps(2024, 'Toyota', 'RAV4', 'used', null, 'AB', 1, 300)) e where (e->>'price')::numeric = 44888 and (e->>'odometerKm')::int = 21663)
-- @assert: (select count(*) = 0 from jsonb_array_elements(public.fn_market_comps(2024, 'Toyota', 'RAV4', 'used', null, 'AB', 1, 300)) e where e->>'dealerName' ~* '^\s*n/?a\s*$')
