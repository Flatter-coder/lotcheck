-- ============================================================================
-- Admin "grant free checks to an email". Owner-only control to comp a
-- customer/tester N free personal Quote Checks by email.
--   * If an account with that (normalized) email exists -> credit it now.
--   * If not -> hold the grant in pending_credit_grant; it lands automatically
--     when that email signs in (redeemed by the signup trigger).
--
-- Depends on: credit_ledger + fn_available_credits + fn_grant_signup +
--             tg_grant_signup (quote credits), fn_is_admin (admin_economics).
-- ============================================================================
create table if not exists public.pending_credit_grant (
  email      text primary key,          -- normalized (lowercased, +tag stripped)
  credits    integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.pending_credit_grant enable row level security;
-- No policies => only the service role / SECURITY DEFINER fns below touch it.

-- Grant N personal credits to an email (admin only). Returns where it landed.
create or replace function public.fn_admin_grant_credits(p_email text, p_count integer)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_admin uuid := auth.uid(); v_email text; v_uid uuid; v_n integer;
begin
  if not public.fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  v_email := regexp_replace(lower(btrim(coalesce(p_email, ''))), '\+[^@]*@', '@');
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid email' using errcode = '23514'; end if;
  v_n := greatest(1, least(coalesce(p_count, 0), 100));  -- clamp 1..100

  -- Find an account whose NORMALIZED email matches (handles +tags / case).
  select id into v_uid from auth.users
    where regexp_replace(lower(email), '\+[^@]*@', '@') = v_email
    order by created_at asc limit 1;

  if v_uid is not null then
    insert into credit_ledger(user_id, kind, delta, reason) values (v_uid, 'personal', v_n, 'promo');
    return jsonb_build_object('ok', true, 'target', 'account', 'credits', v_n,
      'balance', public.fn_available_credits(v_uid, 'personal'));
  else
    insert into pending_credit_grant(email, credits, created_by) values (v_email, v_n, v_admin)
      on conflict (email) do update set credits = pending_credit_grant.credits + excluded.credits, created_by = excluded.created_by;
    return jsonb_build_object('ok', true, 'target', 'pending', 'credits', v_n);
  end if;
end; $$;

revoke all    on function public.fn_admin_grant_credits(text, integer) from public;
grant  execute on function public.fn_admin_grant_credits(text, integer) to authenticated;

-- Extend the signup trigger to also redeem any admin pre-grant for the new
-- user's email (in addition to the existing share-only signup grant).
create or replace function public.tg_grant_signup()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_email text; v_pending integer;
begin
  perform public.fn_grant_signup(new.id);
  v_email := regexp_replace(lower(coalesce(new.email, '')), '\+[^@]*@', '@');
  if v_email <> '' then
    select credits into v_pending from pending_credit_grant where email = v_email for update;
    if v_pending is not null and v_pending > 0 then
      insert into credit_ledger(user_id, kind, delta, reason) values (new.id, 'personal', v_pending, 'promo');
      delete from pending_credit_grant where email = v_email;
    end if;
  end if;
  return new;
end; $$;
