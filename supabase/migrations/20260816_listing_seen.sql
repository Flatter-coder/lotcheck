-- ============================================================================
-- Universal first-seen: every VIN we scan, on every platform.
--
-- Days-on-lot fails 100% of the time. Only SM360 and Convertus publish a lot
-- date, and the own-engine fallback reads vehicle_listing — which is filled by
-- crawl-alberta-inventory.mjs, hardcoded to `platform: "sm360"`. So a VW store
-- on FoxDealer, a Dealer.com site, an independent: nothing, forever.
--
-- The obvious fix is a fetcher per platform. That is the wrong shape: N
-- scrapers to write, N to maintain, each one a fresh breakage, and a brand new
-- platform is a gap again by default. The class recurs.
--
-- THIS is the structural fix: LotCheck already visits every listing a buyer
-- scans. Record the VIN and the moment we saw it, every time, and coverage
-- becomes platform-agnostic by construction. Nothing to maintain per platform,
-- nothing to keep in sync, and a new dealer platform is covered the first time
-- anyone runs a check on it.
--
-- It is a LOWER BOUND, and the report already says so — captureOwnDaysOnLot
-- sets atLeast:true and the card reads "at least N days". A car may have sat
-- long before we first saw it. A floor stated as a floor is honest and useful;
-- a floor stated as a total is what a dealer takes apart.
--
-- The trade: it counts from first sight, so it is worth nothing on day one and
-- more every week. vehicle_listing stays the better source where it has data —
-- a dealer's own inventory date is exact — so this only fills the gap beneath it.
--
-- NO PII. A VIN and a hostname describe a car and a shop, never a person, and
-- nothing here records who ran the scan.
-- ============================================================================

create table if not exists public.listing_seen (
  vin           text primary key check (vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  listing_host  text,
  times_seen    integer not null default 1
);
create index if not exists listing_seen_host_idx on public.listing_seen(listing_host, first_seen_at desc);
alter table public.listing_seen enable row level security;

-- first_seen_at is set ONCE and never moved. Re-scanning a car must not reset
-- its clock -- that would silently shorten every repeat listing's age, and the
-- cars people re-check are exactly the ones they are negotiating on.
create or replace function public.fn_note_listing_seen(
  p_vin text,
  p_host text default null
) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare v_first timestamptz;
begin
  if p_vin is null or p_vin !~ '^[A-HJ-NPR-Z0-9]{17}$' then return null; end if;

  insert into listing_seen (vin, listing_host)
  values (upper(p_vin), nullif(p_host,''))
  on conflict (vin) do update
    set last_seen_at = now(),
        times_seen   = listing_seen.times_seen + 1,
        listing_host = coalesce(listing_seen.listing_host, excluded.listing_host)
  returning first_seen_at into v_first;

  return v_first;
end $$;

revoke all on function public.fn_note_listing_seen(text, text) from public, anon, authenticated;
grant execute on function public.fn_note_listing_seen(text, text) to service_role;

-- Read for the days-on-lot fallback. Service role only: it is called from the
-- edge function during a scan, never from a browser.
create or replace function public.fn_listing_first_seen(p_vin text)
returns timestamptz
language sql security definer stable set search_path = public as $$
  select first_seen_at from listing_seen where vin = upper(p_vin);
$$;

revoke all on function public.fn_listing_first_seen(text) from public, anon, authenticated;
grant execute on function public.fn_listing_first_seen(text) to service_role;

-- Coverage, for the admin panel: how much of the days-on-lot gap this is
-- actually closing over time. Expected to be useless on day one and to climb.
create or replace function public.fn_admin_listing_seen_coverage()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.fn_can_read_costs() then raise exception 'not authorized' using errcode = '42501'; end if;
  select jsonb_build_object(
    'vins_tracked', (select count(*) from listing_seen),
    'oldest_first_seen', (select min(first_seen_at) from listing_seen),
    'aged_over_30d', (select count(*) from listing_seen where first_seen_at < now() - interval '30 days'),
    'hosts', (select count(distinct listing_host) from listing_seen where listing_host is not null)
  ) into v;
  return v;
end $$;

revoke all on function public.fn_admin_listing_seen_coverage() from public, anon;
grant execute on function public.fn_admin_listing_seen_coverage() to authenticated, service_role;
