-- ============================================================================
-- ALBERTA INVENTORY — our own VIN dataset, built from dealers' own public feeds.
--
-- WHY THIS EXISTS. Every vehicle-data vendor worth buying sells to dealers too,
-- which makes them a kill switch held by the other side of the table (see the
-- vendor policy in CLAUDE.md). This is the alternative: a dataset nobody can
-- revoke, assembled from the inventory feeds dealers publish themselves.
--
-- WHAT THE FEED ACTUALLY GIVES US (confirmed live 2026-08-11 against three
-- Alberta SM360 dealers, 48/48 valid 17-character VINs):
--   serialNo         -> the VIN
--   dateEntry        -> the dealer's OWN date the unit entered inventory
--   daysInInventory  -> the dealer's OWN days-on-lot count
--   listPrice/salePrice -> both numbers, so every markdown is visible
--   odometer, certified, demo, severelyDamagedVehicle, vehicleStatus
--
-- That is strictly better than inferring first-seen from our own crawl: it is
-- the dealer's own record, so a days-on-lot claim is quoting them to themselves.
-- We still record OUR first/last observation separately — never conflate the
-- two, because only one of them is ours to stand behind (make-it-dispute-proof).
--
-- SHIPS WITH THE CRON DISABLED. A per-buyer URL read and a standing bulk crawl
-- are different activities, and the second one is part of what is currently with
-- counsel (legal-brief-ppr-amvic-access.md, legal-brief-url-listing-scraping.md).
-- The workflow is workflow_dispatch-only until that comes back. Same pattern as
-- the flywheel capture: build it, ship it dormant, flip it when cleared.
--
-- PRIVACY. A VIN attached to a person is personal information. These rows attach
-- a VIN to a DEALER'S PUBLIC LISTING — no buyer, no owner, no contact details,
-- nothing about a person. Tables are RLS-locked with no client policies. Needs a
-- legal_rule + legal_control row before the cron is enabled.
-- ============================================================================

-- ---- 1) the crawl seed ------------------------------------------------------
create table if not exists public.dealer_source (
  id                   bigint generated always as identity primary key,
  host                 text not null unique,          -- 'https://www.tazaparkvw.com' (origin only, no path)
  platform             text not null check (platform in ('sm360','convertus','other')),
  -- Convertus needs the dealer's `cp` id (the page's inventoryId) to address its
  -- feed. SM360 addresses by host alone, so this stays null there.
  platform_id          text,
  name                 text,
  city                 text,
  province             text not null default 'AB',
  sections             text[] not null default '{new-inventory,used-inventory}',
  active               boolean not null default true,
  last_ok_at           timestamptz,
  last_error           text,
  consecutive_failures integer not null default 0,
  created_at           timestamptz not null default now(),
  -- Origin only. A path here would silently crawl the wrong thing.
  constraint dealer_source_host_is_origin check (host ~ '^https://[^/]+$')
);
alter table public.dealer_source enable row level security;

-- ---- 2) one row per (dealer, VIN) -------------------------------------------
create table if not exists public.vehicle_listing (
  id                 bigint generated always as identity primary key,
  dealer_id          bigint not null references public.dealer_source(id) on delete cascade,
  vin                text not null,
  stock_no           text,
  year               integer,
  make               text,
  model              text,
  trim               text,
  condition          text check (condition in ('new','used')),
  odometer_km        integer,
  -- msrp is the manufacturer figure where the feed states one (Convertus does on
  -- new). list/sale are what the DEALER is asking, so msrp - sale_price is a
  -- discount off sticker, which is a different claim from a markdown off their
  -- own earlier price. Kept in its own column so the two never get conflated.
  msrp               numeric,
  list_price         numeric,
  sale_price         numeric,
  -- THEIRS: from the dealer's own inventory system.
  date_entry         date,
  days_in_inventory  integer,
  -- OURS: what we personally observed. Kept separate on purpose.
  first_seen_on      date not null default current_date,
  last_seen_on       date not null default current_date,
  delisted_on        date,
  certified          boolean,
  demo               boolean,
  damaged            boolean,
  status             text,
  updated_at         timestamptz not null default now(),
  unique (dealer_id, vin),
  constraint vehicle_listing_vin_shape check (vin ~ '^[A-HJ-NPR-Z0-9]{17}$')
);
alter table public.vehicle_listing enable row level security;
create index if not exists ix_vehicle_listing_vin      on public.vehicle_listing(vin);
create index if not exists ix_vehicle_listing_live     on public.vehicle_listing(dealer_id) where delisted_on is null;
create index if not exists ix_vehicle_listing_ymm      on public.vehicle_listing(year, make, model);

-- ---- 3) price history — a row only when a price actually MOVED --------------
-- Storing a row per crawl per vehicle would be millions of duplicates. Storing
-- one only on change makes "every markdown, with dates" a trivial query and
-- keeps the table proportional to real events.
create table if not exists public.listing_price_history (
  id          bigint generated always as identity primary key,
  listing_id  bigint not null references public.vehicle_listing(id) on delete cascade,
  observed_on date not null default current_date,
  list_price  numeric,
  sale_price  numeric,
  unique (listing_id, observed_on)
);
alter table public.listing_price_history enable row level security;
create index if not exists ix_price_history_listing on public.listing_price_history(listing_id, observed_on desc);

-- ---- 4) bulk upsert — one round trip per dealer page ------------------------
-- Takes the normalized rows the crawler built and does the whole day's work
-- server-side: insert new, refresh existing, append price history ONLY when a
-- price differs from the row's current value, and revive anything that was
-- previously marked delisted but has reappeared.
create or replace function public.fn_upsert_listings(p_dealer_id bigint, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r          jsonb;
  v_id       bigint;
  v_old_list numeric;
  v_old_sale numeric;
  n_new int := 0; n_seen int := 0; n_priced int := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('ok', true, 'new', 0, 'seen', 0, 'price_changes', 0);
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    -- The crawler already validates the VIN check digit; this is defence in
    -- depth so a bad row is skipped rather than poisoning the table.
    continue when coalesce(r->>'vin','') !~ '^[A-HJ-NPR-Z0-9]{17}$';

    select id, list_price, sale_price into v_id, v_old_list, v_old_sale
      from vehicle_listing
     where dealer_id = p_dealer_id and vin = r->>'vin'
     for update;

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
    n_seen := n_seen + 1;
  end loop;

  return jsonb_build_object('ok', true, 'new', n_new, 'seen', n_seen, 'price_changes', n_priced);
end; $$;
revoke all on function public.fn_upsert_listings(bigint, jsonb) from public;

-- ---- 5) delisting — the "it sold" signal ------------------------------------
-- Anything we did NOT see in a successful full crawl of this dealer is marked
-- delisted. Guarded on p_saw_count: a crawl that returned suspiciously little
-- must NOT mass-delist a dealer's whole lot on the strength of one bad fetch
-- (no-single-point-of-failure — an availability failure has to degrade, not
-- corrupt). Returns how many were marked.
create or replace function public.fn_mark_delisted(p_dealer_id bigint, p_seen_vins text[], p_saw_count integer)
returns integer language plpgsql security definer set search_path = public as $$
declare v_live integer; v_marked integer;
begin
  select count(*) into v_live from vehicle_listing
   where dealer_id = p_dealer_id and delisted_on is null;

  -- Sanity gate: if we saw less than half of what we had live, treat the crawl
  -- as incomplete and mark nothing.
  if v_live > 10 and p_saw_count < (v_live / 2) then
    raise notice 'delist skipped for dealer %: saw % of % live', p_dealer_id, p_saw_count, v_live;
    return 0;
  end if;

  update vehicle_listing set delisted_on = current_date, updated_at = now()
   where dealer_id = p_dealer_id
     and delisted_on is null
     and not (vin = any(coalesce(p_seen_vins, '{}')));
  get diagnostics v_marked = row_count;
  return v_marked;
end; $$;
revoke all on function public.fn_mark_delisted(bigint, text[], integer) from public;

-- ---- 6) crawl bookkeeping ---------------------------------------------------
create or replace function public.fn_record_crawl(p_dealer_id bigint, p_ok boolean, p_error text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_ok then
    update dealer_source set last_ok_at = now(), last_error = null, consecutive_failures = 0
     where id = p_dealer_id;
  else
    update dealer_source set last_error = left(coalesce(p_error,''), 500),
           consecutive_failures = consecutive_failures + 1
     where id = p_dealer_id;
  end if;
end; $$;
revoke all on function public.fn_record_crawl(bigint, boolean, text) from public;

-- ---- 7) the leverage view ---------------------------------------------------
-- What the whole dataset is for: a live unit, how long the DEALER says it has
-- sat, and how far they have already cut it themselves.
create or replace view public.v_lot_leverage as
  select l.vin, d.name as dealer, d.city, l.year, l.make, l.model, l.trim,
         l.condition, l.odometer_km, l.list_price, l.sale_price,
         (l.list_price - l.sale_price) as cut_to_date,
         l.date_entry, l.days_in_inventory, l.first_seen_on, l.last_seen_on,
         (select count(*) from listing_price_history h where h.listing_id = l.id) as price_observations
    from vehicle_listing l
    join dealer_source d on d.id = l.dealer_id
   where l.delisted_on is null;
alter view public.v_lot_leverage set (security_invoker = on);

revoke all on public.dealer_source, public.vehicle_listing,
              public.listing_price_history, public.v_lot_leverage
  from anon, authenticated;

-- ---- 8) seed: the three Alberta SM360 dealers confirmed live 2026-08-11 -----
-- Deliberately small. The seed grows by CONFIRMING a feed responds, never by
-- guessing hosts — an unverified host in this table is a silent 404 every night.
insert into public.dealer_source (host, platform, name, city) values
  ('https://www.tazaparkvw.com',        'sm360', 'Taza Park Volkswagen',  'Calgary'),
  ('https://www.infinitinorthcalgary.ca','sm360', 'Infiniti North Calgary','Calgary'),
  ('https://www.citygm.com',            'sm360', 'City GM',               'Calgary')
on conflict (host) do nothing;
