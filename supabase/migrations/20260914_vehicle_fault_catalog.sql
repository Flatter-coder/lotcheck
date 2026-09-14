-- What owners reported to the safety regulator: the backing catalogue.
--
-- Built by scripts/build-fault-catalog.mjs from NHTSA's seven ODI complaint
-- slices. One row per year|make|model cell that holds enough filings to rank.
-- Roughly 6,300 rows at 2026-09-14, rebuilt whole on each run.
--
-- WHY A CATALOGUE AND NOT A LIVE LOOKUP. NHTSA's API sits behind an Akamai rate
-- control that answers overload with a 403 HTML page -- no 429, no Retry-After --
-- and its own use policy says the API "is NOT meant to be used by any other
-- applications". A per-scan lookup would put that failure inside a paying
-- customer's report, where a block renders as "no faults reported".
-- [[every-point-has-a-catalogue]]
--
-- WRITERS ARE service_role ONLY. On 2026-09-13 fn_upsert_listings was found
-- anon-executable because it was created three days before the 20260814
-- lockdown and `create or replace` preserves privileges. This table is locked
-- at creation instead of being locked later.

create table if not exists public.vehicle_fault_catalog (
  cell_key            text primary key,          -- '2015|TOYOTA|RAV4', from cellKey()
  model_year          int  not null,
  make                text not null,
  model               text not null,             -- the flattened model key
  nhtsa_spellings     text[] not null default '{}',   -- every NHTSA variant folded in
  total_filings       int  not null,
  unknown_only        int  not null default 0,   -- filings NHTSA typed only as "unknown or other"
  distinct_systems    int  not null default 0,
  ranking             jsonb not null,            -- { total, attributed, unknownOnly, distinctSystems, top[] }
  source_updated_at   timestamptz,               -- NHTSA's OWN Last-Modified, never our run time
  refreshed_at        timestamptz not null default now(),
  constraint vehicle_fault_catalog_year_ck
    check (model_year between 1900 and 2100),
  constraint vehicle_fault_catalog_total_ck
    check (total_filings >= 0)
);

create index if not exists vehicle_fault_catalog_ymm_idx
  on public.vehicle_fault_catalog (model_year, make, model);

comment on column public.vehicle_fault_catalog.source_updated_at is
  'Last-Modified of the NHTSA slice this cell came from. A report may only claim '
  'freshness from THIS column, never from refreshed_at: one slice was 36 days '
  'stale on 2026-09-14 while NHTSA''s page still advertised daily updates.';

comment on column public.vehicle_fault_catalog.nhtsa_spellings is
  'Every NHTSA model string folded into this cell, e.g. {"FORD F-150","FORD F-150 SUPERCREW"}. '
  'Kept so the card can say what it combined rather than implying an exact match.';

alter table public.vehicle_fault_catalog enable row level security;

-- Readable by the app (the report needs it); writable only by the builder.
drop policy if exists vehicle_fault_catalog_read on public.vehicle_fault_catalog;
create policy vehicle_fault_catalog_read
  on public.vehicle_fault_catalog for select
  to anon, authenticated
  using (true);

revoke insert, update, delete on public.vehicle_fault_catalog from anon, authenticated;
grant select on public.vehicle_fault_catalog to anon, authenticated;
grant select, insert, update, delete on public.vehicle_fault_catalog to service_role;

-- Readback, so pasting this proves what it did rather than reporting success.
select
  has_table_privilege('anon', 'public.vehicle_fault_catalog', 'SELECT')  as anon_can_read,
  has_table_privilege('anon', 'public.vehicle_fault_catalog', 'INSERT')  as anon_can_insert_should_be_false,
  has_table_privilege('anon', 'public.vehicle_fault_catalog', 'UPDATE')  as anon_can_update_should_be_false,
  has_table_privilege('service_role', 'public.vehicle_fault_catalog', 'INSERT') as builder_can_write,
  (select count(*) from public.vehicle_fault_catalog) as rows_now;
