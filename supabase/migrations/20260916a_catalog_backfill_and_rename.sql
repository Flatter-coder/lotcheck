-- ============================================================================
-- CATALOG HYGIENE, PART A — NOTHING IS DELETED HERE.
--
-- REWRITTEN 2026-09-16, AFTER THIS FILE HALF-APPLIED AND REPORTED SUCCESS.
--
-- The original addressed every row by surrogate id. It was applied at 16:03 and
-- the run printed "✅ 1/1 applied". Four of its seven statements did what they
-- said. THE OTHER THREE MATCHED ZERO ROWS AND CHANGED NOTHING:
--
--     update public.msrp_catalog set trim = 'XLE Mobility Package'
--      where id = 47978 and trim = 'Sienna XLE Mobility Package';
--
-- Those ids were correct when the PR was written at 14:34. The daily catalog
-- refresh ran at 15:27 — 53 minutes after the merge — and replaceRows() deletes
-- a make's rows and re-inserts them, so every id in that block was reassigned.
-- 47978 had become 49444. An UPDATE that matches no rows is not an error in
-- Postgres, so the migration went green over work that never happened and the
-- Sienna trims stayed wrong.
--
-- Rewriting the file is safe and is the point: the four statements that DID
-- apply are written to be a clean no-op on a re-run, and the three that never
-- ran now address rows the way that survives a refresh.
--
-- WHAT CHANGED IN THE REWRITE
--   1. Rows are addressed by NATURAL KEY (year, make, model, trim) — which is
--      also msrp_catalog's UNIQUE constraint, and the key that carry-forward
--      and supersede run on in scripts/lib/catalog-io.mjs. Ids are not stable
--      for the life of a pull request; the natural key is.
--   2. Every statement RAISES when it matches nothing it expected to match, so
--      a no-op can never again read as success.
--   3. "Already done" is distinguished from "matched nothing" by an EXISTS
--      guard around each block. A re-run prints a notice and changes nothing;
--      only a genuine failure to find work that should be there raises.
--
-- scripts/check-migration-row-identity.mjs now fails the build on either fault.
--
-- WHY ANY OF THIS EXISTS. A 2023 Lexus NX listing sent me through msrp_catalog
-- and what came back was not the shortage I expected. The all-in data is largely
-- right where it exists; what is wrong is that the SAME CAR is in the table more
-- than once under different spellings, and the copy the trim matcher happens to
-- land on may be the one with no all_in_price. When that happens msrp-claim.ts
-- refuses an over/under claim we were holding the evidence for.
--
-- A CORRECTION I OWE THE RECORD. I first measured this as "187 of 1,472 rows
-- are duplicates" by grouping on year+make+msrp. That is a PRICE COLLISION
-- count, not a duplicate count, and most of them are legitimate: Jeep Gladiator
-- Rubicon and Mojave are both $65,495, Ram 2500 Rebel and Power Wagon are both
-- $91,495, Chevrolet Trax 2RS and ACTIV are both $33,392. Those are different
-- vehicles that happen to cost the same. Merging on price would have destroyed
-- real rows.
--
-- A SECOND CORRECTION. "Standard Package" appears as a trim 27 times, and my
-- first instinct was to call the whole convention a bug. It is not a Toyota
-- convention at all: it is Adobe AEM's DEFAULT LABEL for a base package with no
-- distinct name, and the real trim is the fragment's own `grade`. Verified
-- against the live fragments on 2026-09-16 for all 27 models. The write-side
-- fix is in scripts/lib/tci-stack.mjs (resolveTrim); this file only repairs the
-- rows already in the table.
-- ============================================================================

-- ── 1. Backfill all_in_price from the row's own twin ────────────────────────
-- These four rows are the same car, at the same price, as a row that already
-- carries a captured all-in. The value is copied from that twin; nothing here
-- is computed from a fee table (fee-catalog's hard rule: the authoritative
-- all-in is the manufacturer's captured figure, never a sum of parts).
--
-- Without this, a listing matching "RAV4 LE" can find no all_in_price and
-- refuse a claim the catalogue has the evidence for.
--
-- THESE FOUR ALREADY APPLIED on 2026-09-16 at 16:03. The EXISTS guard makes the
-- re-run a no-op rather than a raise — "already done" is not the same failure
-- as "matched nothing", and conflating them is how an assert gets deleted.
do $$
declare
  r record;
  n int;
  filled int := 0;
begin
  for r in
    select * from (values
      (2026, 'Toyota', 'RAV4',                 'LE',  41361.40),
      (2026, 'Toyota', 'RAV4',                 'XLE', 45161.40),
      (2026, 'Toyota', 'RAV4',                 'XSE', 54761.40),
      (2026, 'Toyota', 'RAV4 Plug-in Hybrid',  'SE',  51814.00)
    ) as t(yr, mk, md, tr, all_in)
  loop
    if not exists (select 1 from public.msrp_catalog c
                    where c.year = r.yr and c.make = r.mk
                      and c.model = r.md and c.trim = r.tr) then
      raise exception 'backfill: no row for % % % "%" — the natural key is wrong, not the data',
        r.yr, r.mk, r.md, r.tr;
    end if;

    if exists (select 1 from public.msrp_catalog c
                where c.year = r.yr and c.make = r.mk and c.model = r.md
                  and c.trim = r.tr and c.all_in_price is null) then
      update public.msrp_catalog c
         set all_in_price = r.all_in, fetched_at = now()
       where c.year = r.yr and c.make = r.mk and c.model = r.md
         and c.trim = r.tr and c.all_in_price is null;
      get diagnostics n = row_count;
      if n = 0 then
        raise exception 'backfill: % % % "%" matched nothing after EXISTS said it would',
          r.yr, r.mk, r.md, r.tr;
      end if;
      filled := filled + n;
      raise notice 'backfilled all-in $% on % % % "%"', r.all_in, r.yr, r.mk, r.md, r.tr;
    else
      raise notice 'already has an all-in: % % % "%"', r.yr, r.mk, r.md, r.tr;
    end if;
  end loop;
  raise notice 'all_in_price backfilled on % row(s)', filled;
end $$;

-- DELIBERATELY NOT BACKFILLED: the 2026 RAV4 Plug-in Hybrid XSE at $56,400. It
-- has no twin. Its three siblings in that line all carry adds of exactly $3,064,
-- so the answer is almost certainly $59,464 — and "almost certainly" is how a
-- fabricated figure gets into a report. It needs a capture, not an inference.

-- ── 2. A trim must not repeat the model it sits under ───────────────────────
-- "Sienna / Sienna XLE Mobility Package" renders as "Sienna Sienna XLE Mobility
-- Package" wherever the two are concatenated, and it means an exact trim match
-- against a listing's "XLE" never fires.
--
-- THESE THREE ARE THE STATEMENTS THAT NEVER RAN. Under the old id pins they
-- matched nothing and the migration still reported success. Keyed on the model
-- and the trim text, they survive any number of refreshes.
--
-- This also converges the rows with what the scraper will write from now on:
-- stripModelPrefix() in tci-stack.mjs produces the same names, so the next
-- refresh supersedes these rows in place instead of forking a second copy.
do $$
declare
  r record;
  n int;
  renamed int := 0;
begin
  for r in
    select * from (values
      (2026, 'Toyota', 'Sienna', 'Sienna XLE Mobility Package', 'XLE Mobility Package'),
      (2026, 'Toyota', 'Sienna', 'Sienna LE Mobility Package',  'LE Mobility Package'),
      (2026, 'Toyota', 'Sienna', 'Sienna XSE Mobility Package', 'XSE Mobility Package')
    ) as t(yr, mk, md, old_trim, new_trim)
  loop
    if exists (select 1 from public.msrp_catalog c
                where c.year = r.yr and c.make = r.mk
                  and c.model = r.md and c.trim = r.old_trim) then
      -- Renaming onto an existing name would violate UNIQUE(year,make,model,trim).
      -- Refuse rather than let the migration die on a constraint halfway through.
      if exists (select 1 from public.msrp_catalog c
                  where c.year = r.yr and c.make = r.mk
                    and c.model = r.md and c.trim = r.new_trim) then
        raise exception 'rename: % % % already has a row named "%" — refusing to collide',
          r.yr, r.mk, r.md, r.new_trim;
      end if;

      update public.msrp_catalog c
         set trim = r.new_trim, fetched_at = now()
       where c.year = r.yr and c.make = r.mk
         and c.model = r.md and c.trim = r.old_trim;
      get diagnostics n = row_count;
      if n = 0 then
        raise exception 'rename: "%" matched nothing after EXISTS said it would', r.old_trim;
      end if;
      renamed := renamed + n;
      raise notice 'renamed "%" -> "%" (% row(s))', r.old_trim, r.new_trim, n;
    else
      raise notice 'already renamed, or never present: % % % "%"', r.yr, r.mk, r.md, r.old_trim;
    end if;
  end loop;
  raise notice 'trims renamed: %', renamed;
end $$;

-- NOT RENAMED, on purpose: Volkswagen "Golf R / Golf R Black" and BMW
-- "i5 / i5 xDrive40" have the same shape, but I have not read either maker's
-- own naming to know what the trim is actually called. Stripping the prefix
-- there would be a guess about a real product. They stay until captured.
--
-- Toyota "Land Cruiser / Land Cruiser Premium Package" is the same shape AND a
-- duplicate of "Land Cruiser / Premium Package" at the identical $86,835 with
-- the identical $90,601 all-in, so it belongs in the delete file (20260916b),
-- not here.

-- ── 3. What this file deliberately leaves alone ─────────────────────────────
-- 2026 4Runner rows TRD Sport ($60,322), TRD Off Road Premium ($65,462) and
-- Limited 7 Passenger ($69,644) all carry fuel_type 'Hybrid'. The separate
-- "4Runner Hybrid" line starts at $69,207, and the hand-verified row for the
-- bare "4Runner" nameplate says Gas — so those three are almost certainly gas
-- trims mislabelled. ALMOST CERTAINLY IS NOT ENOUGH, and a wrong powertrain is
-- the IONIQ 9 defect that [[powertrain-identity-rule]] exists to forbid. They
-- are named here and left for a capture that can settle them rather than
-- rewritten on a price argument.
--
-- The guard that should have caught it (flagAllOnePowertrain in
-- scripts/lib/tci-overrides.mjs) proves a mis-tag by looking for a sibling
-- nameplate carrying a powertrain marker — but it only sees the CURRENT SCRAPE
-- BATCH, and "4Runner Hybrid" was not in that batch. Widening it to read the
-- catalogue is its own change: the obvious version would also refuse the 2026
-- RAV4, which is genuinely hybrid-only, and deleting a real lineup is worse
-- than the mis-tag.
