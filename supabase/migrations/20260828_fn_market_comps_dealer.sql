-- ============================================================================
-- fn_market_comps: expose the dealer name + city per comp.
--
-- The rebuilt value report (Collette's bar) shows a NAMED comps table — dealer +
-- city beside each listing, e.g. "Honda Certified, Edmonton" — and a price-vs-
-- mileage chart. The function already joins dealer_source; this just surfaces
-- ds.name and ds.city on each returned row. Additive: computeBand and every
-- existing caller read named fields and ignore the new ones, so nothing else
-- changes. Same signature -> a plain replace.
--
-- Still only a dealer's own already-public advertised listing (name, city, price,
-- km) — no more disclosive than the per-listing fn_comparable_listings that
-- already ships (it returns dealerName + city too).
-- ============================================================================
create or replace function public.fn_market_comps(
  p_year        integer,
  p_make        text,
  p_model       text,
  p_condition   text,
  p_exclude_vin text default null,
  p_province    text default 'AB',
  p_year_span   integer default 1,
  p_limit       integer default 300
)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'price',      price,
               'odometerKm', odometer_km,
               'trim',       trim,
               'year',       year,
               'asOf',       to_char(last_seen_on, 'YYYY-MM-DD'),
               'certified',  certified,
               'dealerName', dealer_name,
               'city',       city
             )
             order by price
           ),
           '[]'::jsonb
         )
  from (
    select coalesce(vl.sale_price, vl.list_price)::numeric as price,
           vl.odometer_km,
           vl.trim,
           vl.year,
           vl.last_seen_on,
           coalesce(vl.certified, false) as certified,
           ds.name as dealer_name,
           ds.city as city
    from public.vehicle_listing vl
    join public.dealer_source ds on ds.id = vl.dealer_id
    where lower(vl.make)  = lower(p_make)
      and lower(vl.model) = lower(p_model)
      and vl.condition    = p_condition
      and vl.delisted_on is null
      and coalesce(vl.damaged, false) = false
      and coalesce(vl.sale_price, vl.list_price) > 0
      and ds.province = p_province
      and vl.year between p_year - greatest(0, coalesce(p_year_span, 1))
                      and p_year + greatest(0, coalesce(p_year_span, 1))
      and (p_exclude_vin is null or vl.vin <> p_exclude_vin)
    order by coalesce(vl.sale_price, vl.list_price)
    limit greatest(1, least(coalesce(p_limit, 300), 500))
  ) q
$$;

revoke all on function public.fn_market_comps(integer, text, text, text, text, text, integer, integer) from public;
grant execute on function public.fn_market_comps(integer, text, text, text, text, text, integer, integer) to anon, authenticated;
