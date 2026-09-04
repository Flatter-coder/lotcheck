-- ============================================================================
-- A CATCH-ALL THAT RETURNS ONE MESSAGE FOR EVERY FAILURE IS A BLINDFOLD.
--
-- 20260903e wrapped the insert in `exception when others` and returned "that
-- link or email address did not look right" for anything that went wrong. An
-- end-to-end test with a perfectly valid URL and address came back with exactly
-- that message -- and the handler had thrown away the one piece of information
-- needed to find out why. Every cause looked like the same cause.
--
-- That is the "green signal, no check" shape from docs/FIXING-HISTORY.md,
-- inverted: a RED signal with no detail, which is just as useless. A test that
-- cannot distinguish a bad email from a broken constraint has not tested
-- anything.
--
-- Two changes:
--
-- 1. The regex CHECK constraints are dropped. They duplicated validation the
--    function already does, and a constraint violation surfaced as an opaque
--    exception rather than a reason a buyer could act on. Validation belongs
--    where it can explain itself.
--
-- 2. The handler now RAISEs a WARNING carrying SQLSTATE and SQLERRM into the
--    Postgres log before returning the friendly message. The buyer still sees
--    plain language; we keep the cause.
-- ============================================================================

alter table public.manual_review_request drop constraint if exists manual_review_url_shape;
alter table public.manual_review_request drop constraint if exists manual_review_email_shape;

create or replace function public.fn_request_manual_review(
  p_url text, p_email text, p_error text default null, p_client_hint text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_url text := btrim(coalesce(p_url, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_recent int; v_today int; v_id bigint; v_ahead int;
begin
  -- Each refusal names the thing that was wrong, so a buyer can fix it and we
  -- can tell a bad address from a broken table.
  if v_url = '' or v_email = '' then
    return jsonb_build_object('ok', false, 'reason', 'a listing link and an email address are both required');
  end if;
  if position('http' in v_url) <> 1 or length(v_url) < 12 or length(v_url) > 2000 then
    return jsonb_build_object('ok', false, 'reason', 'that does not look like a full listing link — it should start with http');
  end if;
  if position('@' in v_email) < 2 or position('.' in split_part(v_email, '@', 2)) < 2 or length(v_email) > 254 then
    return jsonb_build_object('ok', false, 'reason', 'that email address did not look right');
  end if;

  select count(*) into v_today from manual_review_request
   where reporter_email = v_email and created_at > now() - interval '1 day';
  if v_today >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'that address has already sent five requests today');
  end if;

  select count(*) into v_recent from manual_review_request
   where reporter_email = v_email and listing_url = v_url
     and created_at > now() - interval '10 minutes';
  if v_recent > 0 then
    return jsonb_build_object('ok', true, 'duplicate', true, 'message', 'That one is already in the queue.');
  end if;

  insert into manual_review_request (listing_url, reporter_email, error_message, client_hint)
    values (v_url, v_email, left(coalesce(p_error, ''), 500), left(coalesce(p_client_hint, ''), 200))
    returning id into v_id;

  select count(*) into v_ahead from manual_review_request
   where status = 'pending' and id < v_id;

  return jsonb_build_object('ok', true, 'ahead', v_ahead);
exception when others then
  -- KEEP THE CAUSE. The buyer gets plain language; the log gets the truth.
  raise warning 'fn_request_manual_review failed: % / %', sqlstate, sqlerrm;
  return jsonb_build_object('ok', false, 'reason', 'we could not record that just now — please try again in a minute');
end; $$;

revoke all on function public.fn_request_manual_review(text, text, text, text) from public;
grant execute on function public.fn_request_manual_review(text, text, text, text) to anon, authenticated, service_role;
