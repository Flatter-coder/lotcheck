-- ============================================================================
-- COMPARABLE LISTINGS — public RPC, same posture as fn_city_price_index
-- (20260818_fn_city_price_index.sql) and fn_alberta_msrp_deviation: the
-- underlying tables (vehicle_listing, dealer_source) stay RLS-locked with no
-- client policy, and this function is the ONLY public surface onto them.
--
-- WHY. Vic, checking a used 2022 RAV4 LE at 106,000 km: "i wish i have 3 more
-- rav4 le used to compare pricing ... from the location lotcheck is checking,
-- after that suggestion for new vehicles." The data already exists --
-- scripts/crawl-alberta-inventory.mjs has been writing exactly this (year,
-- make, model, trim, condition, odometer, price, dealer, city) into
-- vehicle_listing since 2026-08-11 -- it just had no public-facing surface.
--
-- Nothing this returns is private: every row traces to a dealer's OWN public
-- listing page, the same source LotCheck's whole product already reads (see
-- CLAUDE.md's vendor policy). Re-showing "Dealer X's used RAV4 LE is $Y at
-- Z km" to a buyer discloses nothing the dealer didn't already publish.
--
-- No geographic radius filter: dealer_source has city/province text only, no
-- lat/lng, so "within 100km" would be a false precision this can't back.
-- Scoped to one province instead (p_province, defaults 'AB' -- the only one
-- crawled today) and ordered by relevance, not distance. Revisit if/when a
-- real coordinate table exists.
-- ============================================================================

create or replace function public.fn_comparable_listings(
  p_year integer,
  p_make text,
  p_model text,
  p_condition text,
  p_exclude_vin text default null,
  p_trim text default null,
  p_odometer_km integer default null,
  p_province text default 'AB',
  p_limit integer default 3
)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(row_data order by rn), '[]'::jsonb)
  from (
    select
      jsonb_build_object(
        'dealerName', ds.name,
        'city', ds.city,
        'year', vl.year,
        'make', vl.make,
        'model', vl.model,
        'trim', vl.trim,
        'odometerKm', vl.odometer_km,
        'price', coalesce(vl.sale_price, vl.list_price),
        'condition', vl.condition,
        'firstSeenOn', to_char(vl.first_seen_on, 'YYYY-MM-DD')
      ) as row_data,
      row_number() over (
        order by
          -- Same-trim rows first (a "LE" comparing against another "LE" is
          -- worth more than a same-model different-trim), then closest
          -- odometer for a used comparison (mileage is the dominant price
          -- driver on a used car), then price for new (trim/options aside,
          -- the number that matters), price as the final tiebreak either way.
          case when p_trim is not null and lower(vl.trim) = lower(p_trim) then 0 else 1 end,
          case when p_condition = 'used' and p_odometer_km is not null and vl.odometer_km is not null
            then abs(vl.odometer_km - p_odometer_km) end asc nulls last,
          coalesce(vl.sale_price, vl.list_price) asc nulls last
      ) as rn
    from public.vehicle_listing vl
    join public.dealer_source ds on ds.id = vl.dealer_id
    where vl.year = p_year
      and lower(vl.make) = lower(p_make)
      and lower(vl.model) = lower(p_model)
      and vl.condition = p_condition
      and vl.delisted_on is null
      and coalesce(vl.sale_price, vl.list_price) > 0
      and ds.province = p_province
      and (p_exclude_vin is null or vl.vin <> p_exclude_vin)
  ) ranked
  where rn <= greatest(1, least(coalesce(p_limit, 3), 10))
$$;

revoke all on function public.fn_comparable_listings(integer, text, text, text, text, text, integer, text, integer) from public;
-- Anon-callable on purpose, same reasoning as fn_city_price_index: every row
-- traces to a dealer's own already-public listing, and /quote-check is its
-- only consumer.
grant execute on function public.fn_comparable_listings(integer, text, text, text, text, text, integer, text, integer) to anon, authenticated;
