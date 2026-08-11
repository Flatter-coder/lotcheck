-- ============================================================================
-- ALBERTA MARKET vs MSRP — the one aggregate the public index chart may read.
--
-- vehicle_listing is RLS-locked with no client policies, and it stays that way:
-- it holds VIN-level rows and the price index has no business reading them. This
-- exposes ONLY an aggregate — how far Alberta asking prices sit from
-- manufacturer MSRP, and how many listings that rests on.
--
-- DIRECTION MATTERS. Early real data from the crawler's dry run had every new
-- vehicle asking BELOW MSRP (a 2025 Escape at $35,995 against $40,889). A chart
-- that only draws "over MSRP" would misread this market and tell a buyer to
-- brace for a markup when they should be negotiating a discount. The sign is
-- returned as-is; the page colours it.
--
-- K-ANONYMITY. Returns {enough:false} below the floor rather than a figure
-- computed from a handful of cars — same discipline as fn_fee_benchmark. A
-- median off three listings is not a market reading, and publishing one would
-- be exactly the kind of unbacked claim the report exists to catch.
--
-- Depends on: 20260811_alberta_inventory.sql.
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
begin
  -- Only live listings that state BOTH a manufacturer MSRP and an asking price.
  -- Used cars mostly carry no MSRP, so this is a new-vehicle reading and the
  -- page must say so.
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
         count(*) filter (where pct > 0)
    into v_n, v_med, v_p25, v_p75, v_over
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
    -- Negative = the market is asking BELOW sticker (good for the buyer).
    'median',  round(v_med, 2),
    'p25',     round(v_p25, 2),
    'p75',     round(v_p75, 2),
    'over_n',  v_over,
    'over_share', round((v_over::numeric / v_n) * 100, 1)
  );
end; $$;

revoke all on function public.fn_alberta_msrp_deviation(int) from public;
-- Anon-callable on purpose: it is an aggregate behind a k-anonymity floor, and
-- the public index page is its only consumer.
grant execute on function public.fn_alberta_msrp_deviation(int) to anon, authenticated;
