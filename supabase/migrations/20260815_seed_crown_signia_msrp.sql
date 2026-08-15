-- ============================================================================
-- 2026 Crown Signia Limited — and the summary that broke this morning's rule.
--
-- SOURCE: Toyota Canada Build & Price summaries, Alberta, captured 2026-08-15
-- (4:48 and 4:49 PM MDT). Both reconcile to their printed cash subtotals.
--
-- ---------------------------------------------------------------------------
-- THE GATE SHIPPED AN HOUR AGO WOULD HAVE SEEDED THIS $905 TOO HIGH.
--
-- That gate said: a package line suffixed "with Premium Paint" bundles the
-- colour, so refuse. True, and it holds. But the Crown Signia Limited summary
-- has NO PACKAGE LINE AT ALL, so the check never fires — and the figure is
-- still wrong, because the paint is folded into the MSRP line itself with
-- nothing in the document naming it:
--
--     build A   MSRP $59,460   exterior "Oxygen White with Black Roof"
--     build B   MSRP $58,555   exterior "Oxygen White"
--                    -------
--                    $   905   <- the black roof, never printed as a line item
--
-- Same trim, same block heater, same fees, both reconciling. $58,555 is a
-- DIRECT READ of Toyota's own MSRP line on build B, not an inference.
--
-- Third nameplate, third time: RAV4 Limited carried $350 of Ruby Flare Pearl,
-- Land Cruiser $390 of two-tone, Crown Signia $905. Each time the response was
-- a warning comment in a migration header, and each time the next one landed
-- anyway. So this one is CODE: scripts/lib/bp-summary.mjs refuses on BOTH
-- routes — the package suffix and the exterior — plus a reconciliation check
-- that catches a bad parse before it becomes a bad row. 19 cases pinned in
-- scripts/test-bp-summary.mjs, wired into gates.yml as test:bp-summary.
--
-- The gate now refuses build A by name, and refuses ANY summary whose colour is
-- not a confirmed positive finding. "Not known to be paid" is not "free".
-- ---------------------------------------------------------------------------
--
-- THE BLOCK HEATER IS $717 — a SIXTH distinct value:
--     RAV4 Hybrid            $797.40
--     Crown Signia           $717.00   <- new
--     Corolla Cross Hybrid   $712.00
--     Corolla Cross (gas)    $707.00
--     Land Cruiser           $702.00
--     4Runner / 4Runner Hyb  $682.00
--     RAV4 Plug-in Hybrid    none — a plug-in ships with a cord
-- Alberta adds here total $3,781.
--
-- ALL-IN IS TOYOTA'S OWN ARITHMETIC, NOT AN ESTIMATE. Their disclaimer states
-- the formula verbatim ("MSRP plus ... Delivery and Destination Charge of
-- $1,930.00, Air Conditioning Charge of $100.00, Premium Plug-In Block Heater
-- of up to $717.00, AMVIC of $10.00, Tire Levy of $25.00 ... and Dealer Fees of
-- up to $999.00"), and applying it to build A reproduces build A's printed
-- subtotal to the cent ($59,460 + $717 + $3,064 = $63,241). The same formula on
-- the base gives $62,336.
-- ============================================================================

insert into public.msrp_catalog
  (year, make, model, trim, msrp, all_in_price, fuel_type, drivetrain, price_basis, source_url, fetched_at, attrs)
values
  (2026,'Toyota','Crown Signia','Limited', 58555, 62336,'Hybrid','AWD','excl_freight',
   'https://www.toyota.ca/en/build-price/crown-signia/', now(),
   jsonb_build_object('province','AB','block_heater_included',true,
     'premium_paint_two_tone', 905,
     'all_in_breakdown', jsonb_build_object('delivery_destination',1930,'dealer_fees_max',999,
       'air_conditioning',100,'tire_levy',25,'amvic',10,'block_heater',717),
     'reference_code','ACAAJC BM 0090',
     'all_in_basis','computed from Toyota''s own published formula; verified to the cent against the two-tone build''s printed subtotal',
     'captured_from','toyota.ca Build & Price, Alberta — base read directly from the single-tone build''s MSRP line'))
on conflict (year, make, model, trim) do update
  set msrp         = excluded.msrp,
      all_in_price = excluded.all_in_price,
      fuel_type    = excluded.fuel_type,
      drivetrain   = excluded.drivetrain,
      price_basis  = excluded.price_basis,
      source_url   = excluded.source_url,
      attrs        = excluded.attrs,
      fetched_at   = now();

-- Toyota's published finance rate for this line, WITH its expiry. 4.59% here
-- against 5.69% on the RAV4 PHEV — the rate is per model line, so a single
-- "Toyota rate" would be wrong on one of them ([[reference-point-model]]).
insert into public.finance_rate_catalog
  (make, model, apr, term_months, promo, effective_date, source_url)
values
  ('Toyota', 'Crown Signia', 4.59, 72, false, date '2026-08-30',
   'https://www.toyota.ca/en/build-price/crown-signia/')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- WITHHELD: Limited - Advanced Technology Package. Its line reads "Limited -
-- Advanced Technology Package with Premium Paint $2,425.00", bundling the
-- package with Oxygen White. Knowing the base is $58,555 does not separate
-- them — one equation, two unknowns. A build of this package in a no-cost
-- colour closes it.
--
-- NOT A LEASE RATE: the summary prints a 60-month lease TERM but no lease
-- interest rate, so none is recorded. A blank is not a zero.
-- ---------------------------------------------------------------------------

select year, model, "trim", msrp, all_in_price, all_in_price - msrp as adds,
       attrs->>'premium_paint_two_tone' as two_tone_paint,
       attrs->'all_in_breakdown'->>'block_heater' as block_heater
from public.msrp_catalog
where make ilike 'Toyota' and year = 2026
order by model, msrp;
