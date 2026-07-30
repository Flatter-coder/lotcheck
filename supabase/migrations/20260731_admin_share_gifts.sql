-- ============================================================================
-- Owner "give a free check" — single-use, tap-to-redeem gift links.
--
-- Lets the owner hand a friend/family a free Quote Check on the spot: the admin
-- panel mints a short code -> a link (…/quote-check?gift=CODE); the friend taps
-- it, signs in, and the code redeems into +1 PERSONAL check on THEIR account.
--
-- Guardrails:
--   * Minting is admin-only (fn_is_admin) and capped per admin per day
--     (app_config.admin_daily_share_cap, default 10, adjustable from the panel).
--   * Codes are SINGLE-USE (redeemed_by stamped once, FOR UPDATE locked) — a
--     forwarded/leaked link can't be reused. Blast radius is bounded by the
--     daily mint cap.
--   * Redeeming requires a signed-in user (the credit must attach to an account).
--   * Revoking an un-redeemed code refunds that day's allowance slot.
--
-- Depends on: 20260729_quote_credits.sql (credit_ledger),
--             20260730_admin_economics.sql (fn_is_admin, admin_config, app_config).
-- Uses only built-in gen_random_uuid() (pg_catalog) -- no pgcrypto/extensions-schema dependency.
-- ============================================================================

-- ---- adjustable daily mint cap ------------------------------------------------
insert into public.app_config(key, int_value) values ('admin_daily_share_cap', 10)
  on conflict (key) do nothing;

-- ---- gift codes ---------------------------------------------------------------
create table if not exists public.gift_code (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,
  created_by  uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  redeemed_by uuid references auth.users(id) on delete set null,
  redeemed_at timestamptz,
  revoked     boolean not null default false
);
create index if not exists gift_code_creator_day_idx
  on public.gift_code (created_by, created_at);

alter table public.gift_code enable row level security;
-- No policies => only SECURITY DEFINER fns / service role touch it directly.
-- (Redeemers never read the table; they call fn_redeem_gift.)

-- ---- extend credit_ledger reasons to cover an admin-minted gift ----------------
-- Redemptions land as 'gift_received' (already allowed). The owner-side record is
-- the gift_code row itself — no ledger row is written for the giver (no personal
-- credit is spent; this is an owner allowance, not a peer transfer).
-- (No schema change needed to credit_ledger — 'gift_received' is already in the
--  reason CHECK from 20260729_quote_credits.sql.)

-- ---- create a gift code (admin only, daily-capped) ----------------------------
-- Returns { ok, code, remaining_today }. Raises 42501 if not admin, or a plain
-- error when the day's cap is reached. Atomic: an advisory lock per (admin, day)
-- serializes concurrent mints so the cap can't be over-run.
create or replace function public.fn_admin_create_gift()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_admin uuid := auth.uid();
  v_cap   integer;
  v_used  integer;
  v_code  text;
  v_try   integer := 0;
begin
  if not public.fn_is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_admin is null then
    raise exception 'no session' using errcode = '42501';
  end if;

  -- serialize this admin's mints for today so the cap check is race-free
  perform pg_advisory_xact_lock(hashtext('gift_mint:' || v_admin::text || ':' || current_date::text));

  select coalesce(int_value, 10) into v_cap from app_config where key = 'admin_daily_share_cap';
  if v_cap is null then v_cap := 10; end if;

  -- count today's codes that still "hold a slot" (active or redeemed; revoked refunds)
  select count(*) into v_used from gift_code
    where created_by = v_admin
      and created_at >= date_trunc('day', now())
      and not revoked;

  if v_used >= v_cap then
    raise exception 'daily share limit reached (% of %)', v_used, v_cap
      using errcode = 'P0001';
  end if;

  -- generate a unique, unambiguous short code (hex, uppercased). Retry on collision.
  loop
    v_try := v_try + 1;
    v_code := upper(substring(replace(gen_random_uuid()::text, '-', '') from 1 for 8));
    begin
      insert into gift_code(code, created_by) values (v_code, v_admin);
      exit;  -- inserted OK
    exception when unique_violation then
      if v_try >= 5 then raise; end if;  -- astronomically unlikely; give up after 5
    end;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'code', v_code,
    'remaining_today', greatest(0, v_cap - (v_used + 1))
  );
end; $$;

-- ---- redeem a gift code (any signed-in user) ----------------------------------
-- Single-use: stamps redeemed_by/redeemed_at under FOR UPDATE and grants +1
-- personal 'gift_received'. Returns { ok, personal } on success. Distinct errors
-- for invalid / already-used / revoked so the UI can message clearly.
create or replace function public.fn_redeem_gift(p_code text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_id   uuid;
  v_redeemed uuid;
  v_revoked  boolean;
  v_code text := upper(btrim(coalesce(p_code, '')));
begin
  if v_user is null then
    raise exception 'sign in to claim this free check' using errcode = '42501';
  end if;
  if v_code = '' then
    raise exception 'invalid code' using errcode = '22023';
  end if;

  select id, redeemed_by, revoked
    into v_id, v_redeemed, v_revoked
    from gift_code where code = v_code for update;

  if v_id is null then
    raise exception 'this link is not valid' using errcode = 'P0002';
  end if;
  if v_revoked then
    raise exception 'this link was cancelled' using errcode = 'P0002';
  end if;
  if v_redeemed is not null then
    -- idempotent for the SAME user (double-tap); a different user is rejected.
    if v_redeemed = v_user then
      return jsonb_build_object('ok', true, 'personal',
        public.fn_available_credits(v_user, 'personal'), 'already', true);
    end if;
    raise exception 'this link was already used' using errcode = 'P0002';
  end if;

  update gift_code set redeemed_by = v_user, redeemed_at = now() where id = v_id;
  insert into credit_ledger(user_id, kind, delta, reason, gift_id)
    values (v_user, 'personal', 1, 'gift_received', v_id);

  return jsonb_build_object('ok', true,
    'personal', public.fn_available_credits(v_user, 'personal'), 'already', false);
end; $$;

-- ---- list my recent gift codes (admin only) -----------------------------------
-- Status + timestamps only; never exposes WHO redeemed (no PII). Powers the
-- "your links" list + today's remaining count in the panel.
create or replace function public.fn_admin_list_gifts(p_limit integer default 25)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_admin uuid := auth.uid();
  v_cap   integer;
  v_used  integer;
  v_rows  jsonb;
begin
  if not public.fn_is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select coalesce(int_value, 10) into v_cap from app_config where key = 'admin_daily_share_cap';

  select count(*) into v_used from gift_code
    where created_by = v_admin and created_at >= date_trunc('day', now()) and not revoked;

  select coalesce(jsonb_agg(r order by r_created desc), '[]'::jsonb) into v_rows
  from (
    select jsonb_build_object(
             'code', code,
             'created_at', created_at,
             'status', case when revoked then 'revoked'
                            when redeemed_by is not null then 'redeemed'
                            else 'active' end,
             'redeemed_at', redeemed_at
           ) as r,
           created_at as r_created
    from gift_code
    where created_by = v_admin
    order by created_at desc
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  ) s;

  return jsonb_build_object(
    'cap', coalesce(v_cap, 10),
    'used_today', coalesce(v_used, 0),
    'remaining_today', greatest(0, coalesce(v_cap,10) - coalesce(v_used,0)),
    'codes', v_rows
  );
end; $$;

-- ---- revoke an un-redeemed code (admin only) ----------------------------------
-- Frees that day's allowance slot. A redeemed code can't be revoked.
create or replace function public.fn_admin_revoke_gift(p_code text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_admin uuid := auth.uid();
  v_code  text := upper(btrim(coalesce(p_code, '')));
  v_id    uuid;
  v_redeemed uuid;
begin
  if not public.fn_is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select id, redeemed_by into v_id, v_redeemed
    from gift_code where code = v_code and created_by = v_admin for update;

  if v_id is null then
    raise exception 'code not found' using errcode = 'P0002';
  end if;
  if v_redeemed is not null then
    raise exception 'already redeemed — cannot revoke' using errcode = 'P0001';
  end if;

  update gift_code set revoked = true where id = v_id;
  return jsonb_build_object('ok', true);
end; $$;

-- ---- adjust the daily mint cap (admin only) -----------------------------------
create or replace function public.fn_admin_set_share_cap(p_value integer)
returns integer
language plpgsql security definer set search_path = public as $$
declare v_new integer;
begin
  if not public.fn_is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_value is null then
    raise exception 'value required';
  end if;
  v_new := greatest(0, least(p_value, 1000));  -- clamp: 0 disables, cap absurd values
  insert into app_config(key, int_value, updated_at)
    values ('admin_daily_share_cap', v_new, now())
  on conflict (key) do update set int_value = excluded.int_value, updated_at = now();
  return v_new;
end; $$;

-- ---- grants: admin fns gated INSIDE by fn_is_admin; redeem open to any user ----
revoke all on function public.fn_admin_create_gift()          from public;
revoke all on function public.fn_redeem_gift(text)            from public;
revoke all on function public.fn_admin_list_gifts(integer)    from public;
revoke all on function public.fn_admin_revoke_gift(text)      from public;
revoke all on function public.fn_admin_set_share_cap(integer) from public;

grant execute on function public.fn_admin_create_gift()          to authenticated;
grant execute on function public.fn_redeem_gift(text)            to authenticated;
grant execute on function public.fn_admin_list_gifts(integer)    to authenticated;
grant execute on function public.fn_admin_revoke_gift(text)      to authenticated;
grant execute on function public.fn_admin_set_share_cap(integer) to authenticated;
