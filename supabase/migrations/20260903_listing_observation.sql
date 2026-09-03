-- ============================================================================
-- ON-LOT ARCHIVE: a duration needs two observations.
--
-- Days-on-lot is one of the few facts that actually moves a price, and it is
-- ours -- no aggregator tells a buyer how long a car has sat. It is also, as
-- shipped, the least defensible number on the report, for two separate reasons
-- found on 2026-09-03 against a real listing (VIN KMUHBESB0SU232048, a 2025
-- GV80 at Genesis North Calgary):
--
--   1. The lookup took the earliest `first_seen_on` for a VIN across ALL
--      dealers -- vehicle_listing is keyed (dealer_id, vin), so a car that
--      moved lots has a row per dealer -- while the card printed "N days on
--      THE DEALER'S lot" under the current dealer's name. Our only row for
--      that VIN was Okotoks Chevrolet; the report was for Genesis North
--      Calgary. Say "16 days on your lot" at that desk and they answer "we got
--      it last week", and we are the ones who look wrong.
--
--   2. `listing_price_history` records a row only when a price MOVES, so
--      nothing in this schema proved continuous PRESENCE. With one recent
--      crawl (the cron is off; last success 2026-08-18) `first_seen_on` is the
--      date we last looked, not the date the car arrived. Every "N days on
--      lot" was really "days since our last crawl".
--
-- This migration adds the missing half: one narrow row per listing per crawl
-- day. That is what a span cannot give us --
--   * a true COUNT of days seen, so a duration rests on observations;
--   * GAPS, so a car that delisted and relisted is not sold as one that sat;
--   * evidence, so the claim survives a dealer disputing it.
--
-- Cost: one row per live listing per crawl. At ~1,600 Alberta dealers this is
-- narrow and index-friendly, and it is the cheapest honest way to measure time.
-- ============================================================================

-- ---- 1) the observation trail ----------------------------------------------
create table if not exists public.listing_observation (
  listing_id  bigint not null references public.vehicle_listing(id) on delete cascade,
  observed_on date   not null default current_date,
  primary key (listing_id, observed_on)
);
alter table public.listing_observation enable row level security;
create index if not exists ix_listing_obs_listing on public.listing_observation(listing_id, observed_on desc);

comment on table public.listing_observation is
  'One row per listing per crawl day. The evidence behind every days-on-lot claim: a duration is a claim about time, so it needs at least two observations separated in time. One sighting is a date, not a duration.';

-- ---- 2) seed from what we already know --------------------------------------
-- first_seen_on and last_seen_on ARE observations we made; losing them would
-- throw away the only history we have. Seeded rather than invented: exactly the
-- two dates the row already asserts, and nothing in between, because we cannot
-- prove the days between were observed.
insert into public.listing_observation (listing_id, observed_on)
  select id, first_seen_on from public.vehicle_listing
  on conflict do nothing;
insert into public.listing_observation (listing_id, observed_on)
  select id, last_seen_on from public.vehicle_listing where last_seen_on <> first_seen_on
  on conflict do nothing;

-- ---- 3) record an observation on every crawl --------------------------------
-- fn_upsert_listings is replaced wholesale below with the observation insert
-- added to BOTH branches. Everything else is byte-identical to the version in
-- 20260811_alberta_inventory.sql -- deliberately, so this migration is
-- reviewable as "one insert, twice" rather than a rewrite.
create or replace function public.fn_upsert_listings(p_dealer_id bigint, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r jsonb; v_id bigint; v_old_list numeric; v_old_sale numeric;
  n_new int := 0; n_seen int := 0; n_priced int := 0;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    select id, list_price, sale_price into v_id, v_old_list, v_old_sale
      from vehicle_listing where dealer_id = p_dealer_id and vin = r->>'vin';

    if v_id is null then
      insert into vehicle_listing (
        dealer_id, vin, stock_no, year, make, model, trim, condition, odometer_km,
        msrp, list_price, sale_price, date_entry, days_in_inventory,
        certified, demo, damaged, status
      ) values (
        p_dealer_id, r->>'vin', nullif(r->>'stock_no',''),
        (r->>'year')::int, nullif(r->>'make',''), nullif(r->>'model',''), nullif(r->>'trim',''),
        nullif(r->>'condition',''), (r->>'odometer_km')::int,
        (r->>'msrp')::numeric, (r->>'list_price')::numeric, (r->>'sale_price')::numeric,
        (r->>'date_entry')::date, (r->>'days_in_inventory')::int,
        (r->>'certified')::boolean, (r->>'demo')::boolean, (r->>'damaged')::boolean,
        nullif(r->>'status','')
      ) returning id into v_id;
      n_new := n_new + 1;
      insert into listing_price_history(listing_id, list_price, sale_price)
        values (v_id, (r->>'list_price')::numeric, (r->>'sale_price')::numeric)
        on conflict (listing_id, observed_on) do nothing;
      n_priced := n_priced + 1;
    else
      update vehicle_listing set
        stock_no = coalesce(nullif(r->>'stock_no',''), stock_no),
        year = coalesce((r->>'year')::int, year),
        make = coalesce(nullif(r->>'make',''), make),
        model = coalesce(nullif(r->>'model',''), model),
        trim = coalesce(nullif(r->>'trim',''), trim),
        condition = coalesce(nullif(r->>'condition',''), condition),
        odometer_km = coalesce((r->>'odometer_km')::int, odometer_km),
        msrp = coalesce((r->>'msrp')::numeric, msrp),
        list_price = (r->>'list_price')::numeric,
        sale_price = (r->>'sale_price')::numeric,
        date_entry = coalesce((r->>'date_entry')::date, date_entry),
        days_in_inventory = coalesce((r->>'days_in_inventory')::int, days_in_inventory),
        certified = (r->>'certified')::boolean,
        demo = (r->>'demo')::boolean,
        damaged = (r->>'damaged')::boolean,
        status = coalesce(nullif(r->>'status',''), status),
        last_seen_on = current_date,
        delisted_on = null,                 -- reappeared: it is live again
        updated_at = now()
      where id = v_id;

      -- Only on a real move, so the history table records events not heartbeats.
      if (r->>'list_price')::numeric is distinct from v_old_list
         or (r->>'sale_price')::numeric is distinct from v_old_sale then
        insert into listing_price_history(listing_id, list_price, sale_price)
          values (v_id, (r->>'list_price')::numeric, (r->>'sale_price')::numeric)
          on conflict (listing_id, observed_on) do update
            set list_price = excluded.list_price, sale_price = excluded.sale_price;
        n_priced := n_priced + 1;
      end if;
    end if;

    -- THE HEARTBEAT. Unlike price history, this one fires every crawl, because
    -- "we saw it again today" is exactly the fact days-on-lot is missing.
    insert into listing_observation (listing_id, observed_on)
      values (v_id, current_date) on conflict do nothing;

    n_seen := n_seen + 1;
  end loop;

  return jsonb_build_object('ok', true, 'new', n_new, 'seen', n_seen, 'price_changes', n_priced);
end; $$;
revoke all on function public.fn_upsert_listings(bigint, jsonb) from public;

-- ---- 4) the honest on-lot read ----------------------------------------------
-- Scoped to the dealer whose report this is, and it reports what it can prove:
-- how many separate days we saw the car AT THIS DEALER, over what span, with
-- how many gaps. It returns the cross-dealer sightings SEPARATELY rather than
-- folding them into a day count, because "the same VIN was advertised by
-- another Alberta dealer on 2026-08-18 at $68,890" is a stronger and more
-- defensible fact than a number that quietly spans two lots.
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
     order by o.observed_on
  )
  select jsonb_build_object(
    'vin', upper(p_vin),
    'thisDealer', (select case when me.id is null then null else jsonb_build_object(
        'host',          me.host,
        'firstSeenOn',   to_char(me.first_seen_on, 'YYYY-MM-DD'),
        'lastSeenOn',    to_char(me.last_seen_on,  'YYYY-MM-DD'),
        'delistedOn',    to_char(me.delisted_on,   'YYYY-MM-DD'),
        'listPrice',     me.list_price,
        -- The count is the claim. One observation is a DATE, not a duration.
        'observations',  (select count(*) from obs),
        'spanDays',      greatest(0, me.last_seen_on - me.first_seen_on),
        -- Days inside the span we did NOT see it. A car that vanished and came
        -- back has not been sitting; selling that as continuous lot time would
        -- be the kind of overclaim a dealer can disprove on the spot.
        'unobservedDaysInSpan',
          greatest(0, (me.last_seen_on - me.first_seen_on + 1) - (select count(*) from obs))
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
  'Days-on-lot facts scoped to ONE dealer, plus the same VIN seen at other dealers as a separate fact. Never blends the two: a day count that silently spans two lots is a claim we cannot defend at a desk.';
