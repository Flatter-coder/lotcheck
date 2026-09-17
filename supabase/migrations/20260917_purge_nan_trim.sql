-- ============================================================================
-- A FAILED COMPUTATION BECAME A CAR'S TRIM NAME.
--
-- msrp_catalog held this row:
--
--   2026 Cadillac LYRIQ   trim = 'NaN 2026 LYRIQ'   $74,042
--   source_url = https://www.cadillaccanada.ca/en/electric/lyriq
--
-- Nobody typed that. cadillaccanada.ca rendered a literal "NaN" where its own
-- script failed to format a number, and scripts/lib/published-price.mjs took the
-- nearest preceding text as the trim name. The row shipped WITH a source_url,
-- which is the flag replaceRows' DELETE reads as "hand-verified, spare me" -- so
-- the daily refresh protected it and it would have sat in the catalogue
-- indefinitely under a name no dealer and no buyer will ever write.
--
-- The write-side fix is in the same commit: cleanTrim() now refuses a trim
-- carrying a parse artifact and drops the pair, and strips a model year or the
-- model name from ANYWHERE in the name rather than only from the ends -- which
-- is how "2026" survived in the middle of the stored string. That suite existed
-- and was green 8/8 the whole time, because it was wired into nothing; it runs
-- in gates.yml now.
--
-- SAFE TO APPLY: the $74,042 figure is also held by the trim-less LYRIQ row
-- captured 2026-08-18 from the same page, so deleting this one removes a
-- corrupted duplicate, not a price. The block below REFUSES to delete unless
-- that twin is actually present.
--
-- Addressed by NATURAL KEY (year, make, model, trim), never by id: ids in this
-- table are reassigned by every catalog refresh. See
-- scripts/check-migration-row-identity.mjs.
-- ============================================================================

do $$
declare
  n int;
begin
  if exists (
    select 1 from public.msrp_catalog
     where year = 2026 and make = 'Cadillac' and model = 'LYRIQ'
       and trim = 'NaN 2026 LYRIQ'
  ) then
    -- The price must survive this delete somewhere else, or we are removing the
    -- only record we hold of what Cadillac publishes for that car.
    if not exists (
      select 1 from public.msrp_catalog
       where year = 2026 and make = 'Cadillac' and model = 'LYRIQ'
         and msrp = 74042
         and coalesce(trim, '') <> 'NaN 2026 LYRIQ'
    ) then
      raise exception
        'refusing to delete the NaN-trim LYRIQ: $74,042 is held by no other row for that year/make/model, so this is the only record of that published price';
    end if;

    delete from public.msrp_catalog
     where year = 2026 and make = 'Cadillac' and model = 'LYRIQ'
       and trim = 'NaN 2026 LYRIQ';
    get diagnostics n = row_count;
    if n = 0 then
      raise exception 'NaN-trim delete matched nothing after EXISTS said it would';
    end if;
    raise notice 'removed % corrupted-trim row(s)', n;
  else
    raise notice 'NaN-trim LYRIQ: nothing to do (already removed)';
  end if;
end $$;

-- ── The check that makes this migration mean something ──────────────────────
-- Pinning one row fixes one row. This asserts the CLASS is empty: no trim
-- anywhere in the catalogue may be, or contain, a failed computation. If another
-- maker page has done the same thing somewhere I did not look, this raises
-- instead of quietly leaving it.
--
-- Measured before it was written: exactly ONE row in 1,497 matched, the LYRIQ
-- above. The pattern is anchored on word boundaries so a real trim is never
-- caught -- "Nan" as a word, not the "nan" inside a longer name.
do $$
declare
  bad int;
  sample text;
begin
  select count(*),
         min(year || ' ' || make || ' ' || model || ' / ' || trim)
    into bad, sample
    from public.msrp_catalog
   where trim ~* '(^|[^a-z])(nan|undefined|null|nil|infinity)([^a-z]|$)';

  if bad > 0 then
    raise exception
      'trim carries a failed computation in % row(s) -- e.g. %. published-price.mjs cleanTrim() refuses these on capture; these predate the fix and need the same natural-key removal as the LYRIQ above.',
      bad, sample;
  end if;
  raise notice 'no trim in the catalogue carries a failed computation';
end $$;
