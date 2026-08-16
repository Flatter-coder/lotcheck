-- ============================================================================
-- Re-sync the RAV4 alias rows, and stop them drifting again.
--
-- THE DEFECT. 20260815_rav4_hybrid_alias.sql copies the 2026 RAV4 rows to the
-- name 'RAV4 Hybrid' with INSERT ... SELECT ... FROM msrp_catalog WHERE
-- model = 'RAV4'. That is a POINT-IN-TIME COPY. It ran when RAV4 held four
-- trims, later migrations grew RAV4 to seven, and nothing ever re-ran it:
--
--     RAV4          7 rows   floor $41,361.40  (LE)
--     RAV4 Hybrid   4 rows   floor $47,660.40
--                                   ---------
--                                   $6,299 apart
--
-- So a report's "manufacturer sells this model from ..." floor depended
-- entirely on which of the two names the lookup happened to resolve to. The
-- earlier migration's own closing comment says "Both names, same four trims" —
-- true when written, false within a day.
--
-- THE REASON FOR THE ALIAS IS STILL SOUND. The 2026 RAV4 is hybrid-only in
-- Canada, Toyota publishes both names for the same vehicle, and the powertrain
-- guard rightly refuses to let a "RAV4 Hybrid XLE" listing match a row named
-- plain 'RAV4'. What was unsound is holding the same car as TWO INDEPENDENT
-- COPIES: two sources of truth diverge the moment either one changes, and this
-- pair diverged inside 24 hours.
--
-- This migration makes the copy TOTAL and idempotent — it adds what is missing
-- AND removes alias rows whose source row is gone, so re-running it can only
-- converge the two sets. It is safe to run after every RAV4 seed, and
-- check:alias-drift (offline) now fails the build if any future migration
-- introduces the same one-shot-copy shape.
--
-- THE REAL FIX IS TO STOP DUPLICATING and resolve both names to one row set in
-- the matcher. That is a design change with a powertrain-guard interaction, so
-- it is Vic's call rather than a 4am refactor. This closes the live gap.
-- ============================================================================

-- 1. Add every RAV4 trim the alias set is missing (and refresh any that moved).
insert into public.msrp_catalog
  (year, make, model, trim, msrp, all_in_price, fuel_type, drivetrain, price_basis, source_url, fetched_at, attrs)
select
  m.year, m.make, 'RAV4 Hybrid', m.trim, m.msrp, m.all_in_price, m.fuel_type,
  m.drivetrain, m.price_basis, m.source_url, now(),
  coalesce(m.attrs, '{}'::jsonb) || jsonb_build_object(
    'alias_of', 'RAV4',
    'alias_reason', '2026 RAV4 is hybrid-only; Toyota publishes both names',
    'alias_resynced_at', '2026-08-16')
from public.msrp_catalog m
where m.make ilike 'Toyota' and m.model = 'RAV4' and m.year = 2026
on conflict (year, make, model, trim) do update
  set msrp         = excluded.msrp,
      all_in_price = excluded.all_in_price,
      fuel_type    = excluded.fuel_type,
      drivetrain   = excluded.drivetrain,
      price_basis  = excluded.price_basis,
      source_url   = excluded.source_url,
      attrs        = excluded.attrs,
      fetched_at   = now();

-- 2. Drop alias rows whose SOURCE row no longer exists. Without this the copy
--    is additive only, and a trim corrected away on 'RAV4' would survive
--    forever under 'RAV4 Hybrid' — the drift running the other direction.
delete from public.msrp_catalog a
where a.make ilike 'Toyota' and a.model = 'RAV4 Hybrid' and a.year = 2026
  and a.attrs->>'alias_of' = 'RAV4'
  and not exists (
    select 1 from public.msrp_catalog m
    where m.make ilike 'Toyota' and m.model = 'RAV4' and m.year = a.year
      and coalesce(m."trim",'') = coalesce(a."trim",'')
  );

-- Both names must now agree on count, floor and ceiling. If these two rows
-- differ, the resync did not converge and the report's floor is still a
-- coin-flip between two names for one car.
select model, count(*) as rows,
       min(all_in_price) as floor_all_in,
       max(all_in_price) as ceiling_all_in
from public.msrp_catalog
where make ilike 'Toyota' and year = 2026 and model in ('RAV4','RAV4 Hybrid')
group by model order by model;
