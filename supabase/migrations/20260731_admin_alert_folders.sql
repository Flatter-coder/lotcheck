-- ============================================================================
-- Admin "MSRP Alerts" folders view — read the waitlist signups.
--
-- msrp_alert_subscription has RLS ON with NO policies, so no client can read it
-- directly. This admin-gated SECURITY DEFINER RPC lets the OWNER see the signups
-- (their own business data) as per-make "folders" — the demand inventory that
-- later feeds the Dealer Bridge. Dealers are NOT given this; sharing a folder
-- with a dealer is a separate, explicitly-consented flow (not built here).
--
-- Returns aggregate counts per make + the raw rows (email included, since this
-- is the owner's admin view) for client-side grouping/drill-down. Gated by
-- fn_is_admin() exactly like fn_admin_economics.
--
-- Depends on: 20260730_admin_economics.sql (fn_is_admin),
--             20260730_msrp_alerts.sql (msrp_alert_subscription).
-- ============================================================================
create or replace function public.fn_admin_alert_folders(p_limit integer default 2000)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare result jsonb;
begin
  if not public.fn_is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  with picked as (
    select email_raw, make, model, year, city, province, threshold_type, pct, status, created_at
    from msrp_alert_subscription
    order by created_at desc
    limit greatest(1, least(coalesce(p_limit, 2000), 5000))
  ),
  mk as (
    select make, count(*)::int as n from msrp_alert_subscription group by make
  )
  select jsonb_build_object(
    'total', (select count(*)::int from msrp_alert_subscription),
    'by_make', (select coalesce(jsonb_agg(jsonb_build_object('make', make, 'buyers', n) order by n desc, make asc), '[]'::jsonb) from mk),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object(
              'email', email_raw, 'make', make, 'model', model, 'year', year,
              'city', city, 'province', province, 'threshold', threshold_type,
              'pct', pct, 'status', status, 'created_at', created_at
            ) order by created_at desc), '[]'::jsonb) from picked)
  ) into result;

  return result;
end; $$;

revoke all on function public.fn_admin_alert_folders(integer) from public;
grant execute on function public.fn_admin_alert_folders(integer) to authenticated;
