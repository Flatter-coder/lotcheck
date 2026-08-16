-- ============================================================================
-- Profit by day / week / month, and each founder's third of it.
--
-- The panel could say what a pack earns in theory. It could not say what was
-- actually earned today. This closes that: realised profit over the three
-- windows a founder actually thinks in.
--
-- REALISED, NOT PROJECTED. It counts purchase rows in credit_ledger joined to
-- the pack they bought, then subtracts what that sale genuinely cost — the
-- Stripe fee on each transaction and the Claude tokens for the checks it
-- bought. A number that quietly counted intent, or ignored the processor, is
-- the kind that gets repeated in a founder conversation and then has to be
-- walked back.
--
-- It will read CA$0.00 until Stripe is wired, and that is correct. Zero sales
-- is zero profit; showing an aspirational figure instead would make this panel
-- exactly as trustworthy as the "checks sold" placeholders it replaced.
-- ============================================================================

create or replace function public.fn_admin_profit_periods()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v jsonb;
  v_fx numeric := 1.50;
  v_fee_pct numeric := 2.9;
  v_fee_fix numeric := 0.30;
  v_cost_per numeric;
  v_checks bigint := 0;
  v_var numeric := 0;
  v_month timestamptz := date_trunc('month', now());
begin
  if not public.fn_can_read_costs() then raise exception 'not authorized' using errcode = '42501'; end if;

  select coalesce(nullif(text_value,'')::numeric, 1.50) into v_fx      from admin_config where key = 'fx_usd_cad';
  select coalesce(nullif(text_value,'')::numeric, 2.9)  into v_fee_pct from admin_config where key = 'stripe_fee_pct';
  select coalesce(nullif(text_value,'')::numeric, 0.30) into v_fee_fix from admin_config where key = 'stripe_fee_fixed_cad';

  if to_regclass('public.api_usage_log') is not null then
    execute format('select count(*), coalesce(sum(cost_usd),0) from api_usage_log where created_at >= %L', v_month)
      into v_checks, v_var;
  end if;
  v_cost_per := case when v_checks > 0 then round((v_var * v_fx) / v_checks, 4) else 0.0416 end;

  with sales as (
    select cl.created_at, p.price_cad, p.checks
      from credit_ledger cl
      join credit_pack p on p.checks = cl.delta
     where cl.reason in ('purchase','purchase_share')
  ),
  net as (
    select created_at,
           price_cad
             - round(v_cost_per * checks, 2)
             - round(price_cad * v_fee_pct / 100.0 + v_fee_fix, 2) as profit
      from sales
  ),
  win as (
    select 'day'   as k, coalesce(sum(profit),0) as p, count(*) as n from net where created_at >= date_trunc('day', now())
    union all
    select 'week',      coalesce(sum(profit),0),      count(*) from net where created_at >= date_trunc('week', now())
    union all
    select 'month',     coalesce(sum(profit),0),      count(*) from net where created_at >= date_trunc('month', now())
  )
  select jsonb_object_agg(k, jsonb_build_object(
           'profit_cad', round(p, 2),
           'sales', n,
           -- Each founder's cut, on the same share_bps as the cost split.
           'per_founder', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'name', f.display_name,
                      'profit_cad', round(p * f.share_bps / 10000.0, 2))
                    order by f.share_bps desc, f.display_name)
               from founder f where f.active), '[]'::jsonb)
         )) into v
    from win;

  return coalesce(v, '{}'::jsonb);
end $$;

revoke all on function public.fn_admin_profit_periods() from anon, public;
grant execute on function public.fn_admin_profit_periods() to authenticated, service_role;
