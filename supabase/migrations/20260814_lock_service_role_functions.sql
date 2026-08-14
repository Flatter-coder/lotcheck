-- ============================================================================
-- SECURITY: service-role-only functions were reachable with the ANON key.
--
-- HOW THIS WAS FOUND. Probing the newly-created delivery-ledger RPCs from the
-- public anon key (the one shipped in the client bundle) returned 200, not
-- "permission denied". Widening the probe found the same for functions that
-- have been live for weeks:
--
--   fn_record_delivery_webhook  200  -> anyone can forge a delivery event
--   fn_free_check_status        200  -> leaks the breaker's internal counters
--   fn_capture_quote            200  -> the CREDIT CAPTURE function
--
-- WHY THE EXISTING PATTERN DOES NOT WORK. Every migration here does:
--
--   revoke all on function f from public;
--   grant execute on function f to service_role;
--
-- `PUBLIC` is the implicit pseudo-role. Supabase separately holds EXPLICIT
-- grants to `anon` and `authenticated` (from its default privileges on the
-- public schema), and revoking from PUBLIC does not remove an explicit grant to
-- a named role. So the intent was right and the effect was nil.
--
-- THE CLASS FIX. Revoke from the named roles, not just PUBLIC, and drive it
-- from a list of function NAMES rather than hand-written signatures — a
-- signature typo in a REVOKE is silent, and this file must not have a silent
-- failure mode. Re-runnable: revoking a privilege that is not held is a no-op.
--
-- NOT CHANGED, on purpose: fn_admin_* stays granted to `authenticated`. Those
-- self-gate on fn_is_admin() and that gate is working — the same probe against
-- fn_admin_delivery_by_pdf correctly returned 42501 "not authorized".
-- ============================================================================

do $$
declare
  r record;
  -- Functions whose own migration headers say service-role/edge-function only.
  locked text[] := array[
    -- delivery ledger (20260814_report_delivery.sql)
    'fn_record_delivery_attempt',
    'fn_record_delivery_result',
    'fn_record_delivery_webhook',
    -- quote credits (20260729_quote_credits.sql) — "clients can only READ their
    -- own balance (RLS) — never mutate it"
    'fn_authorize_quote',
    'fn_capture_quote',
    'fn_release_quote',
    -- free-check breaker (20260730_free_check_breaker.sql) — granted to
    -- service_role only, by its own comment
    'fn_free_check_status'
  ];
  n int := 0;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.proname = any (locked)
  loop
    execute format('revoke all on function %s from anon, authenticated, public', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    n := n + 1;
    raise notice 'locked to service_role: %', r.sig;
  end loop;

  if n = 0 then
    raise exception 'locked nothing — the function names in this migration no longer match anything in public. Fix the list rather than letting this pass silently.';
  end if;
  raise notice 'locked % function signature(s) to service_role', n;
end $$;

-- Stop the next migration from reintroducing this. New functions in public will
-- no longer be granted to anon/authenticated by default; a function that genuinely
-- needs client access must now say so explicitly, which is the correct default
-- for a schema whose functions move credits and write evidence.
alter default privileges in schema public revoke execute on functions from anon, authenticated;
