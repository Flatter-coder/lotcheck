-- ============================================================================
-- Correction: JC's actual email is jayceang72@gmail.com.
--
-- 20260828_jc_founder_email_update.sql set it to Jayceang@gmail.com (no
-- digits) — that was wrong. JC tried signing in with jayceang7@gmail.com and
-- jayceang72@gmail.com within a minute of each other today (2026-08-29, see
-- auth.users), neither matching what was on file, which is why he got
-- "Not a founder account." Vic confirmed jayceang72@gmail.com is correct.
-- ============================================================================

update public.founder set email = 'jayceang72@gmail.com' where display_name = 'JC';
