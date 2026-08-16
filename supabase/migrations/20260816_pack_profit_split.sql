-- ============================================================================
-- Split each pack's profit three ways, by name.
--
-- The cards already showed net profit per pack. What they did not show is the
-- part a founder actually cares about: of that CA$11.90, what is MINE. Vic, JC
-- and Josh fund the bill in equal thirds, so they share the upside in the same
-- proportion — and seeing "Josh CA$3.97" against a pack he can picture selling
-- is a different kind of motivating than "CA$11.90 net".
--
-- Shares come from founder.share_bps, the SAME basis points the monthly cost
-- split uses (3334/3333/3333 summing to 10000). Reusing them means the upside
-- and the obligation can never disagree: change a share and both move together.
-- Rounding is per founder and the remainder lands on the largest share, so the
-- three figures always add back to the pack's net profit exactly.
--
-- Gated on fn_can_read_costs() — admin OR founder — because this is precisely
-- what JC and Josh should be able to see (20260815_founder_access.sql).
-- ============================================================================

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
  if not public.fn_can_read_costs() then raise exception 'not authorized' using errcode = '42501'; end if;

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
          'key', d.key, 'name', d.name, 'price_cad', d.price_cad, 'checks', d.checks,
          'best_value', d.best_value, 'sort', d.sort,
          'user_pays_per_scan', round(d.price_cad / d.checks, 2),
          'costs_us_per_scan',  v_cost_per,
          'scan_cost_per_pack', d.scan_cost,
          'stripe_fee_cad',     d.fee,
          'stripe_pct_of_price', round(100.0 * d.fee / nullif(d.price_cad,0), 1),
          'net_profit_per_pack', d.net,
          'net_margin_pct', round(100.0 * d.net / nullif(d.price_cad,0), 1),
          'packs_to_pay_bills', case when d.net > 0 then ceil(v_fixed / d.net) end,
          -- Whose money it is. Same share_bps as the cost split, so upside and
          -- obligation can never drift apart. The residual from rounding three
          -- shares to cents lands on the LARGEST share, so the names always add
          -- back to net_profit_per_pack exactly — three figures that visibly
          -- don't sum to the total is the fastest way to lose trust in a number.
          'profit_split', coalesce((
            select jsonb_agg(jsonb_build_object(
                     'name', t.display_name,
                     'share_bps', t.share_bps,
                     'profit_cad', t.share + case when t.rn = 1 then t.residual else 0 end)
                   order by t.share_bps desc, t.display_name)
              from (
                select f.display_name, f.share_bps,
                       round(d.net * f.share_bps / 10000.0, 2) as share,
                       row_number() over (order by f.share_bps desc, f.display_name) as rn,
                       d.net - sum(round(d.net * f.share_bps / 10000.0, 2)) over () as residual
                  from founder f where f.active
              ) t
          ), '[]'::jsonb)
        ) as x, d.sort
        from (
          select key, name, price_cad, checks, best_value, sort,
                 round(v_cost_per * checks, 2) as scan_cost,
                 round(price_cad * v_fee_pct / 100.0 + v_fee_fix, 2) as fee,
                 round(price_cad
                       - round(v_cost_per * checks, 2)
                       - round(price_cad * v_fee_pct / 100.0 + v_fee_fix, 2), 2) as net
            from credit_pack where active
        ) d
      ) s
    ), '[]'::jsonb)
  ) into v;

  return v;
end $$;

revoke all on function public.fn_admin_pack_economics() from anon, public;
grant execute on function public.fn_admin_pack_economics() to authenticated, service_role;
