-- ============================================================================
-- The checkpoint writer was never granted to anyone. Every write has failed.
--
-- 20260815_verification_check.sql line 89:
--
--     revoke all on function public.fn_log_verification_checks(jsonb)
--       from public, anon, authenticated;
--
-- ...and then no matching grant. Not to service_role, not to anything. Only the
-- function owner could execute it, and the edge functions call it with the
-- service-role key — so every single call has come back "permission denied for
-- function" since the day it shipped.
--
-- WHY NOBODY NOTICED. recordCheckpoints is deliberately fail-open — a telemetry
-- write must never sink a buyer's report — so it catches the error and calls
-- console.warn. Correct instinct, and it turned a hard failure into a silent
-- one. The table stayed empty, the panel had nothing to show, and the empty
-- state reads exactly like "this feature was never built".
--
-- Every other writer in this repo has the grant: fn_log_provider_call,
-- fn_record_delivery_attempt, fn_record_delivery_result. This one was missed,
-- and the revoke line looked so deliberate that it read as intentional.
--
-- The panel was telling the truth the whole time. Nothing was measuring these
-- checkpoints, so it refused to paint them green — which is precisely what it
-- was built to do. It just could not say WHY.
-- ============================================================================

grant execute on function public.fn_log_verification_checks(jsonb) to service_role;

-- Prove it, rather than assume it. A grant that silently fails to apply would
-- leave us exactly where we started, and the failure mode is invisible.
do $$
declare v_ok boolean;
begin
  select has_function_privilege('service_role', 'public.fn_log_verification_checks(jsonb)', 'EXECUTE')
    into v_ok;
  if not v_ok then
    raise exception 'service_role still cannot execute fn_log_verification_checks — the grant did not take';
  end if;
  raise notice 'service_role can now execute fn_log_verification_checks; checkpoints will record from the next scan';
end $$;

-- Sweep for the same class of defect: any SECURITY DEFINER function whose name
-- says it is a writer, that no role can execute. One missing grant was a silent
-- feature outage for a day; a second one should not need a screenshot to find.
do $$
declare r record; n int := 0;
begin
  for r in
    select p.oid::regprocedure as sig, p.proname
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.prosecdef
       and (p.proname like 'fn_log_%' or p.proname like 'fn_record_%')
  loop
    if not has_function_privilege('service_role', r.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', r.oid, 'EXECUTE') then
      raise warning 'WRITER WITH NO GRANT: % — nothing can call it', r.sig;
      n := n + 1;
    end if;
  end loop;
  if n = 0 then
    raise notice 'all fn_log_* / fn_record_* writers are callable by at least one role';
  else
    raise warning '% writer function(s) are uncallable — check each one', n;
  end if;
end $$;
