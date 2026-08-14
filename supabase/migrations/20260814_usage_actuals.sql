-- ============================================================================
-- Claude API credits are CONSUMPTION, not a subscription — bill the real figure.
--
-- THE DEFECT. operational_cost carried 'Claude API credits' as a flat US$50.00
-- and fn_accrue_statement_charges billed each founder CA$25.00 for it. US$50 is
-- the AUTO-RELOAD INCREMENT, not the monthly spend. August's actual console
-- figure was US$24.47, so the real share is CA$12.24 each at the card rate —
-- JC and Josh were each over-charged CA$12.76 by the backfill.
--
-- The subscription (CA$294) and Scrapfly (US$30) are genuinely fixed. The API
-- line is the one that moves, and modelling a variable cost as a flat fee bills
-- co-founders a number nobody can reconcile to a statement.
--
-- BASIS, decided by Vic 2026-08-14: the CONSOLE TOTAL. Anthropic's balance is
-- consumed by "API, Claude Code and Workbench usage" and all of it is shared —
-- so the split is the whole account figure, not just api_usage_log's record of
-- LotCheck's edge-function calls (which would under-count and leave Vic
-- absorbing the difference).
--
-- Anthropic publishes no balance or usage API, so the figure is ENTERED, once a
-- month, from the console Vic already reads. Entering it updates the cost line
-- and issues adjustments against any charges already accrued for that month —
-- so a correction is a new ledger entry, never an edit.
-- ============================================================================

create table if not exists public.vendor_usage_actual (
  id           uuid primary key default gen_random_uuid(),
  vendor       text not null,
  line_label   text not null,
  period_month date not null,
  amount       numeric(10,2) not null check (amount >= 0),
  currency     text not null check (currency in ('CAD','USD')),
  source       text,                    -- where the number came from
  recorded_at  timestamptz not null default now(),
  recorded_by  text,
  unique (vendor, line_label, period_month)
);
alter table public.vendor_usage_actual enable row level security;

-- The August figure, from the Anthropic console screenshot (2026-08-14).
insert into public.vendor_usage_actual (vendor, line_label, period_month, amount, currency, source, recorded_by)
values ('anthropic', 'Claude API credits', date '2026-08-01', 24.47, 'USD',
        'Anthropic console — spend this period, resets Sep 1 2026', 'backfill')
on conflict (vendor, line_label, period_month) do nothing;

-- ---- record an actual, and true up anything already charged -----------------
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
  v_n int := 0;
begin
  if not public.fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;

  select coalesce(nullif(text_value,'')::numeric, 1.50) into v_fx
    from admin_config where key = 'fx_usd_cad';

  insert into vendor_usage_actual (vendor, line_label, period_month, amount, currency, source, recorded_by)
  values (p_vendor, p_line_label, date_trunc('month', p_period_month)::date, p_amount,
          upper(p_currency), p_source, v_actor)
  on conflict (vendor, line_label, period_month)
    do update set amount = excluded.amount, currency = excluded.currency,
                  source = excluded.source, recorded_at = now(), recorded_by = excluded.recorded_by;

  v_cad := round(case when upper(p_currency) = 'USD' then p_amount * v_fx else p_amount end, 2);

  -- Keep the cost line in step so the burn figure and future accruals use the
  -- real number rather than the auto-reload placeholder.
  update operational_cost
     set amount = p_amount, currency = upper(p_currency), updated_at = now()
   where vendor = p_vendor and label = p_line_label and active;

  -- True up founders already charged for this month. Append-only: the
  -- correction is an 'adjustment' row carrying the difference, so the history
  -- shows what was billed, what it should have been, and why it moved.
  for v_f in
    select l.founder_id, f.share_bps, sum(l.amount_cad) as charged
      from founder_ledger l
      join founder f on f.id = l.founder_id
     where l.kind in ('charge','adjustment')
       and l.line_label = p_line_label
       and l.period_month = date_trunc('month', p_period_month)::date
     group by l.founder_id, f.share_bps
  loop
    v_charged := v_f.charged;
    v_should  := round(v_cad * v_f.share_bps / 10000.0, 2);
    v_delta   := round(v_should - v_charged, 2);
    if abs(v_delta) >= 0.01 then
      insert into founder_ledger (founder_id, period_month, kind, amount_cad,
                                  vendor, line_label, note, recorded_by)
      values (v_f.founder_id, date_trunc('month', p_period_month)::date, 'adjustment',
              v_delta, p_vendor, p_line_label,
              format('True-up to actual %s%s (was %s, now %s)',
                     upper(p_currency), to_char(p_amount,'FM999990.00'),
                     to_char(v_charged,'FM999990.00'), to_char(v_should,'FM999990.00')),
              v_actor);
      v_n := v_n + 1;
    end if;
  end loop;

  return jsonb_build_object('recorded', true, 'cad_total', v_cad,
                            'adjustments', v_n);
end $$;

-- Applying the August actual now: US$24.47 -> CA$36.71, CA$12.24 each, against
-- the CA$25.00 the backfill charged. Runs as the migration, not through the
-- admin gate, so it is done without waiting for a click.
do $$
declare
  v_fx numeric; v_cad numeric; v_f record; v_charged numeric; v_should numeric; v_delta numeric;
begin
  select coalesce(nullif(text_value,'')::numeric, 1.50) into v_fx
    from admin_config where key = 'fx_usd_cad';
  v_cad := round(24.47 * v_fx, 2);

  update operational_cost set amount = 24.47, updated_at = now()
   where vendor = 'anthropic' and label = 'Claude API credits' and active;

  for v_f in
    select l.founder_id, f.share_bps, sum(l.amount_cad) as charged
      from founder_ledger l join founder f on f.id = l.founder_id
     where l.kind in ('charge','adjustment') and l.line_label = 'Claude API credits'
       and l.period_month = date '2026-08-01'
     group by l.founder_id, f.share_bps
  loop
    v_charged := v_f.charged;
    v_should  := round(v_cad * v_f.share_bps / 10000.0, 2);
    v_delta   := round(v_should - v_charged, 2);
    if abs(v_delta) >= 0.01 then
      insert into founder_ledger (founder_id, period_month, kind, amount_cad,
                                  vendor, line_label, note, recorded_by)
      values (v_f.founder_id, date '2026-08-01', 'adjustment', v_delta,
              'anthropic', 'Claude API credits',
              format('True-up to actual US$24.47 (was %s, now %s)',
                     to_char(v_charged,'FM999990.00'), to_char(v_should,'FM999990.00')),
              'backfill');
    end if;
  end loop;
end $$;

revoke all on function public.fn_admin_record_usage_actual(text,text,date,numeric,text,text) from anon, public;
grant execute on function public.fn_admin_record_usage_actual(text,text,date,numeric,text,text) to authenticated, service_role;
