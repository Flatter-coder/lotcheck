-- ============================================================================
-- fn_recent_listing_events (20260908) shipped and immediately failed its own
-- purpose the first time it was checked live: every one of the first 60 rows
-- returned was kind='new', none were 'price_move' or 'delisted', even though
-- 455 price moves and 305 delistings happened the same day.
--
-- WHY. first_seen_on, listing_price_history.observed_on and delisted_on are
-- all `date` columns -- no time-of-day. Every event from the same calendar
-- day ties at exactly midnight when cast to timestamptz, so `order by
-- event_at desc limit N` has no real ordering to fall back on within a day,
-- and Postgres is free to break the tie however it likes -- which turned out
-- to mean "new" rows happened to win every tie and crowd the other two kinds
-- out of the result entirely. The ticker existed to show a MIX of activity;
-- as shipped it could show only one kind and never notice.
--
-- FIX: rank each kind's rows independently (event_at desc, listing_id desc
-- for a stable tiebreak) and take a fair share of EACH kind before merging,
-- so a busy "new" day can never crowd price moves and delistings out of the
-- feed the way it just did. [[a-count-read-as-a-classification]] -- this is
-- the same family of bug: a limit that silently favours whichever rows
-- happen to sort first is a count masquerading as "the recent ones".
-- ============================================================================

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
  -- A fair share of EACH kind, ranked within itself, so a tie at day
  -- granularity can never let one kind crowd the other two out entirely.
  per_kind as (
    select e.*, row_number() over (partition by kind order by event_at desc, listing_id desc) as rn
      from events e
  ),
  ranked as (
    select pk.*, ds.city, ds.name as dealer_name
      from per_kind pk
      join vehicle_listing vl on vl.id = pk.listing_id
      join dealer_source ds on ds.id = vl.dealer_id
     where ds.city is not null
       and pk.rn <= ceil(greatest(least(coalesce(p_limit, 40), 200), 1) / 3.0)
     order by event_at desc, listing_id desc
     limit least(greatest(coalesce(p_limit, 40), 1), 200)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'kind', kind, 'eventAt', to_char(event_at, 'YYYY-MM-DD"T"HH24:MI:SSZ'),
    'year', year, 'make', make, 'model', model, 'trim', trim, 'condition', condition,
    'price', price, 'prevPrice', prev_price, 'city', city, 'dealerName', dealer_name
  ) order by event_at desc, kind), '[]'::jsonb)
  from ranked;
$$;
revoke all on function public.fn_recent_listing_events(int) from public;
grant execute on function public.fn_recent_listing_events(int) to anon, authenticated;
