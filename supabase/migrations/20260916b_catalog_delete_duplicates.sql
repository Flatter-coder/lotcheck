-- ============================================================================
-- CATALOG HYGIENE, PART B — THIS FILE DELETES ROWS. READ IT BEFORE APPLYING.
--
-- Eight rows. Every one is a second copy of a car that is already in the table
-- under a better name, and every one is listed by id with the row it duplicates
-- named beside it. Nothing is deleted on a pattern or a LIKE; each id was read
-- off the live table on 2026-09-16 and checked by hand.
--
-- APPLY 20260916a FIRST. Four of the surviving rows get their all_in_price from
-- their twin in that file. If B runs first, the twin is gone and the survivor
-- is left blind -- worse than the state this started in.
--
-- WHY DELETE RATHER THAN LEAVE THEM. An exact-trim match is the precondition
-- for any over/under claim. With one car under two trim names, which row the
-- matcher lands on is arbitrary, and four of these pairs have a copy with no
-- all_in_price -- so the arbitrary outcome decides whether the buyer gets a
-- claim or a refusal. That is not a tie-break anyone should be making at
-- request time.
-- ============================================================================

-- ── 1. "Standard Package" copies of a car already named by its real grade ───
-- Toyota's own name for these is the grade. Keeping both leaves the ladder with
-- two bases. ONLY these five: the other 22 "Standard Package" rows are the sole
-- row for their base grade and must not be touched.
delete from public.msrp_catalog where id = 47973;  -- 2026 Crown Signia / Standard Package $58,555 == "Limited" (id 7509-series)
delete from public.msrp_catalog where id = 47940;  -- 2026 GR Corolla    / Standard Package $50,295 == "Core"
delete from public.msrp_catalog where id = 47967;  -- 2026 RAV4          / Standard Package $37,500 == "LE"  (id 21037, backfilled in A)
delete from public.msrp_catalog where id = 47970;  -- 2026 RAV4 PHEV     / Standard Package $48,750 == "SE"  (id 21044, backfilled in A)

-- id 47985 is the same car as id 7516 (2026 4Runner / "4Runner", $55,520,
-- all_in $59,266) and ALSO carries the wrong powertrain: it says Hybrid at a
-- price $13,687 below where the 4Runner Hybrid line starts. Deleting it removes
-- the duplicate and the mislabel in one move, and leaves the row that has a
-- source_url.
delete from public.msrp_catalog where id = 47985;  -- 2026 4Runner / Standard Package (Hybrid @ the gas price)

-- ── 2. The trim that repeats its own model name, and duplicates a sibling ───
delete from public.msrp_catalog where id = 47988;  -- 2027 Land Cruiser / "Land Cruiser Premium Package" $86,835 == "Premium Package", same $90,601 all-in

-- ── 3. Byte-identical rows written twice by two capture passes ──────────────
-- Same year, make, model, blank trim, same price, same source_url; one from the
-- 2026-08-11 pass and one from 2026-08-18. The FRESHER row is kept, because in
-- a price catalogue the newer read is the one to trust.
--
-- (These two also have a blank trim, which can never satisfy an exact-config
-- match. Deduplicating them does not fix that -- 104 rows across six makes have
-- no trim at all. That is a capture gap, listed at the end.)
delete from public.msrp_catalog where id = 2744;   -- 2027 Chevrolet Trax, blank trim, $30,192 (08-11)  -- keeps id 12455 (08-18)
delete from public.msrp_catalog where id = 2773;   -- 2026 Cadillac  LYRIQ, blank trim, $74,042 (08-11)  -- keeps id 12484 (08-18)

-- ============================================================================
-- AFTER THIS FILE: 1,472 rows -> 1,464.
--
-- NOT ADDRESSED, and named so nobody reads this as "the catalogue is clean":
--
--   104 rows have a BLANK trim and can never produce an exact-config match:
--        Mercedes-Benz 77, Porsche 10, Volvo 7, Mini 6, Chevrolet 2, Cadillac 2.
--   1,105 rows across 28 makes still have NO all_in_price, so in an all-in
--        province msrp-claim.ts refuses the over/under claim for all of them.
--   3 rows (2026 4Runner TRD Sport / TRD Off Road Premium / Limited 7
--        Passenger) carry a powertrain I could not verify.
--   1 row (2026 RAV4 PHEV / XSE) has no all-in and no twin to take one from.
-- ============================================================================
