-- Catalogue status: one row per refresh of each background catalogue.
--
-- WHY. Vic, 2026-09-25: every catalogue a report reads (MSRP, APR new and used,
-- warranty, freight & PDI, dealer fees, Alberta inventory, the per-dealer price
-- comparison, maker vs dealer) refreshes at 6am and midnight and shows in the
-- daily report "with green check marks when it is all done and a time frame".
-- Until now the only record of a refresh was a GitHub Actions log: four days of
-- a red MSRP refresh and a failed daily-report step were visible to nobody who
-- was not reading run logs.
--
-- WHAT A ROW SAYS. The job's own verdict (green = refreshed and complete,
-- amber = refreshed but partial or unverified, red = failed or not built),
-- the coverage it reached (covered of of_total, in `unit`), and ONE plain
-- sentence naming why. The page never upgrades a state; it only downgrades a
-- row that has gone stale. A catalogue with no row at all reads red.
-- [[three-state-check-marks]] [[no-single-point-of-failure]]

create table if not exists public.catalog_status (
  id          bigserial primary key,
  catalog     text        not null check (catalog in (
                'msrp', 'apr_new', 'apr_used', 'warranty', 'freight_pdi',
                'dealer_fees', 'inventory', 'price_compare', 'maker_vs_dealer')),
  ran_at      timestamptz not null default now(),
  state       text        not null check (state in ('green', 'amber', 'red')),
  rows_total  integer,
  covered     integer,
  of_total    integer,
  unit        text,
  note        text        not null check (length(btrim(note)) > 0),
  run_url     text
);

create index if not exists catalog_status_latest on public.catalog_status (catalog, ran_at desc);

-- Written by the refresh jobs with the service role only; read through the
-- function below, which returns nothing but the latest verdict per catalogue.
alter table public.catalog_status enable row level security;
revoke all on table public.catalog_status from anon, authenticated;

create or replace function public.fn_catalog_status()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(s) order by s.catalog), '[]'::jsonb)
    from (select distinct on (catalog)
                 catalog, ran_at, state, rows_total, covered, of_total, unit, note
            from public.catalog_status
           order by catalog, ran_at desc) s
$$;

revoke all on function public.fn_catalog_status() from public;
grant execute on function public.fn_catalog_status() to anon, authenticated, service_role;

comment on table public.catalog_status is
  'One row per refresh of a background catalogue: the job''s own green/amber/red verdict, its coverage and why. Read via fn_catalog_status().';
