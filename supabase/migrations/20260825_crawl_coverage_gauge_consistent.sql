-- ============================================================================
-- Align the /crawl "Most-tracked models" RANGE + count with the value-band gauge.
--
-- The panel showed raw min(price)/max(price) across ALL model-years with no
-- outlier trim, so a Ford F-150 read "$10,886–$109,990" (a salvage-cheap old one
-- and a typo/loaded extreme) while the gauge for the same model showed the
-- trimmed 2020–2024 band "$29,373–$95,988" — two different numbers for one model
-- on one page, a question the page must never create (present-without-creating-
-- questions).
--
-- This recomputes the per-model n / lo / med / hi on the SAME set the gauge uses:
-- the 2020–2024 window (the /crawl gauge fetches fn_market_comps at p_year 2022
-- ±2yr) and the 0.4x–2.0x-of-median outlier trim (marketvalue.ts computeBand and
-- the /crawl reducer). So the RANGE and the "· N comps" now match the gauge, and
-- modelsGauge counts models that can ACTUALLY show a band, not an all-years
-- overcount. Coverage stats (totalUsed, dealers, cities, freshest) stay all-years
-- — those are "how much we track", not a band, so they don't get windowed.
--
-- NOTE: the 2020–2024 window is hardcoded to match the client's hardcoded 2022±2.
-- When that default is made dynamic, change both together.
-- ============================================================================

create or replace function public.fn_crawl_coverage(p_province text default 'AB')
returns jsonb language sql stable security definer set search_path = public as $$
  with used as (
    select vl.make, vl.model, vl.year,
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
  -- the gauge window: the same 2020–2024 the /crawl gauge fetches (2022 ±2yr).
  recent as (
    select make, model, price from used where year between 2020 and 2024
  ),
  model_med as (
    select make, model, percentile_cont(0.5) within group (order by price) as med
    from recent group by make, model having count(*) >= 5
  ),
  -- per model: outlier-trim to 0.4x–2.0x the median, then count / range on the
  -- survivors — mirrors computeBand and the /crawl gauge reducer so the RANGE and
  -- the "N comps" agree with the gauge exactly. Kept-count floor of 5.
  model_band as (
    select r.make, r.model, mm.med,
           count(*) filter (where r.price >= mm.med * 0.4 and r.price <= mm.med * 2.0) as n,
           min(r.price) filter (where r.price >= mm.med * 0.4 and r.price <= mm.med * 2.0) as lo,
           max(r.price) filter (where r.price >= mm.med * 0.4 and r.price <= mm.med * 2.0) as hi
    from recent r
    join model_med mm on mm.make = r.make and mm.model = r.model
    group by r.make, r.model, mm.med
    having count(*) filter (where r.price >= mm.med * 0.4 and r.price <= mm.med * 2.0) >= 5
  ),
  models as (
    select make, model, n, med, lo, hi from model_band order by n desc limit 40
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
    'modelsGauge',    (select count(*) from model_band),
    'freshest',       (select to_char(max(last_seen_on), 'YYYY-MM-DD') from used)
  )
$$;

revoke all on function public.fn_crawl_coverage(text) from public;
grant execute on function public.fn_crawl_coverage(text) to anon, authenticated;
