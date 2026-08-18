-- ============================================================================
-- Admin/founder view of city_dealer_index — EVERY row, not just publishable
-- ones. fn_city_price_index() (20260818_fn_city_price_index.sql) is the public
-- surface and only ever returns is_publishable=true rows; this is the
-- founders'/admin's own dashboard, so it shows the cities BELOW the gate too
-- (dealers/listings/index%) so Vic, Josh and JC can watch coverage grow
-- toward the threshold before it ever reaches the public page.
--
-- Same gate as every other founder-visible read: fn_can_read_costs()
-- (fn_is_admin() OR fn_is_founder()), see 20260815_founder_access.sql /
-- 20260816_checkpoint_rollup.sql for the pattern this copies.
-- ============================================================================

create or replace function public.fn_admin_city_price_index()
returns table (
  city                  text,
  province              text,
  n_dealers             integer,
  n_listings            integer,
  index_pct             numeric,
  p25_pct               numeric,
  p75_pct               numeric,
  avg_deviation_dollars numeric,
  is_publishable        boolean,
  computed_at           timestamptz,
  max_updated_at        timestamptz
)
language plpgsql security definer set search_path = public as $$
begin
  if not public.fn_can_read_costs() then raise exception 'not authorized' using errcode = '42501'; end if;
  return query
    select c.city, c.province, c.n_dealers, c.n_listings, c.index_pct, c.p25_pct, c.p75_pct,
           c.avg_deviation_dollars, c.is_publishable, c.computed_at, c.max_updated_at
      from city_dealer_index c
     order by c.n_listings desc;
end $$;

revoke all on function public.fn_admin_city_price_index() from public, anon;
grant execute on function public.fn_admin_city_price_index() to authenticated;
