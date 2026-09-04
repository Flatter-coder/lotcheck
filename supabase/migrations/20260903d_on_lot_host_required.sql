-- ============================================================================
-- "WE DO NOT KNOW WHICH DEALER" MUST NEVER BE SPELLED THE SAME WAY AS
-- "ANY DEALER".
--
-- 20260903b shipped fn_listing_on_lot with these two predicates:
--
--     (p_host is null or ds.host =  p_host)     -- picks the subject's listing
--     (p_host is null or ds.host <> p_host)     -- picks the OTHER dealers
--
-- Both short-circuit to TRUE when p_host is null. And p_host was ALWAYS null,
-- because the caller read `analysis.sourceUrl` 621 lines before anything
-- assigns it, so `new URL("")` threw and the catch left host = null.
--
-- The result was the exact defect PR #387 was written to end, reintroduced by
-- its own fix, plus a worse one:
--
--   * `me` became "whichever dealer we crawled most recently for this VIN", so
--     a Genesis North Calgary report printed Okotoks Chevrolet's first-seen
--     date and price ladder under "this dealer's lot";
--   * and because the second predicate was also true for every row, the
--     subject's OWN listing came back in otherDealers -- so a report told the
--     buyer the car was "also advertised" by the dealership they were standing
--     in. That is a claim a dealer disproves by pointing at their own window,
--     and it needed no second observation, so it fired on almost every scan.
--
-- Two changes, and the first is the one that matters:
--
-- 1. A NULL p_host now REFUSES. thisDealer comes back null and otherDealers
--    empty. An absent dealer identity is an absence, exactly like an absent
--    odometer -- the same lesson as read-num.js, one layer down. A caller that
--    cannot say which dealer it is asking about gets nothing, not everything.
--
-- 2. HOSTS ARE COMPARED NORMALISED. dealer_source.host is a seeded origin
--    ('https://www.tazaparkvw.com'); the caller derives its origin from
--    whatever URL a buyer pasted, which may lack the www. An exact string
--    compare made that mismatch silently return no dealer at all -- failing
--    closed, but for a reason nobody could see. Scheme and a leading www. are
--    stripped from both sides, and nothing else: two genuinely different hosts
--    still do not match.
-- ============================================================================

create or replace function public.fn_listing_on_lot(p_vin text, p_host text default null)
returns jsonb language sql stable security definer set search_path = public as $$
  with h as (
    -- Normalised once. null stays null, and null means REFUSE below.
    select case when p_host is null or btrim(p_host) = '' then null
                else regexp_replace(lower(btrim(p_host)), '^https?://(www\.)?', '') end as host
  ),
  me as (
    select vl.id, ds.host, vl.first_seen_on, vl.last_seen_on, vl.delisted_on, vl.list_price
      from vehicle_listing vl join dealer_source ds on ds.id = vl.dealer_id, h
     where vl.vin = upper(p_vin)
       and h.host is not null
       and regexp_replace(lower(ds.host), '^https?://(www\.)?', '') = h.host
     order by vl.last_seen_on desc
     limit 1
  ),
  obs as (
    select o.observed_on from listing_observation o join me on o.listing_id = me.id
  ),
  hist as (
    select h2.observed_on, coalesce(h2.sale_price, h2.list_price) as price
      from listing_price_history h2 join me on h2.listing_id = me.id
     where coalesce(h2.sale_price, h2.list_price) is not null
     order by h2.observed_on
  )
  select jsonb_build_object(
    'vin', upper(p_vin),
    -- Null when we could not say WHICH dealer. The caller must treat that as
    -- "no days-on-lot claim", never as "some dealer's".
    'thisDealer', (select case when me.id is null then null else jsonb_build_object(
        'host',          me.host,
        'firstSeenOn',   to_char(me.first_seen_on, 'YYYY-MM-DD'),
        'lastSeenOn',    to_char(me.last_seen_on,  'YYYY-MM-DD'),
        'delistedOn',    to_char(me.delisted_on,   'YYYY-MM-DD'),
        'listPrice',     me.list_price,
        'observations',  (select count(*) from obs),
        'spanDays',      greatest(0, me.last_seen_on - me.first_seen_on),
        'unobservedDaysInSpan',
          greatest(0, (me.last_seen_on - me.first_seen_on + 1) - (select count(*) from obs)),
        'priceHistory', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'observedOn', to_char(hist.observed_on, 'YYYY-MM-DD'),
                   'price', hist.price) order by hist.observed_on)
            from hist), '[]'::jsonb)
      ) end from me),
    -- Empty when the dealer is unknown: without an identity there is no "other"
    -- to be other THAN, and returning every row made the subject its own twin.
    'otherDealers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'host', ds.host, 'dealerName', ds.name, 'city', ds.city,
               'firstSeenOn', to_char(vl.first_seen_on, 'YYYY-MM-DD'),
               'lastSeenOn',  to_char(vl.last_seen_on,  'YYYY-MM-DD'),
               'listPrice',   vl.list_price,
               'certified',   vl.certified)
             order by vl.last_seen_on desc)
        from vehicle_listing vl join dealer_source ds on ds.id = vl.dealer_id, h
       where vl.vin = upper(p_vin)
         and h.host is not null
         and regexp_replace(lower(ds.host), '^https?://(www\.)?', '') <> h.host), '[]'::jsonb)
  );
$$;
revoke all on function public.fn_listing_on_lot(text, text) from public;
grant execute on function public.fn_listing_on_lot(text, text) to service_role;

comment on function public.fn_listing_on_lot(text, text) is
  'Days-on-lot, observed price moves and same-VIN-elsewhere, scoped to ONE dealer. A NULL or blank p_host REFUSES: it returns no dealer and no others, because "we do not know which dealer" must never be spelled the same way as "any dealer". Hosts compare with scheme and a leading www. stripped from both sides.';
