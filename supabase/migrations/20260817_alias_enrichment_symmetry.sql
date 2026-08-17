-- ============================================================================
-- Two keys for one car must agree on ENRICHMENT, whichever side learns it first.
--
-- THE SYMPTOM Vic saw: a RAV4 Woodland report showed "$47,000 · starting at"
-- when the catalog holds that trim's exact price. Not a matching failure — the
-- matcher was being honest. rowConfirmsConfig() refuses an `exact` basis when
-- the listing states a drivetrain and the row's is NULL, because a
-- drivetrain-blind match already shipped a wrong MSRP once.
--
-- THE NULL WAS DELIBERATE AND CORRECT. 20260815_seed_rav4_hybrid_msrp.sql says
-- so outright: none of the Build & Price summaries state AWD or FWD, so the
-- seed left it null rather than guess. That was the right call.
--
-- WHAT ACTUALLY WENT WRONG is the alias split. NRCan's backfill (Government of
-- Canada open data, the authoritative non-guessable source) ran on 2026-08-17
-- and pinned:
--
--     toyota|rav4 hybrid   -> AWD   (2 NRCan entries)
--     toyota|rav4          -> not pinned
--
-- Same car. Two model keys. The enrichment landed on ONE of them, and the
-- report happened to resolve to the other. The alias pair has now cost us a
-- wrong FLOOR (20260816_rav4_alias_resync.sql) and an unearned `starting_at`,
-- from the same root: one vehicle held as two independent copies.
--
-- This makes enrichment SYMMETRIC. Where one side of an alias pair knows a
-- carry column and the other does not, the known value propagates — in whichever
-- direction the knowledge arrived. It fills only NULLs, so a real difference is
-- never overwritten, and it is idempotent.
--
-- The permanent fix is still to stop duplicating and resolve both names to one
-- row set in the matcher; that interacts with the powertrain guard and is Vic's
-- call. This stops the pair silently disagreeing in the meantime.
-- ============================================================================

-- RAV4 <-> RAV4 Hybrid, both directions, NULLs only.
update public.msrp_catalog a
   set drivetrain = b.drivetrain
  from public.msrp_catalog b
 where a.make ilike 'Toyota' and b.make ilike 'Toyota'
   and a.year = b.year
   and coalesce(a."trim",'') = coalesce(b."trim",'')
   and a.model = 'RAV4' and b.model = 'RAV4 Hybrid'
   and a.drivetrain is null and b.drivetrain is not null;

update public.msrp_catalog a
   set drivetrain = b.drivetrain
  from public.msrp_catalog b
 where a.make ilike 'Toyota' and b.make ilike 'Toyota'
   and a.year = b.year
   and coalesce(a."trim",'') = coalesce(b."trim",'')
   and a.model = 'RAV4 Hybrid' and b.model = 'RAV4'
   and a.drivetrain is null and b.drivetrain is not null;

-- Same for the other carry columns, so the pair cannot diverge on any of them.
update public.msrp_catalog a
   set price_basis = coalesce(a.price_basis, b.price_basis),
       source_url  = coalesce(a.source_url,  b.source_url),
       attrs       = coalesce(a.attrs,       b.attrs)
  from public.msrp_catalog b
 where a.make ilike 'Toyota' and b.make ilike 'Toyota'
   and a.year = b.year
   and coalesce(a."trim",'') = coalesce(b."trim",'')
   and ((a.model = 'RAV4' and b.model = 'RAV4 Hybrid') or (a.model = 'RAV4 Hybrid' and b.model = 'RAV4'))
   and (a.price_basis is null or a.source_url is null or a.attrs is null);

-- Both names must now agree on drivetrain per trim. Any row here with a null
-- drivetrain is a genuine gap NRCan could not pin, not an alias split.
select model, "trim", msrp, all_in_price, drivetrain
from public.msrp_catalog
where make ilike 'Toyota' and year = 2026 and model in ('RAV4','RAV4 Hybrid')
order by "trim", model;

-- Anything still null across the whole Toyota catalog: these are the rows that
-- will keep reading "starting at" instead of an exact claim.
select model, count(*) filter (where drivetrain is null) as null_drivetrain, count(*) as rows
from public.msrp_catalog
where make ilike 'Toyota' and year in (2026, 2027)
group by model having count(*) filter (where drivetrain is null) > 0
order by model;
