-- ============================================================================
-- Admin "Unit Economics" panel — SECURITY DEFINER aggregate RPCs.
--
-- The admin panel signs in with Supabase Auth (signInWithPassword) and talks to
-- the DB with the ANON key + the session bearer, so its DB role is `authenticated`
-- — exactly the same role every signed-in *buyer* has. That means we CANNOT gate
-- these business-metric reads with a plain `grant ... to authenticated`: any
-- logged-in customer would then be able to call them.
--
-- The existing data is also not reachable by the admin session as-is:
--   * credit_ledger RLS is read-your-own (auth.uid() = user_id) — no cross-user
--     aggregate.
--   * app_config / free_check_daily have RLS enabled with NO policies — only the
--     service role / SECURITY DEFINER fns touch them.
--   * the breaker's fn_free_check_status() is granted to service_role only.
--
-- So: SECURITY DEFINER functions that return ONLY aggregates (never a user_id,
-- email, or any row-level PII), each gated by fn_is_admin(), and EXECUTE granted
-- to `authenticated`. The email gate — not the grant — is the real boundary:
-- a non-admin authenticated caller is rejected inside the function.
--
-- Depends on: 20260730_free_check_breaker.sql (app_config, free_check_daily),
--             20260729_quote_credits.sql (credit_ledger).
-- ============================================================================

-- ---- who counts as admin ------------------------------------------------------
-- The admin login is a normal Supabase Auth user (created by hand with the
-- owner's email). We identify it by email claim, kept in app_config so it can be
-- changed without a code deploy. Comma-separated, case-insensitive.
--
-- >>> EDIT THIS to your real admin login email(s) if it differs. <<<
insert into public.app_config(key, int_value) values ('free_checks_per_day', 25)
  on conflict (key) do nothing;  -- harmless if the breaker migration already seeded it

-- app_config.int_value can't hold text, so store the admin email list in its own
-- tiny table (same "service-role/SECURITY DEFINER only" posture as app_config).
create table if not exists public.admin_config (
  key        text primary key,
  text_value text,
  updated_at timestamptz not null default now()
);
insert into public.admin_config(key, text_value)
  values ('admin_emails', 'vic.todorovic@gmail.com')
  on conflict (key) do nothing;

alter table public.admin_config enable row level security;
-- No policies => unreachable except through the service role / SECURITY DEFINER
-- fns below. The email allowlist is never exposed to clients.

-- Returns TRUE iff the caller's JWT email is in the admin allowlist. STABLE so it
-- can be reused cheaply within a single statement. Reads the JWT email claim the
-- same way Supabase's own auth.uid() reads its claims (request.jwt.claims).
create or replace function public.fn_is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from admin_config
    where key = 'admin_emails'
      and text_value is not null
      and lower(coalesce(
            nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email',
            ''
          )) = any (
        string_to_array(lower(replace(text_value, ' ', '')), ',')
      )
      -- an empty/absent email claim never matches (the '' guard above + the fact
      -- that admin_emails should never contain a blank entry)
      and length(coalesce(
            nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email',
            ''
          )) > 0
  );
$$;
revoke all on function public.fn_is_admin() from public;
grant execute on function public.fn_is_admin() to authenticated;

-- ---- the economics snapshot ---------------------------------------------------
-- ONE round trip: a jsonb blob of aggregate-only figures for today / last 7 /
-- last 30 days (calendar-day aligned, in the DB timezone), plus the current
-- free-check breaker status. No PII: only counts and summed deltas.
--
-- Window definitions (calendar-day aligned so the free-check tally, which is
-- keyed by `day date`, lines up with the ledger windows):
--   today = since date_trunc('day', now())
--   7d    = last 7 calendar days (incl. today)
--   30d   = last 30 calendar days (incl. today)
create or replace function public.fn_admin_economics()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  result jsonb;
begin
  if not public.fn_is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  with bounds as (
    select
      date_trunc('day', now())                          as t_today,
      date_trunc('day', now()) - interval '6 days'       as t_7d,
      date_trunc('day', now()) - interval '29 days'      as t_30d,
      current_date                                       as d_today,
      current_date - 6                                   as d_7d,
      current_date - 29                                  as d_30d
  ),
  -- credit_ledger aggregates per window (count of events + summed credit delta),
  -- per reason of interest. Cross-user, but aggregate-only.
  ledger as (
    select
      w.win,
      cl.reason,
      count(*)::bigint            as n,
      coalesce(sum(cl.delta),0)::bigint as credit_delta
    from bounds b
    cross join lateral (values
      ('today', b.t_today),
      ('7d',    b.t_7d),
      ('30d',   b.t_30d)
    ) as w(win, since)
    join credit_ledger cl on cl.created_at >= w.since
    group by w.win, cl.reason
  ),
  -- purchase rows broken down by delta (credits bought), so the panel can map
  -- delta -> price for an ESTIMATED revenue figure (Stripe isn't wired yet).
  purchases as (
    select w.win, cl.delta, count(*)::bigint as n
    from bounds b
    cross join lateral (values
      ('today', b.t_today),
      ('7d',    b.t_7d),
      ('30d',   b.t_30d)
    ) as w(win, since)
    join credit_ledger cl
      on cl.created_at >= w.since and cl.reason = 'purchase'
    group by w.win, cl.delta
  ),
  -- anonymous free checks from the breaker tally (calendar-day keyed).
  freechecks as (
    select
      'today'::text as win, coalesce(sum(fcd.count),0)::bigint as free_checks
      from bounds b join free_check_daily fcd on fcd.day = b.d_today
    union all
    select '7d',  coalesce(sum(fcd.count),0)::bigint
      from bounds b join free_check_daily fcd on fcd.day >= b.d_7d
    union all
    select '30d', coalesce(sum(fcd.count),0)::bigint
      from bounds b join free_check_daily fcd on fcd.day >= b.d_30d
  ),
  windows as (
    select w.win,
      jsonb_build_object(
        'free_checks',    coalesce((select free_checks from freechecks f where f.win = w.win), 0),
        'quote_check_n',  coalesce((select n from ledger l where l.win = w.win and l.reason = 'quote_check'), 0),
        'gift_sent_n',    coalesce((select n from ledger l where l.win = w.win and l.reason = 'gift_sent'), 0),
        'gift_received_n',coalesce((select n from ledger l where l.win = w.win and l.reason = 'gift_received'), 0),
        'purchase_n',     coalesce((select n from ledger l where l.win = w.win and l.reason = 'purchase'), 0),
        'purchase_credits', coalesce((select credit_delta from ledger l where l.win = w.win and l.reason = 'purchase'), 0),
        'purchase_share_n', coalesce((select n from ledger l where l.win = w.win and l.reason = 'purchase_share'), 0),
        'signup_free_n',  coalesce((select n from ledger l where l.win = w.win and l.reason = 'signup_free'), 0),
        'referral_bonus_n', coalesce((select n from ledger l where l.win = w.win and l.reason = 'referral_bonus'), 0),
        'purchases_by_delta', coalesce((
          select jsonb_object_agg(p.delta::text, p.n)
          from purchases p where p.win = w.win
        ), '{}'::jsonb)
      ) as obj
    from (values ('today'),('7d'),('30d')) as w(win)
  )
  select jsonb_build_object(
    'generated_at', now(),
    'windows', jsonb_object_agg(win, obj),
    'free_check_status', jsonb_build_object(
      'day', current_date,
      'used', coalesce((select count from free_check_daily where day = current_date), 0),
      'limit_per_day', coalesce((select int_value from app_config where key = 'free_checks_per_day'), 25)
    )
  )
  into result
  from windows;

  return result;
end; $$;
revoke all on function public.fn_admin_economics() from public;
grant execute on function public.fn_admin_economics() to authenticated;

-- ---- adjustable breaker cap ---------------------------------------------------
-- Update app_config.free_checks_per_day live from the panel. Admin-gated; clamps
-- to a sane range. Returns the new value. (<= 0 disables free checks entirely,
-- which fn_try_free_check already honours — so we allow 0 as the floor.)
create or replace function public.fn_admin_set_free_checks_per_day(p_value integer)
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
  v_new := greatest(0, least(p_value, 100000));  -- clamp: 0 disables, cap absurd values
  insert into app_config(key, int_value, updated_at)
    values ('free_checks_per_day', v_new, now())
  on conflict (key) do update set int_value = excluded.int_value, updated_at = now();
  return v_new;
end; $$;
revoke all on function public.fn_admin_set_free_checks_per_day(integer) from public;
grant execute on function public.fn_admin_set_free_checks_per_day(integer) to authenticated;
