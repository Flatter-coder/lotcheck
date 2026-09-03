-- ============================================================================
-- MSRP Alerts — Phase B: double opt-in + dealer-push trigger + matched dispatch.
--
-- Phase A (20260730_msrp_alerts.sql) captured a 'waitlist' row per buyer. This
-- turns the waitlist into a real (but still owner-controlled) alert engine:
--
--   1. Double opt-in (CASL): a signup gets a confirmation email; fn_alert_confirm
--      flips status 'waitlist' -> 'confirmed'. Only CONFIRMED buyers are ever
--      emailed an alert.
--   2. Dealer-push trigger: instead of scraping, an AMVIC dealer's at/below-MSRP
--      unit is entered as an alert_candidate (admin-gated for now; a verified
--      dealer self-serve portal is the next, legally-gated step).
--   3. Matched dispatch: fn_admin_dispatch_prepare returns the CONFIRMED buyers
--      matching a candidate (make + city, model fuzzy) who haven't been alerted
--      for it yet; the alert-dispatch edge fn sends the email and marks it.
--
-- Privacy/CASL posture unchanged: the subscription table stays RLS-locked with
-- NO client policies. Every ingress is a SECURITY DEFINER RPC — anon can confirm
-- their own row; only admins (fn_is_admin) can push candidates or read matches.
-- Depends on: 20260730_msrp_alerts.sql, 20260730_admin_economics.sql (fn_is_admin).
-- ============================================================================

-- ---- 1) confirmed_at + double opt-in confirm ---------------------------------
alter table public.msrp_alert_subscription
  add column if not exists confirmed_at timestamptz;

-- Confirm a subscription from its per-row confirm_token (the link in the email).
-- Idempotent: confirming an already-confirmed row just returns ok. anon-callable
-- (the token IS the auth), never reads anyone else's data beyond the vehicle text
-- it echoes back for the confirmation page.
create or replace function public.fn_alert_confirm(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if p_token is null then raise exception 'missing token' using errcode = '22004'; end if;
  update public.msrp_alert_subscription
    set status = 'confirmed', confirmed_at = coalesce(confirmed_at, now())
    where confirm_token = p_token
    returning make, model, city into r;
  if not found then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'make', r.make, 'model', r.model, 'city', r.city);
end; $$;
-- RETIRED 2026-09-01. MSRP Alerts was removed (commit ecc7f85). This file has
-- never been applied to the live project, so the grant below is neutralised HERE
-- rather than only being undone downstream: apply-migrations.mjs replays in
-- filename order with no ledger, so a grant left in an unapplied file is a door
-- that reopens the next time history is replayed.
-- See 20260901_retire_msrp_alerts_grants.sql.
revoke all on function public.fn_alert_confirm(uuid) from public, anon, authenticated;

-- ---- 2) fn_alert_subscribe: also return confirm_token ------------------------
-- Same signature + behaviour as Phase A, but the returned jsonb now carries the
-- confirm_token so the alert-subscribe edge fn can build the confirmation link.
-- (Reproduced in full; only the RETURNING + final jsonb changed.)
create or replace function public.fn_alert_subscribe(
  p_email text, p_make text, p_model text, p_year int, p_province text,
  p_city text, p_threshold text, p_pct int, p_consent boolean
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_email_raw text := btrim(coalesce(p_email, ''));
  v_email text; v_make text := btrim(coalesce(p_make, '')); v_model text := btrim(coalesce(p_model, ''));
  v_city text := nullif(btrim(coalesce(p_city, '')), ''); v_province text := nullif(btrim(coalesce(p_province, '')), '');
  v_threshold text := btrim(coalesce(p_threshold, '')); v_pct int; v_ip text; v_id uuid; v_token uuid;
begin
  if p_consent is not true then raise exception 'consent required' using errcode = '23514'; end if;
  if v_email_raw = '' or v_make = '' or v_model = '' then raise exception 'email, make and model are required' using errcode = '23514'; end if;
  if v_email_raw !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid email' using errcode = '23514'; end if;
  v_email := regexp_replace(lower(v_email_raw), '\+[^@]*@', '@');
  if v_threshold not in ('at_msrp', 'below_msrp', 'pct_below') then raise exception 'invalid threshold' using errcode = '23514'; end if;
  if v_threshold = 'pct_below' then v_pct := coalesce(p_pct, 5); else v_pct := null; end if;
  begin
    v_ip := coalesce(split_part(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-forwarded-for', ',', 1),
                     nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-real-ip');
  exception when others then v_ip := null; end;
  insert into public.msrp_alert_subscription (
    email, email_raw, make, model, year, province, city,
    threshold_type, pct, status, consent_at, consent_ip, consent_text
  ) values (
    v_email, v_email_raw, v_make, v_model, p_year, v_province, v_city,
    v_threshold, v_pct, 'waitlist', now(), v_ip, 'MSRP alerts email opt-in'
  )
  on conflict (email, make, model, (coalesce(city, '')))
  do update set email_raw = excluded.email_raw, year = excluded.year, province = excluded.province,
                threshold_type = excluded.threshold_type, pct = excluded.pct
  returning id, confirm_token into v_id, v_token;
  return jsonb_build_object('ok', true, 'id', v_id, 'confirm_token', v_token);
end; $$;
-- RETIRED 2026-09-01. MSRP Alerts was removed (commit ecc7f85). This file has
-- never been applied to the live project, so the grant below is neutralised HERE
-- rather than only being undone downstream: apply-migrations.mjs replays in
-- filename order with no ledger, so a grant left in an unapplied file is a door
-- that reopens the next time history is replayed.
-- See 20260901_retire_msrp_alerts_grants.sql.
revoke all on function public.fn_alert_subscribe(text,text,text,int,text,text,text,int,boolean) from public, anon, authenticated;

-- ---- 3) dealer-push candidate + dispatch log --------------------------------
create table if not exists public.alert_candidate (
  id uuid primary key default gen_random_uuid(),
  make text not null, model text, year int,
  city text not null, province text default 'AB',
  price numeric,                    -- the at/below-MSRP price the dealer is offering
  below_msrp boolean not null default false,
  dealer_name text,                 -- who's offering it (AMVIC dealer)
  note text,
  created_by text,                  -- admin email who pushed it
  created_at timestamptz not null default now()
);
alter table public.alert_candidate enable row level security;   -- no policies: admin RPC only

create table if not exists public.alert_dispatch (
  subscription_id uuid not null references public.msrp_alert_subscription(id) on delete cascade,
  candidate_id    uuid not null references public.alert_candidate(id) on delete cascade,
  sent_at         timestamptz not null default now(),
  primary key (subscription_id, candidate_id)   -- dedupe: one alert per buyer per candidate
);
alter table public.alert_dispatch enable row level security;

-- ---- 4) admin RPCs (all gated by fn_is_admin) -------------------------------
-- Push an at/below-MSRP unit and get how many CONFIRMED buyers it matches.
create or replace function public.fn_admin_push_candidate(
  p_make text, p_model text, p_year int, p_city text, p_province text,
  p_price numeric, p_below boolean, p_dealer text, p_note text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_email text; v_matches int;
begin
  if not public.fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if btrim(coalesce(p_make,'')) = '' or btrim(coalesce(p_city,'')) = '' then
    raise exception 'make and city are required' using errcode = '23514'; end if;
  begin v_email := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'; exception when others then v_email := null; end;
  insert into public.alert_candidate(make, model, year, city, province, price, below_msrp, dealer_name, note, created_by)
    values (btrim(p_make), nullif(btrim(coalesce(p_model,'')),''), p_year, btrim(p_city),
            coalesce(nullif(btrim(coalesce(p_province,'')),''),'AB'), p_price, coalesce(p_below,false),
            nullif(btrim(coalesce(p_dealer,'')),''), nullif(btrim(coalesce(p_note,'')),''), v_email)
    returning id into v_id;
  select count(*) into v_matches from public.msrp_alert_subscription s
    where s.status = 'confirmed'
      and lower(s.make) = lower(btrim(p_make))
      and lower(coalesce(s.city,'')) = lower(btrim(p_city))
      and (p_model is null or btrim(p_model) = '' or lower(s.model) like lower(btrim(p_model))||'%' or lower(btrim(p_model)) like lower(s.model)||'%');
  return jsonb_build_object('ok', true, 'id', v_id, 'matches', v_matches);
end; $$;
revoke all on function public.fn_admin_push_candidate(text,text,int,text,text,numeric,boolean,text,text) from public;
grant execute on function public.fn_admin_push_candidate(text,text,int,text,text,numeric,boolean,text,text) to authenticated;

-- Return the CONFIRMED buyers a candidate should alert (not already alerted).
-- Emails are returned because this is the owner's server-side dispatch path.
create or replace function public.fn_admin_dispatch_prepare(p_candidate uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c record; v jsonb;
begin
  if not public.fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into c from public.alert_candidate where id = p_candidate;
  if not found then raise exception 'candidate not found' using errcode = 'P0002'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'email', s.email_raw, 'make', s.make, 'model', s.model,
           'year', s.year, 'city', s.city, 'unsub_token', s.unsub_token)), '[]'::jsonb)
    into v
    from public.msrp_alert_subscription s
    where s.status = 'confirmed'
      and lower(s.make) = lower(c.make)
      and lower(coalesce(s.city,'')) = lower(c.city)
      and (c.model is null or lower(s.model) like lower(c.model)||'%' or lower(c.model) like lower(s.model)||'%')
      and not exists (select 1 from public.alert_dispatch d where d.subscription_id = s.id and d.candidate_id = p_candidate);
  return jsonb_build_object('ok', true,
    'candidate', jsonb_build_object('make', c.make, 'model', c.model, 'year', c.year, 'city', c.city,
                                    'price', c.price, 'below_msrp', c.below_msrp, 'dealer', c.dealer_name),
    'recipients', v);
end; $$;
revoke all on function public.fn_admin_dispatch_prepare(uuid) from public;
grant execute on function public.fn_admin_dispatch_prepare(uuid) to authenticated;

-- Mark one buyer as alerted for one candidate (dedupe log + last_notified_at).
create or replace function public.fn_admin_dispatch_mark(p_sub uuid, p_candidate uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  insert into public.alert_dispatch(subscription_id, candidate_id) values (p_sub, p_candidate)
    on conflict do nothing;
  update public.msrp_alert_subscription set last_notified_at = now() where id = p_sub;
  return jsonb_build_object('ok', true);
end; $$;
revoke all on function public.fn_admin_dispatch_mark(uuid, uuid) from public;
grant execute on function public.fn_admin_dispatch_mark(uuid, uuid) to authenticated;
