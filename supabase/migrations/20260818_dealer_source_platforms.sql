-- ============================================================================
-- Two more crawlable platforms, confirmed live 2026-08-18 with a plain
-- honest-UA fetch (no JS rendering): 'jsonld_itemlist' (a JSON-LD ItemList of
-- Car nodes per model/category page -- Wolfe Chevrolet, Village Honda) and
-- 'edealer' (an inline `vehicleArray = {...}` object -- Rainbow Ford). See
-- scripts/lib/structured-inventory.mjs for the parsers.
--
-- The old check constraint only allowed sm360/convertus/other -- 'other' was
-- never actually crawlable (crawl-alberta-inventory.mjs's dealer query
-- filters to .in("platform", [...]) explicitly), so it was a label with no
-- behaviour. Widening the real allowed set rather than repurposing 'other'
-- keeps every platform value meaning exactly one crawl code path.
-- ============================================================================

alter table public.dealer_source drop constraint if exists dealer_source_platform_check;
alter table public.dealer_source add constraint dealer_source_platform_check
  check (platform in ('sm360', 'convertus', 'jsonld_itemlist', 'edealer', 'other'));
