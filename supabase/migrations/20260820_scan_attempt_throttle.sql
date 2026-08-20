-- ============================================================================
-- REPEAT-ATTEMPT THROTTLE — closes a real cost-exploit gap Vic flagged
-- 2026-08-20: the multi-vehicle detector (analyze-quote's cheap triage,
-- analyze-listing-url's picker) already never CHARGES a credit for a
-- rejected multi-vehicle page/upload (fn_release_quote deletes the hold) --
-- but nothing capped how many TIMES a signed-in caller could re-submit the
-- SAME input and trigger that (cheap, but non-zero) vendor spend again.
-- tryFreeCheck/fn_try_free_check already rate-limits the ANONYMOUS path;
-- this is the equivalent for repeat hits on one (identity, input) pair,
-- signed-in or anonymous alike.
--
-- Deliberately narrow: only multi-vehicle REJECTIONS bump the counter (a
-- normal successful scan of a different vehicle never touches this table),
-- and only the SAME input re-tried bumps it (a different URL/upload is a
-- fresh attempt). 2nd hit on the same pair -> 2h cooldown; 3rd+ -> 24h.
-- ============================================================================

create table if not exists public.scan_attempt_throttle (
  id               bigint generated always as identity primary key,
  identity_key     text not null,   -- 'user:<uuid>' (signed-in) or 'ip:<addr>' (anon)
  input_hash       text not null,   -- sha256 of the URL, or of the uploaded file bytes
  attempt_count    integer not null default 1,
  first_attempt_at timestamptz not null default now(),
  last_attempt_at  timestamptz not null default now(),
  cooldown_until   timestamptz,
  unique (identity_key, input_hash)
);
alter table public.scan_attempt_throttle enable row level security;
-- No client policy -- RLS-locked, same posture as vehicle_listing/dealer_source.
-- Only the two functions below (SECURITY DEFINER) touch this table.
create index if not exists ix_scan_attempt_throttle_lookup
  on public.scan_attempt_throttle(identity_key, input_hash);

-- Pure read, called BEFORE any vendor spend (even before the cheap triage) --
-- so a caller already in cooldown costs nothing at all, not even the
-- reduced triage cost.
create or replace function public.fn_check_repeat_cooldown(p_identity text, p_input_hash text)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(
    (select jsonb_build_object('blocked', true, 'cooldownUntil', to_char(cooldown_until, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'attemptCount', attempt_count)
     from public.scan_attempt_throttle
     where identity_key = p_identity and input_hash = p_input_hash
       and cooldown_until is not null and cooldown_until > now()),
    jsonb_build_object('blocked', false)
  );
$$;
revoke all on function public.fn_check_repeat_cooldown(text, text) from public;
grant execute on function public.fn_check_repeat_cooldown(text, text) to anon, authenticated;

-- Called ONLY after a genuine multi-vehicle rejection. Atomic upsert so
-- concurrent requests for the same pair can't race past the count.
create or replace function public.fn_record_multivehicle_hit(p_identity text, p_input_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  rec record;
begin
  insert into public.scan_attempt_throttle (identity_key, input_hash, attempt_count, first_attempt_at, last_attempt_at)
  values (p_identity, p_input_hash, 1, now(), now())
  on conflict (identity_key, input_hash) do update
    set attempt_count = public.scan_attempt_throttle.attempt_count + 1,
        last_attempt_at = now(),
        cooldown_until = case
          when public.scan_attempt_throttle.attempt_count + 1 = 2 then now() + interval '2 hours'
          when public.scan_attempt_throttle.attempt_count + 1 >= 3 then now() + interval '24 hours'
          else public.scan_attempt_throttle.cooldown_until
        end
  returning * into rec;
  return jsonb_build_object(
    'attemptCount', rec.attempt_count,
    'cooldownUntil', case when rec.cooldown_until is not null then to_char(rec.cooldown_until, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') else null end
  );
end;
$$;
revoke all on function public.fn_record_multivehicle_hit(text, text) from public;
grant execute on function public.fn_record_multivehicle_hit(text, text) to anon, authenticated;
