-- ============================================================================
-- manufacturer_warranties: terms vary by MODEL and by WHEN THE CAR WAS SOLD.
-- The table could express neither, and a real customer report paid for it.
--
-- WHAT HAPPENED. 2026-09-12, report LC-BDA3-B85, a 2020 Tesla Model X at
-- 198,909 km. The Tesla row read:
--
--     powertrain_coverage = '8-year/160,000 km (battery & drive unit, varies by model)'
--
-- Whoever wrote that knew one string per make was not enough — the parenthetical
-- says so. The parser read past it, took the 160,000, and published it as that
-- car's number. It was wrong in BOTH directions on the two cars that exposed it:
--
--   * 2020 Model X — the real term is 8 years or 240,000 km. We told the buyer
--     the car was past its cap. It had 41,091 km of headroom. A false negative
--     on the most expensive component on the vehicle, stated against the buyer.
--   * 2017 Model X — the real term is 8 years with NO distance cap. We invented
--     a 160,000 km limit and would have killed a warranty that the odometer
--     cannot affect at all.
--
-- 160,000 km is not a Tesla battery term anywhere. It is the ceiling of Tesla's
-- Extended Service Agreement — a different product that expressly EXCLUDES
-- high-voltage batteries and drive units. That is the likeliest source of the
-- mix-up, and it is exactly the kind of error one string per make invites.
--
-- Tesla's own current Canadian warranty PDF states the principle outright:
-- "Any Model S or Model X purchased prior to the effective date ... is subject
-- to the applicable Battery and Drive Unit Warranty effective as of the date of
-- purchase." For a USED-car product the binding terms are the ones in force at
-- the car's first sale — not today's. The schema had no model dimension and no
-- effective-date dimension, so it could not have been right by accident.
--
-- WHAT THIS MIGRATION DOES
--   1. Adds `model`, `year_from`, `year_to`. A NULL model stays the make-wide
--      fallback, so every existing row keeps working unchanged.
--   2. Replaces the make-only primary key with a surrogate id plus a uniqueness
--      rule over (make, model, year_from, year_to).
--   3. Adds the SOURCED Tesla Model S / Model X rows for both eras.
--   4. LEAVES the make-level Tesla row hedged on purpose — see below.
--
-- WHY THE HEDGE STAYS ON THE MAKE-LEVEL TESLA ROW. We verified Model S and
-- Model X terms against Tesla's own pages. We did NOT verify Model 3 or Model Y,
-- so we still cannot answer for them. The application now REFUSES to publish a
-- figure from any row whose text hedges (scripts/test-warranty-labels.mjs pins
-- this), so leaving the hedge in place makes a Model 3 report say "cannot state"
-- instead of quietly borrowing Model X's number. The hedge is load-bearing: it
-- is the refusal. Do not "tidy" it away without adding sourced Model 3/Y rows.
--
-- Paste into the Supabase SQL editor. Safe to re-run.
-- ============================================================================

-- ---- 1) the two missing dimensions -----------------------------------------
alter table public.manufacturer_warranties add column if not exists model     text;
alter table public.manufacturer_warranties add column if not exists year_from integer;
alter table public.manufacturer_warranties add column if not exists year_to   integer;
alter table public.manufacturer_warranties add column if not exists note      text;

comment on column public.manufacturer_warranties.model is
  'NULL = applies to the whole make (fallback). A value scopes the row to that model, matched case-insensitively.';
comment on column public.manufacturer_warranties.year_from is
  'First MODEL YEAR this row applies to, inclusive. NULL = open-ended. Terms change by sale date; model year is the proxy we can read from a listing.';
comment on column public.manufacturer_warranties.year_to is
  'Last MODEL YEAR this row applies to, inclusive. NULL = open-ended.';

-- ---- 2) make is no longer unique -------------------------------------------
-- Done defensively: the constraint name is whatever Postgres generated for the
-- original `make text primary key`, so find it rather than guess it.
do $$
declare c text;
begin
  select conname into c
    from pg_constraint
   where conrelid = 'public.manufacturer_warranties'::regclass and contype = 'p';
  if c is not null then
    execute format('alter table public.manufacturer_warranties drop constraint %I', c);
  end if;
end $$;

alter table public.manufacturer_warranties
  add column if not exists id bigint generated always as identity;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.manufacturer_warranties'::regclass and contype = 'p'
  ) then
    alter table public.manufacturer_warranties add primary key (id);
  end if;
end $$;

-- One row per (make, model, year range). COALESCE so NULL model/years take part
-- in uniqueness instead of silently permitting duplicates — a duplicate here
-- would make the resolver's choice depend on row order, which is not a choice.
create unique index if not exists manufacturer_warranties_scope_uq
  on public.manufacturer_warranties (
    lower(make), coalesce(lower(model), ''), coalesce(year_from, -1), coalesce(year_to, -1)
  );

create index if not exists manufacturer_warranties_lookup_idx
  on public.manufacturer_warranties (lower(make), lower(model));

-- ---- 3) the sourced Tesla rows ---------------------------------------------
-- Sources, read 2026-09-12:
--   * tesla.com/en_ca/support/vehicle-warranty
--   * Tesla Canada New Vehicle Limited Warranty PDF, effective 2026/09/01
--   * Archived captures of the same Tesla Canada page, 2020-03-13 and 2020-09-29,
--     for the terms in force when a 2020 car was sold.
-- Basic NVLW is 4-year/80,000 km across the range and is unchanged here.
delete from public.manufacturer_warranties
 where lower(make) = 'tesla' and model is not null;

insert into public.manufacturer_warranties
  (make, model, year_from, year_to, basic_coverage, powertrain_coverage, corrosion_coverage, roadside_assistance, hybrid_ev_coverage, source_url, note)
values
  -- 2020-era and later: 8 years or 240,000 km, minimum 70% battery retention.
  ('Tesla', 'Model X', 2020, null, '4-year/80,000 km', '8-year/240,000 km', '12-year/unlimited km', '4-year/80,000 km',
   '8-year/240,000 km (battery & drive unit, minimum 70% retention)',
   'https://www.tesla.com/en_ca/support/vehicle-warranty',
   'Battery & Drive Unit: 8 yr or 240,000 km, whichever first, min 70% retention. The 70% floor is a minimum, not cover against ordinary degradation. Both limbs must be open; the 8-year limb runs from FIRST DELIVERY, not model year.'),
  ('Tesla', 'Model S', 2020, null, '4-year/80,000 km', '8-year/240,000 km', '12-year/unlimited km', '4-year/80,000 km',
   '8-year/240,000 km (battery & drive unit, minimum 70% retention)',
   'https://www.tesla.com/en_ca/support/vehicle-warranty',
   'Same terms as Model X of the same era.'),

  -- Pre-2020: 8 years, NO distance cap, and no retention floor.
  ('Tesla', 'Model X', null, 2019, '4-year/80,000 km', '8-year/unlimited km', '12-year/unlimited km', '4-year/80,000 km',
   '8-year/unlimited km (battery & drive unit)',
   'https://www.tesla.com/en_ca/support/vehicle-warranty',
   'Pre-2020 Model S/X carried NO kilometre cap on Battery & Drive Unit and no minimum retention. The odometer has no bearing; only the 8-year date from first delivery does. The one carve-out was the original 60 kWh pack built before 2015 (8 yr/200,000 km), which does not apply to Model X.'),
  ('Tesla', 'Model S', null, 2019, '4-year/80,000 km', '8-year/unlimited km', '12-year/unlimited km', '4-year/80,000 km',
   '8-year/unlimited km (battery & drive unit)',
   'https://www.tesla.com/en_ca/support/vehicle-warranty',
   'Same terms as Model X of the same era. Original 60 kWh packs built before 2015 were 8 yr/200,000 km.');

-- The make-level Tesla row KEEPS its hedge on purpose. Model 3 and Model Y are
-- not verified, and the hedge is what makes the application refuse rather than
-- borrow Model X's figure. Refreshed here only so the wording is unambiguous
-- about what it is: an admission, not a term.
update public.manufacturer_warranties
   set powertrain_coverage = '8-year/160,000 km (battery & drive unit, varies by model - not verified for this model)',
       note = 'FALLBACK ONLY. Model S and Model X have their own sourced rows. Model 3 / Model Y terms are NOT verified, so this row hedges deliberately and the app refuses to publish a figure from it. Add sourced rows before removing the hedge. 160,000 km here is the Extended Service Agreement ceiling, NOT a battery term.'
 where lower(make) = 'tesla' and model is null;

-- ---- 4) prove the resolver has something to resolve -------------------------
do $$
declare n integer;
begin
  select count(*) into n from public.manufacturer_warranties
   where lower(make) = 'tesla' and model is not null;
  if n <> 4 then
    raise exception 'expected 4 model-scoped Tesla rows, found %', n;
  end if;
  raise notice 'OK: % model-scoped Tesla rows, make-level fallback left hedged on purpose.', n;
end $$;
