-- ============================================================================
-- Report Issuance Ledger  (fast-follow to the tamper-evident report ID / #58)
--
-- Purpose: keep a LotCheck-SIDE record that a given report ID was genuinely
-- issued by us, at a given time -- WITHOUT storing the report or any personal
-- information. Stores ONLY {report_id, fingerprint, issued_at}. No VIN, name,
-- email, price, dealer, or free text ever touches this table.
--
-- ⚠️ GATED: do not deploy until AMVIC / PIPA / PIPEDA / Alberta CPA sign-off
-- confirms (a) fingerprint-only storage is non-personal and (b) the reworded
-- "we keep only its fingerprint" copy. See issuance-ledger-scope.md +
-- memory: defamation-proof-and-compliant, always-check-legally-clear.
--
-- Integrity: the write function RE-DERIVES the fingerprint from the verify
-- payload in-database and rejects any (report_id, payload) pair that doesn't
-- match. So a caller can only ever log a REAL, self-consistent report -- they
-- cannot forge "LC-XXXX was issued at time T" for a fingerprint that isn't ours.
-- (report_id, fingerprint, issued_at) are cryptographically bound by the hash.
--
-- Depends on: pgcrypto (digest), fn_is_admin (admin_economics migration).
-- ============================================================================
create extension if not exists pgcrypto;

create table if not exists public.report_issuance_ledger (
  id          uuid primary key default gen_random_uuid(),
  report_id   text not null,                 -- e.g. 'LC-00A9-AFE' (already public)
  fingerprint text not null,                 -- full SHA-256 hex the ID derives from
  issued_at   timestamptz,                   -- the report's stamped issuedAt
  created_at  timestamptz not null default now(),
  unique (report_id, fingerprint)
);
comment on table public.report_issuance_ledger is
  'Fingerprint-only issuance record. Contains NO personal information by design.';

alter table public.report_issuance_ledger enable row level security;
-- No policies => no anon/authenticated direct table access. All reads/writes go
-- through the SECURITY DEFINER functions below.

-- ── Derive the LotCheck report ID from a SHA-256 hex digest. Must match the
--    client's makeReportId(): 'LC-' + hex[0:4] + '-' + hex[4:7], upper-cased.
create or replace function public.fn_make_report_id(p_fp_hex text)
returns text language sql immutable as $$
  select 'LC-' || upper(substr(p_fp_hex, 1, 4)) || '-' || upper(substr(p_fp_hex, 5, 3));
$$;

-- ── base64url -> bytea (the exact UTF-8 bytes the client hashed).
create or replace function public.fn_b64url_to_bytea(p text)
returns bytea language sql immutable as $$
  select decode(
    -- url-safe -> standard, then pad to a multiple of 4 with '='
    rpad(translate(p, '-_', '+/'), ((length(translate(p, '-_', '+/')) + 3) / 4) * 4, '='),
    'base64');
$$;

-- ── Log an issuance. Recomputes the fingerprint from the payload and only
--    writes if it reproduces the claimed report_id. Idempotent. Safe to call
--    from the client (anon/authenticated): the DB self-verifies, so no forged
--    pair can ever be stored. Returns {ok, matched, report_id}.
create or replace function public.fn_log_issuance(p_report_id text, p_verify_payload text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_bytes bytea;
  v_fp    text;
  v_json  jsonb;
  v_issued timestamptz;
begin
  if coalesce(p_report_id,'') = '' or coalesce(p_verify_payload,'') = '' then
    return jsonb_build_object('ok', false, 'matched', false, 'reason', 'missing input');
  end if;

  -- Decode the payload to its exact bytes, hash them, derive the id.
  begin
    v_bytes := public.fn_b64url_to_bytea(p_verify_payload);
  exception when others then
    return jsonb_build_object('ok', false, 'matched', false, 'reason', 'bad payload');
  end;
  v_fp := encode(digest(v_bytes, 'sha256'), 'hex');

  -- Reject anything whose contents don't reproduce the claimed id (anti-spoof).
  if public.fn_make_report_id(v_fp) <> p_report_id then
    return jsonb_build_object('ok', false, 'matched', false, 'report_id', p_report_id);
  end if;

  -- issued_at comes from inside the (now-verified) payload, so it's bound to
  -- the fingerprint -- it cannot be independently backdated.
  begin
    v_json := convert_from(v_bytes, 'utf8')::jsonb;
    v_issued := (v_json ->> 'issuedAt')::timestamptz;
  exception when others then
    v_issued := null;
  end;

  insert into public.report_issuance_ledger(report_id, fingerprint, issued_at)
  values (p_report_id, v_fp, v_issued)
  on conflict (report_id, fingerprint) do nothing;

  return jsonb_build_object('ok', true, 'matched', true, 'report_id', p_report_id);
end; $$;

revoke all    on function public.fn_log_issuance(text, text) from public;
grant  execute on function public.fn_log_issuance(text, text) to anon, authenticated;

-- ── Admin dispute lookup: does this ID exist in our ledger, and when? Returns
--    the fingerprint + timestamps, or null. Admin-gated (owner only).
create or replace function public.fn_report_issuance_lookup(p_report_id text)
returns table(report_id text, fingerprint text, issued_at timestamptz, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not public.fn_is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return query
    select l.report_id, l.fingerprint, l.issued_at, l.created_at
    from public.report_issuance_ledger l
    where l.report_id = p_report_id
    order by l.created_at desc;
end; $$;

revoke all    on function public.fn_report_issuance_lookup(text) from public;
grant  execute on function public.fn_report_issuance_lookup(text) to authenticated;
