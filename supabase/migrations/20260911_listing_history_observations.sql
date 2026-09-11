-- ============================================================================
-- THE ARCHIVE HAS TO ANSWER "WHAT DID THIS LISTING SAY, AND WHEN?"
--
-- Vic, 2026-09-11, after working through what a delisting actually proves:
--   "need to track this daily 6am and midnight ... if have disputes in future
--    we can go back track this listing's every single day ... the more we track
--    our accuracy increases"
--
-- Two things stopped that working, and both are in this file.
--
-- 1. EVERY TIME COLUMN WAS A DATE, so a second read in the same day was not a
--    second observation -- it was the first one overwritten.
--
--    `listing_observation` is keyed (listing_id, observed_on::date) and
--    `listing_price_history` is unique on the same, with ON CONFLICT DO UPDATE.
--    Read at 00:00 and again at 06:00 and both land on the same calendar day:
--    the heartbeat collapses to one row, and a price that moved between the two
--    reads REPLACES the row the first read wrote. The trail then reads A -> C
--    and the move to B never existed. Doubling the crawl rate under a date key
--    does not double the evidence; it overwrites half of it.
--
--    Both tables now carry `observed_at timestamptz` and are keyed on it.
--    `observed_on` stays, because a day is still the right unit for "how many
--    DAYS has this sat" -- see the fn_listing_on_lot fix below, which is the
--    trap this change sets if it is not made.
--
-- 2. ONLY PRICE WAS VERSIONED. Everything else -- odometer, trim, certified,
--    demo, damaged, status, stock number, the dealer's own date_entry -- was
--    overwritten in place with no history at all.
--
--    For a dispute that is backwards. "The listing said 46,680 km when I looked
--    and now it says 40,100" is a worse allegation than a price change, and we
--    could not have answered it. A `damaged` flag quietly flipping to false is
--    worse still. `listing_field_history` records those, old value AND new, so
--    a single row stands on its own as evidence without needing the row before
--    it to be read as well.
--
-- WHAT THIS FILE DOES NOT DO. It does not change the crawl schedule. The
-- standing bulk crawl stays commented out in crawl-inventory.yml pending
-- counsel, and this migration is deliberately useful at any cadence: it is what
-- makes a second daily read WORTH taking, not permission to take one.
--
-- Cost: field history is written only on a real change, like price history, so
-- the table stays proportional to events rather than crawls. The observation
-- heartbeat is the one per-crawl row, and it is two integers and a timestamp.
-- ============================================================================

-- ---- 1) observations get a time, not just a day -----------------------------
alter table public.listing_observation
  add column if not exists observed_at   timestamptz,
  -- TRUE for the rows backfilled below, whose timestamp is DERIVED from a date
  -- we recorded before this migration existed. We know the day; we do not know
  -- the hour, and an archive kept for disputes must not imply otherwise.
  add column if not exists day_precision boolean not null default false;

update public.listing_observation
   set observed_at = observed_on::timestamptz, day_precision = true
 where observed_at is null;

alter table public.listing_observation alter column observed_at set not null;
alter table public.listing_observation alter column observed_at set default now();

-- Re-key on the instant. Two reads in one day are now two rows.
alter table public.listing_observation drop constraint if exists listing_observation_pkey;
alter table public.listing_observation
  add constraint listing_observation_pkey primary key (listing_id, observed_at);
create index if not exists ix_listing_obs_day on public.listing_observation(listing_id, observed_on desc);

comment on column public.listing_observation.observed_at is
  'When the crawl actually saw this listing. Keyed on this, so a second read the same day is a second observation rather than an overwrite.';
comment on column public.listing_observation.day_precision is
  'TRUE where observed_at was derived from a date recorded before timestamps existed. The day is evidence; the hour is not.';

-- ---- 2) price history gets a time too ---------------------------------------
alter table public.listing_price_history
  add column if not exists observed_at   timestamptz,
  add column if not exists day_precision boolean not null default false;

update public.listing_price_history
   set observed_at = observed_on::timestamptz, day_precision = true
 where observed_at is null;

alter table public.listing_price_history alter column observed_at set not null;
alter table public.listing_price_history alter column observed_at set default now();

alter table public.listing_price_history drop constraint if exists listing_price_history_listing_id_observed_on_key;
create unique index if not exists ux_price_history_at on public.listing_price_history(listing_id, observed_at);
create index if not exists ix_price_history_listing_at on public.listing_price_history(listing_id, observed_at desc);

-- ---- 3) the field trail — what else changed, and what it changed FROM --------
create table if not exists public.listing_field_history (
  id          bigint generated always as identity primary key,
  listing_id  bigint not null references public.vehicle_listing(id) on delete cascade,
  observed_at timestamptz not null default now(),
  observed_on date not null default current_date,
  field       text not null,
  old_value   text,
  new_value   text,
  unique (listing_id, field, observed_at)
);
alter table public.listing_field_history enable row level security;
create index if not exists ix_field_history_listing on public.listing_field_history(listing_id, observed_at desc);
create index if not exists ix_field_history_field   on public.listing_field_history(field, observed_at desc);

comment on table public.listing_field_history is
  'One row per listing per field per real change, carrying the old value AND the new one so the row is evidence on its own. Price lives in listing_price_history; this is everything else a dealer can quietly edit -- odometer above all.';

-- ---- 4) record it on every crawl --------------------------------------------
-- fn_upsert_listings is replaced wholesale. The diff against the 20260903
-- version is: the old row is captured as jsonb before the update, the new row
-- comes back from the update, and the tracked keys are compared. Diffing jsonb
-- rather than hand-writing fourteen comparisons is deliberate -- a hand-written
-- list silently stops covering a column the day someone adds one, and the
-- column it would miss is exactly the one nobody thought about.
create or replace function public.fn_upsert_listings(p_dealer_id bigint, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r jsonb; v_id bigint; v_old_list numeric; v_old_sale numeric;
  v_old_row jsonb; v_new_row jsonb; f text;
  n_new int := 0; n_seen int := 0; n_priced int := 0; n_fields int := 0;
  v_at timestamptz := now();
  -- What a dealer can edit that changes what the listing CLAIMS. Price is
  -- excluded because listing_price_history already owns it; last_seen_on,
  -- updated_at and delisted_on are excluded because they are our bookkeeping,
  -- not the dealer's assertion.
  k_tracked constant text[] := array[
    'odometer_km','trim','condition','certified','demo','damaged','status',
    'stock_no','date_entry','days_in_inventory','msrp','year','make','model'
  ];
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
      insert into listing_price_history(listing_id, observed_at, list_price, sale_price)
        values (v_id, v_at, (r->>'list_price')::numeric, (r->>'sale_price')::numeric)
        on conflict (listing_id, observed_at) do nothing;
      n_priced := n_priced + 1;
    else
      select to_jsonb(vl.*) into v_old_row from vehicle_listing vl where vl.id = v_id;

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
      where id = v_id
      returning to_jsonb(vehicle_listing.*) into v_new_row;

      -- Only on a real move, so the history table records events not heartbeats.
      if (r->>'list_price')::numeric is distinct from v_old_list
         or (r->>'sale_price')::numeric is distinct from v_old_sale then
        insert into listing_price_history(listing_id, observed_at, list_price, sale_price)
          values (v_id, v_at, (r->>'list_price')::numeric, (r->>'sale_price')::numeric)
          on conflict (listing_id, observed_at) do update
            set list_price = excluded.list_price, sale_price = excluded.sale_price;
        n_priced := n_priced + 1;
      end if;

      -- THE FIELD TRAIL. Same rule as price: a row only when the value really
      -- changed. `is distinct from` on the text form treats null correctly, so
      -- a value appearing for the first time is a change and a value that
      -- vanished is too.
      foreach f in array k_tracked loop
        if (v_old_row->>f) is distinct from (v_new_row->>f) then
          insert into listing_field_history(listing_id, observed_at, field, old_value, new_value)
            values (v_id, v_at, f, v_old_row->>f, v_new_row->>f)
            on conflict (listing_id, field, observed_at) do nothing;
          n_fields := n_fields + 1;
        end if;
      end loop;
    end if;

    -- THE HEARTBEAT. Unlike the two history tables, this fires every crawl,
    -- because "we saw it again, at this time" is the fact a duration rests on.
    insert into listing_observation (listing_id, observed_at, observed_on)
      values (v_id, v_at, v_at::date) on conflict do nothing;

    n_seen := n_seen + 1;
  end loop;

  return jsonb_build_object('ok', true, 'new', n_new, 'seen', n_seen,
                            'price_changes', n_priced, 'field_changes', n_fields);
end; $$;
revoke all on function public.fn_upsert_listings(bigint, jsonb) from public;

-- ---- 5) THE TRAP THIS CHANGE SETS, DISARMED ---------------------------------
-- fn_listing_on_lot counted observation ROWS and called the total "days". That
-- was true only while the key guaranteed one row per day. Two reads a day would
-- have doubled every days-on-lot figure on every report and driven
-- unobservedDaysInSpan to zero -- a silent inflation of the one number we most
-- need to defend at a desk, failing in our own favour, which is the worst
-- direction for it to fail.
--
-- THIS IS 20260903d's FUNCTION, UNCHANGED EXCEPT FOR THE DAY MATH. The
-- null-host refusal and the normalised host compare from that migration are
-- load-bearing incident fixes -- without them a Genesis North Calgary report
-- prints Okotoks Chevrolet's dates, and the subject listing comes back as its
-- own "other dealer". Rebuilding this function from an older copy would have
-- reverted both. The diff here is: obs carries observed_at, `observedDays`
-- counts DISTINCT days, `observations` stays the raw tally, `lastObservedAt` is
-- new, and the price ladder orders by instant so two moves in one day keep
-- their order.
create or replace function public.fn_listing_on_lot(p_vin text, p_host text default null)
returns jsonb language sql stable security definer set search_path = public as $$
  with h as (
    -- Normalised once. null stays null, and null means REFUSE below.
    select case when p_host is null or btrim(p_host) = '' then null
                else regexp_replace(lower(btrim(p_host)), '^https?://(www\.)?', '') end as host
  ),
  me as (
    select vl.id, ds.host, vl.first_seen_on, vl.last_seen_on, vl.delisted_on, vl.list_price
      from vehicle_listing vl join dealer_source ds on ds.id = vl.dealer_id, h
     where vl.vin = upper(p_vin)
       and h.host is not null
       and regexp_replace(lower(ds.host), '^https?://(www\.)?', '') = h.host
     order by vl.last_seen_on desc
     limit 1
  ),
  obs as (
    select o.observed_on, o.observed_at from listing_observation o join me on o.listing_id = me.id
  ),
  hist as (
    select h2.observed_on, h2.observed_at, coalesce(h2.sale_price, h2.list_price) as price
      from listing_price_history h2 join me on h2.listing_id = me.id
     where coalesce(h2.sale_price, h2.list_price) is not null
     order by h2.observed_at
  )
  select jsonb_build_object(
    'vin', upper(p_vin),
    -- Null when we could not say WHICH dealer. The caller must treat that as
    -- "no days-on-lot claim", never as "some dealer's".
    'thisDealer', (select case when me.id is null then null else jsonb_build_object(
        'host',          me.host,
        'firstSeenOn',   to_char(me.first_seen_on, 'YYYY-MM-DD'),
        'lastSeenOn',    to_char(me.last_seen_on,  'YYYY-MM-DD'),
        'delistedOn',    to_char(me.delisted_on,   'YYYY-MM-DD'),
        'listPrice',     me.list_price,
        -- DAYS, not rows. Two observations on one date are still one day.
        'observedDays',  (select count(distinct obs.observed_on) from obs),
        -- The raw tally, kept separate and never called days.
        'observations',  (select count(*) from obs),
        'lastObservedAt',(select to_char(max(obs.observed_at), 'YYYY-MM-DD"T"HH24:MI:SSZ') from obs),
        'spanDays',      greatest(0, me.last_seen_on - me.first_seen_on),
        'unobservedDaysInSpan',
          greatest(0, (me.last_seen_on - me.first_seen_on + 1)
                      - (select count(distinct obs.observed_on) from obs)),
        'priceHistory', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'observedOn', to_char(hist.observed_on, 'YYYY-MM-DD'),
                   'observedAt', to_char(hist.observed_at, 'YYYY-MM-DD"T"HH24:MI:SSZ'),
                   'price', hist.price) order by hist.observed_at)
            from hist), '[]'::jsonb)
      ) end from me),
    -- Empty when the dealer is unknown: without an identity there is no "other"
    -- to be other THAN, and returning every row made the subject its own twin.
    'otherDealers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'host', ds.host, 'dealerName', ds.name, 'city', ds.city,
               'firstSeenOn', to_char(vl.first_seen_on, 'YYYY-MM-DD'),
               'lastSeenOn',  to_char(vl.last_seen_on,  'YYYY-MM-DD'),
               'listPrice',   vl.list_price,
               'certified',   vl.certified)
             order by vl.last_seen_on desc)
        from vehicle_listing vl join dealer_source ds on ds.id = vl.dealer_id, h
       where vl.vin = upper(p_vin)
         and h.host is not null
         and regexp_replace(lower(ds.host), '^https?://(www\.)?', '') <> h.host), '[]'::jsonb)
  );
$$;
revoke all on function public.fn_listing_on_lot(text, text) from public;
grant execute on function public.fn_listing_on_lot(text, text) to service_role;

-- ---- 6) the last-24h read ---------------------------------------------------
-- What CHANGED in a window, which is the question "daily history report" asks.
-- Deliberately not a totals report: a standing count repeated every morning
-- says nothing, and the movement is the product.
--
-- It reports its own coverage, because the window is only as good as the reads
-- inside it. `readsInWindow` is how many distinct crawl instants actually
-- landed; when that is 0 the honest answer is "we did not look", not "nothing
-- happened", and the caller is given what it needs to say so.
create or replace function public.fn_listing_history_24h(p_hours int default 24, p_limit int default 300)
returns jsonb language sql stable security definer set search_path = public as $$
  with w as (
    select now() - make_interval(hours => least(greatest(coalesce(p_hours, 24), 1), 720)) as since,
           least(greatest(coalesce(p_limit, 300), 1), 1000) as lim
  ),
  cover as (
    select count(distinct o.observed_at) as reads_in_window,
           count(distinct vl.dealer_id)  as dealers_read,
           max(o.observed_at)            as last_read_at,
           min(o.observed_at)            as first_read_at
      from listing_observation o
      join vehicle_listing vl on vl.id = o.listing_id, w
     where o.observed_at >= w.since
  ),
  moves as (
    select lph.listing_id, lph.observed_at,
           coalesce(lph.sale_price, lph.list_price) as price,
           lag(coalesce(lph.sale_price, lph.list_price))
             over (partition by lph.listing_id order by lph.observed_at) as prev_price
      from listing_price_history lph
  ),
  ev as (
    select 'new'::text as kind, vl.id as listing_id, vl.first_seen_on::timestamptz as at,
           null::text as field, null::text as old_value, null::text as new_value,
           coalesce(vl.sale_price, vl.list_price) as price, null::numeric as prev_price
      from vehicle_listing vl, w where vl.first_seen_on::timestamptz >= w.since
    union all
    select 'price_move', m.listing_id, m.observed_at, null, null, null, m.price, m.prev_price
      from moves m, w
     where m.observed_at >= w.since
       and m.prev_price is not null and m.prev_price is distinct from m.price
    union all
    -- The odometer and its neighbours. old_value AND new_value travel with the
    -- row so a reader never has to trust a previous row to read this one.
    select 'field_change', fh.listing_id, fh.observed_at,
           fh.field, fh.old_value, fh.new_value, null, null
      from listing_field_history fh, w where fh.observed_at >= w.since
    union all
    select 'delisted', vl.id, vl.delisted_on::timestamptz, null, null, null,
           coalesce(vl.sale_price, vl.list_price), null
      from vehicle_listing vl, w
     where vl.delisted_on is not null and vl.delisted_on::timestamptz >= w.since
  ),
  ranked as (
    select ev.*, ds.city, ds.name as dealer_name, ds.host,
           vl.vin, vl.year, vl.make, vl.model, vl.trim, vl.condition
      from ev
      join vehicle_listing vl on vl.id = ev.listing_id
      join dealer_source ds on ds.id = vl.dealer_id, w
     order by ev.at desc
     limit (select lim from w)
  )
  select jsonb_build_object(
    'windowHours', least(greatest(coalesce(p_hours, 24), 1), 720),
    'coverage', (select jsonb_build_object(
        'readsInWindow', c.reads_in_window,
        'dealersRead',   c.dealers_read,
        'dealersActive', (select count(*) from dealer_source where active),
        'firstReadAt',   to_char(c.first_read_at, 'YYYY-MM-DD"T"HH24:MI:SSZ'),
        'lastReadAt',    to_char(c.last_read_at,  'YYYY-MM-DD"T"HH24:MI:SSZ')
      ) from cover c),
    'counts', (select jsonb_build_object(
        'new',          count(*) filter (where kind = 'new'),
        'priceMoves',   count(*) filter (where kind = 'price_move'),
        'fieldChanges', count(*) filter (where kind = 'field_change'),
        'delisted',     count(*) filter (where kind = 'delisted')
      ) from ranked),
    'truncated', (select count(*) >= (select lim from w) from ranked),
    'events', coalesce((select jsonb_agg(jsonb_build_object(
        'kind', kind, 'at', to_char(at, 'YYYY-MM-DD"T"HH24:MI:SSZ'),
        'vin', vin, 'year', year, 'make', make, 'model', model, 'trim', trim,
        'condition', condition, 'city', city, 'dealerName', dealer_name, 'host', host,
        'price', price, 'prevPrice', prev_price,
        'field', field, 'oldValue', old_value, 'newValue', new_value
      ) order by at desc) from ranked), '[]'::jsonb)
  );
$$;
revoke all on function public.fn_listing_history_24h(int, int) from public;
grant execute on function public.fn_listing_history_24h(int, int) to anon, authenticated;

comment on function public.fn_listing_history_24h(int, int) is
  'What CHANGED across tracked listings in a window: arrivals, price moves, field changes (odometer and the rest), delistings -- with the coverage that produced them, so "we did not look" is never rendered as "nothing happened".';
