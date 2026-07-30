-- ============================================================================
-- MSRP Alerts: continuous target (the kinetic pad). Replaces the 3-way
-- threshold with a signed target_pct relative to MSRP: negative = under MSRP,
-- 0 = at MSRP, positive = over MSRP. threshold_type/pct are still written
-- (derived) for back-compat and existing readers; threshold_type gains
-- 'over_msrp'. When the buyer's vehicle isn't in msrp_catalog yet, the widget
-- still submits a target_pct (the % is meaningful without a $ MSRP) so the
-- waitlist is never blocked.
--
-- Depends on: 20260730_msrp_alerts.sql (msrp_alert_subscription, fn_alert_subscribe).
-- ============================================================================
alter table public.msrp_alert_subscription add column if not exists target_pct numeric;

-- Allow the "over MSRP" target (hot / allocation-limited models).
alter table public.msrp_alert_subscription
  drop constraint if exists msrp_alert_subscription_threshold_type_check;
alter table public.msrp_alert_subscription
  add constraint msrp_alert_subscription_threshold_type_check
  check (threshold_type in ('at_msrp','below_msrp','pct_below','over_msrp'));

-- Recreate the subscribe RPC with an optional p_target_pct. When supplied it is
-- the source of truth (threshold_type/pct are derived from it); when null, the
-- legacy p_threshold/p_pct path runs unchanged, so older clients still work.
drop function if exists public.fn_alert_subscribe(text, text, text, int, text, text, text, int, boolean);

create or replace function public.fn_alert_subscribe(
  p_email text, p_make text, p_model text, p_year int, p_province text, p_city text,
  p_threshold text, p_pct int, p_consent boolean, p_target_pct numeric default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_email_raw text := btrim(coalesce(p_email,''));
  v_email     text;
  v_make      text := btrim(coalesce(p_make,''));
  v_model     text := btrim(coalesce(p_model,''));
  v_city      text := nullif(btrim(coalesce(p_city,'')),'');
  v_province  text := nullif(btrim(coalesce(p_province,'')),'');
  v_threshold text;
  v_pct       int;
  v_target    numeric;
  v_ip        text;
  v_id        uuid;
begin
  if p_consent is not true then raise exception 'consent required' using errcode='23514'; end if;
  if v_email_raw='' or v_make='' or v_model='' then raise exception 'email, make and model are required' using errcode='23514'; end if;
  if v_email_raw !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid email' using errcode='23514'; end if;
  v_email := regexp_replace(lower(v_email_raw), '\+[^@]*@', '@');

  if p_target_pct is not null then
    v_target := greatest(-40, least(40, p_target_pct));
    if abs(v_target) < 0.4 then v_threshold := 'at_msrp'; v_pct := null;
    elsif v_target < 0 then    v_threshold := 'pct_below'; v_pct := round(abs(v_target));
    else                       v_threshold := 'over_msrp'; v_pct := round(v_target); end if;
  else
    v_threshold := btrim(coalesce(p_threshold,''));
    if v_threshold not in ('at_msrp','below_msrp','pct_below') then raise exception 'invalid threshold' using errcode='23514'; end if;
    v_pct    := case when v_threshold='pct_below' then coalesce(p_pct,5) else null end;
    v_target := case when v_threshold='at_msrp' then 0 when v_threshold='below_msrp' then -1 else -coalesce(p_pct,5) end;
  end if;

  begin
    v_ip := coalesce(
      split_part(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-forwarded-for', ',', 1),
      nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-real-ip');
  exception when others then v_ip := null; end;

  insert into public.msrp_alert_subscription (
    email, email_raw, make, model, year, province, city,
    threshold_type, pct, target_pct, status, consent_at, consent_ip, consent_text
  ) values (
    v_email, v_email_raw, v_make, v_model, p_year, v_province, v_city,
    v_threshold, v_pct, v_target, 'waitlist', now(), v_ip, 'MSRP alerts email opt-in'
  )
  on conflict (email, make, model, (coalesce(city,'')))
  do update set email_raw=excluded.email_raw, year=excluded.year, province=excluded.province,
    threshold_type=excluded.threshold_type, pct=excluded.pct, target_pct=excluded.target_pct
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
end; $$;

revoke all    on function public.fn_alert_subscribe(text,text,text,int,text,text,text,int,boolean,numeric) from public;
grant  execute on function public.fn_alert_subscribe(text,text,text,int,text,text,text,int,boolean,numeric) to anon;
grant  execute on function public.fn_alert_subscribe(text,text,text,int,text,text,text,int,boolean,numeric) to authenticated;
