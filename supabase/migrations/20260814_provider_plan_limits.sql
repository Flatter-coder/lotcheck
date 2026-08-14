-- ============================================================================
-- Plan ceilings for the provider cost panel.
--
-- Spend without its ceiling is a number you cannot act on: "$24.47" means
-- nothing until you know the cap is $100. These are the three limits, taken
-- from the vendor consoles on 2026-08-14:
--
--   Anthropic  monthly spend limit  $100      (balance $38.92, auto-reload on)
--   Scrapfly   plan credits         200,000   (33,319 used)
--   Nimble     trial requests       5,000     (835 used, trial ends in 315 days
--                                              -- but VOLUME binds first: at
--                                              ~973 requests/week that is about
--                                              five weeks, not 315 days)
--
-- They live in admin_config, not in the code, so a plan change is an UPDATE
-- rather than a deploy. A stale ceiling silently misreports headroom, which is
-- worse than no ceiling at all.
-- ============================================================================

insert into public.admin_config (key, text_value) values
  ('limit_anthropic_usd_month',  '100'),
  ('limit_scrapfly_credits',     '200000'),
  ('limit_nimble_requests',      '5000'),
  -- Vendor-reported starting points, so the panel can show a true total while
  -- provider_call is still ramping up from zero. Update these when you reset a
  -- plan or read the console again; the panel labels them as vendor-reported.
  ('baseline_scrapfly_credits',  '33319'),
  ('baseline_nimble_requests',   '835'),
  ('baseline_read_at',           '2026-08-14')
on conflict (key) do nothing;

-- Extend the provider-cost RPC with ceilings and month-to-date spend.
--
-- WHERE EACH NUMBER COMES FROM, because mixing them silently would double-count:
--   Anthropic MTD  -> api_usage_log. It has logged cost_usd since long before
--                     provider_call existed, so it is the only source with real
--                     month-to-date history. Guarded on to_regclass: that table
--                     has no migration in this repo and referencing a missing
--                     table would take the whole panel down.
--   Scrapfly/Nimble-> provider_call, which started today. Their month-to-date
--                     will read low until it has run a full month, so the panel
--                     shows the vendor-reported baseline alongside it rather
--                     than pretending our count is the whole picture.
create or replace function public.fn_admin_provider_costs(p_hours integer default 168)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v jsonb;
  v_since timestamptz := now() - make_interval(hours => greatest(1, p_hours));
  v_month timestamptz := date_trunc('month', now());
  v_anthropic_mtd numeric := 0;
  v_cfg jsonb;
begin
  if not public.fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;

  if to_regclass('public.api_usage_log') is not null then
    execute format(
      'select coalesce(sum(cost_usd), 0) from api_usage_log where created_at >= %L', v_month
    ) into v_anthropic_mtd;
  end if;

  select jsonb_object_agg(key, text_value) into v_cfg
    from admin_config
   where key like 'limit\_%' or key like 'baseline\_%';

  select jsonb_build_object(
    'window_hours', p_hours,
    'since', v_since,
    'month_start', v_month,
    'config', coalesce(v_cfg, '{}'::jsonb),
    'month_to_date', jsonb_build_object(
      'anthropic_usd',     round(v_anthropic_mtd, 2),
      'scrapfly_credits',  coalesce((select sum(credits) from provider_call
                                      where provider = 'scrapfly' and created_at >= v_month), 0),
      'nimble_requests',   coalesce((select count(*) from provider_call
                                      where provider = 'nimble' and created_at >= v_month), 0)
    ),
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

revoke all on function public.fn_admin_provider_costs(integer) from anon, public;
grant execute on function public.fn_admin_provider_costs(integer) to authenticated, service_role;
