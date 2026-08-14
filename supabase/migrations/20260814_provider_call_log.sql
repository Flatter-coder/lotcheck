-- ============================================================================
-- Per-provider call log — the missing evidence behind "is Nimble worth keeping".
--
-- WHY A NEW TABLE. api_usage_log records ONE row per report run: success, the
-- Claude token counts, and a single cost_usd. A run fans out to Nimble (a
-- vx6/vx8 driver race, plus a separate search+extract for the MSRP fallback),
-- Scrapfly (render, screenshot, vision rescue) and Anthropic — so a failed
-- Nimble extract that the Scrapfly rescue then saves is logged as `success:
-- true` with no trace of the failure. Nimble's real failure rate and its share
-- of the bill are, today, literally unmeasurable. That is the whole reason the
-- keep-or-drop question can't be answered.
--
-- One row per PROVIDER CALL, not per run. api_usage_log is left untouched: it
-- has no migration in this repo (created ad hoc against the live DB), so
-- altering it blind is how you lose the cost history you already have.
--
-- NO PII. A provider call is about a URL and a driver, never a person. The
-- host is stored, not the full URL — enough to see which dealer platforms fail
-- without keeping the buyer's browsing.
-- ============================================================================

create table if not exists public.provider_call (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),

  provider     text not null check (provider in ('anthropic','scrapfly','nimble')),
  -- what the call was for. Deliberately coarse: 'listing_extract' is the job
  -- Scrapfly's render path also does, so the two are directly comparable.
  operation    text not null check (operation in (
                 'listing_extract','search','manufacturer_extract',
                 'render','screenshot','vision_rescue','analysis')),
  driver       text,                       -- nimble vx6/vx8/vx10, scrapfly asp/render
  listing_host text,                       -- dealer platform, never the full URL

  ok           boolean not null,
  attempts     integer not null default 1,
  duration_ms  integer,
  error_code   text,

  -- Cost is best-effort and per-provider. Anthropic is computed from tokens;
  -- Scrapfly bills in credits (60/screenshot on Discovery, ~$0.009); Nimble's
  -- per-call price is not exposed by the API, so it stays null and the panel
  -- reports Nimble in CALLS, not dollars, rather than inventing a number.
  cost_usd     numeric(10,5),
  credits      integer
);

create index if not exists provider_call_created_idx  on public.provider_call(created_at desc);
create index if not exists provider_call_provider_idx on public.provider_call(provider, created_at desc);
create index if not exists provider_call_fail_idx     on public.provider_call(provider, created_at desc) where not ok;

alter table public.provider_call enable row level security;
-- No policies: service-role writes, admin reads via the RPC below.

-- ---- write (edge functions, service role) ----------------------------------
-- Fail-open at the call site: instrumentation must never break a buyer's report.
create or replace function public.fn_log_provider_call(
  p_provider     text,
  p_operation    text,
  p_ok           boolean,
  p_driver       text default null,
  p_listing_host text default null,
  p_attempts     integer default 1,
  p_duration_ms  integer default null,
  p_error_code   text default null,
  p_cost_usd     numeric default null,
  p_credits      integer default null
) returns void
language sql security definer set search_path = public as $$
  insert into provider_call (provider, operation, ok, driver, listing_host,
                             attempts, duration_ms, error_code, cost_usd, credits)
  values (p_provider, p_operation, coalesce(p_ok,false), nullif(p_driver,''),
          nullif(p_listing_host,''), coalesce(p_attempts,1), p_duration_ms,
          nullif(p_error_code,''), p_cost_usd, p_credits);
$$;

-- ---- admin read ------------------------------------------------------------
-- Returns per-provider reliability AND cost in one shape, plus the per-operation
-- breakdown that actually answers the Nimble question: how often does
-- nimble/listing_extract fail, and how often does a Scrapfly path rescue it.
create or replace function public.fn_admin_provider_costs(p_hours integer default 168)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb; v_since timestamptz := now() - make_interval(hours => greatest(1, p_hours));
begin
  if not public.fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;

  select jsonb_build_object(
    'window_hours', p_hours,
    'since', v_since,
    'by_provider', coalesce((
      select jsonb_agg(x order by x->>'provider')
        from (
          select jsonb_build_object(
                   'provider',   provider,
                   'calls',      count(*),
                   'ok',         count(*) filter (where ok),
                   'failed',     count(*) filter (where not ok),
                   'fail_pct',   round(100.0 * count(*) filter (where not ok) / greatest(1, count(*)), 1),
                   'cost_usd',   round(coalesce(sum(cost_usd), 0), 4),
                   'credits',    coalesce(sum(credits), 0),
                   'p50_ms',     percentile_disc(0.5) within group (order by duration_ms),
                   'p95_ms',     percentile_disc(0.95) within group (order by duration_ms),
                   'retries',    coalesce(sum(attempts - 1), 0)
                 ) as x
            from provider_call
           where created_at >= v_since
           group by provider
        ) s
    ), '[]'::jsonb),
    'by_operation', coalesce((
      select jsonb_agg(x order by x->>'provider', x->>'operation')
        from (
          select jsonb_build_object(
                   'provider',  provider,
                   'operation', operation,
                   'calls',     count(*),
                   'failed',    count(*) filter (where not ok),
                   'fail_pct',  round(100.0 * count(*) filter (where not ok) / greatest(1, count(*)), 1)
                 ) as x
            from provider_call
           where created_at >= v_since
           group by provider, operation
        ) s
    ), '[]'::jsonb),
    -- The hosts where the listing extract fails most. This is what tells you
    -- whether Nimble is broadly unreliable or just walled by two platforms.
    'worst_hosts', coalesce((
      select jsonb_agg(x)
        from (
          select jsonb_build_object(
                   'host', listing_host,
                   'calls', count(*),
                   'failed', count(*) filter (where not ok)
                 ) as x
            from provider_call
           where created_at >= v_since and listing_host is not null
             and operation in ('listing_extract','render','vision_rescue')
           group by listing_host
          having count(*) filter (where not ok) > 0
           order by count(*) filter (where not ok) desc
           limit 8
        ) s
    ), '[]'::jsonb)
  ) into v;

  return v;
end $$;

-- ---- grants ----------------------------------------------------------------
-- Explicit role revokes, not `from public` — see
-- 20260814_lock_service_role_functions.sql for why that distinction matters.
revoke all on function public.fn_log_provider_call(text,text,boolean,text,text,integer,integer,text,numeric,integer) from anon, authenticated, public;
grant execute on function public.fn_log_provider_call(text,text,boolean,text,text,integer,integer,text,numeric,integer) to service_role;

revoke all on function public.fn_admin_provider_costs(integer) from anon, public;
grant execute on function public.fn_admin_provider_costs(integer) to authenticated, service_role;
