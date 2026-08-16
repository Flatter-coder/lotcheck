-- ============================================================================
-- Plug the 13 checkpoints in — they were only ever a permissions problem.
--
-- Everything behind them already worked. verification_check has been filling
-- since 20260815, both analyze functions call recordCheckpoints, and the panel
-- already fetches fn_admin_verification_checks and reduces it per checkpoint
-- with a green/red/n-a breakdown and a 1% target.
--
-- But that read gates on fn_is_admin(), and the founders panel runs as JC or
-- Josh. They get 42501, the fetch throws, checkStats lands null, and EVERY
-- checkpoint falls through to the hollow branch — which renders the table name
-- as its note. That is exactly the screenshot: thirteen rows reading
-- "verification_check.msrp", "verification_check.odometer", and so on.
--
-- So the panel was not unplugged. It was told it had no data, by the only
-- error path that looks identical to having none.
--
-- One line: fn_can_read_costs() instead of fn_is_admin(), matching every other
-- read on that page. Nothing else about the function changes — same signature,
-- same rows, same limit — so the client needs no change at all.
--
-- Deliberately NOT adding a server-side rollup. The client already reduces
-- these rows and that code is pinned by test:checkpoints; at ~350 scans a month
-- it is 4,500 rows, not a firehose. A second aggregation path would be a second
-- place for the n/a rule to drift out of agreement with the test.
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

revoke all on function public.fn_admin_verification_checks(timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.fn_admin_verification_checks(timestamptz, timestamptz, integer) to authenticated;

-- Sanity: the table these rows come from must exist, or the panel would keep
-- reporting "no data" for a completely different reason and we would be back
-- here in a week chasing the same screenshot.
do $$
begin
  if to_regclass('public.verification_check') is null then
    raise exception 'verification_check is missing — apply 20260815_verification_check.sql first, or the checkpoints stay hollow whatever the grant says';
  end if;
  raise notice 'verification_check present; checkpoint reads now open to founders';
end $$;
