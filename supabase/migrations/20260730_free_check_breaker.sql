-- ============================================================================
-- Free-check circuit breaker: a global daily cap on ANONYMOUS free checks, so
-- free-check API cost can never blow the budget. The limit is adjustable
-- (app_config.free_checks_per_day) — the admin panel edits it live.
--
-- Signed-in checks are unaffected (they draw on the user's paid credit balance).
-- Only the anonymous/free path is metered by this breaker.
-- ============================================================================

-- ---- adjustable config (admin-editable) ---------------------------------------
create table if not exists public.app_config (
  key        text primary key,
  int_value  integer,
  updated_at timestamptz not null default now()
);
insert into public.app_config(key, int_value) values ('free_checks_per_day', 25)
  on conflict (key) do nothing;

-- ---- per-day free-check tally --------------------------------------------------
create table if not exists public.free_check_daily (
  day   date primary key,
  count integer not null default 0
);

alter table public.app_config       enable row level security;
alter table public.free_check_daily enable row level security;
-- No policies => only the service role / SECURITY DEFINER functions touch these.

-- ---- the breaker: atomically allow-and-count, or block ------------------------
-- Returns TRUE and increments today's count if under the configured daily limit;
-- returns FALSE (blocked) once the limit is reached. limit <= 0 disables free
-- checks entirely. Called by the edge functions (service role) on the anon path,
-- BEFORE any expensive Claude/Nimble work, so a blocked check costs nothing.
create or replace function public.fn_try_free_check()
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_limit integer; v_count integer;
begin
  select int_value into v_limit from app_config where key = 'free_checks_per_day';
  if v_limit is null then v_limit := 25; end if;
  if v_limit <= 0 then return false; end if;

  insert into free_check_daily(day, count) values (current_date, 0)
    on conflict (day) do nothing;
  select count into v_count from free_check_daily where day = current_date for update;

  if v_count >= v_limit then
    return false;
  end if;
  update free_check_daily set count = count + 1 where day = current_date;
  return true;
end; $$;

revoke all on function public.fn_try_free_check() from public;
grant execute on function public.fn_try_free_check() to service_role;

-- ---- admin read helper: today's free-check usage + the current limit ----------
-- (the Unit Economics panel reads this; service-role only)
create or replace function public.fn_free_check_status()
returns table(day date, used integer, limit_per_day integer)
language sql stable security definer set search_path = public as $$
  select current_date,
         coalesce((select count from free_check_daily where day = current_date), 0),
         coalesce((select int_value from app_config where key = 'free_checks_per_day'), 25);
$$;
revoke all on function public.fn_free_check_status() from public;
grant execute on function public.fn_free_check_status() to service_role;
