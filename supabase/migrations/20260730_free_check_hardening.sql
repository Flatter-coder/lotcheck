-- ============================================================================
-- Free-check anti-abuse hardening.
--
-- Two farming vectors closed here:
--   (1) Multi-account farming of the free PERSONAL credit. The original signup
--       grant handed every new auth user +1 personal (signup_free) + 1 shareable
--       (signup_share). The +1 personal made the daily anonymous breaker moot:
--       10 throwaway magic-link accounts = 10 free personal checks, uncapped.
--       We stop granting the free personal credit on signup. New users get ONLY
--       the shareable credit; the "free check" everyone still gets is the
--       ANONYMOUS one — which is now capped globally AND per-IP by the breaker.
--   (2) A single IP hammering the anonymous free-check breaker. The global cap
--       alone lets one abuser burn the whole daily budget. We add a per-IP cap.
--
-- Existing users are NOT clawed back — whatever they were already granted stays.
-- ============================================================================

-- ---- (1) signup grant → share-only ---------------------------------------------
-- Multi-account farming defense: no free PERSONAL credit is minted on signup, so
-- there is nothing to farm by creating extra accounts. The only "free" check is
-- the anonymous one, which the breaker below caps (global + per-IP). New users
-- still receive +1 SHAREABLE so the gift/share flow keeps working.
-- Idempotency guard now keys on 'signup_share' (the row we still insert), so a
-- re-fire never double-grants. Existing users keep their prior grants (no claw-back).
create or replace function public.fn_grant_signup(p_user uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from credit_ledger where user_id = p_user and reason = 'signup_share') then
    insert into credit_ledger(user_id, kind, delta, reason) values
      (p_user, 'shareable', 1, 'signup_share');
  end if;
end; $$;

revoke all on function public.fn_grant_signup(uuid) from public;

-- ---- (2) per-IP cap config + tally ---------------------------------------------
insert into public.app_config(key, int_value) values ('free_checks_per_ip_per_day', 3)
  on conflict (key) do nothing;

create table if not exists public.free_check_ip_daily (
  ip    text,
  day   date,
  count integer not null default 0,
  primary key (ip, day)
);
alter table public.free_check_ip_daily enable row level security;
-- No policies => only the service role / SECURITY DEFINER functions touch this.

-- ---- (2) breaker: global cap + optional per-IP cap -----------------------------
-- Replaces the no-arg breaker with a param-taking one. Because p_ip DEFAULTs to
-- null, the currently-deployed edge functions that still call
-- fn_try_free_check() (no arg) keep resolving to this function (global-only path)
-- until they are redeployed — so the migration is backward compatible.
--
-- Returns TRUE and increments the counters when under BOTH applicable caps;
-- returns FALSE (blocked, no increment) if EITHER the global OR the per-IP cap is
-- already reached. The global count always advances; the per-IP count advances
-- only when p_ip is present. Atomic: a per-day global advisory lock serializes
-- concurrent callers, and rows are taken FOR UPDATE, so the check-then-increment
-- cannot race. Called by the edge functions (service role) BEFORE any expensive
-- Claude/Nimble work, so a blocked check costs nothing.
drop function if exists public.fn_try_free_check();

create or replace function public.fn_try_free_check(p_ip text default null)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_limit     integer;
  v_count     integer;
  v_ip_limit  integer;
  v_ip_count  integer;
begin
  -- Serialize all free-check accounting for today so the reads below are stable.
  perform pg_advisory_xact_lock(hashtext('free_check:' || current_date::text));

  -- Global daily cap (existing behavior).
  select int_value into v_limit from app_config where key = 'free_checks_per_day';
  if v_limit is null then v_limit := 25; end if;
  if v_limit <= 0 then return false; end if;

  insert into free_check_daily(day, count) values (current_date, 0)
    on conflict (day) do nothing;
  select count into v_count from free_check_daily where day = current_date for update;
  if v_count >= v_limit then
    return false;
  end if;

  -- Per-IP daily cap (only when we have an IP).
  if p_ip is not null then
    select int_value into v_ip_limit from app_config where key = 'free_checks_per_ip_per_day';
    if v_ip_limit is null then v_ip_limit := 3; end if;
    if v_ip_limit <= 0 then return false; end if;

    insert into free_check_ip_daily(ip, day, count) values (p_ip, current_date, 0)
      on conflict (ip, day) do nothing;
    select count into v_ip_count from free_check_ip_daily
      where ip = p_ip and day = current_date for update;
    if v_ip_count >= v_ip_limit then
      return false;
    end if;
  end if;

  -- Under every applicable cap → count the check and allow it.
  update free_check_daily set count = count + 1 where day = current_date;
  if p_ip is not null then
    update free_check_ip_daily set count = count + 1 where ip = p_ip and day = current_date;
  end if;
  return true;
end; $$;

revoke all on function public.fn_try_free_check(text) from public;
grant execute on function public.fn_try_free_check(text) to service_role;
