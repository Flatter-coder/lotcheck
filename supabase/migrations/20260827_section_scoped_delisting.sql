-- Section/condition-scoped delisting.
--
-- fn_mark_delisted used to decide delisting at DEALER granularity: it counted
-- ALL live listings for the dealer and marked delisted every live VIN not in
-- `seen`. But a dealer's new and used inventory are crawled as separate sections
-- (and, for convertus, live in separate sitemaps that can lag independently), so
-- a stale/undercounted ONE section, masked by a healthy other section, could
-- slip past the >50% collapse guard and wrongly delist live cars — a partial
-- crawl read as "the rest of the lot sold" (the hard rule this must never break).
--
-- This adds an optional p_condition scope. When passed, BOTH the live count (for
-- the collapse guard) and the delist UPDATE are confined to that condition, so a
-- collapse in one section can only ever affect that section, and the guard is
-- evaluated at the same granularity the inventory can go stale. p_condition
-- defaults to null (whole-dealer, the old behaviour) so a 3-arg caller is
-- unaffected. The crawler now calls it once per crawled condition.

drop function if exists public.fn_mark_delisted(bigint, text[], integer);

create or replace function public.fn_mark_delisted(
  p_dealer_id bigint,
  p_seen_vins text[],
  p_saw_count integer,
  p_condition text default null
)
returns integer language plpgsql security definer set search_path = public as $$
declare v_live integer; v_marked integer;
begin
  -- Live count, scoped to the condition when one is given.
  select count(*) into v_live from vehicle_listing
   where dealer_id = p_dealer_id
     and delisted_on is null
     and (p_condition is null or condition = p_condition);

  -- Sanity gate: if we saw fewer than HALF of what we had live in this scope,
  -- treat the crawl as an undercount — silent or otherwise — and mark nothing.
  -- Exact arithmetic (p_saw_count*2 < v_live, never integer-division rounding),
  -- and NO small-lot floor: the guard must protect a small per-condition scope
  -- too (a convertus sitemap can silently lag; a paginated feed can stop early).
  -- The cost is that a genuine >50%-in-one-crawl drop lingers until a later
  -- crawl — the safe direction for a buyer-facing dataset (missing beats wrong).
  if p_saw_count * 2 < v_live then
    raise notice 'delist skipped for dealer % (condition %): saw % of % live', p_dealer_id, coalesce(p_condition, 'all'), p_saw_count, v_live;
    return 0;
  end if;

  update vehicle_listing set delisted_on = current_date, updated_at = now()
   where dealer_id = p_dealer_id
     and delisted_on is null
     and (p_condition is null or condition = p_condition)
     and not (vin = any(coalesce(p_seen_vins, '{}')));
  get diagnostics v_marked = row_count;
  return v_marked;
end; $$;
revoke all on function public.fn_mark_delisted(bigint, text[], integer, text) from public;
