-- ============================================================================
-- MANUAL REVIEW QUEUE: a request that cannot be silently dropped.
--
-- When a listing will not read automatically, the buyer can hand it to a human.
-- The first version of that was a mailto -- honest, but it leaves no trace on
-- our side, so "we never heard from you" and "we lost it" look identical. This
-- is the ledger version: every request is a ROW, with a status that starts
-- 'pending' and can only be closed deliberately.
--
-- WHY A LEDGER AND NOT A MAILBOX. An email to support is a promise kept in
-- somebody's inbox. A row is countable: how many came in, how many are still
-- open, how long the oldest has waited. We promise a report within 24 hours on
-- the card, and this is the only way to know whether we are keeping that.
--
-- The buyer's email lives here because we have to write back to it. That is the
-- one piece of personal data in the table, it is given for exactly that purpose,
-- and the table is closed to anon and authenticated -- it is reachable only
-- through the security-definer function below, which can insert but never read.
-- ============================================================================

create table if not exists public.manual_review_request (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  listing_url  text not null,
  reporter_email text not null,
  error_message text,
  -- What the buyer's browser told us, for rate limiting only. Not an identity.
  client_hint  text,
  status       text not null default 'pending'
                 check (status in ('pending', 'in_progress', 'sent', 'declined')),
  handled_at   timestamptz,
  handled_note text,
  constraint manual_review_url_shape   check (listing_url ~* '^https?://[^ ]{6,2000}$'),
  constraint manual_review_email_shape check (reporter_email ~* '^[^@\s]{1,120}@[^@\s.]{1,120}[.][^@\s]{2,20}$')
);
alter table public.manual_review_request enable row level security;
create index if not exists ix_mrr_pending on public.manual_review_request(created_at desc) where status = 'pending';
create index if not exists ix_mrr_email_recent on public.manual_review_request(reporter_email, created_at desc);

revoke all on public.manual_review_request from anon, authenticated;

comment on table public.manual_review_request is
  'Buyer requests for a human read of a listing our scan could not handle. A ledger, not a mailbox: pending rows are countable, so "we promised 24 hours" is a measurable claim. Closed to anon; written only through fn_request_manual_review.';

-- ---- the one way in --------------------------------------------------------
-- Security definer so the table stays closed, and rate limited so the endpoint
-- cannot be turned into a way to make us email an address repeatedly. Returns
-- the queue position rather than a row id: a buyer should learn nothing about
-- anyone else's request.
create or replace function public.fn_request_manual_review(
  p_url text, p_email text, p_error text default null, p_client_hint text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_recent int; v_today int; v_id bigint; v_ahead int;
begin
  if p_url is null or btrim(p_url) = '' or p_email is null or btrim(p_email) = '' then
    return jsonb_build_object('ok', false, 'reason', 'a listing link and an email address are both required');
  end if;

  -- Per address: five a day is generous for a real buyer and useless to anyone
  -- trying to use us as a mailer.
  select count(*) into v_today from manual_review_request
   where reporter_email = lower(btrim(p_email)) and created_at > now() - interval '1 day';
  if v_today >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'that address has already sent five requests today');
  end if;

  -- The same listing twice in ten minutes is a double-click, not a second ask.
  select count(*) into v_recent from manual_review_request
   where reporter_email = lower(btrim(p_email))
     and listing_url = btrim(p_url)
     and created_at > now() - interval '10 minutes';
  if v_recent > 0 then
    return jsonb_build_object('ok', true, 'duplicate', true,
                              'message', 'That one is already in the queue.');
  end if;

  insert into manual_review_request (listing_url, reporter_email, error_message, client_hint)
    values (btrim(p_url), lower(btrim(p_email)), left(coalesce(p_error, ''), 500), left(coalesce(p_client_hint, ''), 200))
    returning id into v_id;

  select count(*) into v_ahead from manual_review_request
   where status = 'pending' and id < v_id;

  return jsonb_build_object('ok', true, 'ahead', v_ahead);
exception when others then
  -- A malformed email or URL trips a CHECK constraint. Tell the buyer plainly
  -- rather than showing them a database error.
  return jsonb_build_object('ok', false, 'reason', 'that link or email address did not look right');
end; $$;

revoke all on function public.fn_request_manual_review(text, text, text, text) from public;
grant execute on function public.fn_request_manual_review(text, text, text, text) to anon, authenticated, service_role;

-- ---- reading the queue is a separate, privileged act ------------------------
create or replace function public.fn_pending_manual_reviews(p_limit int default 50)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'createdAt', to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSZ'),
           'listingUrl', listing_url, 'email', reporter_email,
           'error', error_message,
           'waitingHours', round(extract(epoch from (now() - created_at)) / 3600.0, 1))
         order by created_at), '[]'::jsonb)
    from (select * from manual_review_request where status = 'pending'
           order by created_at limit greatest(1, least(coalesce(p_limit, 50), 200))) q;
$$;
revoke all on function public.fn_pending_manual_reviews(int) from public;
grant execute on function public.fn_pending_manual_reviews(int) to service_role;
