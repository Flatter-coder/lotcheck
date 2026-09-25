-- Used-vehicle APR: each manufacturer's certified pre-owned (CPO) finance
-- rates, read from its own Canadian site.
--
-- WHY. Vic, 2026-09-25: "i need catalog of APR for used vehicle's" -- a used
-- 2025 HR-V was quoted 7.99% over 96 months and nothing in the report could say
-- what the maker's own certified program publishes. Surveyed the same day
-- across 22 makes: Toyota, Nissan, Subaru, MINI, Volkswagen and GM publish CPO
-- rates on pages we can read; Honda and Acura state that the lender sets each
-- buyer's rate; Infiniti states it offers CPO rates without a number. Those
-- three statements are rows too -- "the maker publishes none" is a finding.
--
-- A PROGRAM RATE IS NOT A QUOTE. GM's loans run through three banks, MINI's
-- headline includes a reduction that requires two protection products, and
-- every rate is "on approved credit". conditions carries the maker's words.
--
-- Replaced per make on each refresh (scripts/scrape-cpo-rates.mjs); a make whose
-- page no longer reads keeps yesterday's rows and turns the check mark amber.

create table if not exists public.cpo_rate_catalog (
  id           bigint generated always as identity primary key,
  make         text    not null,
  program      text    not null,
  status       text    not null check (status in ('published', 'lender_discretion', 'no_number')),
  model_scope  text,
  year_from    integer check (year_from is null or year_from between 2000 and 2100),
  year_to      integer check (year_to is null or year_to between 2000 and 2100),
  term_months  integer check (term_months is null or term_months between 6 and 120),
  apr          numeric check (apr is null or (apr >= 0 and apr < 30)),
  lender       text,
  conditions   text,
  valid_until  date,
  source_url   text    not null,
  read_on      date    not null,
  check ((status = 'published') = (apr is not null and term_months is not null))
);

create index if not exists cpo_rate_catalog_make on public.cpo_rate_catalog (make, read_on desc);

alter table public.cpo_rate_catalog enable row level security;
revoke all on table public.cpo_rate_catalog from anon, authenticated;

-- Every current row for a make (or all makes), for the report at scan time.
create or replace function public.fn_cpo_rates(p_make text default null)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'make', make, 'program', program, 'status', status, 'modelScope', model_scope,
           'yearFrom', year_from, 'yearTo', year_to, 'termMonths', term_months, 'apr', apr,
           'lender', lender, 'conditions', conditions, 'validUntil', valid_until,
           'sourceUrl', source_url, 'readOn', read_on)
         order by make, model_scope, year_from, term_months), '[]'::jsonb)
    from public.cpo_rate_catalog
   where p_make is null or lower(make) = lower(p_make)
$$;

revoke all on function public.fn_cpo_rates(text) from public;
grant execute on function public.fn_cpo_rates(text) to anon, authenticated, service_role;

comment on table public.cpo_rate_catalog is
  'Manufacturers'' certified pre-owned finance rates (or their stated absence), read from each maker''s own Canadian site. Read via fn_cpo_rates().';
