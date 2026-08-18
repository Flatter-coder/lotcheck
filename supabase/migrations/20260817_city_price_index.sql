-- ============================================================================
-- CITY PRICE INDEX — per-city advertised-price-vs-MSRP, computed from our own
-- Alberta inventory dataset (dealer_source / vehicle_listing).
--
-- WHY A TABLE, NOT A VIEW. The trim match that turns a dealer's listing trim
-- string ("SE Upgrade Nightshade") into a specific msrp_catalog row is real
-- logic (fuel partition, drivetrain scoring, token overlap — see
-- supabase/functions/_shared/trim-match.js), not a join condition SQL can
-- express. scripts/build-city-price-index.mjs runs that matcher in JS and
-- writes its output here, the same delete-then-insert pattern catalog-io.mjs
-- uses for msrp_catalog. This table IS the "aggregation query" alberta-scope.md
-- calls for — the gate lives in the script that writes it, once, not scattered
-- across every reader.
--
-- THE PUBLISHABLE GATE IS DATA, NOT A UI CHECK. is_publishable is computed at
-- write time from n_dealers/n_listings/freshness and stored as a column, so a
-- reader can never accidentally show a thin city's number — filtering on
-- is_publishable = true is the only way to get a row that looks real.
--
-- STAYS RLS-LOCKED, NO ANON GRANT, ON PURPOSE — same posture as
-- dealer_source/vehicle_listing in 20260811_alberta_inventory.sql. This table
-- has none of the sensitivity that lockdown was protecting against (no VINs,
-- no dealer names, city-level medians only) — but the underlying data still
-- comes from the standing crawl that's with counsel, and alberta-scope.md's
-- own launch-gate checklist (defamation-lawyer sign-off on authored
-- MSRP-deviation content) is not yet satisfied. Built dormant, flip when
-- cleared — same pattern as fee_observations and the crawl cron itself.
-- ============================================================================

create table if not exists public.city_dealer_index (
  id                   bigint generated always as identity primary key,
  city                 text not null,
  province             text not null default 'AB',
  computed_at          timestamptz not null default now(),
  n_dealers            integer not null,
  n_listings           integer not null,
  -- median / p25 / p75 of (list_price - msrp) / msrp * 100, matched listings only
  index_pct            numeric,
  p25_pct              numeric,
  p75_pct              numeric,
  avg_deviation_dollars numeric,
  -- freshness window over the matched listings that fed this row
  min_updated_at       timestamptz,
  max_updated_at       timestamptz,
  -- MIN_DEALERS / MIN_LISTINGS / STALE_DAYS gate, evaluated once at write time
  is_publishable       boolean not null default false,
  unique (city, province)
);
alter table public.city_dealer_index enable row level security;
create index if not exists ix_city_dealer_index_publishable
  on public.city_dealer_index(is_publishable) where is_publishable;

-- No grants to anon/authenticated. Matches dealer_source/vehicle_listing:
-- service-role (the build script) writes it, nothing public reads it yet.
revoke all on public.city_dealer_index from anon, authenticated;
