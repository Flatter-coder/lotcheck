-- ============================================================================
-- Quote Check credits — server-authoritative ledger + authorize/capture.
--
-- Rule: a credit is deducted ONLY after an accurate result is delivered.
-- Modeled like a card pre-auth/capture:
--   authorize()  -> if >=1 personal credit available, place a short-lived hold
--   ... edge fn reads URL/PDF, verifies, delivers the report ...
--   capture()    -> on verified delivery, finalize the hold as a -1 (quote_check)
--   release()    -> on failed / low-confidence read, drop the hold (no charge)
--
-- Identity = auth.users (Supabase Auth, magic link). All writes happen through
-- SECURITY DEFINER functions called by the edge functions with the service role;
-- clients can only READ their own balance (RLS) — never mutate it.
-- ============================================================================

-- ---- ledger: append-only; balance = SUM(delta) --------------------------------
create table if not exists public.credit_ledger (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  kind           text not null check (kind in ('personal','shareable')),
  delta          integer not null,
  reason         text not null check (reason in (
                    'signup_free','signup_share','purchase','purchase_share',
                    'quote_check','gift_sent','gift_received','referral_bonus',
                    'refund','clawback','promo')),
  stripe_session text unique,   -- idempotent purchase grants
  quote_id       uuid,          -- which check captured this credit
  gift_id        uuid,          -- links gift_sent <-> gift_received
  created_at     timestamptz not null default now()
);
create index if not exists credit_ledger_user_kind_idx on public.credit_ledger(user_id, kind);

-- ---- holds: short-lived reservations so concurrent checks can't oversell -------
create table if not exists public.credit_holds (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  captured   boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists credit_holds_active_idx on public.credit_holds(user_id) where not captured;

-- ---- RLS: read-your-own only; no client writes --------------------------------
alter table public.credit_ledger enable row level security;
alter table public.credit_holds  enable row level security;

drop policy if exists credit_ledger_read_own on public.credit_ledger;
create policy credit_ledger_read_own on public.credit_ledger
  for select using (auth.uid() = user_id);

drop policy if exists credit_holds_read_own on public.credit_holds;
create policy credit_holds_read_own on public.credit_holds
  for select using (auth.uid() = user_id);
-- (no insert/update/delete policies => only SECURITY DEFINER fns / service role write)

-- ============================================================================
-- Functions
-- ============================================================================

-- available balance for a kind. For 'personal', subtracts active holds
-- (uncaptured and < 10 min old, so stale holds self-release with no cron).
create or replace function public.fn_available_credits(p_user uuid, p_kind text default 'personal')
returns integer
language sql stable security definer set search_path = public as $$
  select coalesce((select sum(delta) from credit_ledger
                   where user_id = p_user and kind = p_kind), 0)
       - case when p_kind = 'personal'
              then (select count(*) from credit_holds
                    where user_id = p_user and not captured
                      and created_at > now() - interval '10 minutes')
              else 0 end;
$$;

-- client-callable: my own available balances (for the "quotes left" chip)
create or replace function public.fn_my_credits()
returns table(personal integer, shareable integer)
language sql stable security definer set search_path = public as $$
  select public.fn_available_credits(auth.uid(), 'personal'),
         public.fn_available_credits(auth.uid(), 'shareable');
$$;

-- one-time signup grant: +1 personal (free check) + 1 shareable (to share)
create or replace function public.fn_grant_signup(p_user uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from credit_ledger where user_id = p_user and reason = 'signup_free') then
    insert into credit_ledger(user_id, kind, delta, reason) values
      (p_user, 'personal',  1, 'signup_free'),
      (p_user, 'shareable', 1, 'signup_share');
  end if;
end; $$;

-- AUTHORIZE: serialize per-user, and if >=1 personal available place a hold.
-- Returns the hold id, or NULL when the user is out of credits (-> 402/paywall).
create or replace function public.fn_authorize_quote(p_user uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_hold uuid;
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text));  -- serialize this user's authorizes
  if public.fn_available_credits(p_user, 'personal') < 1 then
    return null;
  end if;
  insert into credit_holds(user_id) values (p_user) returning id into v_hold;
  return v_hold;
end; $$;

-- CAPTURE: called only after an accurate result is delivered. Finalizes the hold
-- as a -1 personal 'quote_check'. Idempotent: a captured/unknown hold is a no-op.
-- Returns the new available balance (or NULL if the hold was invalid).
create or replace function public.fn_capture_quote(p_hold uuid, p_quote uuid default null)
returns integer
language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  select user_id into v_user from credit_holds where id = p_hold and not captured for update;
  if v_user is null then
    return null;  -- unknown or already captured -> never double-charge
  end if;
  update credit_holds set captured = true where id = p_hold;
  insert into credit_ledger(user_id, kind, delta, reason, quote_id)
    values (v_user, 'personal', -1, 'quote_check', p_quote);
  return public.fn_available_credits(v_user, 'personal');
end; $$;

-- RELEASE: failed / low-confidence read -> drop the hold, no charge.
create or replace function public.fn_release_quote(p_hold uuid)
returns void
language sql security definer set search_path = public as $$
  delete from credit_holds where id = p_hold and not captured;
$$;

-- ---- auto-grant signup credits when a new auth user is created -----------------
-- Server-side + automatic: the client can't skip or double-fire it.
create or replace function public.tg_grant_signup()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.fn_grant_signup(new.id);
  return new;
end; $$;

drop trigger if exists on_auth_user_created_grant on auth.users;
create trigger on_auth_user_created_grant
  after insert on auth.users
  for each row execute function public.tg_grant_signup();

-- ---- execute grants: clients may only read their own balance -------------------
revoke all on function public.fn_available_credits(uuid, text) from public;
revoke all on function public.fn_grant_signup(uuid)            from public;
revoke all on function public.fn_authorize_quote(uuid)         from public;
revoke all on function public.fn_capture_quote(uuid, uuid)     from public;
revoke all on function public.fn_release_quote(uuid)           from public;
-- fn_my_credits is safe for logged-in clients (uses auth.uid())
grant execute on function public.fn_my_credits() to authenticated;

-- NOTE: purchase grants (Stripe webhook), gifting, and the referral bonus are a
-- follow-up migration (20260729_quote_credits_share.sql) once accounts + Stripe exist.
