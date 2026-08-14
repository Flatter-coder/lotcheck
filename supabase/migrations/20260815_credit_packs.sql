-- ============================================================================
-- New credit ladder, and the number that should make a founder sit up.
--
--   1 check   $4.99   $4.99 each
--   3 checks  $9.99   $3.33 each
--   5 checks  $12.99  $2.60 each
--
-- WHAT CHANGED AND WHY. The old ladder (5 for $9.99, 10 for $14.99) forced a
-- $9.99 minimum on someone looking at one car. Most buyers check one or two
-- vehicles, so the entry price was the barrier, not the unit price. $4.99 buys
-- exactly what a typical buyer needs.
--
-- The 5-pack is $12.99, not $14.99, deliberately. At $14.99 the marginal price
-- was flat -- $4.99->$9.99 and $9.99->$14.99 are both +$5 for +2 checks -- so
-- the 5-pack gave a buyer no reason to trade up from the 3-pack. $12.99 makes
-- the last two checks $1.50 each and the ladder actually pull.
--
-- THE EYE-OPENER. A URL scan costs LotCheck about CA$0.03 in Claude tokens.
-- The buyer pays CA$2.60-4.99 for it. That is a 99%+ gross margin per report,
-- and it is why the fixed CA$339/month is the whole battle: cover it and every
-- further report is nearly pure margin. The panel now states both numbers side
-- by side per tier, because "what it costs us" and "what they pay" being three
-- orders of magnitude apart is the single most useful fact about this business.
--
-- FREE TIER. Removed from the ladder for now (email-abuse concern). The
-- anonymous free-check machinery in free_check_daily / free_check_ip_daily is
-- left intact and simply not offered, so re-enabling it -- ideally gated behind
-- the existing magic-link sign-in rather than removed outright -- is a config
-- change, not a rebuild.
-- ============================================================================

create table if not exists public.credit_pack (
  key           text primary key,
  name          text not null,
  price_cad     numeric(10,2) not null check (price_cad >= 0),
  checks        integer not null check (checks > 0),
  share_credits integer not null default 0,
  sort          integer not null default 0,
  active        boolean not null default true,
  best_value    boolean not null default false,
  stripe_price_id text,                  -- filled once the Stripe price exists
  updated_at    timestamptz not null default now()
);
alter table public.credit_pack enable row level security;

-- Buyers need to READ the ladder to see what they can buy. Prices are public
-- information; nothing here is sensitive.
drop policy if exists credit_pack_read on public.credit_pack;
create policy credit_pack_read on public.credit_pack for select using (active);
grant select on public.credit_pack to anon, authenticated;

insert into public.credit_pack (key, name, price_cad, checks, share_credits, sort, best_value) values
  ('single', '1 check',  4.99, 1, 0, 1, false),
  ('three',  '3 checks', 9.99, 3, 1, 2, false),
  ('five',   '5 checks', 12.99, 5, 2, 3, true)
on conflict (key) do update
  set name = excluded.name, price_cad = excluded.price_cad, checks = excluded.checks,
      share_credits = excluded.share_credits, sort = excluded.sort,
      best_value = excluded.best_value, active = true, updated_at = now();

-- Retire the old ladder rather than deleting it, so historical purchases still
-- resolve to a pack name.
update public.credit_pack set active = false, best_value = false
 where key in ('ten','free','sub') ;

-- ---- per-pack economics -----------------------------------------------------
create or replace function public.fn_admin_pack_economics()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v jsonb;
  v_fx numeric := 1.50;
  v_month timestamptz := date_trunc('month', now());
  v_checks bigint := 0;
  v_var numeric := 0;
  v_cost_per numeric;
  v_fixed numeric := 0;
  v_rev_month numeric := 0;
begin
  if not public.fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  select coalesce(nullif(text_value,'')::numeric, 1.50) into v_fx from admin_config where key = 'fx_usd_cad';

  -- Actual cost per scan this month, measured — not assumed. Falls back to the
  -- measured intro-pricing figure only when no scans have run yet.
  if to_regclass('public.api_usage_log') is not null then
    execute format('select count(*), coalesce(sum(cost_usd),0) from api_usage_log where created_at >= %L', v_month)
      into v_checks, v_var;
  end if;
  v_cost_per := case when v_checks > 0 then round((v_var * v_fx) / v_checks, 4) else 0.0416 end;

  select coalesce(sum(case when currency='USD' then amount*v_fx else amount end), 0) into v_fixed
    from operational_cost where active and cadence='monthly' and cost_type='fixed';

  -- Revenue actually taken this month, from the credit ledger's purchase rows.
  select coalesce(sum(p.price_cad), 0) into v_rev_month
    from credit_ledger cl
    join credit_pack p on p.checks = cl.delta
   where cl.reason in ('purchase','purchase_share') and cl.created_at >= v_month;

  select jsonb_build_object(
    'cost_per_scan_cad', v_cost_per,
    'cost_basis', case when v_checks > 0 then format('measured — %s scans this month', v_checks)
                       else 'estimate — no scans yet this month' end,
    'fixed_month_cad', round(v_fixed, 2),
    'revenue_month_cad', round(v_rev_month, 2),
    'bills_paid_pct', case when v_fixed > 0 then round(100.0 * v_rev_month / v_fixed, 1) else 0 end,
    'bills_paid', (v_rev_month >= v_fixed),
    'still_needed_cad', round(greatest(v_fixed - v_rev_month, 0), 2),
    'packs', coalesce((
      select jsonb_agg(jsonb_build_object(
               'key', key, 'name', name, 'price_cad', price_cad, 'checks', checks,
               'best_value', best_value,
               'user_pays_per_scan', round(price_cad / checks, 2),
               'costs_us_per_scan',  v_cost_per,
               'cost_per_pack',      round(v_cost_per * checks, 2),
               'profit_per_scan',    round((price_cad / checks) - v_cost_per, 2),
               'profit_per_pack',    round(price_cad - (v_cost_per * checks), 2),
               'margin_pct',         round(100.0 * (price_cad - (v_cost_per * checks)) / nullif(price_cad,0), 1),
               -- How many of THIS pack alone cover the fixed monthly bill.
               'packs_to_pay_bills', case when (price_cad - (v_cost_per * checks)) > 0
                                          then ceil(v_fixed / (price_cad - (v_cost_per * checks))) end,
               'scans_to_pay_bills', case when ((price_cad / checks) - v_cost_per) > 0
                                          then ceil(v_fixed / ((price_cad / checks) - v_cost_per)) end
             ) order by sort)
        from credit_pack where active
    ), '[]'::jsonb)
  ) into v;

  return v;
end $$;

revoke all on function public.fn_admin_pack_economics() from anon, public;
grant execute on function public.fn_admin_pack_economics() to authenticated, service_role;
