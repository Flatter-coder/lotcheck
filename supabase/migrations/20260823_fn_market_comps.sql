-- ============================================================================
-- MARKET COMPS — raw candidate prices for the used-value band, our own data.
--
-- Phase 1 of the used-vehicle value method (see the "Tracker Teardown" analysis
-- and pctracker.ca's median-of-asking approach). This is the VENDOR-FREE source
-- behind marketvalue.ts's `lotcheck` provider: no MarketCheck, no CBB, nothing a
-- dealer could pressure into cutting us off (vendor-capture-risk / CLAUDE.md
-- vendor policy). Every row traces to a dealer's OWN public listing, the same
-- source the rest of the product already reads, and the same posture already
-- shipped anon-public in fn_comparable_listings (20260820).
--
-- WHY A SEPARATE FUNCTION FROM fn_comparable_listings. That one returns up to 10
-- DISPLAY rows (dealer name/city/odometer) ranked for a human to read. This one
-- returns a larger, lean price pool (price + odometer + trim + year only) so the
-- band math -- median, quartiles, mileage-band selection, outlier trim, the
-- min-comps gate -- runs ONCE in tested TypeScript (marketvalue.ts computeBand),
-- never duplicated in SQL where it can't be unit-tested. SQL filters; TS decides.
--
-- EXCLUSIONS baked in here (correctness before the number is ever shown):
--   * delisted_on is null      -- only cars actually for sale right now
--   * damaged = false          -- severelyDamagedVehicle: salvage/branded titles
--                                 never anchor a clean-title median
--   * price > 0                -- a $0 / "call for price" row is not a comp
--   * same make+model, condition, province, within +/- p_year_span model years
--   * excludes the subject VIN so a car is never compared against itself
--
-- Aggregates of already-public listings, so anon-callable like its siblings.
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
               'asOf',       to_char(last_seen_on, 'YYYY-MM-DD')
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
           vl.last_seen_on
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
-- Anon-callable, same reasoning as fn_comparable_listings / fn_city_price_index:
-- every input row is a dealer's own already-public listing, and this returns only
-- a price pool, less disclosive than the per-listing function that already ships.
grant execute on function public.fn_market_comps(integer, text, text, text, text, text, integer, integer) to anon, authenticated;
