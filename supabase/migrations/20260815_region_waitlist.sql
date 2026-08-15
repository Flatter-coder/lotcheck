-- ============================================================================
-- region_waitlist — demand from provinces LotCheck does not serve yet.
--
-- A visitor who resolves outside Alberta is not a bounce, they are a signal.
-- Filing them by province turns the access gate into expansion inventory: when
-- the question "which province next" comes up, this table answers it with real
-- names instead of a guess. Same reasoning as the MSRP-alert folders.
--
-- MINIMAL BY DESIGN. An email and a coarse region. No IP, no city, no visitor
-- id, no browsing. The province already came from the network, so asking for it
-- again would be theatre; anything more would be collecting data we have no use
-- for, from someone we are declining to serve.
-- ============================================================================

create table if not exists public.region_waitlist (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  email      text not null,
  country    text,
  region     text
);

create index if not exists region_waitlist_region_idx on public.region_waitlist(region, created_at desc);
-- One row per address per region: a visitor who reloads the page should not
-- inflate the demand signal that decides where we expand.
create unique index if not exists region_waitlist_email_region_uidx
  on public.region_waitlist(lower(email), coalesce(region, ''));

alter table public.region_waitlist enable row level security;

-- Anonymous INSERT only. The person signing up is by definition not signed in,
-- and cannot be — they are being declined. They may add themselves and nothing
-- else: no select, no update, no delete, so the list cannot be read back out
-- by the same key that writes it.
drop policy if exists region_waitlist_anon_insert on public.region_waitlist;
create policy region_waitlist_anon_insert
  on public.region_waitlist for insert to anon, authenticated
  with check (email is not null and length(email) between 3 and 320);

-- ---- admin read -------------------------------------------------------------
-- Which provinces are asking, and how loudly.
create or replace function public.fn_admin_region_demand()
returns table (region text, country text, signups bigint, first_seen timestamptz, last_seen timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not public.fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return query
    select w.region, w.country, count(*)::bigint, min(w.created_at), max(w.created_at)
    from region_waitlist w
    group by w.region, w.country
    order by count(*) desc;
end $$;

revoke all on function public.fn_admin_region_demand() from public, anon;
grant execute on function public.fn_admin_region_demand() to authenticated;
