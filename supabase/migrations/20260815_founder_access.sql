-- ============================================================================
-- Founder-level read access, so JC and Josh can see what they are paying for.
--
-- They fund a third of the bill each. Asking them to take the numbers on trust
-- while only Vic can see them is a bad way to run a partnership — but making
-- them admins would hand them dealer records, review queues, credit grants and
-- the free-check breaker, none of which is theirs to touch.
--
-- So: a second, narrower gate. fn_is_founder() is true for any active row in
-- the founder table; the READ functions behind the verification panel accept
-- admin OR founder, and every WRITE stays admin-only.
--
-- Founders can SEE          operational cost, the pack economics, provider
--                           reliability, their own balances, the verification
--                           ledger and the delivery counts.
-- Founders CANNOT           approve or cancel a statement, record a payment,
--                           set the free-check cap, grant credits, or reach
--                           anything on the other admin tabs.
--
-- Vic is in BOTH sets: he is an admin and an active founder, so nothing he
-- could do before changes.
-- ============================================================================

create or replace function public.fn_is_founder()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from founder f
     where f.active
       and length(coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', '')) > 0
       and lower(f.email) = lower(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  );
$$;

-- Convenience: admin OR founder. Every relaxed read below gates on this, so the
-- rule lives in one place instead of being re-spelled in eight functions.
create or replace function public.fn_can_read_costs()
returns boolean
language sql stable security definer set search_path = public as $$
  select public.fn_is_admin() or public.fn_is_founder();
$$;

revoke all on function public.fn_is_founder()     from public;
revoke all on function public.fn_can_read_costs() from public;
grant execute on function public.fn_is_founder()     to authenticated, service_role;
grant execute on function public.fn_can_read_costs() to authenticated, service_role;

-- ---- relax the READS ---------------------------------------------------------
-- Each of these previously raised unless fn_is_admin(). Swapping the predicate
-- is the whole change; the bodies are untouched.
do $$
declare
  r record;
  v_src text;
  v_new text;
begin
  for r in
    select p.oid, p.proname, pg_get_functiondef(p.oid) as def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'fn_admin_operational_cost',
         'fn_admin_pack_economics',
         'fn_admin_provider_costs',
         'fn_admin_founder_balances',
         'fn_admin_owed_to_payer',
         'fn_admin_delivery_ledger'
       )
  loop
    v_src := r.def;
    v_new := replace(v_src, 'not public.fn_is_admin()', 'not public.fn_can_read_costs()');
    if v_new = v_src then
      raise notice '% has no fn_is_admin() guard to relax — check it deliberately', r.proname;
    else
      execute v_new;
      raise notice 'relaxed % to admin-or-founder', r.proname;
    end if;
  end loop;
end $$;

-- Founders need EXECUTE as authenticated users; the functions self-gate.
grant execute on function public.fn_admin_operational_cost()        to authenticated;
grant execute on function public.fn_admin_pack_economics()          to authenticated;
grant execute on function public.fn_admin_provider_costs(integer)   to authenticated;
grant execute on function public.fn_admin_founder_balances()        to authenticated;
grant execute on function public.fn_admin_owed_to_payer()           to authenticated;
grant execute on function public.fn_admin_delivery_ledger(integer)  to authenticated;

-- ---- prove the writes did NOT move -------------------------------------------
-- A migration that quietly widened an approval or a payment write would be far
-- worse than one that failed, so assert it rather than trusting the loop above.
do $$
declare r record; n int := 0;
begin
  for r in
    select p.proname, pg_get_functiondef(p.oid) as def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('fn_admin_approve_statement','fn_admin_cancel_statement',
                         'fn_admin_record_payment','fn_admin_record_usage_actual',
                         'fn_admin_apply_invoice','fn_admin_reject_invoice',
                         'fn_admin_set_free_checks_per_day')
  loop
    if position('fn_is_admin()' in r.def) = 0 then
      raise exception 'WRITE FUNCTION % no longer gates on fn_is_admin() — refusing to leave founders able to call it', r.proname;
    end if;
    n := n + 1;
  end loop;
  raise notice '% write functions confirmed still admin-only', n;
end $$;
