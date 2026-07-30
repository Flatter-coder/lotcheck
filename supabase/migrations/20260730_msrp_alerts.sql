-- ============================================================================
-- MSRP Alerts — Hook 2a, Phase A (WAITLIST ONLY).
--
-- Captures a buyer's intent to be emailed when their vehicle hits / goes under
-- MSRP in their city. This migration ships the CAPTURE + CONSENT RECORD only —
-- NO email is sent here. Double-opt-in confirmation and the Phase-B alert
-- dispatch (which needs SMTP + the price pipeline) come later. Rows land as
-- status = 'waitlist'.
--
-- Privacy posture (email is PII, CASL-regulated):
--   * RLS is ON with NO policies => the table is UNREADABLE by anon/authenticated
--     clients. There is no SELECT/INSERT path for the public page.
--   * The ONLY way in is the SECURITY DEFINER RPC fn_alert_subscribe(), which is
--     EXECUTE-granted to anon (so the public /live-price-index page can call it)
--     but revoked from PUBLIC. anon can create a subscription; it can never read
--     one back.
--   * CASL: the RPC hard-rejects when consent is not TRUE, and stamps
--     consent_at / consent_ip / consent_text on every row.
--
-- Depends on: pgcrypto for gen_random_uuid() (Supabase ships it enabled).
-- ============================================================================

-- ---- table --------------------------------------------------------------------
create table if not exists public.msrp_alert_subscription (
  id             uuid primary key default gen_random_uuid(),
  -- email stored NORMALIZED (lowercased, +tag stripped) for dedupe/matching;
  -- email_raw keeps exactly what the buyer typed (CASL record of what they gave).
  email          text not null,
  email_raw      text not null,
  make           text not null,
  model          text not null,
  year           int,
  province       text,
  city           text,
  threshold_type text not null check (threshold_type in ('at_msrp','below_msrp','pct_below')),
  pct            int,
  status         text not null default 'waitlist',
  -- CASL consent record: what they agreed to, when, and from where.
  consent_at     timestamptz not null default now(),
  consent_ip     text,
  consent_text   text,
  confirm_token  uuid not null default gen_random_uuid(),  -- for later double-opt-in
  unsub_token    uuid not null default gen_random_uuid(),  -- for later one-click unsub
  created_at     timestamptz not null default now(),
  last_notified_at timestamptz
);

-- Lookup by email (dedupe / "manage my alerts" later).
create index if not exists idx_msrp_alert_email
  on public.msrp_alert_subscription (email);

-- Phase-B matching join: subscriptions for a make/model in a province.
create index if not exists idx_msrp_alert_match
  on public.msrp_alert_subscription (make, model, province);

-- Idempotency key: one subscription per (normalized email, make, model, city).
-- city is coalesced to '' so NULL cities don't defeat the unique constraint.
create unique index if not exists uq_msrp_alert_dedupe
  on public.msrp_alert_subscription (email, make, model, (coalesce(city, '')));

-- ---- RLS: on, NO policies => no client can read or write directly ------------
alter table public.msrp_alert_subscription enable row level security;
-- (Intentionally no CREATE POLICY. The SECURITY DEFINER RPC below is the only
--  ingress; it runs as the table owner and bypasses RLS.)

-- ---- subscribe RPC ------------------------------------------------------------
-- The single public ingress. Validates + normalizes + records consent + inserts
-- a 'waitlist' row, idempotent on (normalized email, make, model, city).
-- Returns {ok:true, id:<uuid>}. Never returns anyone else's data.
--
-- Anti-abuse note: anon can insert but never read. The unique index caps
-- duplicate (email,make,model,city) rows. A per-email row cap / rate limit
-- (e.g. reject > N distinct subscriptions per normalized email, or a signup
-- throttle keyed on consent_ip) can be layered in here later without a schema
-- change — left out of Phase A to keep the waitlist frictionless.
create or replace function public.fn_alert_subscribe(
  p_email     text,
  p_make      text,
  p_model     text,
  p_year      int,
  p_province  text,
  p_city      text,
  p_threshold text,
  p_pct       int,
  p_consent   boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email_raw text := btrim(coalesce(p_email, ''));
  v_email     text;
  v_make      text := btrim(coalesce(p_make, ''));
  v_model     text := btrim(coalesce(p_model, ''));
  v_city      text := nullif(btrim(coalesce(p_city, '')), '');
  v_province  text := nullif(btrim(coalesce(p_province, '')), '');
  v_threshold text := btrim(coalesce(p_threshold, ''));
  v_pct       int;
  v_ip        text;
  v_id        uuid;
begin
  -- 1) CASL gate: express consent is mandatory. No consent, no row.
  if p_consent is not true then
    raise exception 'consent required' using errcode = '23514';
  end if;

  -- 2) Required fields.
  if v_email_raw = '' or v_make = '' or v_model = '' then
    raise exception 'email, make and model are required' using errcode = '23514';
  end if;

  -- 3) Basic email shape check (a light guard, not full RFC validation).
  if v_email_raw !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid email' using errcode = '23514';
  end if;

  -- 4) Normalize: lowercase, then strip any +tag from the local part (gmail-style
  --    plus-addressing) so foo+deals@gmail.com dedupes to foo@gmail.com.
  v_email := regexp_replace(lower(v_email_raw), '\+[^@]*@', '@');

  -- 5) Threshold validation (mirrors the table CHECK, with a clearer error).
  if v_threshold not in ('at_msrp', 'below_msrp', 'pct_below') then
    raise exception 'invalid threshold' using errcode = '23514';
  end if;
  -- pct is only meaningful for pct_below; default to 5 if that path omits it.
  if v_threshold = 'pct_below' then
    v_pct := coalesce(p_pct, 5);
  else
    v_pct := null;
  end if;

  -- 6) Best-effort consent IP for the CASL record (never fatal if unavailable).
  begin
    v_ip := coalesce(
      split_part(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-forwarded-for', ',', 1),
      nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-real-ip'
    );
  exception when others then
    v_ip := null;
  end;

  -- 7) Idempotent insert. On repeat (same normalized email + vehicle + city) we
  --    refresh the raw email / threshold and return the existing id — never a
  --    duplicate row, never an error.
  insert into public.msrp_alert_subscription (
    email, email_raw, make, model, year, province, city,
    threshold_type, pct, status, consent_at, consent_ip, consent_text
  ) values (
    v_email, v_email_raw, v_make, v_model, p_year, v_province, v_city,
    v_threshold, v_pct, 'waitlist', now(), v_ip, 'MSRP alerts email opt-in'
  )
  on conflict (email, make, model, (coalesce(city, '')))
  do update set
    email_raw      = excluded.email_raw,
    year           = excluded.year,
    province       = excluded.province,
    threshold_type = excluded.threshold_type,
    pct            = excluded.pct
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

-- Lock the RPC down to anon (the public page) only; never PUBLIC.
revoke all on function public.fn_alert_subscribe(text, text, text, int, text, text, text, int, boolean) from public;
grant execute on function public.fn_alert_subscribe(text, text, text, int, text, text, text, int, boolean) to anon;
-- (authenticated buyers can use it too, harmless — same waitlist capture.)
grant execute on function public.fn_alert_subscribe(text, text, text, int, text, text, text, int, boolean) to authenticated;
