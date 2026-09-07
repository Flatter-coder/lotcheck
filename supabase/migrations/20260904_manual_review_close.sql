-- ============================================================================
-- CLOSING A MANUAL REVIEW HAS TO BE AN OPERATION, NOT A HAND-WRITTEN UPDATE.
--
-- 20260903e gave the queue a status column that "can only be closed
-- deliberately" -- and then gave nobody a way to close it. Every request would
-- have needed an ad-hoc UPDATE typed into the SQL editor, which means no record
-- of who closed it, no guard against closing the wrong id, and a status column
-- that in practice never leaves 'pending'. A ledger whose rows can only be
-- opened is a backlog, not a ledger.
--
-- fn_close_manual_review is service_role only, refuses an unknown id and an
-- unknown status rather than reporting a silent zero-row success, and requires
-- a note saying what was done -- because "sent" with no note cannot be told
-- apart from a mis-click three weeks later.
-- ============================================================================

create or replace function public.fn_close_manual_review(
  p_id bigint, p_status text, p_note text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_before text; v_note text := btrim(coalesce(p_note, ''));
begin
  if p_status not in ('in_progress', 'sent', 'declined') then
    return jsonb_build_object('ok', false, 'reason',
      format('status must be in_progress, sent or declined -- got %L', p_status));
  end if;
  if v_note = '' then
    return jsonb_build_object('ok', false, 'reason', 'a note is required: what was done, or why not');
  end if;

  select status into v_before from manual_review_request where id = p_id;
  -- An UPDATE that matches nothing reports success. Say so instead.
  if v_before is null then
    return jsonb_build_object('ok', false, 'reason', format('no request with id %s', p_id));
  end if;

  update manual_review_request
     set status = p_status,
         handled_at = case when p_status = 'in_progress' then handled_at else now() end,
         handled_note = left(v_note, 1000)
   where id = p_id;

  return jsonb_build_object('ok', true, 'id', p_id, 'from', v_before, 'to', p_status);
end; $$;

revoke all on function public.fn_close_manual_review(bigint, text, text) from public;
grant execute on function public.fn_close_manual_review(bigint, text, text) to service_role;

-- ---- close the end-to-end test row -----------------------------------------
-- Verifying the queue in production put a real row in it. Left pending it would
-- sit at the head of the queue forever and make the oldest-waiting number lie,
-- which is the one number the 24-hour promise is measured by. Matched by its
-- own marker rather than by id, so re-applying this migration is a no-op.
update public.manual_review_request
   set status = 'declined',
       handled_at = now(),
       handled_note = 'End-to-end verification of the queue itself, 2026-09-03. Not a buyer request; nothing to send.'
 where status = 'pending'
   and reporter_email = 'support@lotcheck.ca'
   and coalesce(error_message, '') ilike '%END-TO-END TEST%';
