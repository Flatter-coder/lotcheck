-- ============================================================================
-- ALBERTA MARKET vs the CATALOG sticker — the read that replaces the dealer's
-- own number as the reference on /live-price-index.
--
-- WHY. fn_alberta_msrp_deviation compares each listing's asking price against
-- the MSRP the DEALER states on their own page. A dealer who prints
-- MSRP = asking price is invisible to that stat — proven 2026-08-19:
-- Southpointe Toyota Tacoma Hybrid, asking $89,130, page MSRP $89,130 — so the
-- "over sticker" count could read zero while a lot full of self-ratified
-- stickers sat over the factory figure. The reference has to be OURS:
-- msrp_catalog, matched per trim, exact basis only.
--
-- BASIS-AWARE BY BOUNDS. An Alberta advertised price is all-in by regulation;
-- a catalog MSRP usually is not (freight/PDI, fees). Only 28 of 1,084 catalog
-- rows hold the manufacturer's own all_in_price, so a point comparison would
-- gate this read forever. Instead each listing is judged against a WINDOW
-- [msrp, msrp + ceiling] where the ceiling covers every mandatory add the
-- row's basis can omit. Below the window = under (whatever the basis), above
-- it = over (whatever the basis), inside it = indeterminate — disclosed by
-- count, never silently dropped and never guessed into a direction. "At
-- sticker" is only callable where the row IS the all-in figure. Every stored
-- percentage is a FLOOR of the true distance from the all-in sticker.
-- The window math lives in scripts/build-city-price-index.mjs (regression-
-- tested by npm run test:market-catalog); this table only holds its output.
--
-- SAME POSTURE AS fn_alberta_msrp_deviation (20260812_msrp_deviation.sql):
-- the table is RLS-locked with no client policies; the security-definer RPC
-- is the only public surface; it returns aggregates only, behind a
-- k-anonymity floor of 25 directional calls; anon-callable on purpose because
-- the public index page is its only consumer.
--
-- Depends on: 20260811_alberta_inventory.sql (the listings the script reads),
-- 20260815_msrp_all_in_price.sql / 20260811_msrp_price_basis.sql (the basis
-- columns the window is built from).
-- ============================================================================

create table if not exists public.province_market_read (
  province                    text primary key,
  computed_at                 timestamptz not null,
  -- every live new listing that trim-matched a catalog row on basis "exact"
  n_matched                   integer not null,
  -- the subset that could be CALLED a direction (under / at / over). This is
  -- the k-anonymity n: indeterminate rows back no directional claim.
  n_directional               integer not null,
  n_dealers                   integer not null,
  under_n                     integer not null,
  at_n                        integer not null,
  over_n                      integer not null,
  indeterminate_n             integer not null,
  -- how many were judged against a manufacturer all-in figure (exact window)
  all_in_n                    integer not null default 0,
  -- floor percentages vs the all-in sticker; negative = under
  median_pct                  numeric,
  p25_pct                     numeric,
  p75_pct                     numeric,
  -- typical floor-discount AMONG the under set
  median_discount_pct         numeric,
  -- 21-point percentile curve (0,5,...,100) of the directional floor pcts
  curve                       jsonb,
  -- dealer-sticker inflation: exact matches that print their OWN sticker, and
  -- how many print one above the window ceiling for that exact trim
  sticker_stated_n            integer not null default 0,
  sticker_inflated_n          integer not null default 0,
  sticker_inflated_median_pct numeric,
  min_updated_at              timestamptz,
  max_updated_at              timestamptz,
  -- written by the build script, same discipline as city_dealer_index: no
  -- reader can talk a thin or stale read into publishing
  is_publishable              boolean not null default false
);
alter table public.province_market_read enable row level security;
revoke all on public.province_market_read from anon, authenticated;

create or replace function public.fn_alberta_market_vs_catalog(p_min_n int default 25)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  r     province_market_read%rowtype;
  v_min int := greatest(coalesce(p_min_n, 25), 25);
begin
  select * into r from province_market_read where province = 'AB';

  if not found then
    return jsonb_build_object('enough', false, 'n', 0, 'min', v_min);
  end if;

  -- Freshness is part of the claim. The row persists between pipeline runs,
  -- so a reading computed from listings that have since turned over must say
  -- WHEN it was true instead of posing as current. 7 days mirrors the build
  -- script's STALE_DAYS.
  if r.computed_at < now() - interval '7 days' then
    return jsonb_build_object('enough', false, 'n', coalesce(r.n_directional, 0),
                              'min', v_min, 'stale', true,
                              'as_of', to_char(r.computed_at, 'YYYY-MM-DD'));
  end if;

  if coalesce(r.n_directional, 0) < v_min or not r.is_publishable then
    return jsonb_build_object('enough', false, 'n', coalesce(r.n_directional, 0), 'min', v_min);
  end if;

  return jsonb_build_object(
    'enough',   true,
    'n',        r.n_directional,
    'n_matched', r.n_matched,
    'dealers',  r.n_dealers,
    -- Floors of distance from the all-in sticker. Negative = under.
    'median',   round(r.median_pct, 2),
    'p25',      round(r.p25_pct, 2),
    'p75',      round(r.p75_pct, 2),
    'under_n',  r.under_n,
    'at_n',     r.at_n,
    'over_n',   r.over_n,
    'indeterminate_n', r.indeterminate_n,
    'all_in_n', r.all_in_n,
    'median_discount', round(coalesce(r.median_discount_pct, 0), 2),
    'curve',    r.curve,
    'sticker_stated_n',   r.sticker_stated_n,
    'sticker_inflated_n', r.sticker_inflated_n,
    'sticker_inflated_median_pct', round(coalesce(r.sticker_inflated_median_pct, 0), 2),
    'as_of',    to_char(coalesce(r.max_updated_at, r.computed_at), 'YYYY-MM-DD'),
    -- whose sticker this measures — the page must never have to guess again
    'reference', 'catalog'
  );
end; $$;

revoke all on function public.fn_alberta_market_vs_catalog(int) from public;
-- Anon-callable on purpose, same reasoning as fn_alberta_msrp_deviation: an
-- aggregate behind a k-anonymity floor, and /live-price-index is its only
-- consumer.
grant execute on function public.fn_alberta_market_vs_catalog(int) to anon, authenticated;
