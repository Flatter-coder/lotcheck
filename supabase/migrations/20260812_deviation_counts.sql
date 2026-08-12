-- ============================================================================
-- Split the Alberta-vs-MSRP reading into under / at / over sticker.
--
-- WHY. "658 listings, median 0.0%" reads as if 658 cars are under MSRP. They
-- are not: the median sits exactly ON sticker because roughly half the market
-- is priced at MSRP to the dollar and the other half is discounted. Without
-- the split, the chart invites exactly that misreading — and it did.
--
-- under_n / at_n / over_n are the three numbers a buyer actually needs: how
-- many dealers discount, how many hold the line, how many go above it.
--
-- Replaces the function from 20260812_msrp_deviation_curve.sql; same name,
-- same keys, three added.
-- ============================================================================

create or replace function public.fn_alberta_msrp_deviation(p_min_n int default 25)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_min   int := greatest(coalesce(p_min_n, 25), 25);
  v_n     int; v_med numeric; v_p25 numeric; v_p75 numeric;
  v_over  int; v_under int; v_at int; v_deal int;
  v_curve numeric[];
  v_med_disc numeric;
begin
  with d as (
    select ((l.sale_price - l.msrp) / l.msrp) * 100.0 as pct
      from vehicle_listing l
     where l.delisted_on is null
       and l.msrp > 0 and l.sale_price > 0
       and l.condition = 'new'
  )
  select count(*),
         percentile_cont(0.5)  within group (order by pct),
         percentile_cont(0.25) within group (order by pct),
         percentile_cont(0.75) within group (order by pct),
         count(*) filter (where pct >  0.05),      -- a shade of tolerance for
         count(*) filter (where pct < -0.05),      -- rounding either side of 0
         count(*) filter (where pct between -0.05 and 0.05),
         percentile_cont(array[0,0.05,0.10,0.15,0.20,0.25,0.30,0.35,0.40,0.45,0.50,
                               0.55,0.60,0.65,0.70,0.75,0.80,0.85,0.90,0.95,1.0])
           within group (order by pct)
    into v_n, v_med, v_p25, v_p75, v_over, v_under, v_at, v_curve
    from d;

  -- The typical discount AMONG DISCOUNTED CARS. With half the market at
  -- sticker the overall median is 0, which is true but useless to a buyer
  -- asking "if they do move, how far do they move?"
  select percentile_cont(0.5) within group (order by pct) into v_med_disc
    from (select ((l.sale_price - l.msrp) / l.msrp) * 100.0 as pct
            from vehicle_listing l
           where l.delisted_on is null and l.msrp > 0 and l.sale_price > 0
             and l.condition = 'new'
             and ((l.sale_price - l.msrp) / l.msrp) * 100.0 < -0.05) x;

  select count(distinct dealer_id) into v_deal
    from vehicle_listing
   where delisted_on is null and msrp > 0 and sale_price > 0 and condition = 'new';

  if coalesce(v_n, 0) < v_min then
    return jsonb_build_object('enough', false, 'n', coalesce(v_n, 0), 'min', v_min);
  end if;

  return jsonb_build_object(
    'enough', true, 'n', v_n, 'dealers', v_deal,
    'median', round(v_med, 2), 'p25', round(v_p25, 2), 'p75', round(v_p75, 2),
    'over_n', v_over, 'under_n', v_under, 'at_n', v_at,
    'over_share',  round((v_over::numeric  / v_n) * 100, 1),
    'under_share', round((v_under::numeric / v_n) * 100, 1),
    'median_discount', round(coalesce(v_med_disc, 0), 2),
    'curve', (select jsonb_agg(round(x, 2) order by ord)
                from unnest(v_curve) with ordinality as t(x, ord))
  );
end; $$;

revoke all on function public.fn_alberta_msrp_deviation(int) from public;
grant execute on function public.fn_alberta_msrp_deviation(int) to anon, authenticated;
