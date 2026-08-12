-- ============================================================================
-- Add a distribution CURVE to the Alberta-vs-MSRP reading.
--
-- WHY. The chart wants the shape it always had — a line sweeping across the
-- plot — but built from real data instead of a simulated series. We have no
-- price history yet (one crawl), so there is no honest line "over time". There
-- IS an honest line across the MARKET: every listing sorted by how far it sits
-- from MSRP. Left = the deepest discounts, right = the closest to sticker (and
-- above it, if any dealer ever goes there).
--
-- That curve answers the buyer's question better than a time series would:
-- "where does the price I have been quoted sit against everyone else's?"
--
-- Returned as 21 percentile points (0, 5, ... 100) rather than 658 rows. It
-- stays an aggregate — no VIN, no dealer, no single car identifiable — so the
-- k-anonymity posture of the original function is unchanged.
--
-- Replaces the function from 20260812_msrp_deviation.sql; same name, same
-- existing keys, one added.
-- ============================================================================

create or replace function public.fn_alberta_msrp_deviation(p_min_n int default 25)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_min   int := greatest(coalesce(p_min_n, 25), 25);
  v_n     int;
  v_med   numeric;
  v_p25   numeric;
  v_p75   numeric;
  v_over  int;
  v_deal  int;
  v_curve numeric[];
begin
  with d as (
    select ((l.sale_price - l.msrp) / l.msrp) * 100.0 as pct
      from vehicle_listing l
     where l.delisted_on is null
       and l.msrp > 0
       and l.sale_price > 0
       and l.condition = 'new'
  )
  select count(*),
         percentile_cont(0.5)  within group (order by pct),
         percentile_cont(0.25) within group (order by pct),
         percentile_cont(0.75) within group (order by pct),
         count(*) filter (where pct > 0),
         percentile_cont(array[0,0.05,0.10,0.15,0.20,0.25,0.30,0.35,0.40,0.45,0.50,
                               0.55,0.60,0.65,0.70,0.75,0.80,0.85,0.90,0.95,1.0])
           within group (order by pct)
    into v_n, v_med, v_p25, v_p75, v_over, v_curve
    from d;

  select count(distinct dealer_id) into v_deal
    from vehicle_listing
   where delisted_on is null and msrp > 0 and sale_price > 0 and condition = 'new';

  if coalesce(v_n, 0) < v_min then
    return jsonb_build_object('enough', false, 'n', coalesce(v_n, 0), 'min', v_min);
  end if;

  return jsonb_build_object(
    'enough',  true,
    'n',       v_n,
    'dealers', v_deal,
    'median',  round(v_med, 2),
    'p25',     round(v_p25, 2),
    'p75',     round(v_p75, 2),
    'over_n',  v_over,
    'over_share', round((v_over::numeric / v_n) * 100, 1),
    -- 21 points, deepest discount first. Negative = under sticker.
    'curve',   (select jsonb_agg(round(x, 2) order by ord)
                  from unnest(v_curve) with ordinality as t(x, ord))
  );
end; $$;

revoke all on function public.fn_alberta_msrp_deviation(int) from public;
grant execute on function public.fn_alberta_msrp_deviation(int) to anon, authenticated;
