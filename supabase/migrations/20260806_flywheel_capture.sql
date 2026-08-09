-- ============================================================================
-- Quote-Data Flywheel — Phase 3: DE-IDENTIFIED fee-observation capture.
--
-- SHIPS DORMANT. This creates the capture engine but it stores NOTHING until an
-- admin flips the `flywheel_capture_enabled` flag. That flip must ONLY happen
-- after (a) written legal sign-off (PIPA/PIPEDA/CPA — legal-review-flywheel-fee-
-- data.md) AND (b) the reworded "nothing stored" copy is live. Until then,
-- "analyzed once, nothing stored" stays literally true — the capture RPC returns
-- {enabled:false, stored:0} and inserts nothing.
--
-- What it stores (only when enabled): the exact de-identified projection from
-- _shared/fee-vocab.ts buildFeeObservations() — a DEALER (a business, one-way
-- hashed) + coarse region + make/fuel segment + normalized fee label + amount +
-- date. NEVER a buyer, email, IP, VIN, odometer, trim/stock, raw file, or free
-- text. The RPC re-validates this server-side (defense in depth) and drops
-- anything that doesn't fit the de-identified shape.
-- Depends on: 20260730_admin_economics.sql (admin_config, fn_is_admin).
-- ============================================================================

-- ---- 1) capture flag — DEFAULT OFF -----------------------------------------
insert into public.admin_config(key, text_value)
  values ('flywheel_capture_enabled', 'false')
  on conflict (key) do nothing;

create or replace function public.fn_flywheel_enabled()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select lower(btrim(text_value)) = 'true'
                   from admin_config where key = 'flywheel_capture_enabled' limit 1), false);
$$;
revoke all on function public.fn_flywheel_enabled() from public;
grant execute on function public.fn_flywheel_enabled() to anon, authenticated;

-- ---- 2) the de-identified table (RLS-locked, NO client policies) ------------
create table if not exists public.fee_observation (
  id           bigint generated always as identity primary key,
  dealer_id    text not null,             -- opaque one-way hash of dealer name+city (a business)
  region       text,                      -- coarse geo only, e.g. "Calgary, AB"
  make_segment text,                      -- e.g. "Hyundai / BEV" — no trim, no VIN
  fee_label    text not null,             -- controlled-vocabulary label
  amount       numeric not null check (amount > 0 and amount < 100000),
  verdict      text,
  observed_at  date not null,
  created_at   timestamptz not null default now()
);
alter table public.fee_observation enable row level security;   -- no policies: RPC-only
create index if not exists ix_fee_obs_region_label on public.fee_observation(region, fee_label);

-- ---- 3) capture RPC — anon-callable, SELF-GATING, de-id re-validated --------
create or replace function public.fn_capture_fee_observations(p_obs jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o jsonb; n int := 0; v_amt numeric; v_label text; v_dealer text;
begin
  -- Gate: unless explicitly enabled by an admin, store NOTHING.
  if not fn_flywheel_enabled() then
    return jsonb_build_object('ok', true, 'enabled', false, 'stored', 0);
  end if;
  if p_obs is null or jsonb_typeof(p_obs) <> 'array' then
    return jsonb_build_object('ok', true, 'enabled', true, 'stored', 0);
  end if;
  for o in select * from jsonb_array_elements(p_obs) loop
    v_dealer := nullif(btrim(o->>'dealer_id'), '');
    v_label  := nullif(btrim(o->>'fee_label'), '');
    begin v_amt := (o->>'amount')::numeric; exception when others then v_amt := null; end;
    -- De-identification defense: dealer_id MUST be our opaque 'd_xxxxxxxx' hash
    -- (never a raw name), amount sane, label short. Anything else is dropped —
    -- a VIN, email, or free text can never land in a row.
    if v_dealer is null or v_dealer !~ '^d_[0-9a-f]{8}$' then continue; end if;
    if v_label is null or length(v_label) > 40 then continue; end if;
    if v_amt is null or v_amt <= 0 or v_amt >= 100000 then continue; end if;
    insert into public.fee_observation(dealer_id, region, make_segment, fee_label, amount, verdict, observed_at)
      values (v_dealer,
              left(nullif(btrim(o->>'region'), ''), 60),
              left(nullif(btrim(o->>'make_segment'), ''), 40),
              v_label, round(v_amt),
              left(nullif(btrim(o->>'verdict'), ''), 20),
              coalesce((substr(coalesce(o->>'observed_at', ''), 1, 10))::date, current_date));
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'enabled', true, 'stored', n);
exception when others then
  return jsonb_build_object('ok', false, 'enabled', true, 'stored', n);
end; $$;
revoke all on function public.fn_capture_fee_observations(jsonb) from public;
grant execute on function public.fn_capture_fee_observations(jsonb) to anon, authenticated;

-- ---- 4) k-anonymity benchmark READ (admin-only for now) ---------------------
-- Never returns figures below N observations (default 5) — returns {enough:false}
-- instead, so no stat can trace to a single deal. Phase 4 wires this into the
-- report (still k-anon gated, with n= shown for dispute-proofing).
create or replace function public.fn_fee_benchmark(p_region text, p_fee_label text, p_min_n int default 5)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_n int; v_avg numeric; v_p50 numeric; v_p90 numeric; v_dealers int; v_min int := greatest(coalesce(p_min_n,5), 5);
begin
  if not fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  select count(*), avg(amount),
         percentile_cont(0.5) within group (order by amount),
         percentile_cont(0.9) within group (order by amount),
         count(distinct dealer_id)
    into v_n, v_avg, v_p50, v_p90, v_dealers
    from fee_observation
    where fee_label = lower(btrim(p_fee_label))
      and (p_region is null or region = p_region);
  if coalesce(v_n, 0) < v_min then
    return jsonb_build_object('enough', false, 'n', coalesce(v_n, 0));
  end if;
  return jsonb_build_object('enough', true, 'n', v_n, 'dealers', v_dealers,
    'avg', round(v_avg), 'median', round(v_p50), 'p90', round(v_p90));
end; $$;
revoke all on function public.fn_fee_benchmark(text, text, int) from public;
grant execute on function public.fn_fee_benchmark(text, text, int) to authenticated;
