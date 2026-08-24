-- ============================================================================
-- CRAWL COVERAGE — one-shot USED-ONLY aggregate for the public /crawl page.
--
-- Powers a live "here is our own Alberta used-car dataset" dashboard in the app.
-- USED ONLY on purpose: new cars answer to a published MSRP (few questions), so
-- the market-value/coverage story is a used-vehicle thing -- a different kind of
-- data, kept separate (see design-must-not-create-questions).
--
-- WHAT IT DOES NOT RETURN: dealer names. The per-dealer sources are the moat
-- (dealers-are-adversaries / moat-is-synthesis-not-data); the public page shows
-- the dealer COUNT and the coverage, never the list of who we read. Everything
-- here is an aggregate of dealers' own already-public listings, same anon posture
-- as fn_market_comps / fn_comparable_listings.
-- ============================================================================

create or replace function public.fn_crawl_coverage(p_province text default 'AB')
returns jsonb language sql stable security definer set search_path = public as $$
  with used as (
    select vl.make, vl.model,
           coalesce(vl.sale_price, vl.list_price)::numeric as price,
           vl.last_seen_on, vl.dealer_id, ds.city
    from public.vehicle_listing vl
    join public.dealer_source ds on ds.id = vl.dealer_id
    where vl.condition = 'used'
      and vl.delisted_on is null
      and coalesce(vl.damaged, false) = false
      and coalesce(vl.sale_price, vl.list_price) > 0
      and ds.province = p_province
  ),
  models as (
    select make, model, count(*) as n,
           percentile_cont(0.5) within group (order by price) as med,
           min(price) as lo, max(price) as hi
    from used
    group by make, model
    having count(*) >= 5
    order by count(*) desc
    limit 40
  ),
  cities as (
    select city, count(*) as n from used where city is not null group by city order by count(*) desc
  )
  select jsonb_build_object(
    'province',       p_province,
    'totalUsed',      (select count(*) from used),
    'dealers',        (select count(distinct dealer_id) from used),
    'cities',         (select coalesce(jsonb_agg(jsonb_build_object('city', city, 'n', n) order by n desc), '[]'::jsonb) from cities),
    'models',         (select coalesce(jsonb_agg(jsonb_build_object('make', make, 'model', model, 'n', n, 'lo', round(lo), 'med', round(med), 'hi', round(hi)) order by n desc), '[]'::jsonb) from models),
    'modelsWithData', (select count(*) from (select 1 from used group by make, model) x),
    'modelsGauge',    (select count(*) from (select 1 from used group by make, model having count(*) >= 5) x),
    'freshest',       (select to_char(max(last_seen_on), 'YYYY-MM-DD') from used)
  )
$$;

revoke all on function public.fn_crawl_coverage(text) from public;
grant execute on function public.fn_crawl_coverage(text) to anon, authenticated;
