-- ============================================================================
-- CITY PRICE INDEX — public RPC, same posture as fn_alberta_msrp_deviation
-- (20260812_msrp_deviation.sql): the underlying tables (vehicle_listing,
-- dealer_source, city_dealer_index) stay RLS-locked with no client policy.
-- This function is the ONLY public surface, and it can only ever return rows
-- that ALREADY cleared the publishable gate (n_dealers/n_listings/freshness,
-- computed once by scripts/build-city-price-index.mjs and stored on the row) —
-- there is no argument here that can talk a thin city into showing a number.
--
-- City-level is a finer cut than fn_alberta_msrp_deviation's one province-wide
-- figure, so the gate is per-row here rather than one floor on the whole
-- query: is_publishable = true is the WHERE clause, not a parameter.
-- ============================================================================

create or replace function public.fn_city_price_index()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'city', city,
    'province', province,
    'n_dealers', n_dealers,
    'n_listings', n_listings,
    'index_pct', index_pct,
    'p25_pct', p25_pct,
    'p75_pct', p75_pct,
    'avg_deviation_dollars', avg_deviation_dollars,
    'as_of', to_char(coalesce(max_updated_at, computed_at), 'YYYY-MM-DD')
  ) order by n_listings desc), '[]'::jsonb)
  from city_dealer_index
  where is_publishable;
$$;

revoke all on function public.fn_city_price_index() from public;
-- Anon-callable on purpose, same reasoning as fn_alberta_msrp_deviation: an
-- aggregate already behind a per-row publishable gate, and /alberta is its
-- only consumer.
grant execute on function public.fn_city_price_index() to anon, authenticated;
