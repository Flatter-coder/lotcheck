-- ============================================================================
-- 2026 4Runner HYBRID — a separate nameplate, and the reason that rule exists.
--
-- SOURCE: Toyota Canada Build & Price summaries, Alberta, captured 2026-08-15
-- (five builds, creation-stamped 4:04–4:13 PM MDT). Every figure below
-- reconciles to its printed CASH subtotal exactly.
--
-- THE HEADLINE NUMBER, AND WHY IT IS DANGEROUS:
--
--     2026 4Runner        (gas)     MSRP $55,520     all-in $59,266
--     2026 4Runner Hybrid           MSRP $69,207     all-in $72,953
--                                        -------
--                                        $13,687
--
-- A dealer advertising a 4Runner Hybrid at $72,000 is asking BELOW Toyota's
-- all-in. Matched against the gas row it looks like $16,480 of markup. That is
-- not a rounding error, it is a fabricated accusation of the exact kind that
-- ends the conversation with a buyer — which is why an electrified car never
-- inherits its gas sibling's MSRP, and why these rows are keyed
-- model='4Runner Hybrid', never merged into '4Runner'.
--
-- THE BLOCK HEATER IS $682 — same as the gas 4Runner, and the FIRST time two
-- powertrains of one nameplate have agreed on it. The running tally:
--
--     RAV4 Hybrid            $797.40
--     Corolla Cross (gas)    $707.00
--     Corolla Cross Hybrid   $712.00
--     Land Cruiser           $702.00
--     4Runner (gas)          $682.00
--     4Runner Hybrid         $682.00   <- agrees with its gas sibling
--     RAV4 Plug-in Hybrid    none — a plug-in ships with a cord
--
-- So it varies by NAMEPLATE, not by powertrain. Still five distinct values, so
-- the conclusion is unchanged: there is no "Alberta adds" constant, and any
-- code computing all-in as MSRP + a fixed number is wrong on nearly every row.
-- Alberta adds here total $3,746 ($1,930 + $999 + $682 + $100 + $25 + $10).
--
-- ---------------------------------------------------------------------------
-- THE PARSING RULE THIS CAPTURE ESTABLISHES — and it is the useful part.
--
-- Every packaged build all day has bundled its paint into the package line, and
-- I have been withholding those trims after reading each PDF by eye. The
-- Trailhunter breaks the pattern and shows what the signal actually is:
--
--     "Trailhunter                       $16,447.00"     <- bare. paint is free.
--     "Platinum with Premium Paint        $6,272.00"     <- bundled. unusable.
--     "TRD PRO with Premium Paint        $13,501.00"     <- bundled. unusable.
--
-- Toyota appends "with Premium Paint" to the label ONLY when a paid colour is
-- folded in. When the colour is no-cost the suffix is absent. That holds across
-- every summary captured today — RAV4 XLE Premium, Corolla Cross LE Premium,
-- Land Cruiser Premium Package, 4Runner TRD Sport / Limited 7 Passenger (all
-- suffixed, all withheld) and now 4Runner Hybrid Trailhunter (bare, seeded).
--
-- That converts a human eyeball check into a machine gate: if the package label
-- matches /with Premium Paint$/, the trim price cannot be separated from the
-- colour and the row MUST NOT be seeded. Worth encoding in the catalog importer
-- rather than leaving to whoever reads the next PDF.
--
-- CORRECTION TO TWO EARLIER MIGRATIONS. 20260815_seed_land_cruiser_msrp.sql and
-- 20260815_seed_4runner_msrp.sql both tell the reader to "use the build code in
-- each PDF to reopen the exact configuration". That is wrong. All five hybrid
-- summaries — five genuinely different configurations, from base to Trailhunter
-- — carry the IDENTICAL build code YQ80B0 and URL toyota.ca/build/YQ80B0. What
-- differs is the REFERENCE CODE (VB5BRT CA 0202, HA 06X7, PB 03U5, TB 0796,
-- QB 0089). The build code identifies the model line, not the build, so it will
-- not reopen anything. To capture a withheld trim, reconfigure it from the trim
-- page and pick a no-cost colour.
-- ============================================================================

insert into public.msrp_catalog
  (year, make, model, trim, msrp, all_in_price, fuel_type, drivetrain, price_basis, source_url, fetched_at, attrs)
values
  -- Base hybrid. Exterior Black, and the summary prints NO paint line and NO
  -- package line — so $69,207 is the trim price with nothing folded in.
  -- Toyota's own document does not name this trim beyond "4Runner Hybrid";
  -- the gas base row is recorded the same way for the same reason.
  (2026,'Toyota','4Runner Hybrid','4Runner Hybrid', 69207, 72953,'Hybrid','4WD','excl_freight',
   'https://www.toyota.ca/en/build-price/4runner/', now(),
   jsonb_build_object('province','AB','block_heater_included',true,'seats',5,
     'fuel_l_100km','10.3/9.5','horsepower',326,
     'all_in_breakdown', jsonb_build_object('delivery_destination',1930,'dealer_fees_max',999,
       'air_conditioning',100,'tire_levy',25,'amvic',10,'block_heater',682),
     'reference_code','VB5BRT CA 0202',
     'captured_from','toyota.ca Build & Price summary (Alberta), base build in no-cost Black')),

  -- Trailhunter. Package line is BARE — "Trailhunter $16,447.00" with no
  -- "with Premium Paint" suffix — so Everest is a no-cost colour here and the
  -- package price stands alone. $69,207 + $16,447 = $85,654.
  (2026,'Toyota','4Runner Hybrid','Trailhunter', 85654, 89400,'Hybrid','4WD','excl_freight',
   'https://www.toyota.ca/en/build-price/4runner/', now(),
   jsonb_build_object('province','AB','block_heater_included',true,'seats',5,
     'fuel_l_100km','10.3/9.5','horsepower',326,
     'base_msrp',69207,'package_price',16447,'package_line','Trailhunter',
     'all_in_breakdown', jsonb_build_object('delivery_destination',1930,'dealer_fees_max',999,
       'air_conditioning',100,'tire_levy',25,'amvic',10,'block_heater',682),
     'reference_code','VB5BRT HA 06X7',
     'captured_from','toyota.ca Build & Price summary (Alberta), Everest is no-cost on Trailhunter'))
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
-- WITHHELD — three trims, all for the bundled-paint reason above. Each
-- reconciles to its printed subtotal, so the arithmetic is sound; what is
-- missing is how much of the figure is somebody's colour choice.
--
--   Platinum                          "Platinum with Premium Paint  $6,272.00"
--                                     Supersonic Red     subtotal $79,225
--   Platinum with Fixed Running Board "...with Premium Paint        $5,157.00"
--                                     Wind Chill Pearl   subtotal $78,110
--   TRD PRO                           "TRD PRO with Premium Paint  $13,501.00"
--                                     Wave Maker         subtotal $86,454
--
-- THE TWO PLATINUMS LOOK LIKE THEY SHOULD SOLVE EACH OTHER, AND THEY DO NOT.
-- They differ by $1,115, but TWO things changed between them — the running
-- board and the colour — so one equation cannot recover two unknowns. Assuming
-- both premium colours cost the same would make $1,115 the running-board
-- delta, and that assumption is not published anywhere. Not seeding it.
--
-- ONE BUILD EACH IN A NO-COST COLOUR closes all three. Reconfigure from
-- toyota.ca/en/build-price/4runner/ (NOT from the build code — see the
-- correction above), pick the free colour, download the summary.
--
-- ALSO NOT USABLE: the five "2026-4runner-summary-AB-hybrid-en*.pdf" files are
-- PRODUCT SUMMARIES and byte-identical to one another — no pricing table. Same
-- as the gas set. Five copies of one document is not five data points.
-- ---------------------------------------------------------------------------

select year, model, "trim", msrp, all_in_price, all_in_price - msrp as adds, fuel_type,
       attrs->'all_in_breakdown'->>'block_heater' as block_heater
from public.msrp_catalog
where make ilike 'Toyota' and model ilike '4Runner%'
order by model, msrp;
