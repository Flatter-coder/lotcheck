-- ============================================================================
-- SECURITY: anyone with the public anon key can write the comps corpus.
--
-- HOW THIS WAS FOUND, 2026-09-13. While checking whether a scan could safely
-- write into vehicle_listing, fn_upsert_listings was probed with the anon key
-- that ships in the client bundle (it is in public/alberta-inventory-daily.html
-- and therefore on the open web):
--
--   POST /rest/v1/rpc/fn_upsert_listings  {"p_dealer_id":-1,"p_rows":[]}
--   -> 200  {"ok": true, "new": 0, "seen": 0, "field_changes": 0, "price_changes": 0}
--
-- Not "permission denied". It executed. The probe used an EMPTY row array so it
-- wrote nothing, but the authorization is what matters: a stranger can insert
-- arbitrary VINs and prices under any dealer_id, and vehicle_listing is the
-- table every comparable-listings RPC reads. That is the buyer-facing price
-- band, poisonable from a browser.
--
-- fn_mark_delisted and fn_record_crawl are the same shape, from the same
-- migrations.
--
-- WHY, AND WHY THE EXISTING FIX DID NOT COVER IT. These three carry
-- `revoke all on function ... from public` and NO grant at all -- not even to
-- service_role. 20260814_lock_service_role_functions.sql exists because that
-- exact pattern is a no-op against Supabase's separate, explicit grants to the
-- named roles `anon` and `authenticated`: revoking from the PUBLIC pseudo-role
-- does not remove a grant held by a named role.
--
-- That migration also ended with a line intended to stop the class recurring:
--
--   alter default privileges in schema public revoke execute on functions from anon, authenticated;
--
-- IT DID NOT HOLD. fn_upsert_listings was created on 2026-09-03, three weeks
-- AFTER that line ran, and is open anyway. ALTER DEFAULT PRIVILEGES applies only
-- to objects created by the role that ran it; migrations pasted into the SQL
-- editor do not necessarily run as that role. So the guard was believed to be in
-- place and was not -- the same shape as the defect it was guarding against.
-- A default nobody verified is not a default. [[no-single-point-of-failure]]
--
-- THE DURABLE HALF of this fix is not here. It is scripts/check-rpc-exposure.mjs,
-- which fails the build when a function is created in a migration and is neither
-- explicitly granted to a client role nor named in the lock list below --
-- because "neither" silently means anon-executable, and that is exactly how
-- these three shipped.
--
-- Re-runnable: revoking a privilege that is not held is a no-op.
-- ============================================================================

do $$
declare
  r record;
  -- Writers of the inventory corpus. Every one of these is called only from a
  -- GitHub Action or an edge function holding the service key; none has any
  -- business being reachable from a browser.
  locked text[] := array[
    -- inventory writes (20260903_listing_observation.sql, 20260911_listing_history_observations.sql)
    'fn_upsert_listings',    -- VERIFIED anon-executable 2026-09-13
    'fn_mark_delisted',      -- delists a dealer's whole live section
    'fn_record_crawl',       -- writes the crawl run ledger
    -- first-seen / days-on-lot (20260816_listing_seen.sql) -- already granted to
    -- service_role by their own migration; re-locked here so one list covers the
    -- whole surface and a future reader does not have to check two places.
    'fn_note_listing_seen',
    'fn_listing_first_seen',
    'fn_listing_on_lot',
    -- dealer catalogue (20260830_alberta_dealer_catalog.sql)
    'fn_dealer_catalog_observe',
    'fn_dealer_catalog_lookup',
    -- verification telemetry (writes the checkpoint ledger)
    'fn_log_verification_checks',
    'fn_record_dealer_permission',
    -- Two more from the same pre-2026-08-14 window, same pattern (revoke from
    -- PUBLIC only), both of which move money or spend:
    'fn_grant_signup',       -- grants signup credits
    'fn_try_free_check'      -- consumes a free check [[cost-exploit-guards]]
  ];
  n int := 0;
  found text[] := '{}';
begin
  for r in
    select p.oid::regprocedure as sig, p.proname as nm
      from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.proname = any (locked)
  loop
    execute format('revoke all on function %s from anon, authenticated, public', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    n := n + 1;
    found := found || r.nm;
    raise notice 'locked to service_role: %', r.sig;
  end loop;

  -- A name that matched nothing is a typo, and a typo in a REVOKE is silent.
  -- Naming the misses is the difference between this file working and this file
  -- appearing to work.
  declare missed text[] := array(select x from unnest(locked) x where x <> all(found));
  begin
    if array_length(missed, 1) is not null then
      raise warning 'NOT FOUND in public (check the name): %', array_to_string(missed, ', ');
    end if;
  end;

  if n = 0 then
    raise exception 'locked nothing -- every name in this migration is wrong. Fix the list rather than letting this pass silently.';
  end if;
  raise notice 'locked % function signature(s) to service_role', n;
end $$;

-- Belt and braces alongside the default-privileges line from 20260814, which
-- demonstrably did not hold. This one is re-asserted on every apply rather than
-- relied on once.
alter default privileges in schema public revoke execute on functions from anon, authenticated;

-- ---- verify, in the same transaction as the fix ----------------------------
-- A lock you did not read back is a hope. This SELECT is the receipt: every row
-- must read false/false. Anything true is still open.
select p.proname                                            as function_name,
       has_function_privilege('anon',          p.oid, 'EXECUTE') as anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed_can_execute
  from pg_proc p
  join pg_namespace ns on ns.oid = p.pronamespace
 where ns.nspname = 'public'
   and p.proname in (
     'fn_upsert_listings','fn_mark_delisted','fn_record_crawl',
     'fn_note_listing_seen','fn_listing_first_seen','fn_listing_on_lot',
     'fn_dealer_catalog_observe','fn_dealer_catalog_lookup',
     'fn_log_verification_checks','fn_record_dealer_permission',
     'fn_grant_signup','fn_try_free_check')
 order by anon_can_execute desc, p.proname;
