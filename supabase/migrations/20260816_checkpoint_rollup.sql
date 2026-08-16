-- ============================================================================
-- Plug the 13 checkpoints into the panel.
--
-- Everything behind them already worked: verification_check has been filling
-- since 20260815, both analyze functions call recordCheckpoints, and
-- fn_admin_verification_checks reads it. The panel just never asked. It shipped
-- with a hardcoded list of hollow rows and nothing ever replaced them, so the
-- one surface built to prove the checks run has been reporting that none of
-- them do.
--
-- Two changes, both small:
--
--   1. A ROLLUP. The existing read returns raw rows, up to 200k of them. A
--      panel wants counts per checkpoint, not a firehose it has to reduce in
--      the browser.
--
--   2. FOUNDERS CAN SEE IT. Gated on fn_can_read_costs() rather than
--      fn_is_admin(), like every other read on that page. JC and Josh fund the
--      thing; "do the checks actually run" is not a question they should have
--      to take on trust.
--
-- THE RATE EXCLUDES not_applicable, DELIBERATELY. A gas car has no EV rebate to
-- verify — counting that as a failure would make every petrol listing look
-- broken, and counting it as a pass would let absence buy a green. It is
-- neither, so it leaves the denominator entirely. That rule is pinned by
-- test:checkpoints; this function must agree with it.
-- ============================================================================

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
  if not public.fn_can_read_costs() then raise exception 'not authorized' using errcode = '42501'; end if;
  return query
    select v.created_at, v.report_id, v.feature, v.listing_host, v.checkpoint, v.outcome, v.detail
    from verification_check v
    where v.created_at >= p_since
      and (p_until is null or v.created_at < p_until)
    order by v.created_at desc
    limit greatest(1, least(coalesce(p_limit, 50000), 200000));
end $$;

create or replace function public.fn_admin_checkpoint_rollup(p_hours integer default 24)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v jsonb;
  v_since timestamptz := now() - make_interval(hours => greatest(1, coalesce(p_hours, 24)));
  v_reports bigint := 0;
begin
  if not public.fn_can_read_costs() then raise exception 'not authorized' using errcode = '42501'; end if;

  select count(distinct coalesce(report_id, created_at::text)) into v_reports
    from verification_check where created_at >= v_since;

  select jsonb_build_object(
    'window_hours', p_hours,
    'reports', v_reports,
    'checkpoints', coalesce((
      select jsonb_agg(jsonb_build_object(
               'checkpoint', c.checkpoint,
               'total',      c.total,
               'green',      c.green,
               'red',        c.red,
               'na',         c.na,
               -- Null, not 0, when every row was not_applicable: "never
               -- applied to any car in this window" and "failed every time"
               -- are opposite facts and must not render alike.
               'pass_pct',   case when (c.green + c.red) > 0
                                  then round(100.0 * c.green / (c.green + c.red), 1) end,
               'worst_detail', c.worst_detail
             ) order by c.checkpoint)
        from (
          select checkpoint,
                 count(*) as total,
                 count(*) filter (where outcome in ('verified','checked_no_match')) as green,
                 count(*) filter (where outcome in ('error','not_attempted'))       as red,
                 count(*) filter (where outcome = 'not_applicable')                 as na,
                 (array_agg(detail order by created_at desc)
                    filter (where outcome in ('error','not_attempted') and detail is not null))[1] as worst_detail
            from verification_check
           where created_at >= v_since
           group by checkpoint
        ) c
    ), '[]'::jsonb)
  ) into v;

  return v;
end $$;

revoke all on function public.fn_admin_verification_checks(timestamptz, timestamptz, integer) from public, anon;
revoke all on function public.fn_admin_checkpoint_rollup(integer)                             from public, anon;
grant execute on function public.fn_admin_verification_checks(timestamptz, timestamptz, integer) to authenticated;
grant execute on function public.fn_admin_checkpoint_rollup(integer)                             to authenticated, service_role;
