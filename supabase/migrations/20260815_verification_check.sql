-- ============================================================================
-- Per-checkpoint verification outcomes — one row per checkpoint, per report.
--
-- WHY A NEW TABLE. api_usage_log holds ONE boolean for a whole run. A report
-- that returned a price and nothing else -- no MSRP, no VIN, no recall check --
-- was written as `success: true` and drawn on the admin panel identically to a
-- complete one. That is how a hollow report came to look like a finished one,
-- and it is unfixable in that table: there is nowhere to put 13 answers.
--
-- THE STANDARD (2026-08-15): failure rate under 1%, measured PER CHECKPOINT,
-- not per request. A checkpoint that did not resolve is RED -- not neutral, not
-- excused. The buyer paid for 13 points; 12 is a failure of the 13th.
--
-- `not_applicable` is the ONLY outcome excluded from the rate, which makes it
-- the only way this panel could rot back into decoration. The writing code may
-- return it only on a POSITIVE fact (fuel type IS gas, so no EV rebate exists;
-- the vehicle IS new, so there is no odometer history). Never on absence. The
-- panel therefore shows the n/a share next to every rate, so an N/A that starts
-- creeping upward is visible rather than quietly flattering.
--
-- NO PII. A checkpoint outcome is about a vehicle and a dealer, never a person.
-- report_id is the LC-XXXX-XXX printed on the report itself; no email, no
-- account, no quote, no full URL -- host only.
-- ============================================================================

create table if not exists public.verification_check (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),

  -- The LC-XXXX-XXX on the report. Nullable on purpose: finalizeServerSide
  -- swallows signing errors, so a report can reach this point without an id,
  -- and losing the whole checkpoint row over that would defeat the point.
  report_id    text,
  feature      text not null check (feature in ('quote','listing_url','dealer_sentiment')),
  listing_host text,

  checkpoint   text not null check (checkpoint in (
                 'msrp','odometer','recalls','fees','ev_rebate','vin','warranty',
                 'financing','apr','reputation','leverage','days_on_lot','amvic')),

  -- verified / checked_no_match -> GREEN (the check produced a backed answer)
  -- not_applicable              -> excluded from the rate, must be provable
  -- error / not_attempted       -> RED
  outcome      text not null check (outcome in (
                 'verified','checked_no_match','not_applicable','error','not_attempted')),

  -- Why, in the writer's words. This is what makes the panel actionable: the
  -- MSRP row does not just read 60% red, it reads "no catalog row for 2026
  -- Toyota RAV4" 200 times, which names the work.
  detail       text
);

create index if not exists verification_check_created_idx    on public.verification_check(created_at desc);
create index if not exists verification_check_point_idx      on public.verification_check(checkpoint, created_at desc);
create index if not exists verification_check_red_idx        on public.verification_check(checkpoint, created_at desc)
  where outcome in ('error','not_attempted');
create index if not exists verification_check_report_idx     on public.verification_check(report_id);

alter table public.verification_check enable row level security;
-- No policies: service-role writes through the RPC below, admin reads through
-- the guarded reader. Deliberately NOT following api_usage_log, which the panel
-- reads straight off the table.

-- ---- write (edge functions, service role) ----------------------------------
-- Takes the whole 13-row batch as one jsonb array so a report costs one call.
-- Fail-open at the call site: instrumentation must never break a buyer's report.
create or replace function public.fn_log_verification_checks(p_rows jsonb)
returns integer
language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then return 0; end if;

  insert into verification_check (report_id, feature, listing_host, checkpoint, outcome, detail)
  select nullif(r->>'report_id',''), r->>'feature', nullif(r->>'listing_host',''),
         r->>'checkpoint', r->>'outcome', nullif(r->>'detail','')
  from jsonb_array_elements(p_rows) as r
  -- Drop anything that would violate a check constraint rather than losing the
  -- whole batch: a partial record beats none, and beats a 500 on the report.
  where r->>'feature'    in ('quote','listing_url','dealer_sentiment')
    and r->>'checkpoint' in ('msrp','odometer','recalls','fees','ev_rebate','vin','warranty',
                             'financing','apr','reputation','leverage','days_on_lot','amvic')
    and r->>'outcome'    in ('verified','checked_no_match','not_applicable','error','not_attempted');

  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.fn_log_verification_checks(jsonb) from public, anon, authenticated;

-- ---- admin read ------------------------------------------------------------
-- Returns RAW rows for a window and lets the panel bucket them, because the
-- panel already buckets api_usage_log the same way and has to serve two shapes
-- from one query: the rolling windows (1h/24h/7d/30d/12mo) and an anchored
-- calendar pick (a specific day, month or year). p_until is what makes the
-- anchored case possible -- a rolling-only reader cannot answer "what happened
-- on the 11th", which is the question you have when something looks wrong in
-- hindsight.
create or replace function public.fn_admin_verification_checks(
  p_since timestamptz,
  p_until timestamptz default null,
  p_limit integer default 50000
) returns table (
  created_at   timestamptz,
  report_id    text,
  feature      text,
  listing_host text,
  checkpoint   text,
  outcome      text,
  detail       text
)
language plpgsql security definer set search_path = public as $$
begin
  if not public.fn_is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return query
    select v.created_at, v.report_id, v.feature, v.listing_host, v.checkpoint, v.outcome, v.detail
    from verification_check v
    where v.created_at >= p_since
      and (p_until is null or v.created_at < p_until)
    order by v.created_at desc
    limit greatest(1, least(coalesce(p_limit, 50000), 200000));
end $$;

revoke all on function public.fn_admin_verification_checks(timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.fn_admin_verification_checks(timestamptz, timestamptz, integer) to authenticated;
