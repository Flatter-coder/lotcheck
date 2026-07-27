-- lease_rate_catalog — manufacturer advertised LEASE rates by model + term.
-- Mirrors finance_rate_catalog but adds the lease-specific annual km allowance.
-- Populated by the catalog scrapers (scripts/lib/tci-stack.mjs) from each
-- brand's own build-&-price interest_rates.json. Run this once in the Supabase
-- SQL editor (or via `supabase db push`) before enabling lease writes.

create table if not exists public.lease_rate_catalog (
  id             bigint generated always as identity primary key,
  make           text        not null,
  model          text        not null,
  apr            numeric     not null,          -- annual percentage rate, e.g. 5.89
  term_months    integer     not null,          -- 24 / 36 / 39 / 48 / 60 ...
  annual_km      integer,                        -- lease km allowance, e.g. 20000
  effective_date date,
  created_at     timestamptz not null default now()
);

create index if not exists lease_rate_catalog_make_model_idx
  on public.lease_rate_catalog (lower(make), lower(model));

-- Read-only to the anon/public role, same posture as the other catalog tables
-- (the edge functions read with the service role; the browser never writes).
alter table public.lease_rate_catalog enable row level security;

drop policy if exists "lease_rate_catalog_read" on public.lease_rate_catalog;
create policy "lease_rate_catalog_read"
  on public.lease_rate_catalog for select
  using (true);
