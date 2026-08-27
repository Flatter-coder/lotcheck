-- ============================================================================
-- Lexus NX: a gasoline line stored as "Hybrid", and case-duplicate trim rows.
--
-- WHAT A CUSTOMER SAW (2026-08-27, report LC-46A4-66F, a real paid report on
-- a 2026 Lexus NX 350h Premium Hybrid AWD):
--   * "MSRP · STARTING AT $55,080" -- the GAS NX's base price -- while the
--     dealer's own page stated $58,675 for that exact unit.
--   * An "MSRP per trim" card listing SEVENTEEN rows with four different
--     "Luxury" prices.
--
-- TWO WRITE-SIDE CAUSES, both fixed in code alongside this migration:
--
-- 1. SERIES-LEVEL FUEL MIS-TAG. tci-stack.mjs's inferFuel() assigns fuel at
--    the SERIES level, so the whole multi-powertrain Lexus NX line inherited
--    one tag and every gasoline 'NX' row was written fuel_type 'Hybrid'.
--    flagAllOnePowertrain() detected exactly this and only console.warn'd, so
--    the rows shipped anyway. It now REFUSES a proven mis-tag (proven = a
--    powertrain-marked sibling nameplate exists for the same make/year), and
--    model-identity.js learned the 350h / 450h+ / e:HEV / e-POWER convention
--    it was blind to.
--
--    This is the SAME defect a migration hand-fixed for the Lexus TX on
--    2026-08-26 and left unfixed for the NX -- the repeat this migration is
--    meant to end at the source rather than one nameplate at a time.
--
-- 2. CASE-SENSITIVE DEDUPE. The scraper's collapse key and this table's
--    UNIQUE constraint are both case-sensitive, so Lexus's AEM fragment
--    returning "LUXURY" for one package and "Luxury" for another created TWO
--    rows for one trim at two prices. The scraper key is now lower(trim).
--
-- SAFETY. This migration only corrects rows whose fuel is provably wrong for
-- their own nameplate, and only collapses rows that are case-duplicates at
-- the SAME price. Two rows that genuinely disagree on price are a real data
-- question and are left alone -- missing beats wrong, and so does unresolved.
-- ============================================================================

-- 1. The bare 'NX' nameplate is the GAS line. Correct only rows that are
--    provably mis-tagged: model has no powertrain marker, yet is tagged as a
--    non-gas powertrain, while marked sibling nameplates exist for that year.
update public.msrp_catalog m
   set fuel_type = 'Gas',
       fetched_at = now()
 where m.make ilike 'Lexus'
   and m.model = 'NX'
   and m.fuel_type is distinct from 'Gas'
   and exists (
     select 1 from public.msrp_catalog s
      where s.make ilike 'Lexus' and s.year = m.year
        and s.model in ('NX Hybrid', 'NX Plug-in Hybrid')
   );

-- 2. Collapse case-duplicate trims that agree on price. Keeps the lowest id
--    (the earliest row) and its provenance; a genuine price disagreement
--    between case variants is NOT touched.
delete from public.msrp_catalog a
 using public.msrp_catalog b
 where a.make ilike 'Lexus'
   and a.year = b.year and a.make = b.make and a.model = b.model
   and lower(btrim(a.trim)) = lower(btrim(b.trim))
   and a.msrp = b.msrp
   and a.id > b.id;

-- 3. What the fix left behind, so the next reader can see it rather than
--    rediscover it. Rows that still share a trim name at DIFFERENT prices are
--    real trim+package permutations; the report now labels them rather than
--    pretending they are one ladder.
select model, fuel_type, count(*) as rows, min(msrp) as low, max(msrp) as high
  from public.msrp_catalog
 where make ilike 'Lexus' and model like 'NX%'
 group by model, fuel_type
 order by model, fuel_type;
