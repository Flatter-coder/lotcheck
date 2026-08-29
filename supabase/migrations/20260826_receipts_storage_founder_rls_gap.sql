-- ============================================================================
-- Fix: receipt uploads have never actually worked for anyone.
--
-- founder has row-level security enabled with ZERO policies on it (by
-- design — every other read of it goes through a SECURITY DEFINER function:
-- fn_my_founder_id, fn_is_founder, fn_is_admin, fn_admin_founder_balances,
-- etc.). But receipts_founder_insert and receipts_read (20260816_
-- payment_receipts.sql, and the insert policy again in
-- 20260826_founder_admin_identity_fix.sql) embed a RAW
-- `select ... from public.founder f where ...` directly inside the policy
-- expression. An RLS policy body runs as the querying role (`authenticated`
-- here), not as a definer — so that raw select hits founder's own RLS, reads
-- back zero rows every time, and the exists(...) is always false.
--
-- Proven live (rolled back, nothing persisted):
--   the raw founder subquery, run as `authenticated` with Vic's real JWT
--   claim, returns false — while `public.fn_my_founder_id()`, called as the
--   exact same role, correctly returns his id, because the RPC call goes
--   through a SECURITY DEFINER function and bypasses this RLS gap.
--
-- This bug predates the identity fix earlier today and affected every
-- founder (Vic, JC, Josh) equally, not just the admin-session case — it was
-- just never reached, because every previous attempt failed one step
-- earlier at "Not a founder account".
--
-- Fix: route both storage policies through fn_my_founder_id() instead of
-- reading founder directly. That function already encodes "which founder is
-- this JWT" (direct email match, or Vic via the admin fallback) in one
-- place, so this also removes the duplicated logic the insert policy picked
-- up in this morning's fix.
-- ============================================================================

drop policy if exists receipts_founder_insert on storage.objects;
create policy receipts_founder_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'receipts'
  and (storage.foldername(name))[1] = public.fn_my_founder_id()::text
);

drop policy if exists receipts_read on storage.objects;
create policy receipts_read on storage.objects for select to authenticated
using (
  bucket_id = 'receipts'
  and (
    public.fn_is_admin()
    or (storage.foldername(name))[1] = public.fn_my_founder_id()::text
  )
);
