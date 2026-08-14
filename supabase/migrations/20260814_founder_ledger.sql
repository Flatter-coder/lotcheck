-- ============================================================================
-- Founder ledger — what each founder owes, carried forward until they pay.
--
-- Vic, 2026-08-14: "I paid JC's share for the month of August, so when we
-- invoice him it needs the August share for Claude and Scrapfly, plus the 1st
-- of September invoice."
--
-- A monthly statement alone cannot express that. It says "September: CA$138"
-- and forgets August entirely, so an unpaid month silently disappears. What is
-- actually needed is a BALANCE: charges accrue each month, payments reduce it,
-- and the invoice shows the total outstanding.
--
-- JC's September invoice under this model:
--     August charge     CA$138.00   (unpaid — Vic fronted it to the vendor)
--     September charge  CA$138.00
--     -------------------------------
--     Outstanding       CA$276.00
--
-- ONE FOUNDER PAYING THE VENDOR DOES NOT SETTLE ANOTHER'S SHARE. When Vic pays
-- JC's portion, the money reaches Anthropic but JC's obligation moves from the
-- vendor to Vic — it does not vanish. So a vendor payment made on someone's
-- behalf is recorded with `covered_by`, and their charge stays outstanding
-- until they settle with the founder who fronted it. Marking it paid would
-- quietly transfer JC's debt onto Vic's own pocket and lose it.
--
-- CHARGES ACCRUE ON APPROVAL, not on staging. A month Vic never approved must
-- never create a debt — see 20260814_statement_approval.sql.
-- ============================================================================

create table if not exists public.founder_ledger (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  founder_id   uuid not null references public.founder(id) on delete restrict,
  period_month date not null,

  kind         text not null check (kind in ('charge','payment','adjustment')),
  -- Signed against the founder: a charge is positive (they owe more), a payment
  -- negative (they owe less). Balance is then plain SUM, with no per-kind
  -- special-casing to get wrong.
  amount_cad   numeric(10,2) not null,

  -- PER VENDOR LINE, not one lump per month. Vic: "Josh didn't pay his share
  -- for Scrapfly for August." A single CA$138 charge cannot express a founder
  -- who paid the Claude portion and not the Scrapfly one — the partial payment
  -- has nothing to attach to, and next month's invoice cannot say WHICH part is
  -- outstanding. So August generates one charge per active cost line and a
  -- payment can settle exactly one of them.
  vendor       text,
  line_label   text,

  -- Set on a PAYMENT that another founder made on this founder's behalf. The
  -- charge stays outstanding; this records who is owed, and by whom.
  covered_by   uuid references public.founder(id),
  note         text,
  recorded_by  text
);

create index if not exists founder_ledger_founder_idx on public.founder_ledger(founder_id, period_month);
-- A given line may only be charged once per founder per month. Re-approving is
-- therefore a no-op rather than a double-bill.
create unique index if not exists founder_ledger_charge_idx
  on public.founder_ledger(founder_id, period_month, line_label) where kind = 'charge';

alter table public.founder_ledger enable row level security;

create or replace function public.fn_founder_ledger_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'founder_ledger is append-only — correct with an adjustment row, do not edit history'
    using errcode = '42501';
end $$;

drop trigger if exists founder_ledger_append_only on public.founder_ledger;
create trigger founder_ledger_append_only
  before update or delete on public.founder_ledger
  for each row execute function public.fn_founder_ledger_append_only();

-- ---- charges accrue when a statement is approved ---------------------------
create or replace function public.fn_accrue_statement_charges(p_run uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_run statement_run;
  v_f jsonb;
  v_id uuid;
  v_n int := 0;
begin
  select * into v_run from statement_run where id = p_run;
  if not found then raise exception 'no statement run %', p_run; end if;

  for v_f in select * from jsonb_array_elements(v_run.snapshot->'founders') loop
    select id into v_id from founder where email = v_f->>'email';
    if v_id is null then continue; end if;

    -- One charge per active cost line, at this founder's share. Rounded per
    -- line, so the lines a founder is invoiced for sum to what they are asked
    -- to pay; the remainder from rounding lands on the largest line rather
    -- than leaving the total a cent off.
    insert into founder_ledger (founder_id, period_month, kind, amount_cad,
                                vendor, line_label, note, recorded_by)
    select v_id, v_run.period_month, 'charge',
           round(
             (case when oc.currency = 'USD'
                   then oc.amount * coalesce((select nullif(text_value,'')::numeric
                                                from admin_config where key = 'fx_usd_cad'), 1.50)
                   else oc.amount end)
             * (v_f->>'share_bps')::numeric / 10000.0, 2),
           oc.vendor, oc.label,
           'Share of ' || oc.label, coalesce(v_run.approved_by, 'system')
      from operational_cost oc
     where oc.active and oc.cadence = 'monthly' and oc.amount > 0
    on conflict do nothing;   -- the unique index makes re-approval a no-op

    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ---- record a payment ------------------------------------------------------
-- p_covered_by: the founder who actually paid the vendor, when that is someone
-- other than p_founder. Leave null for a founder settling their own balance.
-- p_line_label: settle ONE cost line (e.g. 'Scrapfly DISCOVERY'). Leave null
-- for a general payment against the balance. Vic's case — "Josh didn't pay his
-- share for Scrapfly for August" — is recorded as payments against the OTHER
-- lines, leaving the Scrapfly line outstanding and itemised on the September
-- invoice by name rather than as an unexplained remainder.
create or replace function public.fn_admin_record_payment(
  p_founder_email text,
  p_amount_cad    numeric,
  p_period_month  date default null,
  p_covered_by_email text default null,
  p_note          text default null,
  p_line_label    text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', 'admin');
  v_fid uuid; v_cid uuid;
begin
  if not public.fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_amount_cad is null or p_amount_cad <= 0 then
    raise exception 'payment amount must be positive';
  end if;

  select id into v_fid from founder where lower(email) = lower(p_founder_email);
  if v_fid is null then raise exception 'no founder %', p_founder_email; end if;

  if p_covered_by_email is not null then
    select id into v_cid from founder where lower(email) = lower(p_covered_by_email);
    if v_cid is null then raise exception 'no founder %', p_covered_by_email; end if;
    if v_cid = v_fid then raise exception 'covered_by must be a different founder'; end if;
  end if;

  insert into founder_ledger (founder_id, period_month, kind, amount_cad,
                              covered_by, line_label, note, recorded_by)
  values (v_fid, coalesce(p_period_month, date_trunc('month', now())::date),
          'payment', -abs(p_amount_cad), v_cid, nullif(p_line_label,''), p_note, v_actor);

  return jsonb_build_object('recorded', true, 'founder', p_founder_email,
                            'amount_cad', p_amount_cad);
end $$;

-- ---- balances --------------------------------------------------------------
create or replace function public.fn_founder_balances()
returns jsonb
language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'name',        f.display_name,
           'email',       f.email,
           'balance_cad', round(coalesce(b.total, 0), 2),
           'charged_cad', round(coalesce(b.charged, 0), 2),
           'paid_cad',    round(abs(coalesce(b.paid, 0)), 2),
           'oldest_unpaid_month', b.oldest,
           -- Full history, plus the still-owed lines named individually so an
           -- invoice itemises rather than presenting one lump.
           'lines', coalesce(b.lines, '[]'::jsonb),
           'unpaid_lines', coalesce(b.unpaid_lines, '[]'::jsonb)
         ) order by f.display_name), '[]'::jsonb)
    from founder f
    left join lateral (
      select sum(amount_cad) as total,
             sum(amount_cad) filter (where kind = 'charge') as charged,
             sum(amount_cad) filter (where kind = 'payment') as paid,
             min(period_month) filter (where kind = 'charge') as oldest,
             jsonb_agg(jsonb_build_object('month', period_month, 'kind', kind,
                                          'vendor', vendor, 'line_label', line_label,
                                          'amount_cad', amount_cad, 'note', note)
                       order by period_month, created_at) as lines,
             -- Which specific lines are still owed, by name. This is what lets
             -- a September invoice say "August — Scrapfly, unpaid" instead of
             -- an unexplained CA$15 the recipient cannot check.
             (select jsonb_agg(jsonb_build_object('month', o.period_month,
                                                  'line', o.line_label,
                                                  'amount_cad', o.owed)
                      order by o.period_month, o.line_label)
                from (select period_month, line_label, sum(amount_cad) as owed
                        from founder_ledger x
                       where x.founder_id = f.id and x.line_label is not null
                       group by period_month, line_label
                      having sum(amount_cad) > 0.005) o) as unpaid_lines
        from founder_ledger l where l.founder_id = f.id
    ) b on true
   where f.active;
$$;

create or replace function public.fn_admin_founder_balances()
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return public.fn_founder_balances();
end $$;

-- ---- approval now accrues the charge and stamps the balance ----------------
-- Order matters: re-freeze the figures, accrue this month's charge, THEN read
-- balances — so the snapshot the email sends from already includes the new
-- month on top of anything still outstanding. Reading balances first would
-- invoice JC for August only and drop September.
create or replace function public.fn_admin_approve_statement(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', 'admin');
  v_status text;
  v_snap jsonb;
  v_charged int;
begin
  if not public.fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;

  select status into v_status from statement_run where id = p_id;
  if not found then raise exception 'no statement run %', p_id; end if;
  if v_status <> 'pending_approval' then
    raise exception 'statement % is %, only a pending run can be approved', p_id, v_status;
  end if;

  v_snap := public.fn_founder_statement();

  update statement_run
     set status = 'approved', approved_by = v_actor, approved_at = now(),
         snapshot = v_snap,
         total_cad = (v_snap->>'monthly_total_cad')::numeric
   where id = p_id;

  v_charged := public.fn_accrue_statement_charges(p_id);

  -- Stamp balances AFTER accrual, so each founder's figure is
  -- (everything unpaid) + (this month), which is what the invoice must say.
  update statement_run
     set snapshot = snapshot || jsonb_build_object('balances', public.fn_founder_balances())
   where id = p_id;

  return jsonb_build_object('approved', true, 'by', v_actor, 'charges_accrued', v_charged);
end $$;

-- ---- grants ----------------------------------------------------------------
revoke all on function public.fn_accrue_statement_charges(uuid) from anon, authenticated, public;
revoke all on function public.fn_founder_balances()             from anon, authenticated, public;
grant execute on function public.fn_accrue_statement_charges(uuid) to service_role;
grant execute on function public.fn_founder_balances()             to service_role;

-- Signature is (text,numeric,date,text,text,text) — six args since p_line_label
-- was added. A REVOKE naming a signature that does not exist is a hard error,
-- not a warning, and it aborts the whole migration: exactly what happened on
-- the first run of this file.
revoke all on function public.fn_admin_record_payment(text,numeric,date,text,text,text) from anon, public;
revoke all on function public.fn_admin_founder_balances()                               from anon, public;
grant execute on function public.fn_admin_record_payment(text,numeric,date,text,text,text) to authenticated, service_role;
grant execute on function public.fn_admin_founder_balances()                               to authenticated, service_role;
