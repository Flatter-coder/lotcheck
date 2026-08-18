-- ============================================================================
-- Days-on-market, broken out by condition bucket (new / used / certified /
-- demo) and city -- the leverage data (v_lot_leverage) already existed but
-- had no admin surface at all. Same gate as the price index's admin RPC
-- (fn_can_read_costs()), same "every tracked row shown, not just a published
-- subset" posture as fn_admin_city_price_index -- this is the founders'/
-- admin's own dashboard, not the public page.
--
-- BUCKET PRIORITY: demo > certified > new/used. A demo unit is occasionally
-- also flagged certified in a feed; demo is the more specific, more valuable
-- signal for a buyer ("this was a loaner"), so it wins the bucket.
--
-- TWO DAYS-ON-MARKET NUMBERS, NOT ONE, ON PURPOSE:
--   avg_days_dealer_stated  -- THEIRS: the dealer's own days_in_inventory
--                              field, where the feed states one (SM360,
--                              Convertus). Not every platform states this --
--                              jsonld_itemlist and edealer's normalizers
--                              currently leave it null, honestly, rather than
--                              inferring one.
--   avg_days_observed       -- OURS: current_date - first_seen_on, computed
--                              by fn_upsert_listings on every row regardless
--                              of platform. Meaningful only after the crawl
--                              has run repeatedly over time -- on a dataset
--                              this young it reads near zero for everyone,
--                              which is an honest reflection of "we only
--                              just started watching," not a bug.
-- n_missing_days_stated is returned so the coverage gap in the dealer-stated
-- number is visible rather than silently averaged away.
-- ============================================================================

create or replace function public.fn_admin_lot_leverage_summary()
returns table (
  city                    text,
  bucket                  text,
  n_units                 integer,
  n_missing_days_stated   integer,
  avg_days_dealer_stated  numeric,
  max_days_dealer_stated  integer,
  avg_days_observed       numeric,
  max_days_observed       integer,
  avg_cut_to_date_dollars numeric
)
language plpgsql security definer set search_path = public as $$
begin
  if not public.fn_can_read_costs() then raise exception 'not authorized' using errcode = '42501'; end if;
  return query
    select
      d.city,
      case when l.demo then 'demo' when l.certified then 'certified'
           when l.condition = 'new' then 'new' else 'used' end as bucket,
      count(*)::int as n_units,
      count(*) filter (where l.days_in_inventory is null)::int as n_missing_days_stated,
      round(avg(l.days_in_inventory) filter (where l.days_in_inventory is not null), 1) as avg_days_dealer_stated,
      max(l.days_in_inventory) as max_days_dealer_stated,
      round(avg(current_date - l.first_seen_on), 1) as avg_days_observed,
      max(current_date - l.first_seen_on) as max_days_observed,
      round(avg(l.list_price - l.sale_price) filter (where l.list_price is not null and l.sale_price is not null), 0) as avg_cut_to_date_dollars
    from vehicle_listing l
    join dealer_source d on d.id = l.dealer_id
    where l.delisted_on is null
    group by d.city, bucket
    order by d.city, n_units desc;
end $$;

revoke all on function public.fn_admin_lot_leverage_summary() from public, anon;
grant execute on function public.fn_admin_lot_leverage_summary() to authenticated;
