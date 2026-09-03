-- ============================================================================
-- PRICE-DROP WATCH, PART ONE: show the moves we have already seen.
--
-- listing_price_history has recorded a row every time a dealer's advertised
-- price MOVED since 2026-08-11, and nothing has ever read it back. A buyer
-- looking at a car has no way to know it was $3,000 more expensive a fortnight
-- ago, or that it has not moved in ninety days -- and those are two of the very
-- few facts that change what a person says at the desk.
--
-- This is deliberately the half that needs no consent, no email and no CASL
-- surface: it reports price movement we already observed, on the report the
-- buyer already asked for. The half that WATCHES a car for a buyer and writes
-- to them later needs opt-in and a delivery ledger, and is not this.
--
-- Honest by construction, the same way days-on-lot now is: we report the prices
-- we SAW on the dates we saw them. Our crawl is not continuous, so this is a
-- record of observed moves, never "the price history" -- a drop we did not
-- observe is a drop we must not imply did not happen.
-- ============================================================================

create or replace function public.fn_listing_on_lot(p_vin text, p_host text default null)
returns jsonb language sql stable security definer set search_path = public as $$
  with me as (
    select vl.id, ds.host, vl.first_seen_on, vl.last_seen_on, vl.delisted_on, vl.list_price
      from vehicle_listing vl join dealer_source ds on ds.id = vl.dealer_id
     where vl.vin = upper(p_vin)
       and (p_host is null or ds.host = p_host)
     order by vl.last_seen_on desc
     limit 1
  ),
  obs as (
    select o.observed_on from listing_observation o join me on o.listing_id = me.id
  ),
  -- Every distinct advertised price we recorded at THIS dealer, oldest first.
  -- coalesce(sale, list) is what the page was actually asking: a sale price is
  -- the number on the page when there is one.
  hist as (
    select h.observed_on, coalesce(h.sale_price, h.list_price) as price
      from listing_price_history h join me on h.listing_id = me.id
     where coalesce(h.sale_price, h.list_price) is not null
     order by h.observed_on
  )
  select jsonb_build_object(
    'vin', upper(p_vin),
    'thisDealer', (select case when me.id is null then null else jsonb_build_object(
        'host',          me.host,
        'firstSeenOn',   to_char(me.first_seen_on, 'YYYY-MM-DD'),
        'lastSeenOn',    to_char(me.last_seen_on,  'YYYY-MM-DD'),
        'delistedOn',    to_char(me.delisted_on,   'YYYY-MM-DD'),
        'listPrice',     me.list_price,
        'observations',  (select count(*) from obs),
        'spanDays',      greatest(0, me.last_seen_on - me.first_seen_on),
        'unobservedDaysInSpan',
          greatest(0, (me.last_seen_on - me.first_seen_on + 1) - (select count(*) from obs)),
        -- The moves themselves. A caller that wants "has this dropped?" reads
        -- the first and last entries; one that wants to show the ladder has it.
        'priceHistory', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'observedOn', to_char(hist.observed_on, 'YYYY-MM-DD'),
                   'price', hist.price) order by hist.observed_on)
            from hist), '[]'::jsonb)
      ) end from me),
    'otherDealers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'host', ds.host, 'dealerName', ds.name, 'city', ds.city,
               'firstSeenOn', to_char(vl.first_seen_on, 'YYYY-MM-DD'),
               'lastSeenOn',  to_char(vl.last_seen_on,  'YYYY-MM-DD'),
               'listPrice',   vl.list_price,
               'certified',   vl.certified)
             order by vl.last_seen_on desc)
        from vehicle_listing vl join dealer_source ds on ds.id = vl.dealer_id
       where vl.vin = upper(p_vin)
         and (p_host is null or ds.host <> p_host)), '[]'::jsonb)
  );
$$;
revoke all on function public.fn_listing_on_lot(text, text) from public;
grant execute on function public.fn_listing_on_lot(text, text) to service_role;

comment on function public.fn_listing_on_lot(text, text) is
  'Days-on-lot facts scoped to ONE dealer, that dealer''s observed price moves, and the same VIN at other dealers as a separate fact. Never blends them: a day count or a price drop that silently spans two lots is a claim we cannot defend at a desk.';
