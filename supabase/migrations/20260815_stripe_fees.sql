-- ============================================================================
-- Stripe's cut, as its own line — because it is bigger than the compute.
--
-- Stripe Canada charges 2.9% + C$0.30 on a domestic card. Per pack:
--
--   $4.99   fee C$0.44   8.9% of revenue
--   $9.99   fee C$0.59   5.9%
--   $12.99  fee C$0.68   5.2%
--
-- THE POINT. A URL scan costs about C$0.03 in Claude tokens. Stripe takes
-- C$0.44 on a $4.99 sale — roughly FIFTEEN TIMES the compute. Every instinct
-- says the AI is the expensive part; on the entry tier the payment processor
-- costs more than the product does, and the flat C$0.30 is why: it lands
-- hardest on the smallest basket, which is exactly the one the new ladder was
-- designed to attract.
--
-- That is not an argument against $4.99 — the margin is still 90% — but it IS
-- an argument for the 3- and 5-packs, where the fixed 30c is spread. It is also
-- the number that would have quietly eaten the difference if profit had been
-- reported as price minus token cost.
--
-- Rates live in admin_config: Stripe's pricing changes, cross-border and
-- currency-conversion cards cost more, and a hardcoded 2.9% would silently
-- overstate profit the day any of that shifts.
-- ============================================================================

insert into public.admin_config (key, text_value) values
  ('stripe_fee_pct',   '2.9'),
  ('stripe_fee_fixed_cad', '0.30'),
  ('stripe_fee_note',  'Stripe Canada domestic card rate as of 2026-08-15. International cards and currency conversion cost more — raise these if the mix shifts.')
on conflict (key) do update set text_value = excluded.text_value, updated_at = now();

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
  v_fee_pct numeric := 2.9;
  v_fee_fix numeric := 0.30;
begin
  if not public.fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;

  select coalesce(nullif(text_value,'')::numeric, 1.50) into v_fx      from admin_config where key = 'fx_usd_cad';
  select coalesce(nullif(text_value,'')::numeric, 2.9)  into v_fee_pct from admin_config where key = 'stripe_fee_pct';
  select coalesce(nullif(text_value,'')::numeric, 0.30) into v_fee_fix from admin_config where key = 'stripe_fee_fixed_cad';

  if to_regclass('public.api_usage_log') is not null then
    execute format('select count(*), coalesce(sum(cost_usd),0) from api_usage_log where created_at >= %L', v_month)
      into v_checks, v_var;
  end if;
  v_cost_per := case when v_checks > 0 then round((v_var * v_fx) / v_checks, 4) else 0.0416 end;

  select coalesce(sum(case when currency='USD' then amount*v_fx else amount end), 0) into v_fixed
    from operational_cost where active and cadence='monthly' and cost_type='fixed';

  select coalesce(sum(p.price_cad), 0) into v_rev_month
    from credit_ledger cl
    join credit_pack p on p.checks = cl.delta
   where cl.reason in ('purchase','purchase_share') and cl.created_at >= v_month;

  select jsonb_build_object(
    'cost_per_scan_cad', v_cost_per,
    'cost_basis', case when v_checks > 0 then format('measured — %s scans this month', v_checks)
                       else 'estimate — no scans yet this month' end,
    'stripe_fee_pct', v_fee_pct,
    'stripe_fee_fixed_cad', v_fee_fix,
    'fixed_month_cad', round(v_fixed, 2),
    'revenue_month_cad', round(v_rev_month, 2),
    'bills_paid_pct', case when v_fixed > 0 then round(100.0 * v_rev_month / v_fixed, 1) else 0 end,
    'bills_paid', (v_rev_month >= v_fixed),
    'still_needed_cad', round(greatest(v_fixed - v_rev_month, 0), 2),
    'packs', coalesce((
      select jsonb_agg(x order by (x->>'sort')::int) from (
        select jsonb_build_object(
          'key', key, 'name', name, 'price_cad', price_cad, 'checks', checks,
          'best_value', best_value, 'sort', sort,
          'user_pays_per_scan', round(price_cad / checks, 2),
          'costs_us_per_scan',  v_cost_per,
          'scan_cost_per_pack', round(v_cost_per * checks, 2),
          -- Stripe, on its own line. One charge per pack, not per scan.
          'stripe_fee_cad',     round(price_cad * v_fee_pct / 100.0 + v_fee_fix, 2),
          'stripe_pct_of_price', round(100.0 * (price_cad * v_fee_pct / 100.0 + v_fee_fix) / nullif(price_cad,0), 1),
          -- Net of BOTH costs. Reporting profit without the processor fee is
          -- how a 90% margin gets mistaken for a 99% one.
          'net_profit_per_pack', round(price_cad - (v_cost_per * checks) - (price_cad * v_fee_pct / 100.0 + v_fee_fix), 2),
          'net_margin_pct', round(100.0 * (price_cad - (v_cost_per * checks) - (price_cad * v_fee_pct / 100.0 + v_fee_fix)) / nullif(price_cad,0), 1),
          'packs_to_pay_bills',
            case when (price_cad - (v_cost_per * checks) - (price_cad * v_fee_pct / 100.0 + v_fee_fix)) > 0
                 then ceil(v_fixed / (price_cad - (v_cost_per * checks) - (price_cad * v_fee_pct / 100.0 + v_fee_fix))) end
        ) as x, sort
        from credit_pack where active
      ) s
    ), '[]'::jsonb)
  ) into v;

  return v;
end $$;

revoke all on function public.fn_admin_pack_economics() from anon, public;
grant execute on function public.fn_admin_pack_economics() to authenticated, service_role;
