-- ============================================================================
-- JC's founder-portal login changed to Jayceang@gmail.com.
--
-- The jc@lotcheck.ca Google Workspace seat was dropped ($36/mo), so his sign-in
-- and statement address move to a personal gmail — same move Josh made
-- (20260826_josh_founder_email_update.sql). This is the address
-- fn_is_founder()/fn_my_founder_id() match against for the /founders magic-link
-- sign-in, so updating it here is what actually keeps his access working.
-- founder_ledger rows key off founder_id, not email, so his ledger is unaffected.
-- ============================================================================

update public.founder set email = 'Jayceang@gmail.com' where display_name = 'JC';
