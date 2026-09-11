-- ============================================================================
-- TWO REAL FEATURES, NOT TWO FAKED ONES: per-city inventory counts, and a
-- live per-listing event feed. The compact-dashboard mockup this session
-- worked from assumed both existed; they didn't. This builds them for real
-- rather than relabelling something else to look like them.
--
-- PART 1 — city_inventory_daily. NOT the same thing as city_dealer_index.
-- city_dealer_index (20260817) counts listings that matched a catalog MSRP
-- row -- a subset used for the price-index feature. Adding "how many cars are
-- actually for sale" columns to that same table would put two different
-- countable things behind two similarly-named columns on one row -- the
-- "count read as a classification" shape this repo has broken on before.
-- This is its own table, its own script step, its own RPC.
--
-- SAME k-anonymity POSTURE AS city_dealer_index: a city with fewer than
-- MIN_DEALERS (3, see build-city-price-index.mjs) active dealers is not
-- published here either -- one or two dealers' inventory count is close
-- enough to naming a specific dealer's lot size that the gate matters as
-- much here as it does for the price index.
--
-- PART 2 — fn_recent_listing_events. Every other public RPC in this system
-- returns an AGGREGATE. This one deliberately does not: it names real, plain
-- facts about individual listings (year/make/model/trim, a dealer's own city
-- and name, an asking price) that are already public on the dealer's own
-- site -- the same posture as the rest of the product ("we read dealers' own
-- advertised prices from their public listings"). It never exposes a VIN or
-- stock number: neither is needed to show what happened, and both are more
-- identifying than a ticker needs to be. No accusation language anywhere --
-- a price rising reads exactly like a price falling, with no motive named.
-- ============================================================================

-- ---- 1) per-city daily inventory ------------------------------------------
create table if not exists public.city_inventory_daily (
  day                   date not null,
  city                  text not null,
  province              text not null default 'AB',
  computed_at           timestamptz not null,
  dealers_seen          integer not null,
  dealers_flagged       integer not null default 0,
  new_units_verified    integer not null,
  new_units_raw         integer not null,
  used_units_verified   integer not null,
  used_units_raw        integer not null,
  notes                 text,
  primary key (day, city, province)
);
alter table public.city_inventory_daily enable row level security;
create index if not exists ix_cid_day_desc on public.city_inventory_daily(day desc);

revoke all on public.city_inventory_daily from anon, authenticated;

comment on table public.city_inventory_daily is
  'Per-city daily new/used-for-sale counts, raw and plausibility-capped. A DIFFERENT measure from city_dealer_index (which counts only catalog-MSRP-matched listings for the price-index feature) -- do not conflate the two. Gated the same way: a city needs 3+ dealers seen before it is published, so no row can be read back to a single dealer''s lot size. Public read only through fn_city_inventory_daily; written only by scripts/build-alberta-inventory-daily.mjs.';

create or replace function public.fn_city_inventory_daily(p_days int default 14)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'day', to_char(day, 'YYYY-MM-DD'),
    'city', city,
    'province', province,
    'dealersSeen', dealers_seen,
    'dealersFlagged', dealers_flagged,
    'newUnitsVerified', new_units_verified,
    'newUnitsRaw', new_units_raw,
    'usedUnitsVerified', used_units_verified,
    'usedUnitsRaw', used_units_raw,
    'notes', notes
  ) order by day desc, used_units_verified desc), '[]'::jsonb)
  from (
    select * from city_inventory_daily
     where dealers_seen >= 3   -- same MIN_DEALERS gate as city_dealer_index
     order by day desc
     limit greatest(1, least(coalesce(p_days, 14), 60)) * 20  -- headroom for multiple cities per day
  ) recent;
$$;
revoke all on function public.fn_city_inventory_daily(int) from public;
grant execute on function public.fn_city_inventory_daily(int) to anon, authenticated;

-- ---- 2) recent listing events (new / price move / delisted) ---------------
create or replace function public.fn_recent_listing_events(p_limit int default 40)
returns jsonb language sql stable security definer set search_path = public as $$
  with price_moves as (
    select lph.listing_id, lph.observed_on,
           coalesce(lph.sale_price, lph.list_price) as price,
           lag(coalesce(lph.sale_price, lph.list_price)) over (partition by lph.listing_id order by lph.observed_on) as prev_price
      from listing_price_history lph
  ),
  events as (
    select 'new'::text as kind, vl.id as listing_id, vl.first_seen_on::timestamptz as event_at,
           vl.year, vl.make, vl.model, vl.trim, vl.condition,
           coalesce(vl.sale_price, vl.list_price) as price, null::numeric as prev_price
      from vehicle_listing vl
     where vl.first_seen_on >= current_date - 3
    union all
    -- prev_price IS DISTINCT FROM price: the first history row for a listing
    -- has no real prior price, and a re-write of the same price is not a move.
    select 'price_move', pm.listing_id, pm.observed_on::timestamptz,
           vl.year, vl.make, vl.model, vl.trim, vl.condition, pm.price, pm.prev_price
      from price_moves pm join vehicle_listing vl on vl.id = pm.listing_id
     where pm.observed_on >= current_date - 3
       and pm.prev_price is not null and pm.prev_price is distinct from pm.price
    union all
    select 'delisted', vl.id, vl.delisted_on::timestamptz,
           vl.year, vl.make, vl.model, vl.trim, vl.condition,
           coalesce(vl.sale_price, vl.list_price), null
      from vehicle_listing vl
     where vl.delisted_on is not null and vl.delisted_on >= current_date - 3
  ),
  ranked as (
    select e.*, ds.city, ds.name as dealer_name
      from events e
      join vehicle_listing vl on vl.id = e.listing_id
      join dealer_source ds on ds.id = vl.dealer_id
     where ds.city is not null
     order by e.event_at desc
     limit least(greatest(coalesce(p_limit, 40), 1), 200)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'kind', kind, 'eventAt', to_char(event_at, 'YYYY-MM-DD"T"HH24:MI:SSZ'),
    'year', year, 'make', make, 'model', model, 'trim', trim, 'condition', condition,
    'price', price, 'prevPrice', prev_price, 'city', city, 'dealerName', dealer_name
  ) order by event_at desc), '[]'::jsonb)
  from ranked;
$$;
revoke all on function public.fn_recent_listing_events(int) from public;
grant execute on function public.fn_recent_listing_events(int) to anon, authenticated;
