-- ============================================================================
-- SECURITY / RETIREMENT: close the public door left behind by MSRP Alerts.
--
-- FILENAME IS LOAD-BEARING. scripts/apply-migrations.mjs applies in filename
-- order and keeps no ledger, so this file MUST sort after
-- 20260805_alert_phaseb.sql (which is UNAPPLIED and still re-grants to anon) and
-- after 20260814_lock_service_role_functions.sql. Do not rename it earlier.
--
-- WHAT WAS RETIRED. Commit ecc7f85 removed the MSRP Alerts ("MSRP Notifier")
-- feature: the /msrp-alerts and /alert-confirm routes, MsrpAlertsPage,
-- AlertConfirmPage, the admin AlertFoldersTab and PushCarPanel, and both edge
-- functions. vercel.json now redirects both URLs to "/". The DATABASE side was
-- left exactly as it was, which is what this file corrects.
--
-- WHY THAT IS NOT SAFE TO LEAVE. public/live-price-index.html ships the Supabase
-- ANON key in plain page source by design (window.LC_ANON) -- RLS and grants are
-- what protect the data, not the secrecy of that key. So every grant to `anon`
-- is an open, unauthenticated, world-callable endpoint. Verified live on project
-- debigtyjhjamipooajhk with that shipped key, using non-mutating probes:
--
--   POST /rest/v1/rpc/fn_alert_subscribe  (p_consent=false)
--        -> 400 {"code":"23514","message":"consent required"}
--        That message is the function's OWN first statement
--        (20260801_msrp_target_pct.sql:44), so anon PASSED the EXECUTE check and
--        ran the body. A live unauthenticated write path that inserts email,
--        email_raw and consent_ip into a PII table, with no application code
--        left in the repo to review.
--
--   POST /rest/v1/rpc/fn_admin_alert_folders {"p_limit":1}
--        -> 401 {"code":"42501","message":"not authorized"}
--        Also the function's OWN in-body fn_is_admin() raise
--        (20260731_admin_alert_folders.sql:23) -- NOT PostgreSQL's "permission
--        denied for function", which is what a properly revoked function
--        answers. anon can execute it; only a runtime check inside the body
--        stands between an anonymous caller and every buyer's raw email.
--
--   public.msrp_alert_subscription: anon holds SELECT, INSERT, UPDATE and
--        DELETE (a deliberately malformed POST returns 22P02 "invalid input
--        syntax", a type error from inside the write path, rather than 42501).
--        RLS is enabled with NO policies, so RLS alone is what stops every one
--        of those. A single control on a table of buyer email addresses.
--
-- WHY THE EXISTING REVOKES DID NOTHING. All eight revokes across the four alert
-- migrations (20260730:168, 20260731:48, 20260801:82, 20260805:43/83/132/159/172)
-- say `from public`. This repo already documented that as a no-op at
-- 20260814_lock_service_role_functions.sql:13-21 -- PUBLIC is the implicit
-- pseudo-role, Supabase separately holds EXPLICIT grants to `anon` and
-- `authenticated`, and revoking from PUBLIC does not remove a named-role grant.
-- The default-privileges fix at 20260814:76 only covers functions created AFTER
-- 2026-08-14, so these July/August objects kept their anon grant. The feature was
-- never actually locked down; it only looked like it was.
--
-- WHAT THIS FILE DOES, AND WHAT IT DELIBERATELY DOES NOT DO. It revokes, and only
-- revokes. NOTHING is dropped, deleted or truncated: the functions, the tables,
-- the indexes and every row stay exactly where they are. This is "remove it for
-- now" -- unreachable, not erased.
--
-- THE OVERLOAD TRAP, NAMED SO THE NEXT READER DOES NOT REPEAT IT.
-- fn_alert_subscribe appears in the migration files as TWO functions, because
-- `create or replace function` with a different argument list creates a NEW
-- function rather than replacing the old one:
--   (a) (text,text,text,int,text,text,text,int,boolean)          20260730:76
--   (b) (text,text,text,int,text,text,text,int,boolean,numeric)  20260801:26
-- Live, only (b) exists: (a) was dropped at 20260801:24 and is re-created only by
-- 20260805_alert_phaseb.sql:50, which was never applied (proof:
-- msrp_alert_subscription.confirmed_at -> 42703; alert_candidate and
-- alert_dispatch -> 404 PGRST205). Because p_target_pct defaults to null,
-- PostgREST resolves a 9-key body onto (b) too. A REVOKE naming (a) explicitly
-- would raise 42883 -- REVOKE has no IF EXISTS -- and abort this whole
-- transaction, leaving (b) granted to anon. Hence: drive from pg_proc BY NAME,
-- the pattern already proven at 20260814_lock_service_role_functions.sql:53-64.
--
-- THE GUARD AT THE END IS THE POINT. An earlier draft counted loop iterations and
-- announced success. That cannot detect the failure it exists for: REVOKE emits a
-- WARNING rather than an error when the grant came from somewhere it cannot
-- reach, so the loop runs, the count is non-zero, and the migration reports
-- "revoked" over a door that is still open. This file instead asserts the
-- POST-CONDITION -- has_function_privilege / has_table_privilege say NO -- and
-- aborts if any retired object is still reachable by anon or authenticated. A
-- green signal needs a check behind it.
--
-- HOW TO REVERSE IT. The faithful inverse is two grants; the SECURITY DEFINER RPC
-- was always the single ingress, so the TABLE never needs a direct grant back:
--
--   grant execute on function public.fn_alert_subscribe(
--     text, text, text, int, text, text, text, int, boolean, numeric)
--     to anon, authenticated;
--   grant execute on function public.fn_admin_alert_folders(integer)
--     to authenticated;                        -- authenticated ONLY; never anon
--
-- Revoking `authenticated` on fn_admin_alert_folders is deliberate: it leaves
-- service_role and the SQL editor as the only read path to the retained rows
-- (currently zero). That is the correct posture for a retired feature.
--
-- NOT APPLICABLE, on purpose: there is no RLS POLICY to remove. The feature never
-- created one (20260730_msrp_alerts.sql:62-64 enables RLS and says "Intentionally
-- no CREATE POLICY"), so the policy half of the approved decision has no target.
-- RLS stays ON.
--
-- SEPARATE OPEN ITEM, NOT FIXED HERE: public.alerts is anon-readable (200 []) and
-- is created by NO migration in this repo. It carries none of this feature's
-- columns and is NOT part of MSRP Alerts -- PostgREST merely suggests it as a
-- near-miss. Do not let the name pull it into this file. It needs its own look,
-- and it is evidence that a migration-derived list is not by itself a sound basis
-- for a security sweep, which is why section 3 below is catalog-driven.
--
-- Depends on: 20260730_msrp_alerts.sql, 20260731_admin_alert_folders.sql,
--             20260801_msrp_target_pct.sql, 20260805_alert_phaseb.sql (unapplied).
-- ============================================================================

-- Identifiers below are formatted from catalog oids into dynamic SQL. Pin the
-- search_path so they resolve by the oid that was matched, not by whatever the
-- session's path happens to be.
set local search_path = public, pg_catalog;

-- ---- 1) functions: every overload of every retired alert RPC ----------------
do $$
declare
  r record;
  -- BY NAME, never by signature: covers both fn_alert_subscribe overloads, and
  -- skips the four Phase-B functions that do not exist live instead of aborting.
  retired text[] := array[
    'fn_alert_subscribe',        -- 9-arg (absent live) AND 10-arg (LIVE, anon-executable)
    'fn_alert_confirm',          -- 20260805:31   - absent live (phase B unapplied)
    'fn_admin_alert_folders',    -- 20260731:17   - LIVE, anon-executable despite its :48 revoke
    'fn_admin_push_candidate',   -- 20260805:110  - absent live
    'fn_admin_dispatch_prepare', -- 20260805:137  - absent live
    'fn_admin_dispatch_mark'     -- 20260805:163  - absent live
  ];
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.proname = any (retired)
  loop
    execute format('revoke all on function %s from anon, authenticated, public', r.sig);
    raise notice 'revoked (retired MSRP Alerts): %', r.sig;
  end loop;
end $$;

-- ---- 2) tables: the PII store, plus the Phase-B tables if they ever land -----
-- anon holds SELECT/INSERT/UPDATE/DELETE on msrp_alert_subscription today, with
-- RLS-and-no-policies as the only thing stopping any of them. Take the privilege
-- back so anon cannot address the table at all, and RLS becomes the second line
-- rather than the only one. Rows are untouched.
do $$
declare
  r record;
  retired text[] := array[
    'msrp_alert_subscription',  -- 20260730:24  - LIVE
    'alert_candidate',          -- 20260805:87  - absent live
    'alert_dispatch'            -- 20260805:100 - absent live
  ];
begin
  for r in
    select c.oid::regclass as rel
      from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public'
       and c.relname = any (retired)
       and c.relkind in ('r', 'p', 'v', 'm')
  loop
    execute format('revoke all on %s from anon, authenticated, public', r.rel);
    raise notice 'revoked (retired MSRP Alerts): %', r.rel;
  end loop;
end $$;

-- ---- 3) catalog-driven sweep: anything that touches the PII table ------------
-- The lists above were harvested from supabase/migrations/, and this database
-- provably contains objects no migration created (see public.alerts, above). So
-- do not trust the hand list alone: revoke from any OTHER public function whose
-- body references the subscription table and is still reachable by anon.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.prosrc like '%msrp_alert_subscription%'
       and (has_function_privilege('anon', p.oid, 'EXECUTE')
         or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  loop
    execute format('revoke all on function %s from anon, authenticated, public', r.sig);
    raise notice 'revoked (references the retired PII table): %', r.sig;
  end loop;
end $$;

-- ---- 4) POST-CONDITION: prove the door is shut, or abort ---------------------
-- REVOKE is a no-op-with-WARNING, not an error, when it cannot reach the grant.
-- Counting the statements we ran would report success over an open door, so
-- assert what we actually care about: nothing retired is reachable any more.
do $$
declare
  still text;
begin
  select string_agg(x.what, ', ') into still from (
    select p.oid::regprocedure::text as what
      from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.proname in ('fn_alert_subscribe','fn_alert_confirm','fn_admin_alert_folders',
                         'fn_admin_push_candidate','fn_admin_dispatch_prepare','fn_admin_dispatch_mark')
       and (has_function_privilege('anon', p.oid, 'EXECUTE')
         or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    union all
    select c.oid::regclass::text
      from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public'
       and c.relname in ('msrp_alert_subscription','alert_candidate','alert_dispatch')
       and c.relkind in ('r','p','v','m')
       and (has_table_privilege('anon', c.oid, 'SELECT')
         or has_table_privilege('anon', c.oid, 'INSERT')
         or has_table_privilege('authenticated', c.oid, 'SELECT')
         or has_table_privilege('authenticated', c.oid, 'INSERT'))
  ) x;

  if still is not null then
    raise exception 'MSRP Alerts retirement did not take: still reachable by anon/authenticated -> %', still;
  end if;
end $$;

-- ---- 5) the objects the decision KEEPS must still be here -------------------
-- The approved decision was revoke, not drop. If the function or the PII table
-- has gone missing, something other than this migration removed it and that is
-- worth stopping for.
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname = 'public' and p.proname = 'fn_alert_subscribe') then
    raise exception 'fn_alert_subscribe is gone. The approved decision KEEPS it (reversible retirement); find out what dropped it.';
  end if;
  if not exists (select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
                  where ns.nspname = 'public' and c.relname = 'msrp_alert_subscription') then
    raise exception 'msrp_alert_subscription is gone. The approved decision KEEPS the table and its rows.';
  end if;
  raise notice 'MSRP Alerts: grants revoked, objects and rows retained.';
end $$;

-- Belt and braces. scripts/apply-migrations.mjs already issues this after every
-- apply; harmless here and correct when the file is run by hand in the SQL editor.
-- Expected post-state, so verification is unambiguous:
--   POST /rest/v1/rpc/fn_alert_subscribe   -> 404 PGRST202 (not in the anon schema cache)
--   GET  /rest/v1/msrp_alert_subscription  -> 404 PGRST205
notify pgrst, 'reload schema';
