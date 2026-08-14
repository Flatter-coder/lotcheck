-- ============================================================================
-- 1) FIX: "fronted by" was clearing the debt it was supposed to move.
-- 2) Backfill August 2026 so the known payments have charges to settle against.
--
-- THE BUG. fn_admin_record_payment inserted a negative row whether or not
-- covered_by was set. So recording "Vic paid JC's August share" reduced JC's
-- balance to zero — the exact opposite of what happened. Vic paying Anthropic
-- on JC's behalf moves JC's obligation from the vendor to Vic; it does not
-- discharge it. JC still owes CA$138, and the September invoice must say so.
--
-- The fix: a covered payment is recorded as kind 'coverage' with amount 0. It
-- changes nobody's balance — it records WHO fronted the money, so the invoice
-- can say "paid to the vendor by Vic on your behalf" while the charge stays
-- outstanding. The signed-sum balance stays a plain SUM with no special cases.
-- ============================================================================

alter table public.founder_ledger drop constraint if exists founder_ledger_kind_check;
alter table public.founder_ledger add constraint founder_ledger_kind_check
  check (kind in ('charge','payment','adjustment','coverage'));

-- Coverage rows must not move a balance. Enforced, not just intended: this is
-- the invariant the bug violated, so it is now impossible to insert a coverage
-- row that silently discharges a debt.
alter table public.founder_ledger drop constraint if exists founder_ledger_coverage_zero;
alter table public.founder_ledger add constraint founder_ledger_coverage_zero
  check (kind <> 'coverage' or amount_cad = 0);

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
  v_fid uuid; v_cid uuid; v_kind text; v_amt numeric; v_note text;
begin
  if not public.fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_amount_cad is null or p_amount_cad <= 0 then
    raise exception 'payment amount must be positive';
  end if;

  select id into v_fid from founder where lower(email) = lower(p_founder_email);
  if v_fid is null then raise exception 'no founder %', p_founder_email; end if;

  if p_covered_by_email is not null and p_covered_by_email <> '' then
    select id into v_cid from founder where lower(email) = lower(p_covered_by_email);
    if v_cid is null then raise exception 'no founder %', p_covered_by_email; end if;
    if v_cid = v_fid then raise exception 'covered_by must be a different founder'; end if;
    -- Coverage: zero-sum. The debt moves to whoever paid; it does not vanish.
    v_kind := 'coverage'; v_amt := 0;
    v_note := coalesce(p_note, format('CA$%s paid to the vendor by %s on their behalf — still owed to %s',
                to_char(p_amount_cad, 'FM999990.00'), p_covered_by_email, p_covered_by_email));
  else
    v_kind := 'payment'; v_amt := -abs(p_amount_cad); v_note := p_note;
  end if;

  insert into founder_ledger (founder_id, period_month, kind, amount_cad,
                              covered_by, line_label, note, recorded_by)
  values (v_fid, coalesce(p_period_month, date_trunc('month', now())::date),
          v_kind, v_amt, v_cid, nullif(p_line_label,''), v_note, v_actor);

  return jsonb_build_object('recorded', true, 'kind', v_kind, 'founder', p_founder_email,
                            'amount_cad', p_amount_cad,
                            'balance_changed', v_kind = 'payment');
end $$;

-- ---- 2) August 2026 backfill ------------------------------------------------
-- Status 'sent', never 'approved': fn_claim_statement_for_send only claims
-- approved runs, so this historical month can never trigger a retroactive email
-- to JC and Josh about a month that has already passed.
do $$
declare
  v_run uuid;
  v_snap jsonb;
  v_jc uuid; v_josh uuid; v_vic uuid;
begin
  select id into v_vic  from founder where lower(email) = 'vic@lotcheck.ca';
  select id into v_jc   from founder where lower(email) = 'jc@lotcheck.ca';
  select id into v_josh from founder where lower(email) = 'josh@lotcheck.ca';
  if v_vic is null or v_jc is null or v_josh is null then
    raise exception 'founders not seeded — apply 20260814_statement_approval.sql first';
  end if;

  if exists (select 1 from statement_run where period_month = date '2026-08-01') then
    raise notice 'August 2026 already backfilled — nothing to do';
    return;
  end if;

  v_snap := public.fn_founder_statement();
  insert into statement_run (period_month, total_cad, snapshot, status, approved_by, approved_at, sent_at)
  values (date '2026-08-01', (v_snap->>'monthly_total_cad')::numeric, v_snap,
          'sent', 'backfill', now(), now())
  returning id into v_run;

  -- Charges: one per cost line per founder, at August's cost structure (the
  -- same lines were active). fn_accrue_statement_charges reads the RUN's
  -- period_month, which is 2026-08-01, so they land on August directly —
  -- no post-hoc correction, which the append-only trigger would refuse anyway.
  perform public.fn_accrue_statement_charges(v_run);

  -- The two known August facts.
  --   Josh paid CA$98.00 — his share of the Claude subscription — and did NOT
  --   pay the Scrapfly or API-credit lines, which therefore carry into
  --   September and appear on his invoice by name.
  insert into founder_ledger (founder_id, period_month, kind, amount_cad,
                              line_label, note, recorded_by)
  values (v_josh, date '2026-08-01', 'payment', -98.00, 'Claude subscription',
          'Paid August share of the Claude subscription', 'backfill');

  --   Vic paid JC's whole August share to the vendors. Zero-sum coverage: JC's
  --   charges stay outstanding because the debt moved to Vic, it did not clear.
  insert into founder_ledger (founder_id, period_month, kind, amount_cad,
                              covered_by, note, recorded_by)
  values (v_jc, date '2026-08-01', 'coverage', 0, v_vic,
          'August share paid to the vendors by Vic on JC''s behalf — still owed to Vic', 'backfill');

  raise notice 'August 2026 backfilled: run %', v_run;
end $$;
