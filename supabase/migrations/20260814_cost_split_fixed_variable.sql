-- ============================================================================
-- Split the cost panel into the two things it was blurring together.
--
-- Vic: "Operational cost vs usage looks confusing... Each founder pays in
-- green, and user-driven URL running cost in red, separate, easy to
-- understand. And cost per report 1.50 really?"
--
-- The old card put a FIXED monthly burn and a PER-REPORT figure in the same
-- row of tiles, and computed "cost per check" as burn / checks — which is not
-- a unit cost at all. With few checks it reads like each report costs
-- hundreds of dollars; with many it approaches zero. Neither is true, and next
-- to it sat "sells for CA$1.50", which made CA$1.50 look like a COST.
--
-- CA$1.50 is REVENUE — the 10-pack unit price ($14.99/10). The conservative end
-- of the ladder; the 5-pack is $2.00.
--
-- Two genuinely different numbers, so two blocks:
--
--   FIXED (green)     what the founders owe every month no matter what.
--                     Claude subscription + Scrapfly plan. Does not move with
--                     usage; split three ways.
--
--   VARIABLE (red)    what USERS cause by running scans. Claude API tokens,
--                     billed on actual consumption. Scales with reports and is
--                     what report revenue has to cover.
--
-- Then the only unit economics that mean anything: variable cost per report vs
-- the CA$1.50 a report sells for, and how many paid reports cover the fixed
-- burn at that margin.
-- ============================================================================

-- Tag each line as fixed or usage-driven. Only the API credits move with usage;
-- the subscription and the Scrapfly plan are flat whatever the volume.
alter table public.operational_cost
  add column if not exists cost_type text not null default 'fixed'
    check (cost_type in ('fixed','variable'));

update public.operational_cost set cost_type = 'variable'
 where vendor = 'anthropic' and label = 'Claude API credits';

create or replace function public.fn_admin_operational_cost()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v jsonb;
  v_fx numeric := 1.50;
  v_fx_mid numeric := 1.3875;
  v_rev numeric := 1.50;
  v_month timestamptz := date_trunc('month', now());
  v_checks bigint := 0;
  v_fixed numeric := 0;
  v_var numeric := 0;
  v_founders int := 3;
begin
  if not public.fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;

  select coalesce(nullif(text_value,'')::numeric, 1.50)    into v_fx      from admin_config where key = 'fx_usd_cad';
  select coalesce(nullif(text_value,'')::numeric, 1.3875)  into v_fx_mid  from admin_config where key = 'fx_usd_cad_interbank';
  select coalesce(nullif(text_value,'')::numeric, 1.50)    into v_rev     from admin_config where key = 'revenue_per_check_cad';
  select greatest(count(*), 1) into v_founders from founder where active;

  if to_regclass('public.api_usage_log') is not null then
    execute format('select count(*) from api_usage_log where created_at >= %L', v_month) into v_checks;
  end if;

  select
    coalesce(sum(case when currency='USD' then amount*v_fx else amount end) filter (where cost_type='fixed'), 0),
    coalesce(sum(case when currency='USD' then amount*v_fx else amount end) filter (where cost_type='variable'), 0)
    into v_fixed, v_var
    from operational_cost where active and cadence = 'monthly';

  select jsonb_build_object(
    'fx_usd_cad', v_fx, 'fx_usd_cad_interbank', v_fx_mid,
    'fx_markup_pct', round(((v_fx / nullif(v_fx_mid,0)) - 1) * 100, 1),
    'fx_read_at', (select text_value from admin_config where key = 'fx_usd_cad_read_at'),
    'active_founders', v_founders,

    -- GREEN: fixed, founder-funded
    'fixed_month_cad',    round(v_fixed, 2),
    'fixed_per_founder',  round(v_fixed / v_founders, 2),

    -- RED: variable, user-driven
    'variable_month_cad', round(v_var, 2),
    'checks_this_month',  v_checks,
    -- Null, not zero, when nothing has run: "no reports yet" and "each report
    -- costs nothing" are opposite facts and must not render alike.
    'variable_per_report_cad', case when v_checks > 0 then round(v_var / v_checks, 4) end,

    -- Unit economics that actually mean something
    'revenue_per_report_cad', v_rev,
    'margin_per_report_cad',  case when v_checks > 0 then round(v_rev - (v_var / v_checks), 4) end,
    -- Paid reports needed to cover the fixed burn at the current margin.
    'breakeven_reports', case
        when v_checks > 0 and (v_rev - (v_var / v_checks)) > 0
          then ceil(v_fixed / (v_rev - (v_var / v_checks)))
        when v_rev > 0 then ceil(v_fixed / v_rev)
      end,

    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'vendor', vendor, 'label', label, 'amount', amount, 'currency', currency,
               'cost_type', cost_type, 'billing_day', billing_day, 'note', note,
               'cad', round(case when currency='USD' then amount*v_fx else amount end, 2))
             order by cost_type, (case when currency='USD' then amount*v_fx else amount end) desc)
        from operational_cost where active and cadence='monthly'
    ), '[]'::jsonb)
  ) into v;

  return v;
end $$;

revoke all on function public.fn_admin_operational_cost() from anon, public;
grant execute on function public.fn_admin_operational_cost() to authenticated, service_role;
