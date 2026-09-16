-- ============================================================================
-- CATALOG HYGIENE, PART A — NOTHING IS DELETED HERE.
--
-- Every statement in this file backfills a NULL or renames a trim. No row
-- disappears, so it is safe to apply on its own and safe to apply before the
-- delete file (20260916b) has been approved. If B is never applied, A still
-- leaves the catalogue strictly better than it found it.
--
-- WHY. A 2023 Lexus NX listing sent me through msrp_catalog and what came back
-- was not the shortage I expected. The all-in data is largely right where it
-- exists; what is wrong is that the SAME CAR is in the table more than once
-- under different spellings, and the copy the trim matcher happens to land on
-- may be the one with no all_in_price. When that happens msrp-claim.ts refuses
-- an over/under claim we were holding the evidence for.
--
-- A CORRECTION I OWE THE RECORD. I first measured this as "187 of 1,472 rows
-- are duplicates" by grouping on year+make+msrp. That is a PRICE COLLISION
-- count, not a duplicate count, and most of them are legitimate: Jeep Gladiator
-- Rubicon and Mojave are both $65,495, Ram 2500 Rebel and Power Wagon are both
-- $91,495, Chevrolet Trax 2RS and ACTIV are both $33,392. Those are different
-- vehicles that happen to cost the same. Merging on price would have destroyed
-- real rows. The true duplicate set, below, is TWELVE rows.
--
-- A SECOND CORRECTION. "Standard Package" appears as a trim 27 times, and my
-- first instinct was to call the whole convention a bug. It is not. For 22 of
-- those rows it is the only row for that base grade -- Camry, Corolla, Tundra,
-- Sequoia, Highlander, bZ, GR86 and the rest -- and deleting them would have
-- removed the base of nine model ladders. It is a defect only in the five cases
-- where the same car ALSO exists under its real grade name.
-- ============================================================================

-- ── 1. Backfill all_in_price from the row's own twin ────────────────────────
-- These four rows are the same car, at the same price, as a row that already
-- carries a captured all-in. The value is copied from that twin; nothing here
-- is computed from a fee table (fee-catalog's hard rule: the authoritative
-- all-in is the manufacturer's captured figure, never a sum of parts).
--
-- Without this, a listing matching "RAV4 LE" can land on id 21037, find no
-- all_in_price, and refuse a claim that id 7542 has the evidence for.
update public.msrp_catalog set all_in_price = 41361.40, fetched_at = now()
 where id = 21037 and all_in_price is null;   -- 2026 RAV4 / LE   <- twin id 7542
update public.msrp_catalog set all_in_price = 45161.40, fetched_at = now()
 where id = 21042 and all_in_price is null;   -- 2026 RAV4 / XLE  <- twin id 7543
update public.msrp_catalog set all_in_price = 54761.40, fetched_at = now()
 where id = 21038 and all_in_price is null;   -- 2026 RAV4 / XSE  <- twin id 7544
update public.msrp_catalog set all_in_price = 51814.00, fetched_at = now()
 where id = 21044 and all_in_price is null;   -- 2026 RAV4 PHEV / SE <- twin id 47970

-- DELIBERATELY NOT BACKFILLED: id 21046, 2026 RAV4 Plug-in Hybrid / XSE at
-- $56,400. It has no twin. Its three siblings in that line all carry adds of
-- exactly $3,064, so the answer is almost certainly $59,464 -- and "almost
-- certainly" is how a fabricated figure gets into a report. It needs a capture,
-- not an inference.

-- ── 2. A trim must not repeat the model it sits under ───────────────────────
-- "Sienna / Sienna XLE Mobility Package" renders as "Sienna Sienna XLE
-- Mobility Package" wherever the two are concatenated, and it means an exact
-- trim match against a listing's "XLE" never fires.
update public.msrp_catalog set trim = 'XLE Mobility Package', fetched_at = now()
 where id = 47978 and trim = 'Sienna XLE Mobility Package';
update public.msrp_catalog set trim = 'LE Mobility Package', fetched_at = now()
 where id = 47979 and trim = 'Sienna LE Mobility Package';
update public.msrp_catalog set trim = 'XSE Mobility Package', fetched_at = now()
 where id = 47981 and trim = 'Sienna XSE Mobility Package';

-- NOT RENAMED, on purpose: Volkswagen "Golf R / Golf R Black" and BMW
-- "i5 / i5 xDrive40" have the same shape, but I have not read either maker's
-- own naming to know what the trim is actually called. Stripping the prefix
-- there would be a guess about a real product. They stay until captured.
--
-- Toyota "Land Cruiser / Land Cruiser Premium Package" is the same shape AND a
-- duplicate of "Land Cruiser / Premium Package" at the identical $86,835 with
-- the identical $90,601 all-in, so it belongs in the delete file, not here.

-- ── 3. What this file deliberately leaves alone ─────────────────────────────
-- 2026 4Runner rows 47983 (TRD Sport, $60,322), 47984 (TRD Off Road Premium,
-- $65,462) and 47986 (Limited 7 Passenger, $69,644) all carry fuel_type
-- 'Hybrid'. The separate "4Runner Hybrid" line starts at $69,207, which makes
-- it likely those three are gas trims mislabelled. LIKELY IS NOT ENOUGH. A
-- wrong powertrain is the IONIQ 9 defect and powertrain-identity-rule is a hard
-- rule, so they are flagged here and left for a capture that can settle them
-- rather than rewritten on a price argument.
