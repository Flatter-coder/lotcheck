-- ============================================================================
-- 2027 Land Cruiser — and a FOURTH block-heater price.
--
-- SOURCE: Toyota Canada Build & Price summaries, Alberta, captured 2026-08-15.
-- Every figure reconciles to the printed cash subtotal exactly.
--
-- FIRST, A FILENAME WARNING. Five summaries were supplied, two of them named
-- "2026_Land_Cruiser_*". Their CONTENT reads "2027 Land Cruiser" — all five are
-- 2027 builds. Nothing here is 2026. Parse the model year from the document,
-- never from the filename; seeding these as 2026 would have put a whole model
-- year of prices under the wrong key.
--
-- THE BLOCK HEATER IS $702 HERE — a fourth distinct value:
--     RAV4 Hybrid            $797.40
--     Corolla Cross (gas)    $707.00
--     Corolla Cross Hybrid   $712.00
--     Land Cruiser           $702.00
--     RAV4 Plug-in Hybrid    none — a plug-in ships with a cord
-- Four models, four answers. Any code computing all-in as "MSRP + a constant"
-- is wrong on nearly every row. Alberta adds here total $3,766.
--
-- THE PAINT TRAP, THIRD TIME ON A THIRD NAMEPLATE. The plain Land Cruiser build
-- reads MSRP $80,850 because it carries "Heritage Blue with Light Grey Roof".
-- The Premium Package build states the base as $80,460 on its own MSRP line —
-- and both reconcile to their printed subtotals, so the $390 difference IS the
-- two-tone paint. Base is $80,460. (RAV4 XSE and RAV4 Limited were the first
-- two; a captured build is a CAR, a catalog row must hold the TRIM.)
-- ============================================================================

insert into public.msrp_catalog
  (year, make, model, trim, msrp, all_in_price, fuel_type, drivetrain, price_basis, source_url, fetched_at, attrs)
values
  (2027,'Toyota','Land Cruiser','Land Cruiser', 80460, 84226,'Hybrid','4WD','excl_freight',
   'https://www.toyota.ca/en/build-price/land-cruiser/', now(),
   jsonb_build_object('province','AB','block_heater_included',true,
     'premium_paint_two_tone', 390,
     'all_in_breakdown', jsonb_build_object('delivery_destination',1930,'dealer_fees_max',999,
       'air_conditioning',100,'tire_levy',25,'amvic',10,'block_heater',702),
     'captured_from','toyota.ca Build & Price summary (Alberta)'))
on conflict (year, make, model, trim) do update
  set msrp         = excluded.msrp,
      all_in_price = excluded.all_in_price,
      fuel_type    = excluded.fuel_type,
      drivetrain   = excluded.drivetrain,
      price_basis  = excluded.price_basis,
      source_url   = excluded.source_url,
      attrs        = excluded.attrs,
      fetched_at   = now();

-- ---------------------------------------------------------------------------
-- WITHHELD, and why. Both reconcile to their printed subtotals, so the ARITHMETIC
-- is sound — what is missing is knowing how much of each figure is paint.
--
--   1958 — build reads MSRP $71,670 with "Brown Sugar Metallic". No second data
--     point exists to separate a paint charge from the trim price, and $71,670
--     is not an obviously round number. On the RAV4 a single premium pearl was
--     $350 and a two-tone $905; here the two-tone is $390. Seeding this could
--     embed several hundred dollars of somebody's colour choice.
--
--   Premium Package — one line reads "Land Cruiser Premium Package with Premium
--     Paint $6,765.00", bundling package and paint exactly like the RAV4 XLE
--     Premium ($2,849) and the Corolla Cross LE Premium ($2,575). Package alone
--     cannot be separated from published figures.
--
-- ONE BUILD EACH WITH A NO-COST COLOUR closes both. Toyota's own build code in
-- each PDF reopens the exact configuration — change the exterior and re-download.
--
-- ALSO NOT HELD: any 2026 Land Cruiser. The two 2026-named files are 2027
-- builds, and the two "summary-AB-hybrid" files are PRODUCT SUMMARIES with no
-- pricing table.
-- ---------------------------------------------------------------------------

select year, model, "trim", msrp, all_in_price, all_in_price - msrp as adds, drivetrain
from public.msrp_catalog
where make ilike 'Toyota' and model ilike 'Land Cruiser%'
order by year, msrp;
