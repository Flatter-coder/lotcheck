-- ============================================================================
-- The free check moves BEHIND the magic-link sign-in.
--
-- It was never removed — it was anonymous, and that was the problem. The only
-- thing standing between a visitor and an unlimited supply of free reports was
-- a localStorage flag (`lc_free_used`), which clearing site data resets. A
-- throwaway address was not even required, because no address was required.
--
-- Both halves of the replacement already existed:
--
--   fn_grant_signup()  gives every new auth user +1 personal ('signup_free')
--                      and +1 shareable. That IS the free check, already gated
--                      behind the magic link.
--   fn_try_free_check()  the anonymous path, which returns false the moment
--                      app_config.free_checks_per_day drops to 0 (line 80 of
--                      20260730_free_check_hardening.sql).
--
-- So this is a switch, not a build: close the anonymous door, and the signed-in
-- grant becomes the only free check. Same giveaway, but it now buys a verified
-- email address instead of funding whoever is farming reports.
--
-- REVERSIBLE. Setting free_checks_per_day back above 0 re-opens the anonymous
-- path exactly as before, from the admin panel, with no deploy.
-- ============================================================================

update public.app_config
   set int_value = 0
 where key = 'free_checks_per_day';

insert into public.app_config (key, int_value)
select 'free_checks_per_day', 0
 where not exists (select 1 from app_config where key = 'free_checks_per_day');

-- Record why it is zero, so the next person to find it does not "fix" it back.
insert into public.admin_config (key, text_value) values
  ('free_check_policy',
   'Free check is signed-in only since 2026-08-15. The anonymous allowance was gated by a localStorage flag that clearing site data resets, so it could be farmed indefinitely. fn_grant_signup already grants +1 personal on first magic-link sign-in, which is now the only free check. Raise free_checks_per_day above 0 to re-open the anonymous path.')
on conflict (key) do update set text_value = excluded.text_value, updated_at = now();

-- Sanity: the signup grant must still be in place, or closing the anonymous
-- path would leave no free check at all rather than moving it.
do $$
begin
  if to_regprocedure('public.fn_grant_signup(uuid)') is null then
    raise exception 'fn_grant_signup is missing — closing the anonymous free check would leave NO free check. Apply 20260729_quote_credits.sql first.';
  end if;
  raise notice 'free check is now signed-in only; fn_grant_signup confirmed present';
end $$;
