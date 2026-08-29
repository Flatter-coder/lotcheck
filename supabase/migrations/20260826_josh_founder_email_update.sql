-- ============================================================================
-- Josh's founder-portal login changed to joshlotcheck@gmail.com.
--
-- This is the address fn_is_founder()/fn_my_founder_id() match against for
-- the /founders magic-link sign-in — updating it here is what actually grants
-- access, independent of whatever address he receives the monthly statement
-- email at (unaffected: founder_ledger rows key off founder_id, not email).
-- ============================================================================

update public.founder set email = 'joshlotcheck@gmail.com' where display_name = 'Josh';
