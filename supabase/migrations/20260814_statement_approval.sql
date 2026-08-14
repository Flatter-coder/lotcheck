-- ============================================================================
-- Founder statements require Vic's approval before they send.
--
-- Vic, 2026-08-14: "before you send, you need permission from me — because if
-- our cost jumps we need to adjust invoices."
--
-- That is not a preference, it is the control that makes the statement safe. It
-- tells two other people what they owe. If a vendor bill moves between the 1st
-- and the send, an automated statement bills JC and Josh the wrong amount — and
-- a number sent to a co-founder is not a draft, it has already been acted on by
-- the time anyone notices. The approval step is where a cost change gets caught.
--
-- So: the cron may COMPUTE and STAGE. It may never deliver. A run lands as
-- `pending_approval`, Vic reviews the figures, adjusts operational_cost if a
-- bill changed, and approves. A run nobody approves EXPIRES rather than
-- eventually going out on its own.
-- ============================================================================

-- Real addresses, all three active — the split is now a true third each.
update public.founder set email = 'vic@lotcheck.ca', active = true where display_name = 'Vic';
update public.founder set email = 'JC@lotcheck.ca',  active = true where display_name = 'JC';
update public.founder set email = 'josh@lotcheck.ca', active = true where display_name = 'Josh';

create table if not exists public.statement_run (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  period_month date not null,                    -- first of the month it covers
  -- The figures FROZEN at stage time. Kept so approval compares what was
  -- computed against what is true now: if operational_cost moved in between,
  -- the panel can show the difference instead of silently sending the newer
  -- number under the older date.
  total_cad    numeric(10,2) not null,
  snapshot     jsonb not null,
  status       text not null default 'pending_approval'
                 check (status in ('pending_approval','approved','sent','expired','cancelled')),
  approved_by  text,
  approved_at  timestamptz,
  sent_at      timestamptz,
  send_result  jsonb
);
create unique index if not exists statement_run_month_idx on public.statement_run(period_month);
alter table public.statement_run enable row level security;

-- ---- stage (cron, service role) --------------------------------------------
-- Idempotent per month: a re-run returns the existing row rather than creating
-- a second statement for the same period.
create or replace function public.fn_stage_statement()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_month date := date_trunc('month', now())::date;
  v_snap jsonb;
  v_id uuid;
  v_status text;
begin
  select id, status into v_id, v_status from statement_run where period_month = v_month;
  if found then
    return jsonb_build_object('id', v_id, 'status', v_status, 'created', false);
  end if;

  v_snap := public.fn_founder_statement();

  insert into statement_run (period_month, total_cad, snapshot)
  values (v_month, (v_snap->>'monthly_total_cad')::numeric, v_snap)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'status', 'pending_approval', 'created', true,
                            'snapshot', v_snap);
end $$;

-- ---- admin: review, approve, cancel ----------------------------------------
create or replace function public.fn_admin_statement_runs()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.period_month desc), '[]'::jsonb) into v
    from (
      select r.id, r.period_month, r.total_cad, r.status, r.created_at,
             r.approved_by, r.approved_at, r.sent_at, r.snapshot,
             -- What the bill is RIGHT NOW versus what was frozen at stage time.
             -- A non-zero drift is exactly the cost jump Vic wants to catch
             -- before JC and Josh are billed.
             (select round(coalesce(sum(case when currency='USD'
                        then amount * coalesce((select nullif(text_value,'')::numeric
                                                  from admin_config where key='fx_usd_cad'), 1.50)
                        else amount end), 0), 2)
                from operational_cost where active and cadence='monthly') as total_now_cad
        from statement_run r
       order by r.period_month desc limit 12
    ) x;
  return v;
end $$;

-- Approving is the permission. It does NOT send — it authorises the sender to,
-- and only for this run. The edge function refuses anything not in 'approved'.
create or replace function public.fn_admin_approve_statement(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', 'admin');
  v_status text;
begin
  if not public.fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;

  select status into v_status from statement_run where id = p_id;
  if not found then raise exception 'no statement run %', p_id; end if;
  if v_status <> 'pending_approval' then
    raise exception 'statement % is %, only a pending run can be approved', p_id, v_status;
  end if;

  -- Re-freeze at approval time so what sends is what Vic just looked at, not
  -- what was computed on the 1st. If a bill moved, he is approving the CURRENT
  -- number, deliberately.
  update statement_run
     set status = 'approved', approved_by = v_actor, approved_at = now(),
         snapshot = public.fn_founder_statement(),
         total_cad = (public.fn_founder_statement()->>'monthly_total_cad')::numeric
   where id = p_id;

  return jsonb_build_object('approved', true, 'by', v_actor);
end $$;

create or replace function public.fn_admin_cancel_statement(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  update statement_run set status = 'cancelled' where id = p_id and status in ('pending_approval','approved');
end $$;

-- ---- claim for sending (service role) --------------------------------------
-- Atomically flips approved -> sent and returns the snapshot, so a double
-- trigger cannot mail the founders twice.
create or replace function public.fn_claim_statement_for_send()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_row statement_run;
begin
  update statement_run
     set status = 'sent', sent_at = now()
   where id = (select id from statement_run where status = 'approved'
                order by period_month limit 1 for update skip locked)
  returning * into v_row;

  if not found then return null; end if;
  return jsonb_build_object('id', v_row.id, 'period_month', v_row.period_month,
                            'snapshot', v_row.snapshot);
end $$;

-- Stale pending runs expire rather than lingering as something that might still
-- go out. 20 days puts expiry well after both billing dates.
create or replace function public.fn_expire_stale_statements()
returns integer
language sql security definer set search_path = public as $$
  with e as (
    update statement_run set status = 'expired'
     where status = 'pending_approval' and created_at < now() - interval '20 days'
    returning 1
  ) select count(*)::int from e;
$$;

-- ---- grants ----------------------------------------------------------------
revoke all on function public.fn_stage_statement()            from anon, authenticated, public;
revoke all on function public.fn_claim_statement_for_send()   from anon, authenticated, public;
revoke all on function public.fn_expire_stale_statements()    from anon, authenticated, public;
grant execute on function public.fn_stage_statement()            to service_role;
grant execute on function public.fn_claim_statement_for_send()   to service_role;
grant execute on function public.fn_expire_stale_statements()    to service_role;

revoke all on function public.fn_admin_statement_runs()       from anon, public;
revoke all on function public.fn_admin_approve_statement(uuid) from anon, public;
revoke all on function public.fn_admin_cancel_statement(uuid)  from anon, public;
grant execute on function public.fn_admin_statement_runs()       to authenticated, service_role;
grant execute on function public.fn_admin_approve_statement(uuid) to authenticated, service_role;
grant execute on function public.fn_admin_cancel_statement(uuid)  to authenticated, service_role;
