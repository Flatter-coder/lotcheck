-- ============================================================================
-- CATALOG MSRP — the manufacturer's NEW-car price for a make/model, anon-read.
--
-- WHY. The /crawl used-market page can already show what a model asks USED (our
-- own crawl, via fn_market_comps). The missing half of "how far are you from a
-- new one?" is the manufacturer's NEW price — and msrp_catalog is RLS-locked
-- with no anon path (written only by service-role catalog scripts, read only by
-- edge functions). Every other anon catalog RPC returns deviation AGGREGATES,
-- never the sticker dollar. This exposes the published figure itself, read-only.
--
-- BASIS IS CARRIED, NEVER COLLAPSED. A row holds two prices: `msrp` (the
-- conventional figure, usually EXCLUDING freight/PDI) and `all_in_price` (the
-- manufacturer's OWN all-in figure where they publish it, e.g. Toyota Build &
-- Price — see 20260815_msrp_all_in_price.sql). An Alberta advertised/used price
-- is all-in, so the ONLY clean comparison is all-in vs all-in. all_in_price is
-- NULL for most rows. We return BOTH prices plus `price_basis` so the caller can
-- (a) compare all-in to all-in where all_in_price exists, and (b) otherwise use
-- msrp only as a conservative FLOOR ("a new one lists from at least $X, before
-- freight & fees") — never invent a freight-sized markup, which under our own
-- rules would be a public accusation against a named dealer.
--
-- POWERTRAIN SAFETY. Matches make+model EXACTLY (case-insensitive), like
-- fn_market_comps. It never fuzzy-matches, so a used "RAV4 Hybrid" cannot pull a
-- gas "RAV4" MSRP as its reference; a model with no exact catalog row simply
-- returns [] and the caller shows "not held yet" rather than a wrong number.
--
-- Returns the published manufacturer figure, so anon-callable like its siblings
-- (fn_market_comps / fn_comparable_listings / fn_city_price_index).
-- ============================================================================

create or replace function public.fn_catalog_msrp(
  p_make  text,
  p_model text,
  p_year  integer default null
)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'year',       year,
               'trim',       trim,
               'msrp',       msrp,
               'allIn',      all_in_price,
               'basis',      price_basis,
               'fuel',       fuel_type,
               'drivetrain', drivetrain
             )
             order by year desc, coalesce(all_in_price, msrp)
           ),
           '[]'::jsonb
         )
  from public.msrp_catalog
  where lower(make)  = lower(p_make)
    and lower(model) = lower(p_model)
    and (p_year is null or year = p_year)
    and msrp is not null
    and msrp > 0
$$;

revoke all on function public.fn_catalog_msrp(text, text, integer) from public;
-- Anon-callable: returns the manufacturer's OWN published price, nothing
-- dealer-identifying and nothing derived — less disclosive than the used-listing
-- functions that already ship anon.
grant execute on function public.fn_catalog_msrp(text, text, integer) to anon, authenticated;
