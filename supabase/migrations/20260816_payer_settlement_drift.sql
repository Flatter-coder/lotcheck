-- ============================================================================
-- The vendor payer drifts every time a usage actual is trued up.
--
-- Vic's balance reads CA$-12.77 — he appears to have overpaid. He has not.
--
-- WHAT HAPPENS. Accrual writes TWO rows for the founder whose card pays the
-- vendors: the charge for his share, and a matching settlement, because paying
-- the vendor discharges his own share the moment he does it. His balance is
-- therefore always zero, by construction.
--
-- Then fn_admin_record_usage_actual trues up a variable line to its real
-- figure. August's Claude API credits moved CA$25.00 -> CA$12.24, and the
-- true-up wrote an adjustment against the CHARGE. It did not touch the
-- SETTLEMENT, which still says he paid the CA$25.00 version.
--
--   settled  97.99 + 25.00 + 15.00 = 137.99
--   charged  97.99 + 12.24 + 15.00 = 125.23
--   balance                          -12.76
--
-- SAME CLASS AS EVERYTHING ELSE TODAY: a correction applied to one side of a
-- paired entry. The fix is not to zero the number — it is that a true-up must
-- move BOTH halves of a pair, so the class cannot recur on the next actual, or
-- on any future variable line.
--
-- The payer's balance is now zero by arithmetic rather than by luck, and it
-- stays zero however often a usage figure is revised.
-- ============================================================================

create or replace function public.fn_admin_record_usage_actual(
  p_vendor      text,
  p_line_label  text,
  p_period_month date,
  p_amount      numeric,
  p_currency    text default 'USD',
  p_source      text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', 'admin');
  v_fx numeric;
  v_cad numeric;
  v_f record;
  v_charged numeric;
  v_should numeric;
  v_delta numeric;
  v_month date := date_trunc('month', p_period_month)::date;
  v_n int := 0;
begin
  if not public.fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;

  select coalesce(nullif(text_value,'')::numeric, 1.50) into v_fx
    from admin_config where key = 'fx_usd_cad';

  insert into vendor_usage_actual (vendor, line_label, period_month, amount, currency, source, recorded_by)
  values (p_vendor, p_line_label, v_month, p_amount, upper(p_currency), p_source, v_actor)
  on conflict (vendor, line_label, period_month)
    do update set amount = excluded.amount, currency = excluded.currency,
                  source = excluded.source, recorded_at = now(), recorded_by = excluded.recorded_by;

  v_cad := round(case when upper(p_currency) = 'USD' then p_amount * v_fx else p_amount end, 2);

  update operational_cost
     set amount = p_amount, currency = upper(p_currency), updated_at = now()
   where vendor = p_vendor and label = p_line_label and active;

  for v_f in
    select l.founder_id, f.share_bps, f.pays_vendors, sum(l.amount_cad) as charged
      from founder_ledger l
      join founder f on f.id = l.founder_id
     where l.kind in ('charge','adjustment')
       and l.line_label = p_line_label
       and l.period_month = v_month
     group by l.founder_id, f.share_bps, f.pays_vendors
  loop
    v_charged := v_f.charged;
    v_should  := round(v_cad * v_f.share_bps / 10000.0, 2);
    v_delta   := round(v_should - v_charged, 2);

    if abs(v_delta) >= 0.01 then
      insert into founder_ledger (founder_id, period_month, kind, amount_cad,
                                  vendor, line_label, note, recorded_by)
      values (v_f.founder_id, v_month, 'adjustment', v_delta, p_vendor, p_line_label,
              format('True-up to actual %s%s (was %s, now %s)',
                     upper(p_currency), to_char(p_amount,'FM999990.00'),
                     to_char(v_charged,'FM999990.00'), to_char(v_should,'FM999990.00')),
              v_actor);
      v_n := v_n + 1;

      -- BOTH HALVES. The vendor payer's settlement was written against the old
      -- charge; without this it keeps saying he paid the superseded figure and
      -- his balance drifts by the delta on every revision.
      if v_f.pays_vendors then
        insert into founder_ledger (founder_id, period_month, kind, amount_cad,
                                    vendor, line_label, note, recorded_by)
        values (v_f.founder_id, v_month, 'adjustment', -v_delta, p_vendor, p_line_label,
                'Own-share settlement follows the true-up — paid to the vendor directly',
                v_actor);
        v_n := v_n + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object('recorded', true, 'cad_total', v_cad, 'adjustments', v_n);
end $$;

revoke all on function public.fn_admin_record_usage_actual(text,text,date,numeric,text,text) from anon, public;
grant execute on function public.fn_admin_record_usage_actual(text,text,date,numeric,text,text) to authenticated, service_role;

-- Correct the drift already on the books. Append-only, so this is a new
-- adjustment row that names itself, not an edit to the settlement that was
-- written in good faith against the figure known at the time.
do $$
declare v_id uuid; v_bal numeric;
begin
  select f.id into v_id from founder f where f.pays_vendors and f.active limit 1;
  if v_id is null then return; end if;

  select round(coalesce(sum(amount_cad), 0), 2) into v_bal
    from founder_ledger where founder_id = v_id;

  -- A payer who has settled every share he was charged nets to zero. Anything
  -- else is drift from a revision that moved one half of a pair.
  if abs(v_bal) >= 0.01 then
    insert into founder_ledger (founder_id, period_month, kind, amount_cad, note, recorded_by)
    values (v_id, date_trunc('month', now())::date, 'adjustment', -v_bal,
            format('Settlement true-up: payer balance was %s after a usage revision moved the charge but not the matching settlement',
                   to_char(v_bal, 'FM999990.00')),
            'backfill');
    raise notice 'corrected payer drift of %', v_bal;
  else
    raise notice 'payer balance already square';
  end if;
end $$;
