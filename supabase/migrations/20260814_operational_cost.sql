-- ============================================================================
-- Operational cost — what LotCheck pays to run, against what it processes.
--
-- The provider panel answers "how much did the API calls cost". This answers
-- the question that actually decides the business: what does a check COST us,
-- versus what a check SELLS for. Credit packs price a check at roughly
-- CA$1.50-2.00 (1 free / $9.99 for 5 / $14.99 for 10), so the fixed monthly
-- burn divided by monthly checks is the whole unit-economics story on one line.
--
-- FIXED COSTS AS OF 2026-08-14 (from Vic, with the vendor consoles):
--   Claude subscription   CA$294.00/month, billed the 8th   (invoice NA6DBMZO-0004)
--   Claude API credits    US$50.00/month, auto-reload       (console cap US$100)
--   Scrapfly DISCOVERY    US$30.00/month, billed the 10th   (invoice X3J1RQES-0001)
--   Nimble                $0 — free trial, 5,000 requests
--
-- So the month has two fixed hits, two days apart: the 8th and the 10th.
--
-- FX — TWO RATES, and the difference is real money.
--   interbank  1.3875 on 2026-08-14 (frankfurter.dev; a second feed said 1.3934)
--   card       1.50   what the credit card actually bills, markup included
--
-- The panel converts at the CARD rate, because operational cost means what
-- leaves the bank account, not what a mid-market quote says it should have.
-- US$50 shows as CA$75.00, which is what was really charged — the ~CA$5.60 gap
-- against interbank IS the card's conversion fee, not an error.
--
-- The interbank rate is kept alongside it so the spread stays visible: at 1.50
-- vs 1.3875 the card is taking about 8.1%, which on US$80/month of vendor spend
-- is roughly CA$108/year. Worth knowing; worth re-checking if a card changes.
--
-- Both are stored, not hardcoded, because a rate that silently ages is how a
-- cost panel starts lying.
-- ============================================================================

create table if not exists public.operational_cost (
  id          uuid primary key default gen_random_uuid(),
  vendor      text not null,
  label       text not null,
  amount      numeric(10,2) not null check (amount >= 0),
  currency    text not null check (currency in ('CAD','USD')),
  cadence     text not null default 'monthly' check (cadence in ('monthly','annual','usage')),
  billing_day integer check (billing_day between 1 and 28),  -- null = on demand / auto-reload
  active      boolean not null default true,
  note        text,
  updated_at  timestamptz not null default now()
);
create unique index if not exists operational_cost_line_idx on public.operational_cost(vendor, label);
alter table public.operational_cost enable row level security;

insert into public.operational_cost (vendor, label, amount, currency, cadence, billing_day, note) values
  ('anthropic', 'Claude subscription', 294.00, 'CAD', 'monthly', 8,
   'Invoice NA6DBMZO-0004, paid 2026-08-08'),
  ('anthropic', 'Claude API credits',   50.00, 'USD', 'monthly', null,
   'Auto-reload on; console monthly spend cap US$100'),
  ('scrapfly',  'Scrapfly DISCOVERY',   30.00, 'USD', 'monthly', 10,
   'Invoice X3J1RQES-0001, period 2026-08-10 to 2026-09-10. 200,000 credits, max concurrency 5'),
  ('nimble',    'Nimble',                0.00, 'USD', 'monthly', null,
   'Free trial — 5,000 requests. At ~973 req/week the allowance, not the 315-day clock, binds first.')
on conflict (vendor, label) do nothing;

insert into public.admin_config (key, text_value) values
  -- What the card actually bills. This is the one the panel converts at.
  ('fx_usd_cad',            '1.50'),
  -- Mid-market, for reference, so the card's spread stays visible.
  ('fx_usd_cad_interbank',  '1.3875'),
  ('fx_usd_cad_read_at',    '2026-08-14'),
  -- The conservative end of the credit-pack ladder ($14.99 for 10). Using the
  -- LOW figure means break-even is reported pessimistically, which is the right
  -- direction for a number you plan against.
  ('revenue_per_check_cad', '1.50')
on conflict (key) do nothing;

-- ---- admin read ------------------------------------------------------------
create or replace function public.fn_admin_operational_cost()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v jsonb;
  v_fx numeric := 1.50;        -- card-effective, what actually gets billed
  v_fx_mid numeric := 1.3875;  -- interbank, reference only
  v_rev numeric := 1.50;
  v_month timestamptz := date_trunc('month', now());
  v_checks bigint := 0;
  v_total numeric := 0;
begin
  if not public.fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;

  select coalesce(nullif(text_value,'')::numeric, 1.50) into v_fx
    from admin_config where key = 'fx_usd_cad';
  select coalesce(nullif(text_value,'')::numeric, 1.3875) into v_fx_mid
    from admin_config where key = 'fx_usd_cad_interbank';
  select coalesce(nullif(text_value,'')::numeric, 1.50) into v_rev
    from admin_config where key = 'revenue_per_check_cad';

  -- Volume comes from api_usage_log, the only source with real history.
  -- Guarded: it has no migration in this repo (see 20260814_provider_plan_limits.sql).
  if to_regclass('public.api_usage_log') is not null then
    execute format('select count(*) from api_usage_log where created_at >= %L', v_month)
      into v_checks;
  end if;

  select coalesce(sum(case when currency = 'USD' then amount * v_fx else amount end), 0)
    into v_total
    from operational_cost
   where active and cadence = 'monthly';

  select jsonb_build_object(
    'fx_usd_cad',        v_fx,
    'fx_usd_cad_interbank', v_fx_mid,
    -- What the card's conversion costs, made explicit rather than buried in a
    -- total: on the USD lines this is the difference between the mid-market
    -- price and the real one.
    'fx_markup_pct',     round(((v_fx / nullif(v_fx_mid,0)) - 1) * 100, 1),
    'fx_markup_cad_year', round(
      (select coalesce(sum(amount),0) from operational_cost
        where active and cadence = 'monthly' and currency = 'USD') * (v_fx - v_fx_mid) * 12, 2),
    'fx_read_at',    (select text_value from admin_config where key = 'fx_usd_cad_read_at'),
    'monthly_total_cad', round(v_total, 2),
    'checks_this_month', v_checks,
    -- Null rather than a divide-by-zero-flavoured 0: "no checks yet" and
    -- "costs nothing per check" are opposite facts and must not render alike.
    'cost_per_check_cad', case when v_checks > 0 then round(v_total / v_checks, 2) end,
    'revenue_per_check_cad', v_rev,
    'breakeven_checks', case when v_rev > 0 then ceil(v_total / v_rev) end,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'vendor',      vendor,
               'label',       label,
               'amount',      amount,
               'currency',    currency,
               'cad',         round(case when currency = 'USD' then amount * v_fx else amount end, 2),
               'billing_day', billing_day,
               'note',        note
             ) order by (case when currency = 'USD' then amount * v_fx else amount end) desc)
        from operational_cost where active and cadence = 'monthly'
    ), '[]'::jsonb)
  ) into v;

  return v;
end $$;

revoke all on function public.fn_admin_operational_cost() from anon, public;
grant execute on function public.fn_admin_operational_cost() to authenticated, service_role;
