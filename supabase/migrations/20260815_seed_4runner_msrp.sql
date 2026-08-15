-- ============================================================================
-- 2026 4Runner — and a FIFTH block-heater price.
--
-- SOURCE: Toyota Canada Build & Price summaries, Alberta, captured 2026-08-15.
--
-- THE BLOCK HEATER IS $682 HERE. Five models, five values:
--
--     RAV4 Hybrid            $797.40
--     Corolla Cross (gas)    $707.00
--     Corolla Cross Hybrid   $712.00
--     Land Cruiser           $702.00
--     4Runner                $682.00
--     RAV4 Plug-in Hybrid    none — a plug-in ships with a cord
--
-- That settles it beyond argument: there is no "Alberta adds" constant. Any code
-- computing all-in as MSRP + a fixed number is wrong on nearly every row, and
-- would be wrong by a DIFFERENT amount on each. Capture per row from the
-- manufacturer or leave all_in_price null. Alberta adds here total $3,746.
--
-- THE BASE RECONCILES CLEANLY because its build carries WHITE — a no-cost
-- colour. That is the first summary all day where the MSRP line is the trim
-- price with nothing folded in, and it is why it can be seeded with confidence:
--
--     $55,520 + $682 block heater + $3,064 Alberta fees = $59,266
--
-- Every other 4Runner summary supplied carries a premium colour and a bundled
-- package line, so all three are withheld — see the note below.
-- ============================================================================

insert into public.msrp_catalog
  (year, make, model, trim, msrp, all_in_price, fuel_type, drivetrain, price_basis, source_url, fetched_at, attrs)
values
  (2026,'Toyota','4Runner','4Runner', 55520, 59266,'Gas','4WD','excl_freight',
   'https://www.toyota.ca/en/build-price/4runner/', now(),
   jsonb_build_object('province','AB','block_heater_included',true,
     'all_in_breakdown', jsonb_build_object('delivery_destination',1930,'dealer_fees_max',999,
       'air_conditioning',100,'tire_levy',25,'amvic',10,'block_heater',682),
     'captured_from','toyota.ca Build & Price summary (Alberta), base build in no-cost White'))
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
-- WITHHELD — all three packaged trims, for the same reason, on the same line.
-- Each states its package and its paint as ONE figure on top of the $55,520
-- base, so neither can be separated from published numbers:
--
--   "TRD Sport with Premium Paint"            (Wind Chill Pearl)
--   "TRD Off Road Premium ..."                (Heritage Blue)
--   "Limited 7 Passenger with Premium Paint   $14,474"  (Supersonic Red)
--
-- Fourth nameplate showing this shape, after RAV4 XLE Premium ($2,849),
-- Corolla Cross LE Premium ($2,575) and Land Cruiser Premium ($6,765). It is
-- not an occasional quirk — it is how Toyota's configurator reports a packaged
-- build, so ANY packaged trim needs a capture in a no-cost colour before it can
-- be seeded. The build code in each PDF reopens the exact configuration.
--
-- ALSO NOT USABLE: the three "2026-4runner-summary-AB-gas-en*.pdf" files are
-- PRODUCT SUMMARIES (and byte-identical to each other), with no pricing table.
-- ---------------------------------------------------------------------------

select year, model, "trim", msrp, all_in_price, all_in_price - msrp as adds,
       attrs->'all_in_breakdown'->>'block_heater' as block_heater
from public.msrp_catalog
where make ilike 'Toyota' and year in (2026, 2027)
order by model, msrp;
