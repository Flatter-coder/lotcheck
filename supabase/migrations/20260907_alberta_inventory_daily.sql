-- ============================================================================
-- ALBERTA INVENTORY DAILY — a public, standing record of two counts: new
-- vehicles for sale and used vehicles for sale, by day.
--
-- WHY THIS TABLE EXISTS. The inventory crawl (crawl-alberta-inventory.mjs)
-- has read both new and used sections per dealer since it was built, and the
-- result has only ever lived in a GitHub Actions log -- gone the moment the
-- run scrolls past, visible to nobody outside an engineer reading that log.
-- Requested 2026-09-07: a live, public, daily figure with a preview/history.
--
-- SAME POSTURE AS city_dealer_index / province_market_read: a script computes
-- the aggregate OFFLINE and writes one small row; the underlying tables
-- (vehicle_listing, dealer_source, listing_observation) stay RLS-locked with
-- no client policy; a security-definer RPC is the only public surface, and it
-- can only ever return rows a trusted job already wrote.
--
-- RAW VS VERIFIED IS NOT OPTIONAL. The same day this was requested, one
-- dealer pass (Shaw GMC Chevrolet Buick) returned 5,163 of 6,285 used units in
-- a single crawl -- 82%, and no Alberta rooftop carries ten thousand vehicles.
-- That is under its own repair, but this table does not get to assume the
-- upstream fix always holds: scripts/build-alberta-inventory-daily.mjs applies
-- its OWN per-dealer plausibility cap when computing every row here, so a
-- second contaminated source is caught here too, not only upstream.
-- [[no-single-point-of-failure]] Every row therefore carries both a verified
-- figure (the cap applied) and a raw figure (before it), and how many dealers
-- were excluded and why, in `notes`.
-- ============================================================================

create table if not exists public.alberta_inventory_daily (
  day                   date primary key,
  computed_at           timestamptz not null,
  dealers_active        integer not null,
  dealers_seen          integer not null,      -- distinct dealers with at least one observation this day
  dealers_flagged       integer not null default 0,
  amvic_issued_hosts    integer,                -- denominator for coverage; null if that read failed
  new_units_raw         integer not null,
  new_units_verified    integer not null,
  used_units_raw        integer not null,
  used_units_verified   integer not null,
  arrived               integer not null,       -- listings with first_seen_on = day
  delisted              integer not null,       -- listings with delisted_on = day
  price_events          integer not null,       -- listing_price_history rows observed this day
  notes                 text,
  constraint aid_verified_le_raw check (
    new_units_verified <= new_units_raw and used_units_verified <= used_units_raw
  )
);
alter table public.alberta_inventory_daily enable row level security;
create index if not exists ix_aid_day_desc on public.alberta_inventory_daily(day desc);

revoke all on public.alberta_inventory_daily from anon, authenticated;

comment on table public.alberta_inventory_daily is
  'One row per crawl day: new/used vehicle-for-sale counts in Alberta, raw and plausibility-capped. Public read only through fn_alberta_inventory_daily; written only by scripts/build-alberta-inventory-daily.mjs (service role).';

-- ---- the one public read ---------------------------------------------------
create or replace function public.fn_alberta_inventory_daily(p_days int default 30)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'day', to_char(day, 'YYYY-MM-DD'),
    'computedAt', to_char(computed_at, 'YYYY-MM-DD"T"HH24:MI:SSZ'),
    'dealersActive', dealers_active,
    'dealersSeen', dealers_seen,
    'dealersFlagged', dealers_flagged,
    'amvicIssuedHosts', amvic_issued_hosts,
    'newUnitsRaw', new_units_raw,
    'newUnitsVerified', new_units_verified,
    'usedUnitsRaw', used_units_raw,
    'usedUnitsVerified', used_units_verified,
    'arrived', arrived,
    'delisted', delisted,
    'priceEvents', price_events,
    'notes', notes
  ) order by day desc), '[]'::jsonb)
  from (
    select * from alberta_inventory_daily
    order by day desc
    limit greatest(1, least(coalesce(p_days, 30), 180))
  ) recent;
$$;

revoke all on function public.fn_alberta_inventory_daily(int) from public;
-- Anon-callable on purpose: this is exactly the public feature requested, an
-- aggregate that already went through the plausibility cap before it was
-- written, same reasoning as fn_city_price_index.
grant execute on function public.fn_alberta_inventory_daily(int) to anon, authenticated;
